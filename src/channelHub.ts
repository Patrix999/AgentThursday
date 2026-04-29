/**
 * `ChannelHubAgent` Durable Object.
 *
 * Owns inbox / outbox / identity / conversation tables. Provider-agnostic.
 * No Discord/email adapter wiring in this card — only schema, storage, and
 * idempotent ingestion. Cards 86+ wire actual transports.
 *
 * Boundary rationale (review notes §1): kept as its own DO from day 1
 * so AgentThursdayAgent's event_log isn't shared with channel events, and webhook
 * traffic patterns can scale independently of agent task patterns.
 */

import { Agent, getAgentByName, unstable_callable as callable, type AgentNamespace } from "agents";
import {
  ChannelMessageEnvelopeSchema,
  type ChannelInboundResult,
  type ChannelInboxItem,
  type ChannelInboxStatus,
  type ChannelOutboxItem,
  type ChannelOutboxStatus,
  type ChannelSnapshot,
  type ChannelAttachment,
  type ChannelChatType,
  type ChannelProvider,
  type ChannelRouteDecision,
  type ChannelApprovalCard,
  type ChannelApprovalStatus,
  type ApprovalScope,
  type ApprovalKind,
  type ApprovalWarning,
  type EnqueueOutboundTextRequest,
  type EnqueueOutboundApprovalRequest,
  type EnqueueOutboundResult,
  type DeliverPendingResult,
  type ApprovalResolveRequest,
  type ApprovalResolveResult,
  type OutboundChannelMessage,
  type ChannelApprovalRow,
  type ChannelCompactSummary,
} from "./schema";
import { PENDING_CAP_PER_CONVERSATION, PENDING_INBOX_STATUSES, clampRawRef } from "./channel";
import { decideRoute, buildTaskPromptFromInbox } from "./channelRouter";
import {
  hashApprovalPayload,
  buildBridgePayload,
  sanitizeOutboundError,
  rowKindToOutboundKind,
  APPROVAL_DEFAULTS,
} from "./channelOutbound";
import {
  splitForDiscord2000,
  buildDiscordTextSendBody,
  buildDiscordApprovalSendBody,
} from "./discordDirect";
import { sendDiscordMessage } from "./discordSender";
import { renderApprovalText } from "./channelOutbound";

// AgentThursdayAgent is RPC'd cross-DO. Use a structural type so the import doesn't
// pull the full Think class graph into channelHub.ts.
type AgentThursdayAgentRPC = {
  getStatus(): Promise<{
    currentTask: string | null;
    waitingForHuman: boolean;
    currentObstacle: { blocked: boolean } | null;
  }>;
  submitTask(task: string): Promise<{ ok: boolean; taskId: string; loopTriggered: boolean; replyText: string }>;
  approvePendingTool(toolCallId: string, approved: boolean): Promise<{ ok: boolean }>;
  // explicit channel-ingress readiness predicate.
  getChannelIngressReadiness(): Promise<{
    canAccept: boolean;
    reason: string;
    currentTaskId: string | null;
    currentTaskLifecycle: string | null;
  }>;
};

const AGENT_THURSDAY_INSTANCE_NAME = "agent-thursday-dev";

type InboxRow = {
  id: string;
  provider: string;
  conversation_id: string;
  provider_message_id: string;
  sender_provider_user_id: string;
  chat_type: string;
  addressed_to_agent: number;
  addressed_signals_json: string;
  text: string;
  attachments_json: string;
  raw_ref: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  // additive route metadata; nullable on rows ingested before migration.
  route_action: string | null;
  route_reason: string | null;
  routed_at: number | null;
  handoff_task_id: string | null;
};

type OutboxRow = {
  id: string;
  provider: string;
  conversation_id: string;
  reply_to_provider_message_id: string | null;
  text: string;
  payload_json: string;
  status: string;
  error: string | null;
  attempt_count: number;
  created_at: number;
  sent_at: number | null;
  kind: string | null;
  approval_id: string | null;
};

type ApprovalRow = {
  id: string;
  kind: string;
  title: string;
  warning: string;
  reason: string;
  payload_json: string;
  payload_hash: string;
  target_tool_call_id: string | null;
  provider: string;
  conversation_id: string;
  outbox_id: string | null;
  status: string;
  resolved_scope: string | null;
  resolved_actor: string | null;
  audit: string | null;
  expires_at: number;
  created_at: number;
  resolved_at: number | null;
};

export class ChannelHubAgent extends Agent<Env, Record<string, never>> {
  async onStart(props?: unknown): Promise<void> {
    await super.onStart(props as Record<string, unknown> | undefined);

    // §D-11 — additive, idempotent. Each table individually IF NOT EXISTS.

    this.sql`
      CREATE TABLE IF NOT EXISTS channel_inbox (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        sender_provider_user_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        addressed_to_agent INTEGER NOT NULL,
        addressed_signals_json TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        raw_ref TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider, provider_message_id)
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_channel_inbox_conv_status_at ON channel_inbox(conversation_id, status, created_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_channel_inbox_status_at ON channel_inbox(status, created_at)`;

    this.sql`
      CREATE TABLE IF NOT EXISTS channel_outbox (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reply_to_provider_message_id TEXT,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_channel_outbox_status_at ON channel_outbox(status, created_at)`;

    this.sql`
      CREATE TABLE IF NOT EXISTS channel_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'unknown',
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE (provider, provider_user_id)
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_channel_identities_provider_user ON channel_identities(provider, provider_user_id)`;

    this.sql`
      CREATE TABLE IF NOT EXISTS channel_conversations (
        conversation_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        provider_channel_id TEXT,
        provider_thread_id TEXT,
        capability_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `;

    // additive route metadata on channel_inbox. Idempotent via
    // PRAGMA table_info check (mirrors the kanban_mutations migration in
    // AgentThursdayAgent.onStart). Existing rows get NULL until they're routed.
    const inboxCols = this.sql<{ name: string }>`PRAGMA table_info(channel_inbox)`;
    if (!inboxCols.some(c => c.name === "route_action")) {
      this.sql`ALTER TABLE channel_inbox ADD COLUMN route_action TEXT`;
    }
    if (!inboxCols.some(c => c.name === "route_reason")) {
      this.sql`ALTER TABLE channel_inbox ADD COLUMN route_reason TEXT`;
    }
    if (!inboxCols.some(c => c.name === "routed_at")) {
      this.sql`ALTER TABLE channel_inbox ADD COLUMN routed_at INTEGER`;
    }
    if (!inboxCols.some(c => c.name === "handoff_task_id")) {
      this.sql`ALTER TABLE channel_inbox ADD COLUMN handoff_task_id TEXT`;
    }

    // additive outbox kind + approval link.
    const outboxCols = this.sql<{ name: string }>`PRAGMA table_info(channel_outbox)`;
    if (!outboxCols.some(c => c.name === "kind")) {
      this.sql`ALTER TABLE channel_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`;
    }
    if (!outboxCols.some(c => c.name === "approval_id")) {
      this.sql`ALTER TABLE channel_outbox ADD COLUMN approval_id TEXT`;
    }

    // channel_approvals state machine. Single-resolution semantics
    // enforced by the `status` field plus the resolve callable. Payload hash
    // is stored so a payload mutation invalidates a pending approval.
    this.sql`
      CREATE TABLE IF NOT EXISTS channel_approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        warning TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        target_tool_call_id TEXT,
        provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        outbox_id TEXT,
        status TEXT NOT NULL,
        resolved_scope TEXT,
        resolved_actor TEXT,
        audit TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_channel_approvals_status_at ON channel_approvals(status, created_at)`;
  }

  /**
   * Idempotent inbound persist.  §E-15:
   *  - first insert → `{ inserted: true, id }`
   *  - duplicate `(provider, provider_message_id)` → `{ inserted: false, id }`
   *  - per-conversation pending cap exceeded → status `deferred`
   */
  @callable()
  async ingestInbound(envelopeRaw: unknown): Promise<ChannelInboundResult> {
    const parsed = ChannelMessageEnvelopeSchema.parse(envelopeRaw);
    const now = Date.now();

    // Pending cap check before insert. Avoid bloating the inbox if a single
    // conversation goes wild. New rows over cap are stored as `deferred` —
    // they are visible in the snapshot but are not "received" for routing.
    const pending = Number(
      (this.sql<{ n: number | bigint }>`
        SELECT COUNT(*) as n FROM channel_inbox
        WHERE conversation_id = ${parsed.conversationId}
          AND status IN (${PENDING_INBOX_STATUSES[0]}, ${PENDING_INBOX_STATUSES[1]}, ${PENDING_INBOX_STATUSES[2]}, ${PENDING_INBOX_STATUSES[3]})
      `)[0]?.n ?? 0,
    );
    const status: ChannelInboxStatus = pending >= PENDING_CAP_PER_CONVERSATION ? "deferred" : "received";

    const candidateId = parsed.id ?? crypto.randomUUID();
    const senderUid = parsed.sender.providerUserId;
    const signalsJson = JSON.stringify(parsed.addressedSignals);
    const attachmentsJson = JSON.stringify(parsed.attachments);
    const rawRef = clampRawRef(parsed.rawRef ?? null);
    const receivedAt = parsed.receivedAt ?? now;

    // INSERT OR IGNORE so a concurrent duplicate webhook does not create a
    // second row. The dedup key is the UNIQUE(provider, provider_message_id)
    // constraint declared in onStart.
    this.sql`
      INSERT OR IGNORE INTO channel_inbox (
        id, provider, conversation_id, provider_message_id,
        sender_provider_user_id, chat_type,
        addressed_to_agent, addressed_signals_json,
        text, attachments_json, raw_ref, status,
        created_at, updated_at
      ) VALUES (
        ${candidateId}, ${parsed.provider}, ${parsed.conversationId}, ${parsed.providerMessageId},
        ${senderUid}, ${parsed.chatType},
        ${parsed.addressedToAgent ? 1 : 0}, ${signalsJson},
        ${parsed.text}, ${attachmentsJson}, ${rawRef}, ${status},
        ${receivedAt}, ${now}
      )
    `;

    // Read back the canonical row (either the one we just inserted, or the
    // pre-existing duplicate). If the canonical id matches our candidate,
    // we won the insert.
    const row = this.sql<{ id: string; status: string }>`
      SELECT id, status FROM channel_inbox
      WHERE provider = ${parsed.provider} AND provider_message_id = ${parsed.providerMessageId}
      LIMIT 1
    `;
    if (row.length === 0) {
      // Should not happen — INSERT OR IGNORE either inserted or the row exists.
      throw new Error("channel_inbox: ingest failed to materialize a row");
    }
    const inserted = row[0].id === candidateId;

    // Touch the conversation row (UPSERT). Capability/policy left empty.
    this.sql`
      INSERT OR IGNORE INTO channel_conversations (
        conversation_id, provider, chat_type,
        provider_channel_id, provider_thread_id,
        first_seen_at, last_seen_at
      ) VALUES (
        ${parsed.conversationId}, ${parsed.provider}, ${parsed.chatType},
        ${parsed.providerChannelId ?? null}, ${parsed.providerThreadId ?? null},
        ${now}, ${now}
      )
    `;
    this.sql`
      UPDATE channel_conversations SET last_seen_at = ${now}
      WHERE conversation_id = ${parsed.conversationId}
    `;

    // Touch identity row so we know who has talked to us.
    this.sql`
      INSERT OR IGNORE INTO channel_identities (
        provider, provider_user_id, display_name, role, is_self, created_at
      ) VALUES (
        ${parsed.provider}, ${senderUid}, ${parsed.sender.displayName ?? null},
        'unknown', ${parsed.sender.isBot ? 1 : 0}, ${now}
      )
    `;

    return { ok: true, inserted, id: row[0].id, status: row[0].status as ChannelInboxStatus };
  }

  /**
   * Route up to `limit` pending `received` inbox rows.  §B +  §B.
   * For `process` action, RPCs AgentThursdayAgent.submitTask. Active-task guard runs
   * via `AgentThursdayAgent.getStatus()` before any submit so we never overwrite work.
   * : when the guard fires on an addressed/trusted row, the decision
   * is `busy-skip` and the row STAYS `received` (not deferred) so the next
   * route attempt can pick it up when the agent is free.
   * Idempotent: only `received` rows are picked up (others have already been
   * routed); rerun is safe and is exactly what the busy-skip path relies on.
   */
  @callable()
  async routePending(limit: number = 10): Promise<{
    ok: boolean;
    scanned: number;
    busySkipped: number;
    decisions: Array<{
      inboxId: string;
      providerMessageId: string;
      action: ChannelRouteDecision["action"];
      reason: string;
      finalStatus: ChannelInboxStatus;
      handoffTaskId: string | null;
    }>;
  }> {
    const cap = Math.min(Math.max(1, Math.floor(limit)), 50);
    const candidates = this.sql<InboxRow>`
      SELECT id, provider, conversation_id, provider_message_id, sender_provider_user_id,
             chat_type, addressed_to_agent, addressed_signals_json,
             text, attachments_json, raw_ref, status, created_at, updated_at,
             route_action, route_reason, routed_at, handoff_task_id
      FROM channel_inbox
      WHERE status = 'received'
      ORDER BY created_at ASC LIMIT ${cap}
    `;
    if (candidates.length === 0) {
      return { ok: true, scanned: 0, busySkipped: 0, decisions: [] };
    }

    // Read AgentThursdayAgent state once per batch — cheap RPC and avoids racing
    // with our own submits within this loop.
    // explicit readiness instead of inferring from `currentTask` string.
    const readiness = await this.fetchAgentThursdayReadiness();
    const agentThursdayBusy = !readiness.canAccept;
    const decisions: Array<{
      inboxId: string;
      providerMessageId: string;
      action: ChannelRouteDecision["action"];
      reason: string;
      finalStatus: ChannelInboxStatus;
      handoffTaskId: string | null;
    }> = [];

    for (const raw of candidates) {
      const item = rowToInboxItem(raw);
      // P0 sender role: anything we've seen tagged via channel_identities is
      // still "unknown" until a future card explicitly trusts. The router
      // converts unknown + addressed → wait, which is the safe default.
      const role = await this.lookupSenderRole(item.provider, item.senderProviderUserId);
      const decision = decideRoute(item, { activeTaskBusy: agentThursdayBusy, senderRole: role });
      // when the policy fired busy-skip, append the concrete
      // readiness reason so operators can see WHICH busy condition won
      // (waitingForHuman / blocked / active task lifecycle / RPC failure).
      if (decision.action === "busy-skip") {
        decision.reason = `${decision.reason} [readiness: ${readiness.reason}]`;
      }

      const now = Date.now();
      let finalStatus: ChannelInboxStatus;
      let handoffTaskId: string | null = null;

      if (decision.action === "busy-skip") {
        //  invariant: the row is NOT consumed. status stays 'received',
        // route_action / route_reason are NOT written (so it doesn't look
        // routed in inspect). Aggregate-level `busySkipped` counter signals
        // to the caller that this batch had busy-skipped rows.
        decisions.push({
          inboxId: item.id,
          providerMessageId: item.providerMessageId,
          action: decision.action,
          reason: decision.reason,
          finalStatus: "received",
          handoffTaskId: null,
        });
        continue;
      }

      if (decision.action === "process") {
        // Mark processing first so a crash mid-handoff doesn't replay it.
        this.sql`
          UPDATE channel_inbox SET status = 'processing', updated_at = ${now}
          WHERE id = ${item.id}
        `;
        let replyText = "";
        try {
          const prompt = buildTaskPromptFromInbox(item);
          const stub = await this.getAgentThursdayStub();
          const result = await stub.submitTask(prompt);
          handoffTaskId = result.taskId;
          replyText = result.replyText ?? "";
          finalStatus = "handled";
        } catch (e) {
          finalStatus = "failed";
          decision.reason = `${decision.reason} | submit failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
        }

        // auto-reply: enqueue assistant text to outbox + deliver.
        // Isolated try/catch so outbound failure does NOT unwind lifecycle;
        // inbox row stays `handled`, agent task stays `completed`. The
        // outbox row carries its own `failed` state for retry. Only attempts
        // when handoff succeeded and reply text is non-empty (tool-only
        // rounds produce no prose; that's a normal skip).
        if (finalStatus === "handled") {
          const trimmed = replyText.trim();
          if (trimmed.length === 0) {
            console.log(`[agent-thursday-channel] channel.reply.skipped-empty inboxId=${item.id} taskId=${handoffTaskId ?? "null"}`);
          } else {
            const capped = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;
            try {
              const enq = await this.enqueueOutboundText({
                provider: item.provider,
                conversationId: item.conversationId,
                replyToProviderMessageId: item.providerMessageId,
                text: capped,
              });
              if (enq.ok) {
                console.log(`[agent-thursday-channel] channel.reply.enqueued inboxId=${item.id} outboxId=${enq.outboxId} conversationId=${item.conversationId} replyTextLen=${capped.length}`);
                const dr = await this.deliverPendingOutbound(5);
                const failures = dr.deliveries.filter(d => d.finalStatus === "failed");
                if (failures.length > 0) {
                  const errPreview = (failures[0].error ?? "").slice(0, 200);
                  console.log(`[agent-thursday-channel] channel.reply.deliver-failed inboxId=${item.id} outboxId=${enq.outboxId} err=${errPreview}`);
                }
              } else {
                console.log(`[agent-thursday-channel] channel.reply.enqueue-rejected inboxId=${item.id} conversationId=${item.conversationId}`);
              }
            } catch (e) {
              const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
              console.log(`[agent-thursday-channel] channel.reply.deliver-failed inboxId=${item.id} err=${msg}`);
            }
          }
        }
      } else if (decision.action === "ignore") {
        finalStatus = "ignored";
      } else {
        // wait / escalate both park as deferred. Reason field carries the why.
        finalStatus = "deferred";
      }

      this.sql`
        UPDATE channel_inbox SET
          status = ${finalStatus},
          route_action = ${decision.action},
          route_reason = ${decision.reason},
          routed_at = ${now},
          handoff_task_id = ${handoffTaskId},
          updated_at = ${now}
        WHERE id = ${item.id}
      `;

      decisions.push({
        inboxId: item.id,
        providerMessageId: item.providerMessageId,
        action: decision.action,
        reason: decision.reason,
        finalStatus,
        handoffTaskId,
      });
    }

    const busySkipped = decisions.filter(d => d.action === "busy-skip").length;
    return { ok: true, scanned: candidates.length, busySkipped, decisions };
  }

  /**
   * replaces the old `isAgentThursdayBusy()` which incorrectly treated any
   * non-null `currentTask` STRING as busy. Returns the AgentThursdayAgent's explicit
   * `canAccept` verdict + the concrete predicate `reason` so a busy-skip
   * decision can name WHICH busy condition fired.
   *
   * Fail-closed: if the cross-DO RPC throws (Card §A-5), we report
   * `canAccept:false` so a broken AgentThursdayAgent doesn't get spammed with submits.
   */
  private async fetchAgentThursdayReadiness(): Promise<{ canAccept: boolean; reason: string }> {
    try {
      const stub = await this.getAgentThursdayStub();
      const r = await stub.getChannelIngressReadiness();
      return { canAccept: r.canAccept, reason: r.reason };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 120);
      return { canAccept: false, reason: `readiness RPC failed: ${msg}` };
    }
  }

  private async getAgentThursdayStub(): Promise<AgentThursdayAgentRPC> {
    // Cross-DO RPC: getAgentByName's generic constraint expects an `Agent`
    // subclass. We don't import AgentThursdayAgent here (would create a server.ts ⇄
    // channelHub.ts cycle), so we satisfy the constraint with the base
    // Agent<Env> type and cast the returned stub back to the structural RPC
    // shape we actually use.
    const stub = await getAgentByName<Env, Agent<Env>>(
      this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>,
      AGENT_THURSDAY_INSTANCE_NAME,
    );
    return stub as unknown as AgentThursdayAgentRPC;
  }

  private async lookupSenderRole(
    provider: ChannelProvider,
    providerUserId: string,
  ): Promise<"self" | "trusted" | "unknown"> {
    const rows = this.sql<{ role: string; is_self: number }>`
      SELECT role, is_self FROM channel_identities
      WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
      LIMIT 1
    `;
    if (rows.length === 0) return "unknown";
    if (rows[0].is_self === 1) return "self";
    if (rows[0].role === "trusted") return "trusted";
    return "unknown";
  }

  // ── outbound + approval cards ───────────────────────────────

  @callable()
  async enqueueOutboundText(input: EnqueueOutboundTextRequest): Promise<EnqueueOutboundResult> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const allowProactive = input.allowProactive === true;

    //  §D-21: proactive outbound (no reply target) is gated. Without
    // an existing conversation OR replyToProviderMessageId we treat this as
    // proactive and refuse unless caller explicitly opted in.
    if (input.replyToProviderMessageId == null && !allowProactive) {
      const known = this.sql<{ n: number }>`
        SELECT COUNT(*) as n FROM channel_conversations
        WHERE conversation_id = ${input.conversationId}
      `[0]?.n ?? 0;
      if (Number(known) === 0) {
        throw new Error("outbound:proactive-not-allowed");
      }
    }

    const payload: OutboundChannelMessage = {
      id,
      kind: "text",
      conversationId: input.conversationId,
      provider: input.provider,
      text: input.text,
      replyToProviderMessageId: input.replyToProviderMessageId ?? null,
      deliveryPolicy: { allowProactive },
    };
    const payloadJson = JSON.stringify(payload);

    this.sql`
      INSERT INTO channel_outbox (
        id, provider, conversation_id, reply_to_provider_message_id,
        text, payload_json, status, attempt_count, created_at,
        kind, approval_id
      ) VALUES (
        ${id}, ${input.provider}, ${input.conversationId}, ${input.replyToProviderMessageId ?? null},
        ${input.text}, ${payloadJson}, 'pending', 0, ${now},
        'text', NULL
      )
    `;
    return { ok: true, outboxId: id, approvalId: null };
  }

  @callable()
  async enqueueOutboundApproval(input: EnqueueOutboundApprovalRequest): Promise<EnqueueOutboundResult> {
    const now = Date.now();
    const approvalId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const expiresAt = now + (input.ttlMs ?? APPROVAL_DEFAULTS.ttlMs);
    const payloadHash = await hashApprovalPayload(input.payload);
    const alwaysAllowEnabled = this.env.AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS === "true";

    const card: ChannelApprovalCard = {
      id: approvalId,
      kind: input.approvalKind,
      title: input.title,
      warning: input.warning,
      reason: input.reason,
      payload: input.payload,
      payloadHash,
      targetToolCallId: input.targetToolCallId ?? null,
      expiresAt,
      alwaysAllowEnabled,
    };
    const out: OutboundChannelMessage = {
      id: outboxId,
      kind: "approval",
      conversationId: input.conversationId,
      provider: input.provider,
      approval: card,
      replyToProviderMessageId: input.replyToProviderMessageId ?? null,
      deliveryPolicy: { allowProactive: true, requireHumanApproval: true },
    };
    const payloadJson = JSON.stringify(out);

    this.sql`
      INSERT INTO channel_approvals (
        id, kind, title, warning, reason, payload_json, payload_hash,
        target_tool_call_id, provider, conversation_id, outbox_id,
        status, expires_at, created_at
      ) VALUES (
        ${approvalId}, ${input.approvalKind}, ${input.title}, ${input.warning}, ${input.reason},
        ${JSON.stringify(input.payload)}, ${payloadHash},
        ${input.targetToolCallId ?? null}, ${input.provider}, ${input.conversationId}, ${outboxId},
        'pending', ${expiresAt}, ${now}
      )
    `;
    this.sql`
      INSERT INTO channel_outbox (
        id, provider, conversation_id, reply_to_provider_message_id,
        text, payload_json, status, attempt_count, created_at,
        kind, approval_id
      ) VALUES (
        ${outboxId}, ${input.provider}, ${input.conversationId}, ${input.replyToProviderMessageId ?? null},
        ${`(approval card #${approvalId})`}, ${payloadJson}, 'pending', 0, ${now},
        'approval', ${approvalId}
      )
    `;
    return { ok: true, outboxId, approvalId };
  }

  @callable()
  async deliverPendingOutbound(limit: number = 10): Promise<DeliverPendingResult> {
    const cap = Math.min(Math.max(1, Math.floor(limit)), 50);
    const rows = this.sql<OutboxRow>`
      SELECT id, provider, conversation_id, reply_to_provider_message_id,
             text, payload_json, status, error, attempt_count, created_at, sent_at,
             kind, approval_id
      FROM channel_outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC LIMIT ${cap}
    `;
    if (rows.length === 0) return { ok: true, scanned: 0, bridgeMode: this.bridgeMode(), deliveries: [] };

    const bridgeUrl = this.env.AGENT_THURSDAY_OPENCLAW_BRIDGE_URL;
    const bridgeSecret = this.env.AGENT_THURSDAY_OPENCLAW_BRIDGE_SECRET;
    // bridge mode now also reflects direct Discord. Delegate to the
    // single-source-of-truth helper instead of hard-coding here.
    const bridgeMode = this.bridgeMode();

    const deliveries: DeliverPendingResult["deliveries"] = [];

    for (const row of rows) {
      const now = Date.now();
      const conv = this.sql<{ provider_channel_id: string | null; provider_thread_id: string | null }>`
        SELECT provider_channel_id, provider_thread_id FROM channel_conversations
        WHERE conversation_id = ${row.conversation_id} LIMIT 1
      `[0] ?? { provider_channel_id: null, provider_thread_id: null };

      let payload: OutboundChannelMessage;
      try {
        payload = JSON.parse(row.payload_json) as OutboundChannelMessage;
      } catch {
        const errMsg = "outbound:invalid-stored-payload";
        this.sql`
          UPDATE channel_outbox SET status = 'failed', error = ${errMsg},
            attempt_count = attempt_count + 1, sent_at = NULL
          WHERE id = ${row.id}
        `;
        deliveries.push({ outboxId: row.id, kind: rowKindToOutboundKind(row.kind), finalStatus: "failed", error: errMsg });
        continue;
      }
      const bridgePayload = buildBridgePayload(payload, {
        providerChannelId: conv.provider_channel_id,
        providerThreadId: conv.provider_thread_id,
      });

      let finalStatus: ChannelOutboxStatus = "sent";
      let errorOut: string | null = null;

      // direct Discord delivery takes precedence over OpenClaw bridge
      // when DISCORD_BOT_TOKEN is configured AND the row is for the discord
      // provider. Other providers (when they land) still go through bridge/dry-run.
      const useDirectDiscord = row.provider === "discord" && Boolean(this.env.DISCORD_BOT_TOKEN);
      const targetChannelId = conv.provider_thread_id || conv.provider_channel_id || null;

      if (useDirectDiscord) {
        if (!targetChannelId) {
          finalStatus = "failed";
          errorOut = "discord:no-target-channel-on-conversation";
        } else if (payload.kind === "text") {
          // Card §C-4: split for 2000-char limit, code-fence safe.
          const chunks = splitForDiscord2000(payload.text);
          let chunkErr: string | null = null;
          for (let i = 0; i < chunks.length; i++) {
            const body = buildDiscordTextSendBody({
              text: chunks[i],
              // Only the first chunk uses the reply reference.
              replyToProviderMessageId: i === 0 ? row.reply_to_provider_message_id : null,
            });
            const r = await sendDiscordMessage(this.env, { channelId: targetChannelId, body });
            if (!r.ok) { chunkErr = r.error; break; }
          }
          if (chunkErr !== null) {
            finalStatus = "failed";
            errorOut = chunkErr;
          }
        } else {
          // approval kind: render text fallback + native button row
          const text = renderApprovalText(payload.approval);
          const body = buildDiscordApprovalSendBody({
            text,
            card: payload.approval,
            replyToProviderMessageId: row.reply_to_provider_message_id,
          });
          const r = await sendDiscordMessage(this.env, { channelId: targetChannelId, body });
          if (!r.ok) {
            finalStatus = "failed";
            errorOut = r.error;
          }
        }
      } else if (bridgeUrl) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (bridgeSecret) headers["X-AgentThursday-Bridge-Secret"] = bridgeSecret;
          const res = await fetch(bridgeUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(bridgePayload),
          });
          if (!res.ok) {
            finalStatus = "failed";
            errorOut = sanitizeOutboundError(`bridge HTTP ${res.status}`);
          }
        } catch (e) {
          finalStatus = "failed";
          errorOut = sanitizeOutboundError(e);
        }
      } else {
        // Dry-run: log to event-style channel via console.warn; no network call
        console.log(`[agent-thursday-outbound] dry-run delivery id=${row.id} kind=${row.kind ?? "text"} payload=${JSON.stringify(bridgePayload).slice(0, 500)}`);
      }

      if (finalStatus === "sent") {
        this.sql`
          UPDATE channel_outbox SET status = 'sent', error = NULL,
            attempt_count = attempt_count + 1, sent_at = ${now}
          WHERE id = ${row.id}
        `;
      } else {
        this.sql`
          UPDATE channel_outbox SET status = 'failed', error = ${errorOut},
            attempt_count = attempt_count + 1
          WHERE id = ${row.id}
        `;
      }

      deliveries.push({
        outboxId: row.id,
        kind: rowKindToOutboundKind(row.kind),
        finalStatus,
        error: errorOut,
      });
    }

    return { ok: true, scanned: rows.length, bridgeMode, deliveries };
  }

  /**
   * Resolve an approval card from a Discord button click (or text fallback
   * the bridge translated). Single-resolution semantics: duplicate clicks
   * return the prior resolution; payload-hash mismatch invalidates;
   * expiration auto-denies. For `kind=tool` resolutions, calls the existing
   * `AgentThursdayAgent.approvePendingTool` so we do not create a parallel approval
   * authority ( §C-20).
   */
  @callable()
  async resolveApproval(input: ApprovalResolveRequest): Promise<ApprovalResolveResult> {
    const now = Date.now();
    const row = this.sql<ApprovalRow>`
      SELECT id, kind, title, warning, reason, payload_json, payload_hash,
             target_tool_call_id, provider, conversation_id, outbox_id,
             status, resolved_scope, resolved_actor, audit, expires_at, created_at, resolved_at
      FROM channel_approvals WHERE id = ${input.approvalId} LIMIT 1
    `[0];
    if (!row) {
      return {
        ok: false,
        approvalId: input.approvalId,
        status: "expired",
        effectiveScope: "deny",
        audit: "approval id not found",
        alreadyResolved: false,
        downstream: null,
      };
    }

    // Already resolved → return idempotent prior result
    if (row.status !== "pending") {
      return {
        ok: row.status !== "invalidated",
        approvalId: row.id,
        status: row.status as ChannelApprovalStatus,
        effectiveScope: (row.resolved_scope as ApprovalScope | null) ?? "deny",
        audit: row.audit ?? `already ${row.status}`,
        alreadyResolved: true,
        downstream: null,
      };
    }

    // Expiry check
    if (now > row.expires_at) {
      const audit = `expired before resolution (expires ${new Date(row.expires_at).toISOString()})`;
      this.sql`
        UPDATE channel_approvals SET status = 'expired', audit = ${audit}, resolved_at = ${now}
        WHERE id = ${row.id}
      `;
      return {
        ok: false, approvalId: row.id, status: "expired",
        effectiveScope: "deny", audit, alreadyResolved: false, downstream: null,
      };
    }

    // Payload hash check — payload mutation invalidates pending approval
    if (input.payloadHashEcho !== row.payload_hash) {
      const audit = `payload hash mismatch: expected ${row.payload_hash} got ${input.payloadHashEcho}`;
      this.sql`
        UPDATE channel_approvals SET status = 'invalidated', audit = ${audit}, resolved_at = ${now}
        WHERE id = ${row.id}
      `;
      return {
        ok: false, approvalId: row.id, status: "invalidated",
        effectiveScope: "deny", audit, alreadyResolved: false, downstream: null,
      };
    }

    // Actor authorization — only trusted identities may resolve
    const actorRole = await this.lookupSenderRole(input.actorProvider, input.actorProviderUserId);
    if (actorRole !== "trusted") {
      const audit = `actor ${input.actorProvider}:${input.actorProviderUserId} role=${actorRole} not authorized to resolve`;
      // Do NOT mark the approval as resolved on auth failure — leave pending so
      // a real authorized actor can still act.
      return {
        ok: false, approvalId: row.id, status: "pending",
        effectiveScope: "deny", audit, alreadyResolved: false, downstream: null,
      };
    }

    // Always-allow gating: downgrade if env flag is off
    const alwaysAllowEnabled = this.env.AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS === "true";
    let effectiveScope: ApprovalScope = input.scope;
    let scopeNote = "";
    if (input.scope === "always" && !alwaysAllowEnabled) {
      effectiveScope = "session";
      scopeNote = " (downgraded from `always` by policy)";
    }

    const approved = effectiveScope !== "deny";
    const newStatus: ChannelApprovalStatus = approved ? "resolved-approved" : "resolved-denied";
    const verb = approved
      ? (effectiveScope === "once" ? "Approved once" : effectiveScope === "session" ? "Approved (session)" : "Always allowed")
      : "Denied";
    const audit = `${verb} by ${input.actorProvider}:${input.actorProviderUserId}${scopeNote}`;

    this.sql`
      UPDATE channel_approvals SET
        status = ${newStatus},
        resolved_scope = ${effectiveScope},
        resolved_actor = ${`${input.actorProvider}:${input.actorProviderUserId}`},
        audit = ${audit},
        resolved_at = ${now}
      WHERE id = ${row.id}
    `;

    // Downstream side-effect —  §C-20: route tool-kind approvals
    // through the existing AgentThursdayAgent surface, do not create a parallel path.
    let downstream: ApprovalResolveResult["downstream"] = null;
    if (row.kind === "tool" && row.target_tool_call_id) {
      try {
        const stub = await this.getAgentThursdayStub();
        const r = await stub.approvePendingTool(row.target_tool_call_id, approved);
        downstream = { kind: "tool-approval", toolCallId: row.target_tool_call_id, approved, ok: r.ok };
      } catch (e) {
        downstream = {
          kind: "tool-approval", toolCallId: row.target_tool_call_id, approved, ok: false,
        };
        // Append the failure to the audit for inspection
        const newAudit = `${audit} (downstream tool-approval failed: ${sanitizeOutboundError(e)})`;
        this.sql`UPDATE channel_approvals SET audit = ${newAudit} WHERE id = ${row.id}`;
      }
    }

    return {
      ok: true,
      approvalId: row.id,
      status: newStatus,
      effectiveScope,
      audit,
      alreadyResolved: false,
      downstream,
    };
  }

  /**
   * minimal lookup used by the /discord/interactions button
   * handler to fetch the canonical payload hash for an approval, so the
   * resolve call can echo it back as `payloadHashEcho`. Returns null if the
   * approval row doesn't exist (e.g. expired and pruned in the future).
   */
  @callable()
  async lookupApprovalHash(approvalId: string): Promise<string | null> {
    const row = this.sql<{ payload_hash: string }>`
      SELECT payload_hash FROM channel_approvals WHERE id = ${approvalId} LIMIT 1
    `[0];
    return row?.payload_hash ?? null;
  }

  private bridgeMode(): "http" | "dry-run" | "discord-direct" {
    if (this.env.DISCORD_BOT_TOKEN) return "discord-direct";
    if (this.env.AGENT_THURSDAY_OPENCLAW_BRIDGE_URL) return "http";
    return "dry-run";
  }

  /**
   *  helper — set identity role so the router can promote a sender
   * from `unknown` to `trusted` (or back). Minimal seam needed to actually
   * exercise the `process` path;  will surface this in the UI.
   */
  @callable()
  async setIdentityRole(input: {
    provider: ChannelProvider;
    providerUserId: string;
    role: "trusted" | "unknown";
  }): Promise<{ ok: boolean; updated: number }> {
    // Upsert identity then update role. Mirrors ingestInbound's INSERT OR IGNORE pattern.
    const now = Date.now();
    this.sql`
      INSERT OR IGNORE INTO channel_identities (provider, provider_user_id, display_name, role, is_self, created_at)
      VALUES (${input.provider}, ${input.providerUserId}, NULL, ${input.role}, 0, ${now})
    `;
    this.sql`
      UPDATE channel_identities SET role = ${input.role}
      WHERE provider = ${input.provider} AND provider_user_id = ${input.providerUserId}
    `;
    const n = Number((this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_identities
      WHERE provider = ${input.provider} AND provider_user_id = ${input.providerUserId}
    `)[0]?.n ?? 0);
    return { ok: true, updated: n };
  }

  @callable()
  async getSnapshot(): Promise<ChannelSnapshot> {
    const inboxCounts = this.sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) as n FROM channel_inbox GROUP BY status
    `;
    const inbox = { received: 0, routed: 0, processing: 0, handled: 0, ignored: 0, deferred: 0, failed: 0 } as Record<string, number>;
    for (const r of inboxCounts) if (r.status in inbox) inbox[r.status] = Number(r.n);

    const outboxCounts = this.sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) as n FROM channel_outbox GROUP BY status
    `;
    const outbox = { pending: 0, sent: 0, failed: 0, cancelled: 0 } as Record<string, number>;
    for (const r of outboxCounts) if (r.status in outbox) outbox[r.status] = Number(r.n);

    const conversations = Number((this.sql<{ n: number }>`SELECT COUNT(*) as n FROM channel_conversations`)[0]?.n ?? 0);
    const identities = Number((this.sql<{ n: number }>`SELECT COUNT(*) as n FROM channel_identities`)[0]?.n ?? 0);

    const approvalCounts = this.sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) as n FROM channel_approvals GROUP BY status
    `;
    const approvals = {
      pending: 0,
      "resolved-approved": 0,
      "resolved-denied": 0,
      expired: 0,
      invalidated: 0,
    } as Record<string, number>;
    for (const r of approvalCounts) if (r.status in approvals) approvals[r.status] = Number(r.n);

    const recentInboxRows = this.sql<InboxRow>`
      SELECT id, provider, conversation_id, provider_message_id, sender_provider_user_id,
             chat_type, addressed_to_agent, addressed_signals_json,
             text, attachments_json, raw_ref, status, created_at, updated_at,
             route_action, route_reason, routed_at, handoff_task_id
      FROM channel_inbox
      ORDER BY created_at DESC LIMIT 10
    `;
    const recentInbox: ChannelInboxItem[] = recentInboxRows.map((r) => rowToInboxItem(r));

    const recentOutboxRows = this.sql<OutboxRow>`
      SELECT id, provider, conversation_id, reply_to_provider_message_id,
             text, payload_json, status, error, attempt_count, created_at, sent_at,
             kind, approval_id
      FROM channel_outbox
      ORDER BY created_at DESC LIMIT 10
    `;
    const recentOutbox: ChannelOutboxItem[] = recentOutboxRows.map((r) => ({
      id: r.id,
      provider: r.provider as ChannelProvider,
      conversationId: r.conversation_id,
      replyToProviderMessageId: r.reply_to_provider_message_id,
      text: r.text,
      status: r.status as ChannelOutboxStatus,
      error: r.error,
      attemptCount: r.attempt_count,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      kind: rowKindToOutboundKind(r.kind),
      approvalId: r.approval_id,
    }));

    const recentApprovalRows = this.sql<ApprovalRow>`
      SELECT id, kind, title, warning, reason, payload_json, payload_hash,
             target_tool_call_id, provider, conversation_id, outbox_id,
             status, resolved_scope, resolved_actor, audit, expires_at, created_at, resolved_at
      FROM channel_approvals
      ORDER BY created_at DESC LIMIT 10
    `;
    const recentApprovals: ChannelApprovalRow[] = recentApprovalRows.map((r) => ({
      id: r.id,
      kind: r.kind as ChannelApprovalRow["kind"],
      title: r.title,
      warning: r.warning as ChannelApprovalRow["warning"],
      reason: r.reason,
      status: r.status as ChannelApprovalRow["status"],
      effectiveScope: (r.resolved_scope as ChannelApprovalRow["effectiveScope"]) ?? null,
      resolvedActor: r.resolved_actor,
      audit: r.audit,
      payloadPreview: r.payload_json.length > 300 ? `${r.payload_json.slice(0, 300)}…` : r.payload_json,
      payloadHash: r.payload_hash,
      targetToolCallId: r.target_tool_call_id,
      conversationId: r.conversation_id,
      provider: r.provider as ChannelProvider,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
    }));

    return {
      counts: {
        inbox: inbox as ChannelSnapshot["counts"]["inbox"],
        outbox: outbox as ChannelSnapshot["counts"]["outbox"],
        approvals: approvals as ChannelSnapshot["counts"]["approvals"],
        conversations,
        identities,
      },
      recentInbox,
      recentOutbox,
      recentApprovals,
    };
  }

  /**
   * compact, leak-safe counts for the default user-layer panel.
   * No row data, no ids, no payloads — just what the user needs to see.
   */
  @callable()
  async getCompactSummary(): Promise<ChannelCompactSummary> {
    const inboxAddressedPending = Number((this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_inbox
      WHERE status = 'received' AND addressed_to_agent = 1
    `)[0]?.n ?? 0);
    const outboxPending = Number((this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_outbox WHERE status = 'pending'
    `)[0]?.n ?? 0);
    const approvalsPending = Number((this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_approvals WHERE status = 'pending'
    `)[0]?.n ?? 0);
    const lastInboundRow = this.sql<{ created_at: number }>`
      SELECT created_at FROM channel_inbox ORDER BY created_at DESC LIMIT 1
    `;
    const lastInboundAt = lastInboundRow[0]?.created_at ?? null;
    const conversations = Number((this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_conversations
    `)[0]?.n ?? 0);
    return { inboxAddressedPending, outboxPending, approvalsPending, lastInboundAt, conversations };
  }
}

function safeParseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToInboxItem(r: InboxRow): ChannelInboxItem {
  return {
    id: r.id,
    provider: r.provider as ChannelProvider,
    conversationId: r.conversation_id,
    providerMessageId: r.provider_message_id,
    senderProviderUserId: r.sender_provider_user_id,
    chatType: r.chat_type as ChannelChatType,
    addressedToAgent: r.addressed_to_agent === 1,
    addressedSignals: safeParseArray<string>(r.addressed_signals_json),
    text: r.text,
    attachments: safeParseArray<ChannelAttachment>(r.attachments_json),
    rawRef: r.raw_ref,
    status: r.status as ChannelInboxStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    routeAction: (r.route_action as ChannelInboxItem["routeAction"]) ?? null,
    routeReason: r.route_reason,
    routedAt: r.routed_at,
    handoffTaskId: r.handoff_task_id,
  };
}
