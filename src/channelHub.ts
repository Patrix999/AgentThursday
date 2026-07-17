/**
 * `ChannelHubAgent` Durable Object.
 *
 * Owns inbox / outbox / identity / conversation tables. Provider-agnostic.
 * No Discord/email adapter wiring in this card — only schema, storage, and
 * idempotent ingestion. an earlier revision+ wire actual transports.
 *
 * Boundary rationale (review notes §1): kept as its own DO from day 1
 * so AgentThursdayAgent's event_log isn't shared with channel events, and webhook
 * traffic patterns can scale independently of agent task patterns.
 */

import { Agent, getAgentByName, unstable_callable as callable, type AgentNamespace } from "agents";
import {
  type ChannelInboundResult,
  type ChannelInboxItem,
  type ChannelInboxStatus,
  type ChannelOutboxItem,
  type ChannelOutboxStatus,
  type ChannelSnapshot,
  type ChannelProvider,
  type ChannelRouteDecision,
  type ChannelApprovalStatus,
  type ApprovalScope,
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
import { decideRoute, buildTaskPromptFromInbox, buildDisplayTextFromInbox } from "./channelRouter";
import {
  buildBridgePayload,
  sanitizeOutboundError,
  rowKindToOutboundKind,
} from "./channelOutbound";
import {
  splitForDiscord2000,
  buildDiscordTextSendBody,
  buildDiscordApprovalSendBody,
  stripDiscordVisibleInternalMarkers,
} from "./discordDirect";
import { sendDiscordMessage } from "./discordSender";
import { renderApprovalText } from "./channelOutbound";
import {
  redactApprovalRow,
  verifyApprovalToken,
  type ApprovalInspectRow,
  type ApprovalRecord,
  type ApprovalStatus,
} from "./skillset/approvalToken";
import {
  createApprovalRequestImpl,
  decideApprovalImpl,
  consumeApprovalTokenImpl,
  lookupApprovalHashImpl,
  type ApprovalHmacEnv,
  type CreateApprovalRequestInput,
  type CreateApprovalRequestResult,
  type DecideApprovalInput,
  type DecideApprovalResult,
  type ConsumeApprovalTokenInput,
  type ConsumeApprovalTokenResult,
} from "./channelHub/approvalOps";
import {
  APPLY_TOOL_ID,
  ARTIFACT_ID_RE,
  computeApplyInputHash,
  parseUnifiedDiffTargets,
} from "./skillset/patchPolicy";
import { getSandbox } from "@cloudflare/sandbox";
import { ensureRepoCheckout, REPO_BASE_DIR } from "./skillset/repoMaterialization";
import type { Tier } from "./skillset/types";
import { renderReadIntentNoExecutionReply } from "./replyEmptyFallback";
import { ensureChannelHubSchema } from "./channelHub/schema";
import {
  type InboxRow,
  type PatchArtifactInspectRow,
  type PatchApplyEventInspectRow,
  type PatchApplyOutboxInspectRow,
  rowToInboxItem,
  safeParseArray,
} from "./channelHub/mappers";
import {
  proposePatchArtifactImpl,
  inspectPatchArtifactsImpl,
} from "./channelHub/patchArtifacts";
import {
  inspectChannelInboxImpl,
  type ChannelInboxInspectRow,
  type InspectChannelInboxInput,
} from "./channelHub/inboxInspect";
import {
  inspectConversationOwnershipImpl,
  type InspectConversationOwnershipInput,
  type InspectConversationOwnershipResult,
} from "./channelHub/conversationOwnership";
import {
  inspectPatchApplyEventsImpl,
  inspectPatchApplyOutboxImpl,
  getLatestPatchApplyOutboxSummaryImpl,
  type LatestPatchApplyOutboxSummary,
} from "./channelHub/patchApply";
import { ingestInboundImpl } from "./channelHub/inbound";
import {
  resolveChannelAgentRoute,
  type ResolveChannelAgentRouteResult,
} from "./channelHub/resolveChannelAgentRoute";
import {
  tryIngestContinuationImpl,
  type TryIngestContinuationInput,
  type TryIngestContinuationResult,
} from "./channelHub/continuation";
import {
  enqueueOutboundApprovalImpl,
  enqueueOutboundTextImpl,
} from "./channelHub/outbound";

// AgentThursdayAgent is RPC'd cross-DO. Use a structural type so the import doesn't
// pull the full Think class graph into channelHub.ts.
type AgentThursdayAgentRPC = {
  getStatus(): Promise<{
    currentTask: string | null;
    waitingForHuman: boolean;
    currentObstacle: { blocked: boolean } | null;
  }>;
  submitTask(
    task: string,
    opts?: { displayText?: string },
  ): Promise<{ ok: boolean; taskId: string; loopTriggered: boolean; replyText: string }>;
  approvePendingTool(toolCallId: string, approved: boolean): Promise<{ ok: boolean }>;
  // explicit channel-ingress readiness predicate.
  getChannelIngressReadiness(): Promise<{
    canAccept: boolean;
    reason: string;
    currentTaskId: string | null;
    currentTaskLifecycle: string | null;
  }>;
  // registry pointer accessor (only invoked on the
  // registry DO; safe shape so the RPC compiles in this file).
  getActiveContextId(): Promise<{
    contextId: string;
    reason: string | null;
    createdAt: number;
  }>;
  // registry-DO profile read so ChannelHub can validate a
  // `channel_conversations.active_profile_id` at set-time and
  // route-time. Shape mirrors `AgentProfile` (see `src/schema/agent.ts`)
  // but is typed structurally so this file doesn't pull the full
  // server.ts graph. Only invoked on the registry DO.
  readAgentProfile(id: string): Promise<{
    id: string;
    name: string;
    model: string;
    channel: string;
    skillset: string;
    persona: string;
    // an earlier revision lifecycle v2 — persisted enum:
    // `initialized` (active, may be paused via accepts_tasks=false),
    // `archived` (reversible removal), `deleted_marker` (audit tombstone).
    // See `docs/adr/2026-05-26-agent-lifecycle-product-contract.md`.
    status: "initialized" | "archived" | "deleted_marker";
    created_at: string;
    updated_at: string;
  } | null>;
};

// `AGENT_THURSDAY_REGISTRY_INSTANCE_NAME` (was `AGENT_THURSDAY_INSTANCE_NAME`)
// is the registry DO that owns `context_active`. It is **not** the
// default chat target anymore; ChannelHub looks up the canonical
// active context via `getActiveContextId()` on this registry and
// routes inbound messages there. Falls back to the registry only
// when the active pointer is empty or RPC fails.
// constant extracted to ./channelHub/registryName so the
// Discord gateway DO can share it; re-exported import keeps all
// existing references in this file working unchanged.
import { AGENT_THURSDAY_REGISTRY_INSTANCE_NAME } from "./channelHub/registryName";

// DiscordGatewayAgent DO instance name. Match the literal
// in `discordGatewayAgent.ts` (`DISCORD_GATEWAY_INSTANCE`); we don't
// import it here to avoid pulling the full Discord types into ChannelHub.
const GATEWAY_INSTANCE_FOR_POLL = "agentthursday-dev";

// recognise DO isolate memory-pressure errors so
// `routePending` can leave the inbox row retryable (`received`) instead
// of permanently consuming it as `failed`. The CF runtime surfaces these
// resets in a few different shapes depending on which RPC layer caught
// them; match the common ones.
function isMemoryResetError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("exceeded its memory limit")
    || (m.includes("isolate") && m.includes("reset"))
    || m.includes("durable object reset")
    || m.includes("memory limit")
  );
}

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

// read-only outbox inspect surface row shape.
// Verifier-facing only; never includes provider tokens, raw payload JSON
// (which can contain auth headers), or any secret material.
export type ChannelOutboxInspectRow = {
  outbox_id: string;
  provider: string;
  conversation_id: string;
  reply_to_provider_message_id: string | null;
  status: string;
  kind: string | null;
  approval_id: string | null;
  attempt_count: number;
  created_at: number;
  sent_at: number | null;
  body_length: number;
  body_preview: string;
  envelope_markers: string[];
  has_error: boolean;
  error_preview: string | null;
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

    // schema/migration setup extracted to
    // `./channelHub/schema.ts`. Behavior preserved verbatim (additive,
    // idempotent DDL + column-migration block). The Discord bot id is
    // read from env here and passed in because `env` is `protected` on
    // the Agent base class.
    const agentthursdayDiscordBotId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID;
    ensureChannelHubSchema(this, agentthursdayDiscordBotId);
  }

  /**
   * Idempotent inbound persist. an earlier revision §E-15:
   *  - first insert → `{ inserted: true, id }`
   *  - duplicate `(provider, provider_message_id)` → `{ inserted: false, id }`
   *  - per-conversation pending cap exceeded → status `deferred`
   */
  @callable()
  async ingestInbound(envelopeRaw: unknown): Promise<ChannelInboundResult> {
    // body extracted to `./channelHub/inbound.ts`. `env` is
    // `protected`, so the call site reads `AGENT_THURSDAY_DISCORD_BOT_ID` and
    // passes it in. Behavior preserved verbatim.
    const agentthursdayDiscordBotId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID;
    return ingestInboundImpl(this, envelopeRaw, agentthursdayDiscordBotId);
  }

  /**
   * try to merge a non-addressed message into a recent
   * addressed-to-agent anchor row from the same sender/conversation.
   *
   * Called by `/api/channel/discord/direct` when `applyDirectFilters`
   * rejects with reason `"guild message without @mention"`. If a recent
   * anchor is still `status='received'`, the continuation chunk's text
   * is appended to the anchor (so `routePending` builds a single merged
   * prompt for `submitTask`) and a marker inbox row is persisted with
   * `status='ignored'` + `route_action='merged'` for audit + idempotency.
   * If no anchor exists, this returns `merged:false` and the caller is
   * expected to keep the original ignore behaviour (status quo).
   */
  @callable()
  async tryIngestContinuation(input: TryIngestContinuationInput): Promise<TryIngestContinuationResult> {
    return tryIngestContinuationImpl(this, input);
  }

  /**
   * Route up to `limit` pending `received` inbox rows. an earlier revision §B + an earlier revision §B.
   * For `process` action, RPCs AgentThursdayAgent.submitTask. Active-task guard runs
   * via `AgentThursdayAgent.getStatus()` before any submit so we never overwrite work.
   * an earlier revision: when the guard fires on an addressed/trusted row, the decision
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
      action: ChannelRouteDecision["action"] | "invalid-binding";
      reason: string;
      finalStatus: ChannelInboxStatus;
      handoffTaskId: string | null;
      targetKind: ResolveChannelAgentRouteResult["kind"];
      targetName: string | null;
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

    // per-row routing. Behavior change from an earlier revision's
    // single batch-level route:
    //
    //  - Resolve canonical active context ONCE per batch (the unbound
    //    fallback target).
    //  - For each candidate, read `channel_conversations.active_profile_id`
    //    and run `resolveChannelAgentRoute(...)` against a per-batch
    //    profile validation cache (so the registry DO is RPC'd at most
    //    once per distinct profile_id in the batch).
    //  - Per-target cache `Map<resolvedDoName, {stub, readiness}>` so
    //    an earlier revision's invariant — "readiness check and submit hit the
    //    same DO" — is preserved per row instead of per batch. Two rows
    //    bound to different profiles each get their own readiness.
    //  - Rows with `invalid_binding` (missing / archived / RPC-failed
    //    validation) MUST NOT fall back to active context — that would
    //    silently route to the wrong agent and defeat the binding
    //    contract. Park them as `deferred` with action `invalid-binding`
    //    and a structured reason so operators can correct or clear.
    const fallbackRoute = await this.getAgentThursdayRoute();

    type TargetEntry = {
      stub: AgentThursdayAgentRPC;
      name: string;
      readiness: { canAccept: boolean; reason: string };
    };
    const targetCache = new Map<string, TargetEntry>();
    // `AgentValidation` is the corrected name (was
    // `ProfileValidation`). Backing registry RPC is still
    // `readAgentProfile` (legacy persistence callable; the row IS the
    // agent record). See docs/design/2026-05-24-m9.0-agent-centric-correction.md.
    // status enum widened; accept any valid DB value.
    type AgentValidation = { exists: boolean; status: string | null } | null;
    const agentCache = new Map<string, AgentValidation>();

    const resolveTarget = async (resolvedName: string): Promise<TargetEntry> => {
      const cached = targetCache.get(resolvedName);
      if (cached) return cached;
      let stub: AgentThursdayAgentRPC;
      if (resolvedName === fallbackRoute.name) {
        stub = fallbackRoute.stub;
      } else {
        const ns = this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>;
        stub = (await getAgentByName<Env, Agent<Env>>(ns, resolvedName)) as unknown as AgentThursdayAgentRPC;
      }
      const readiness = await this.fetchAgentThursdayReadinessVia(stub);
      const entry: TargetEntry = { stub, name: resolvedName, readiness };
      targetCache.set(resolvedName, entry);
      return entry;
    };

    const validateAgent = async (agentId: string): Promise<AgentValidation> => {
      if (agentCache.has(agentId)) return agentCache.get(agentId) ?? null;
      let validation: AgentValidation;
      try {
        const ns = this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>;
        const registry = await getAgentByName<Env, Agent<Env>>(ns, AGENT_THURSDAY_REGISTRY_INSTANCE_NAME);
        const agent = await (registry as unknown as AgentThursdayAgentRPC).readAgentProfile(agentId);
        validation = agent === null
          ? { exists: false, status: null }
          : { exists: true, status: agent.status };
      } catch {
        // Validation unavailable — resolver will return `invalid_binding`
        // with reason `invalid_binding:agent:<id>:validation_unavailable`,
        // NOT silently fall back.
        validation = null;
      }
      agentCache.set(agentId, validation);
      return validation;
    };

    const decisions: Array<{
      inboxId: string;
      providerMessageId: string;
      action: ChannelRouteDecision["action"] | "invalid-binding";
      reason: string;
      finalStatus: ChannelInboxStatus;
      handoffTaskId: string | null;
      targetKind: ResolveChannelAgentRouteResult["kind"];
      targetName: string | null;
    }> = [];

    for (const raw of candidates) {
      const item = rowToInboxItem(raw);
      // P0 sender role: anything we've seen tagged via channel_identities is
      // still "unknown" until a future card explicitly trusts. The router
      // converts unknown + addressed → wait, which is the safe default.
      const role = await this.lookupSenderRole(item.provider, item.senderProviderUserId);

      // per-row route resolution. Column name
      // `active_profile_id` is legacy storage (an earlier revision §compat); the
      // value it holds IS the agent_id used as the DO routing key.
      const bindingRow = this.sql<{ active_profile_id: string | null }>`
        SELECT active_profile_id FROM channel_conversations
        WHERE conversation_id = ${item.conversationId} LIMIT 1
      `;
      const activeAgentIdRaw = bindingRow[0]?.active_profile_id ?? null;
      const agentValidation = activeAgentIdRaw !== null && activeAgentIdRaw.length > 0
        ? await validateAgent(activeAgentIdRaw)
        : null;
      const resolved = resolveChannelAgentRoute({
        conversationBinding: { activeAgentId: activeAgentIdRaw },
        agentValidation,
        activeContextId: fallbackRoute.name,
      });

      if (resolved.kind === "invalid_binding") {
        const now = Date.now();
        // resolver already produces a self-describing reason
        // string `invalid_binding:agent:<agentId>:<cause>`; persist as-is.
        const reason = resolved.reason;
        this.sql`
          UPDATE channel_inbox SET
            status = 'deferred',
            route_action = 'invalid-binding',
            route_reason = ${reason},
            routed_at = ${now},
            handoff_task_id = NULL,
            updated_at = ${now}
          WHERE id = ${item.id}
        `;
        decisions.push({
          inboxId: item.id,
          providerMessageId: item.providerMessageId,
          action: "invalid-binding",
          reason,
          finalStatus: "deferred",
          handoffTaskId: null,
          targetKind: resolved.kind,
          targetName: null,
        });
        continue;
      }

      // `target.name` is the DO name we'll readiness-check AND
      // submit against. For unbound rows that's the canonical active
      // context (preserves an earlier revision behavior). For bound rows it's
      // the agent_id itself, matching `AgentRunWorkflow.step.do`.
      const target = await resolveTarget(resolved.targetName);
      const agentthursdayBusy = !target.readiness.canAccept;
      const decision = decideRoute(item, { activeTaskBusy: agentthursdayBusy, senderRole: role });
      // when the policy fired busy-skip, append the concrete
      // readiness reason so operators can see WHICH busy condition won
      // (waitingForHuman / blocked / active task lifecycle / RPC failure).
      if (decision.action === "busy-skip") {
        decision.reason = `${decision.reason} [readiness: ${target.readiness.reason}]`;
      }

      const now = Date.now();
      let finalStatus: ChannelInboxStatus;
      let handoffTaskId: string | null = null;

      if (decision.action === "busy-skip") {
        // an earlier revision invariant: the row is NOT consumed. status stays 'received',
        // route_action / route_reason are NOT written (so it doesn't look
        // routed in inspect). Aggregate-level `busySkipped` counter signals
        // to the caller that this batch had busy-skipped rows. an earlier revision
        // note: busy-skip is per-TARGET — profile A busy must not block
        // a row bound to profile B.
        decisions.push({
          inboxId: item.id,
          providerMessageId: item.providerMessageId,
          action: decision.action,
          reason: decision.reason,
          finalStatus: "received",
          handoffTaskId: null,
          targetKind: resolved.kind,
          targetName: target.name,
        });
        continue;
      }

      if (decision.action === "process") {
        // Mark processing first so a crash mid-handoff doesn't replay it.
        this.sql`
          UPDATE channel_inbox SET status = 'processing', updated_at = ${now}
          WHERE id = ${item.id}
        `;
        // re-read text + addressed_signals_json from SQL
        // immediately after the row is locked into `processing`. The
        // `candidates` array was captured before the `await readiness`
        // RPC yielded, so a continuation chunk that merged into this
        // row's text *during* the yield would otherwise be missed when
        // `buildTaskPromptFromInbox` runs on the stale snapshot.
        const fresh = this.sql<{ text: string; addressed_signals_json: string }>`
          SELECT text, addressed_signals_json FROM channel_inbox WHERE id = ${item.id} LIMIT 1
        `;
        if (fresh.length > 0) {
          item.text = fresh[0].text ?? item.text;
          try {
            const reparsed = JSON.parse(fresh[0].addressed_signals_json ?? "[]");
            if (Array.isArray(reparsed)) item.addressedSignals = reparsed.map(String);
          } catch {
            // keep the snapshot signals if the column is malformed
          }
        }
        let replyText = "";
        try {
          const prompt = buildTaskPromptFromInbox(item);
          const display = buildDisplayTextFromInbox(item);
          // submit on the SAME route the readiness check
          // ran against. an earlier revision: `target` is per-row resolved, so
          // this invariant now applies per row, not per batch.
          // pass `displayText` so the YOU line in the
          // Web/mobile dialog shows the user's raw text without
          // channel metadata or safety suffix; agent still gets the
          // full `prompt` for routing/safety context.
          const result = await target.stub.submitTask(prompt, { displayText: display });
          handoffTaskId = result.taskId;
          replyText = result.replyText ?? "";
          finalStatus = "handled";
        } catch (e) {
          const errMsg = String(e instanceof Error ? e.message : e);
          // fail-soft on DO isolate memory resets, with
          // _real_ retry semantics. (156q parked rows as `deferred`
          // but `routePending` only scans `received`, so the row was
          // effectively orphaned — same outcome the user reported.)
          //
          // Behavior: revert the `processing` mark back to `received`,
          // record a marker in `route_reason`, and `continue` so the
          // shared post-process UPDATE that writes `route_action` /
          // `routed_at` does NOT consume the row. Next `routePending`
          // pass picks it up naturally.
          //
          // Duplicate-submit guard: if the previous submit had partially
          // succeeded (agent already running the task), the next pass's
          // `getChannelIngressReadiness()` will return canAccept=false
          // and the row enters busy-skip, NOT a second submit. So no
          // explicit retry counter is needed for that race.
          if (isMemoryResetError(errMsg)) {
            const marker = `memory-reset retryable: ${errMsg.slice(0, 200)}`;
            this.sql`
              UPDATE channel_inbox SET
                status = 'received',
                route_reason = ${marker},
                updated_at = ${Date.now()}
              WHERE id = ${item.id}
            `;
            decisions.push({
              inboxId: item.id,
              providerMessageId: item.providerMessageId,
              action: decision.action,
              reason: marker,
              finalStatus: "received",
              handoffTaskId: null,
              targetKind: resolved.kind,
              targetName: target.name,
            });
            continue;
          } else {
            finalStatus = "failed";
            decision.reason = `${decision.reason} | submit failed: ${errMsg.slice(0, 200)}`;
          }
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
            console.log(`[agentthursday-channel] channel.reply.skipped-empty inboxId=${item.id} taskId=${handoffTaskId ?? "null"}`);
          } else {
            const capped = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;
            // DM channels reject `message_reference.message_id`
            // pointing at the inbound DM (`MESSAGE_REFERENCE_UNKNOWN_MESSAGE`
            // 50035). Don't carry a reply_to into the outbox row at all
            // for DMs — guild channels keep the existing reply behaviour.
            // Defensive guard in `deliverPendingOutbound` re-checks
            // `chat_type` so even an old / proactive row that still has
            // `reply_to_provider_message_id` set can't slip through.
            const replyToForOutbox = item.chatType === "dm" ? null : item.providerMessageId;
            try {
              const enq = await this.enqueueOutboundText({
                provider: item.provider,
                conversationId: item.conversationId,
                replyToProviderMessageId: replyToForOutbox,
                text: capped,
              });
              if (enq.ok) {
                console.log(`[agentthursday-channel] channel.reply.enqueued inboxId=${item.id} outboxId=${enq.outboxId} conversationId=${item.conversationId} replyTextLen=${capped.length}`);
                const dr = await this.deliverPendingOutbound(5);
                const failures = dr.deliveries.filter(d => d.finalStatus === "failed");
                if (failures.length > 0) {
                  const errPreview = (failures[0].error ?? "").slice(0, 200);
                  console.log(`[agentthursday-channel] channel.reply.deliver-failed inboxId=${item.id} outboxId=${enq.outboxId} err=${errPreview}`);
                }
              } else {
                console.log(`[agentthursday-channel] channel.reply.enqueue-rejected inboxId=${item.id} conversationId=${item.conversationId}`);
              }
            } catch (e) {
              const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
              console.log(`[agentthursday-channel] channel.reply.deliver-failed inboxId=${item.id} err=${msg}`);
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
        targetKind: resolved.kind,
        targetName: target.name,
      });
    }

    const busySkipped = decisions.filter(d => d.action === "busy-skip").length;
    return { ok: true, scanned: candidates.length, busySkipped, decisions };
  }

  /**
   * readiness against an already-resolved stub. Used by
   * `routePending` so the readiness check and the per-item submit
   * share a single resolved route (no double active-pointer lookup,
   * no race window).
   */
  private async fetchAgentThursdayReadinessVia(stub: AgentThursdayAgentRPC): Promise<{ canAccept: boolean; reason: string }> {
    try {
      const r = await stub.getChannelIngressReadiness();
      return { canAccept: r.canAccept, reason: r.reason };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 120);
      return { canAccept: false, reason: `readiness RPC failed: ${msg}` };
    }
  }

  /**
   * paired `{ name, stub }` for whichever AgentThursdayAgent
   * instance currently owns the canonical active context.
   *
   * Resolution order:
   *   1. RPC the registry DO (`AGENT_THURSDAY_REGISTRY_INSTANCE_NAME`) for
   *      `getActiveContextId()`.
   *   2. If a non-empty `contextId` comes back, route to that instance.
   *   3. Otherwise — registry RPC failed or pointer empty — fall back
   *      to the registry instance itself (bootstrap path).
   *
   * Returning `{ name, stub }` paired means callers can guarantee
   * "readiness query and submit hit the same DO" without re-resolving;
   * the previous code path looked the registry up twice and the
   * pointer could in principle race between calls.
   *
   * Recursion-safe: the registry lookup uses the registry instance
   * name directly; it never reads from itself via the active pointer.
   */
  private async getAgentThursdayRoute(): Promise<{ name: string; stub: AgentThursdayAgentRPC }> {
    // Cross-DO RPC: getAgentByName's generic constraint expects an `Agent`
    // subclass. We don't import AgentThursdayAgent here (would create a server.ts ⇄
    // channelHub.ts cycle), so we satisfy the constraint with the base
    // Agent<Env> type and cast the returned stub back to the structural RPC
    // shape we actually use.
    const ns = this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>;
    let resolved = AGENT_THURSDAY_REGISTRY_INSTANCE_NAME;
    try {
      const registry = await getAgentByName<Env, Agent<Env>>(ns, AGENT_THURSDAY_REGISTRY_INSTANCE_NAME);
      const active = await (registry as unknown as AgentThursdayAgentRPC).getActiveContextId();
      if (
        typeof active.contextId === "string"
        && active.contextId.length > 0
        && active.contextId.length <= 200
      ) {
        resolved = active.contextId;
      }
    } catch {
      // Registry unreachable — keep `resolved = AGENT_THURSDAY_REGISTRY_INSTANCE_NAME`
      // so the bootstrap / fallback path still routes somewhere.
    }
    const stub = await getAgentByName<Env, Agent<Env>>(ns, resolved);
    return { name: resolved, stub: stub as unknown as AgentThursdayAgentRPC };
  }

  /**
   * single-stub convenience for callers that don't need
   * to know the resolved name. Routes via `getAgentThursdayRoute()` so it
   * always follows the canonical active context. Replaces the
   * previous hardcoded-DEMO_INSTANCE behavior.
   */
  private async getAgentThursdayStub(): Promise<AgentThursdayAgentRPC> {
    const { stub } = await this.getAgentThursdayRoute();
    return stub;
  }

  /**
   * pick the send credentials for a Discord channel. When a
   * runtime-configured bot (registry `discord_bot` table) owns the
   * channel, its token is used; otherwise the env bot. Fail-soft: any
   * registry error falls back to env so existing delivery never breaks.
   */
  private async _resolveDiscordSendEnv(
    channelId: string,
  ): Promise<{ DISCORD_BOT_TOKEN?: string; DISCORD_API_BASE_URL?: string }> {
    try {
      const ns = this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>;
      const registry = await getAgentByName<Env, Agent<Env>>(ns, AGENT_THURSDAY_REGISTRY_INSTANCE_NAME);
      const bots = await (registry as unknown as {
        getDiscordBotsSecret(): Promise<Array<{ bot_id: string; token: string; allowed_channels: string[] }>>;
      }).getDiscordBotsSecret();
      const owner = bots.find((b) => b.allowed_channels.includes(channelId));
      if (owner) {
        return {
          DISCORD_BOT_TOKEN: owner.token,
          DISCORD_API_BASE_URL: (this.env as { DISCORD_API_BASE_URL?: string }).DISCORD_API_BASE_URL,
        };
      }
    } catch { /* fall through to env */ }
    return this.env as { DISCORD_BOT_TOKEN?: string; DISCORD_API_BASE_URL?: string };
  }

  /**
   * fire-and-forget post-reply nudge to the gateway DO so
   * polling-mode ingress runs an immediate sweep on the channel we
   * just replied into. The gateway DO's `pollChannelOnce` is a no-op
   * when ingress mode != polling, so this is safe to call without
   * checking mode at the call site (we don't want every send path
   * to re-derive mode).
   *
   * Cross-DO RPC failure must NOT unwind outbox lifecycle — the
   * caller already wrote `status='sent'`. Errors are swallowed; the
   * regular polling tick still catches up at the next cadence.
   */
  private maybePostReplyPoll(channelId: string): void {
    const ns = this.env.DiscordGatewayAgent as unknown as AgentNamespace<Agent<Env>>;
    if (!ns) return;
    void (async () => {
      try {
        const stub = await getAgentByName<Env, Agent<Env>>(ns, GATEWAY_INSTANCE_FOR_POLL);
        const rpc = stub as unknown as { pollChannelOnce(id: string): Promise<unknown> };
        await rpc.pollChannelOnce(channelId);
      } catch {
        // No-op — the next scheduled tick will sweep this channel.
      }
    })();
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
    // body extracted to `./channelHub/outbound.ts`. Pure
    // SQL + JSON; no env access. Behavior preserved verbatim.
    return enqueueOutboundTextImpl(this, input);
  }

  @callable()
  async enqueueOutboundApproval(input: EnqueueOutboundApprovalRequest): Promise<EnqueueOutboundResult> {
    // body extracted to `./channelHub/outbound.ts`. `env`
    // is `protected`, so the call site reads `AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS`
    // and passes the resolved boolean in. Behavior preserved verbatim.
    const alwaysAllowEnabled = this.env.AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS === "true";
    return enqueueOutboundApprovalImpl(this, input, alwaysAllowEnabled);
  }

  /**
   * sweeper-issued fallback reply. When the agent-side
   * envelope sweeper finalizes a draft because the original
   * saveMessages never returned, the LLM's intended reply text was
   * never generated, so the round would otherwise leave the
   * conversation hanging without the `[envelope: env-...]` marker
   * the demo contract requires.
   *
   * This RPC enqueues a clearly-labeled fallback outbox row reusing
   * the channel/message context of the original inbound message
   * (looked up by `handoff_task_id`, with a bounded recency
   * fallback when the inbox row never recorded the task id because
   * submitTask hung before returning). Fail-soft + idempotent: a
   * duplicate call for the same envelope detects the existing
   * outbox row by marker text and skips re-enqueue.
   *
   * Wording is deliberately distinct from any LLM reply pattern so
   * verifier and humans can tell at a glance this is a system-issued
   * fallback, not a model output.
   */
  @callable()
  async enqueueFallbackReplyForTask(input: {
    taskId: string;
    envelopeId: string;
    /**
     * when present, lets the fallback prefer a specific
     * recovery message body instead of the generic "未正常完成" line.
     * Currently switches text only when value is
     * `"read_intent_no_execution"`; other reasons (or undefined) keep
     * the original system-fallback wording.
     */
    verdictReason?: string;
  }): Promise<{
    ok: boolean;
    outboxId?: string;
    reason?: string;
  }> {
    if (!input?.taskId || !input?.envelopeId) {
      return { ok: false, reason: "missing_input" };
    }
    type InboxLookup = {
      id: string;
      provider: string;
      conversation_id: string;
      provider_message_id: string;
      created_at: number;
    };
    let row: InboxLookup | null = null;
    try {
      const direct = this.sql<InboxLookup>`
        SELECT id, provider, conversation_id, provider_message_id, created_at
          FROM channel_inbox
         WHERE handoff_task_id = ${input.taskId}
         ORDER BY created_at DESC LIMIT 1
      `;
      if (direct.length > 0) row = direct[0];
    } catch { /* fail-soft */ }
    if (!row) {
      // submitTask may have hung BEFORE ChannelHub wrote handoff_task_id.
      // Recover by picking the most recent inbox row whose status is
      // consistent with "we tried to handle it but never finalized".
      // 90-min window keeps this from grabbing unrelated old rows.
      try {
        const cutoff = Date.now() - 90 * 60 * 1000;
        const recents = this.sql<InboxLookup & { status: string }>`
          SELECT id, provider, conversation_id, provider_message_id, created_at, status
            FROM channel_inbox
           WHERE created_at > ${cutoff} AND status IN ('processing', 'handled', 'failed')
           ORDER BY created_at DESC LIMIT 5
        `;
        if (recents.length > 0) row = recents[0];
      } catch { /* fail-soft */ }
    }
    if (!row) return { ok: false, reason: "no_inbox_row_found" };

    const marker = `[envelope: ${input.envelopeId}]`;
    try {
      const existing = this.sql<{ n: number }>`
        SELECT COUNT(*) as n FROM channel_outbox
         WHERE conversation_id = ${row.conversation_id}
           AND text LIKE ${"%" + marker + "%"}
      `;
      if ((existing[0]?.n ?? 0) > 0) {
        return { ok: false, reason: "already_enqueued" };
      }
    } catch { /* fail-soft — fall through to enqueue attempt */ }

    // when sweeper seal produced `read_intent_no_execution`,
    // prefer the dedicated recovery render so the user gets the same
    // honest "我说要读文件但没真正调用工具" explanation that the happy-
    // path empty-fallback emits. The generic "未正常完成" line is
    // accurate for other failure modes (e.g. plain orphan with no
    // signal) but masks read-intent-specific recovery guidance.
    const fallbackText = input.verdictReason === "read_intent_no_execution"
      ? renderReadIntentNoExecutionReply({
          envelopeId: input.envelopeId,
          taskId: input.taskId,
          partialText: "",
        })
      : `⚠️ 上一轮 LLM 输出未正常完成；系统已自动收口 evidence envelope：${marker}`;
    try {
      const result = await this.enqueueOutboundText({
        provider: row.provider as ChannelProvider,
        conversationId: row.conversation_id,
        replyToProviderMessageId: row.provider_message_id,
        text: fallbackText,
        allowProactive: false,
      });
      return { ok: !!result?.ok, outboxId: result?.outboxId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: msg.slice(0, 200) };
    }
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

    const bridgeUrl = this.env.AGENT_THURSDAY_BRIDGE_URL;
    const bridgeSecret = this.env.AGENT_THURSDAY_BRIDGE_SECRET;
    // bridge mode now also reflects direct Discord. Delegate to the
    // single-source-of-truth helper instead of hard-coding here.
    const bridgeMode = this.bridgeMode();

    const deliveries: DeliverPendingResult["deliveries"] = [];

    for (const row of rows) {
      const now = Date.now();
      // also pull `chat_type` so the sender-side defensive
      // guard can drop `message_reference` for DM rows even if the
      // outbox row still carries `reply_to_provider_message_id` (old
      // row from before the routePending fix, or a proactive
      // `enqueueOutboundText` caller that didn't know to clear it).
      const conv = this.sql<{ chat_type: string | null; provider_channel_id: string | null; provider_thread_id: string | null }>`
        SELECT chat_type, provider_channel_id, provider_thread_id FROM channel_conversations
        WHERE conversation_id = ${row.conversation_id} LIMIT 1
      `[0] ?? { chat_type: null, provider_channel_id: null, provider_thread_id: null };
      const isDmConversation = conv.chat_type === "dm";
      const replyRefForDiscord = isDmConversation ? null : row.reply_to_provider_message_id;

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

      // direct Discord delivery takes precedence over bridge
      // when DISCORD_BOT_TOKEN is configured AND the row is for the discord
      // provider. Other providers (when they land) still go through bridge/dry-run.
      const useDirectDiscord = row.provider === "discord" && Boolean(this.env.DISCORD_BOT_TOKEN);
      const targetChannelId = conv.provider_thread_id || conv.provider_channel_id || null;
      // replies into a stored bot's channel must go out with
      // that bot's token. Resolved once per delivery; env token is the
      // fall-through (and the only path when no stored bots exist).
      const sendEnv = targetChannelId !== null
        ? await this._resolveDiscordSendEnv(targetChannelId)
        : this.env;

      if (useDirectDiscord) {
        if (!targetChannelId) {
          finalStatus = "failed";
          errorOut = "discord:no-target-channel-on-conversation";
        } else if (payload.kind === "text") {
          // Card §C-4: split for 2000-char limit, code-fence safe.
          // an earlier revision: only the first chunk uses the reply reference,
          // and `replyRefForDiscord` is null for DMs so Discord
          // doesn't 400 on `MESSAGE_REFERENCE_UNKNOWN_MESSAGE`.
          const visibleText = stripDiscordVisibleInternalMarkers(payload.text);
          const chunks = splitForDiscord2000(visibleText.length > 0 ? visibleText : "(empty)");
          let chunkErr: string | null = null;
          for (let i = 0; i < chunks.length; i++) {
            const body = buildDiscordTextSendBody({
              text: chunks[i],
              replyToProviderMessageId: i === 0 ? replyRefForDiscord : null,
            });
            const r = await sendDiscordMessage(sendEnv, { channelId: targetChannelId, body });
            if (!r.ok) { chunkErr = r.error; break; }
          }
          if (chunkErr !== null) {
            finalStatus = "failed";
            errorOut = chunkErr;
          }
        } else {
          // approval kind: render text fallback + native button row.
          // an earlier revision: same DM guard as text path — DMs go without a
          // reference, channels keep the existing reply behaviour.
          const text = renderApprovalText(payload.approval);
          const body = buildDiscordApprovalSendBody({
            text,
            card: payload.approval,
            replyToProviderMessageId: replyRefForDiscord,
          });
          const r = await sendDiscordMessage(sendEnv, { channelId: targetChannelId, body });
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
        console.log(`[agentthursday-outbound] dry-run delivery id=${row.id} kind=${row.kind ?? "text"} payload=${JSON.stringify(bridgePayload).slice(0, 500)}`);
      }

      if (finalStatus === "sent") {
        this.sql`
          UPDATE channel_outbox SET status = 'sent', error = NULL,
            attempt_count = attempt_count + 1, sent_at = ${now}
          WHERE id = ${row.id}
        `;
        // in polling ingress mode, kick a one-shot poll on
        // the same Discord channel so a user's follow-up message is
        // ingested faster than the next scheduled tick. Fire-and-forget;
        // the gateway DO checks ingress mode itself and turns this into
        // a cheap no-op when mode != polling.
        if (useDirectDiscord && targetChannelId) {
          this.maybePostReplyPoll(targetChannelId);
        }
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
   * authority (an earlier revision §C-20).
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

    // Downstream side-effect — an earlier revision §C-20: route tool-kind approvals
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
    // body extracted to `./channelHub/approvalOps.ts`. Reads the
    // legacy `channel_approvals` table , not `agent_tool_approvals`.
    return lookupApprovalHashImpl(this, approvalId);
  }

  private bridgeMode(): "http" | "dry-run" | "discord-direct" {
    if (this.env.DISCORD_BOT_TOKEN) return "discord-direct";
    if (this.env.AGENT_THURSDAY_BRIDGE_URL) return "http";
    return "dry-run";
  }

  /**
   * an earlier revision helper — set identity role so the router can promote a sender
   * from `unknown` to `trusted` (or back). Minimal seam needed to actually
   * exercise the `process` path; an earlier revision will surface this in the UI.
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

  /**
   * read a conversation's AgentProfile binding.
   * Returns `{ activeProfileId: null }` for an unknown or unbound
   * conversation; routePending treats both the same (active-context
   * fallback). `null` row is intentionally not surfaced as 404 here so
   * the UI can show "Unbound" without an extra error-state branch.
   */
  @callable()
  async getConversationBinding(input: { conversationId: string }): Promise<{
    conversationId: string;
    activeAgentId: string | null;
    // legacy alias retained for backward-compat with any
    // unmigrated client. New clients read `activeAgentId`. Both fields
    // always carry the same value; column name `active_profile_id` is
    // legacy storage (see src/channelHub/schema.ts comment).
    activeProfileId: string | null;
  }> {
    const id = (input?.conversationId ?? "").trim();
    if (id.length === 0 || id.length > 200) {
      return { conversationId: id, activeAgentId: null, activeProfileId: null };
    }
    const rows = this.sql<{ active_profile_id: string | null }>`
      SELECT active_profile_id FROM channel_conversations
      WHERE conversation_id = ${id} LIMIT 1
    `;
    if (rows.length === 0) {
      return { conversationId: id, activeAgentId: null, activeProfileId: null };
    }
    const v = rows[0].active_profile_id;
    const bound = typeof v === "string" && v.length > 0 ? v : null;
    return {
      conversationId: id,
      activeAgentId: bound,
      activeProfileId: bound,
    };
  }

  /**
   * (2026-06-26) — a conversation's stored `provider_channel_id`, for the
   * route-level tenant-ownership check (channel ∈ caller's BYO bots). Null when the
   * row is unknown or a pre-seed binding with no ingested channel yet — the caller
   * (canBind kernel) treats null as not-owned (fail closed).
   */
  @callable()
  async getConversationProviderChannel(input: { conversationId: string }): Promise<{ providerChannelId: string | null }> {
    const id = (input?.conversationId ?? "").trim();
    if (id.length === 0 || id.length > 200) return { providerChannelId: null };
    const rows = this.sql<{ provider_channel_id: string | null }>`
      SELECT provider_channel_id FROM channel_conversations WHERE conversation_id = ${id} LIMIT 1
    `;
    return { providerChannelId: rows.length > 0 ? rows[0].provider_channel_id : null };
  }

  /**
   * (2026-06-26) — list conversations whose `provider_channel_id` is in
   * `channelIds`, with their current binding, for the user-app channel-binding UI.
   * `channelIds: null` = unfiltered (admin/operator). An empty array returns []
   * (a scoped caller with no BYO-bot channels owns no conversations). Caller is
   * responsible for passing only the requesting tenant's channels.
   */
  @callable()
  async listConversationsForChannels(input: { channelIds: string[] | null; limit?: number }): Promise<{
    conversations: Array<{
      conversationId: string;
      providerChannelId: string | null;
      provider: string;
      chatType: string;
      activeAgentId: string | null;
      lastSeenAt: number;
    }>;
  }> {
    const limit = Math.max(1, Math.min(200, Math.floor(input?.limit ?? 100)));
    type Row = {
      conversation_id: string;
      provider_channel_id: string | null;
      provider: string;
      chat_type: string;
      active_profile_id: string | null;
      last_seen_at: number;
    };
    // Filter by channel membership in JS — the DO sql tag does not expand a JS
    // array into an `IN (...)` list, and a tenant's BYO-bot channel set is small.
    // For the scoped path we over-fetch recent rows then keep only owned channels.
    const wanted = input.channelIds === null ? null : new Set(input.channelIds.filter((c) => typeof c === "string" && c.length > 0));
    if (wanted !== null && wanted.size === 0) return { conversations: [] };
    // Over-fetch so JS filtering still yields up to `limit` owned rows.
    const scanLimit = wanted === null ? limit : Math.min(2000, limit * 10);
    const all = this.sql<Row>`
      SELECT conversation_id, provider_channel_id, provider, chat_type, active_profile_id, last_seen_at
      FROM channel_conversations ORDER BY last_seen_at DESC LIMIT ${scanLimit}
    `;
    const rows = (wanted === null
      ? all
      : all.filter((r) => r.provider_channel_id !== null && wanted.has(r.provider_channel_id))
    ).slice(0, limit);
    return {
      conversations: rows.map((r) => ({
        conversationId: r.conversation_id,
        providerChannelId: r.provider_channel_id,
        provider: r.provider,
        chatType: r.chat_type,
        activeAgentId: r.active_profile_id && r.active_profile_id.length > 0 ? r.active_profile_id : null,
        lastSeenAt: r.last_seen_at,
      })),
    };
  }

  /**
   * set or clear a conversation's AgentProfile binding.
   *
   *  - `profileId: string`  → bind. Profile must exist on the registry DO
   *                          and not be archived; validated by RPC here so
   *                          a typoed id can't be persisted.
   *  - `profileId: null`    → clear.
   *
   * The conversation row may not exist yet if no inbound has ever been
   * ingested for it — UPSERT with minimal placeholders so the binding
   * can be set ahead of time. Once a real inbound arrives,
   * `ingestInbound` populates the rest of the columns; the
   * `active_profile_id` is preserved (ingest UPDATEs `last_seen_at` etc
   * but does not touch `active_profile_id`).
   */
  @callable()
  async setConversationBinding(input: {
    conversationId: string;
    // accept either `agentId` (new) or `profileId` (legacy).
    // Caller may pass one or the other; passing both with different
    // values is rejected so we never silently pick one. Same column
    // (`active_profile_id`) backs both.
    agentId?: string | null;
    profileId?: string | null;
  }): Promise<
    | { ok: true; conversationId: string; activeAgentId: string | null; activeProfileId: string | null }
    | { ok: false; code: "invalid_conversation_id" | "invalid_agent_id" | "agent_missing" | "agent_archived" | "validation_failed"; message: string }
  > {
    const id = (input?.conversationId ?? "").trim();
    if (id.length === 0 || id.length > 200) {
      return { ok: false, code: "invalid_conversation_id", message: "conversation_id required (1..200 chars)" };
    }
    // alias resolution. Prefer `agentId`; fall back to
    // `profileId` for legacy callers. If both present and differ, fail.
    const agentRaw = input?.agentId;
    const profileRaw = input?.profileId;
    if (
      agentRaw !== undefined && profileRaw !== undefined
      && agentRaw !== profileRaw
    ) {
      return { ok: false, code: "invalid_agent_id", message: "agent_id and profile_id supplied with conflicting values" };
    }
    const incoming = agentRaw !== undefined ? agentRaw : profileRaw;
    let agentId: string | null = null;
    if (incoming !== null && incoming !== undefined) {
      if (typeof incoming !== "string") {
        return { ok: false, code: "invalid_agent_id", message: "agent_id must be string or null" };
      }
      const trimmed = incoming.trim();
      if (trimmed.length === 0) {
        // Treat empty string as clear; UI passes null but be liberal.
        agentId = null;
      } else if (trimmed.length > 200) {
        return { ok: false, code: "invalid_agent_id", message: "agent_id too long (>200 chars)" };
      } else {
        agentId = trimmed;
      }
    }

    if (agentId !== null) {
      let agent: Awaited<ReturnType<AgentThursdayAgentRPC["readAgentProfile"]>>;
      try {
        const ns = this.env.AgentThursdayAgent as unknown as AgentNamespace<Agent<Env>>;
        const registry = await getAgentByName<Env, Agent<Env>>(ns, AGENT_THURSDAY_REGISTRY_INSTANCE_NAME);
        // Registry callable still named `readAgentProfile` (legacy
        // persistence; see an earlier revision design note compat table).
        agent = await (registry as unknown as AgentThursdayAgentRPC).readAgentProfile(agentId);
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
        return { ok: false, code: "validation_failed", message: `registry RPC failed: ${msg}` };
      }
      if (agent === null) {
        return { ok: false, code: "agent_missing", message: `agent not found: ${agentId}` };
      }
      if (agent.status === "archived") {
        return { ok: false, code: "agent_archived", message: `agent archived: ${agentId}` };
      }
    }

    const now = Date.now();
    // UPSERT — if the conversation row doesn't exist yet (binding set
    // ahead of first inbound), seed minimal placeholders so the column
    // can carry the binding. provider/chat_type get filled by the next
    // ingestInbound which UPDATEs those columns and does not touch
    // active_profile_id (legacy column name; see an earlier revision design note).
    const existing = this.sql<{ n: number }>`
      SELECT COUNT(*) as n FROM channel_conversations WHERE conversation_id = ${id}
    `;
    if (Number(existing[0]?.n ?? 0) === 0) {
      this.sql`
        INSERT INTO channel_conversations
          (conversation_id, provider, chat_type, capability_json, policy_json, first_seen_at, last_seen_at, active_profile_id)
        VALUES (${id}, 'unknown', 'unknown', '{}', '{}', ${now}, ${now}, ${agentId})
      `;
    } else {
      this.sql`
        UPDATE channel_conversations
        SET active_profile_id = ${agentId}, last_seen_at = ${now}
        WHERE conversation_id = ${id}
      `;
    }
    return { ok: true, conversationId: id, activeAgentId: agentId, activeProfileId: agentId };
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

    // SQL-side preview for big text/JSON columns.
    // The snapshot is debug-only; the dialog/delivery surfaces query
    // separately via specific by-id reads. Capping `text`,
    // `attachments_json`, and `payload_json` to ~4000 chars keeps the
    // snapshot bounded even if a single row carries a giant paste,
    // attachment list, or approval payload. (`raw_ref` is already
    // capped at ingest by `clampRawRef`.)
    const recentInboxRows = this.sql<InboxRow>`
      SELECT id, provider, conversation_id, provider_message_id, sender_provider_user_id,
             chat_type, addressed_to_agent, addressed_signals_json,
             substr(text, 1, 4000) AS text,
             substr(attachments_json, 1, 4000) AS attachments_json,
             raw_ref, status, created_at, updated_at,
             route_action, route_reason, routed_at, handoff_task_id
      FROM channel_inbox
      ORDER BY created_at DESC LIMIT 10
    `;
    const recentInbox: ChannelInboxItem[] = recentInboxRows.map((r) => rowToInboxItem(r));

    const recentOutboxRows = this.sql<OutboxRow>`
      SELECT id, provider, conversation_id, reply_to_provider_message_id,
             substr(text, 1, 4000) AS text,
             substr(payload_json, 1, 4000) AS payload_json,
             status, error, attempt_count, created_at, sent_at,
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

    // preview large columns (`payload_json`, `audit`).
    const recentApprovalRows = this.sql<ApprovalRow>`
      SELECT id, kind, title, warning, reason,
             substr(payload_json, 1, 4000) AS payload_json,
             payload_hash,
             target_tool_call_id, provider, conversation_id, outbox_id,
             status, resolved_scope, resolved_actor,
             substr(audit, 1, 4000) AS audit,
             expires_at, created_at, resolved_at
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

    // top 10 recently-seen conversations + their binding
    // for the inspect-surface binding UI. Bounded query so the snapshot
    // size stays predictable as conversation count grows.
    const recentConversationRows = this.sql<{
      conversation_id: string;
      provider: string;
      chat_type: string;
      active_profile_id: string | null;
      last_seen_at: number;
    }>`
      SELECT conversation_id, provider, chat_type, active_profile_id, last_seen_at
      FROM channel_conversations
      ORDER BY last_seen_at DESC LIMIT 10
    `;
    const recentConversations = recentConversationRows.map(r => {
      const bound = typeof r.active_profile_id === "string" && r.active_profile_id.length > 0
        ? r.active_profile_id
        : null;
      return {
        conversationId: r.conversation_id,
        provider: r.provider,
        chatType: r.chat_type,
        // both fields populated from the legacy column.
        activeAgentId: bound,
        activeProfileId: bound,
        lastSeenAt: Number(r.last_seen_at),
      };
    });

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
      recentConversations,
    };
  }

  /**
   * read-only outbox inspect surface.
   *
   * Verifier-facing query of `channel_outbox` for marker / envelope_id /
   * conversation_id / single outbox_id consistency checks. Returns
   * redacted rows (no provider tokens, no raw `payload_json`, no auth
   * material). Body is bounded preview-only and error is sanitized at
   * write time. Caller (HTTP route) is expected to validate input shape;
   * this callable additionally re-validates `envelope_id` to prevent
   * LIKE-pattern wildcards from leaking past a broken caller.
   */
  @callable()
  async inspectOutbox(input: {
    marker?: string;
    envelope_id?: string;
    outbox_id?: string;
    conversation_id?: string;
    limit?: number;
  }): Promise<{ rows: ChannelOutboxInspectRow[] }> {
    const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.floor(input.limit) : 20;
    const limit = Math.max(1, Math.min(100, limitRaw));

    const ENVELOPE_ID_RE = /^env-[a-z0-9]+-[a-z0-9]+$/i;
    const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

    type OutboxQRow = OutboxRow & { text_length: number };
    let rows: OutboxQRow[] = [];
    if (typeof input.outbox_id === "string" && input.outbox_id.length > 0) {
      if (!SAFE_ID_RE.test(input.outbox_id)) return { rows: [] };
      rows = this.sql<OutboxQRow>`
        SELECT id, provider, conversation_id, reply_to_provider_message_id,
               substr(text, 1, 1000) AS text,
               '' AS payload_json,
               status, error, attempt_count, created_at, sent_at,
               kind, approval_id,
               length(text) AS text_length
        FROM channel_outbox
        WHERE id = ${input.outbox_id}
        LIMIT ${limit}
      `;
    } else {
      let envelopeId: string | null = null;
      if (typeof input.marker === "string" && input.marker.length > 0) {
        const m = input.marker.match(/\[envelope:\s*(env-[a-z0-9]+-[a-z0-9]+)\s*\]/i);
        if (m) envelopeId = m[1];
        else return { rows: [] };
      } else if (typeof input.envelope_id === "string" && input.envelope_id.length > 0) {
        if (!ENVELOPE_ID_RE.test(input.envelope_id)) return { rows: [] };
        envelopeId = input.envelope_id;
      }

      if (envelopeId) {
        const pattern = `%[envelope: ${envelopeId}]%`;
        rows = this.sql<OutboxQRow>`
          SELECT id, provider, conversation_id, reply_to_provider_message_id,
                 substr(text, 1, 1000) AS text,
                 '' AS payload_json,
                 status, error, attempt_count, created_at, sent_at,
                 kind, approval_id,
                 length(text) AS text_length
          FROM channel_outbox
          WHERE text LIKE ${pattern}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else if (typeof input.conversation_id === "string" && input.conversation_id.length > 0) {
        if (!SAFE_ID_RE.test(input.conversation_id)) return { rows: [] };
        rows = this.sql<OutboxQRow>`
          SELECT id, provider, conversation_id, reply_to_provider_message_id,
                 substr(text, 1, 1000) AS text,
                 '' AS payload_json,
                 status, error, attempt_count, created_at, sent_at,
                 kind, approval_id,
                 length(text) AS text_length
          FROM channel_outbox
          WHERE conversation_id = ${input.conversation_id}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else {
        return { rows: [] };
      }
    }

    const MARKER_RE = /\[envelope:\s*(env-[a-z0-9]+-[a-z0-9]+)\s*\]/gi;
    const inspectRows: ChannelOutboxInspectRow[] = rows.map((r) => {
      const preview = r.text;
      const markers: string[] = [];
      const seen = new Set<string>();
      for (const m of preview.matchAll(MARKER_RE)) {
        const id = m[1].toLowerCase();
        if (!seen.has(id)) { seen.add(id); markers.push(id); }
      }
      const errorOut = typeof r.error === "string" && r.error.length > 0
        ? (r.error.length > 200 ? `${r.error.slice(0, 200)}…` : r.error)
        : null;
      return {
        outbox_id: r.id,
        provider: r.provider,
        conversation_id: r.conversation_id,
        reply_to_provider_message_id: r.reply_to_provider_message_id,
        status: r.status,
        kind: r.kind,
        approval_id: r.approval_id,
        attempt_count: r.attempt_count,
        created_at: r.created_at,
        sent_at: r.sent_at,
        body_length: r.text_length,
        body_preview: preview,
        envelope_markers: markers,
        has_error: errorOut !== null,
        error_preview: errorOut,
      };
    });
    return { rows: inspectRows };
  }

  /**
   * read-only approval token inspect surface.
   *
   * Returns redacted approval rows from `agent_tool_approvals`. The
   * persisted secret material (`token_hash`) is never SELECTed; row
   * shape comes from `redactApprovalRow` in skillset/approvalToken.ts
   * so a future column add doesn't accidentally widen what inspect
   * exposes.
   *
   * No mutation. The route layer (server.ts) is auth-gated by the
   * global `requireSecret` on `/api/*`; this callable additionally
   * validates `token_id` shape so a broken caller can't smuggle wildcards.
   */
  @callable()
  async inspectApprovals(input: {
    status?: ApprovalStatus | "all";
    token_id?: string;
    limit?: number;
  }): Promise<{ rows: ApprovalInspectRow[] }> {
    const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.floor(input.limit) : 20;
    const limit = Math.max(1, Math.min(100, limitRaw));

    const TOKEN_ID_RE = /^tok_[a-f0-9]{8,64}$/i;
    const VALID_STATUSES = new Set<string>([
      "pending", "granted", "denied", "expired", "consumed", "replay_rejected",
    ]);

    type ApprovalQRow = {
      token_id: string;
      agent_id: string;
      tool_id: string;
      input_hash: string;
      tier: number;
      status: string;
      reviewer_id: string | null;
      reviewer_signature_hash: string | null;
      agent_reason: string | null;
      summary: string | null;
      expires_at: number;
      created_at: number;
      decided_at: number | null;
      consumed_at: number | null;
      key_id: string | null;
    };

    let rows: ApprovalQRow[] = [];
    if (typeof input.token_id === "string" && input.token_id.length > 0) {
      if (!TOKEN_ID_RE.test(input.token_id)) return { rows: [] };
      rows = this.sql<ApprovalQRow>`
        SELECT token_id, agent_id, tool_id, input_hash, tier, status,
               reviewer_id, reviewer_signature_hash,
               agent_reason, summary,
               expires_at, created_at, decided_at, consumed_at,
               key_id
        FROM agent_tool_approvals
        WHERE token_id = ${input.token_id}
        LIMIT 1
      `;
    } else {
      const status = input.status ?? "pending";
      if (status === "all") {
        rows = this.sql<ApprovalQRow>`
          SELECT token_id, agent_id, tool_id, input_hash, tier, status,
                 reviewer_id, reviewer_signature_hash,
                 agent_reason, summary,
                 expires_at, created_at, decided_at, consumed_at,
                 key_id
          FROM agent_tool_approvals
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else {
        if (!VALID_STATUSES.has(status)) return { rows: [] };
        rows = this.sql<ApprovalQRow>`
          SELECT token_id, agent_id, tool_id, input_hash, tier, status,
                 reviewer_id, reviewer_signature_hash,
                 agent_reason, summary,
                 expires_at, created_at, decided_at, consumed_at,
                 key_id
          FROM agent_tool_approvals
          WHERE status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      }
    }

    const inspectRows: ApprovalInspectRow[] = rows.map((r) => {
      const record: ApprovalRecord = {
        token_id: r.token_id,
        token_hash: "",
        agent_id: r.agent_id,
        tool_id: r.tool_id,
        input_hash: r.input_hash,
        tier: r.tier as Tier,
        status: r.status as ApprovalStatus,
        reviewer_id: r.reviewer_id,
        reviewer_signature_hash: r.reviewer_signature_hash,
        agent_reason: r.agent_reason,
        summary: r.summary,
        expires_at: r.expires_at,
        created_at: r.created_at,
        decided_at: r.decided_at,
        consumed_at: r.consumed_at,
        key_id: r.key_id,
      };
      return redactApprovalRow(record);
    });
    return { rows: inspectRows };
  }

  /**
   * verifier-only minimum approval request creation.
   *
   * Persists a `pending` row to `agent_tool_approvals` and returns the raw
   * token **once** in the creation response. The raw token never re-appears:
   * inspect surfaces strip `token_hash`, and `redactApprovalRow` is the
   * single egress point for any subsequent row exposure.
   *
   * Scope (per an earlier revision §D non-goals): no dispatcher integration, no
   * `/api/approve` grant/deny, no replay consumption, no real T4/T5 tool
   * execution. This callable is for verifier smoke + future grant flows.
   *
   * Tier guard: only T4 / T5 are accepted (other tiers don't require
   * approval tokens); ttl_seconds is hard-capped to 1800s (T4) / 900s
   * (T5) per an earlier revision ADR §OQ3 — manifests cannot widen the cap.
   */
  @callable()
  async createApprovalRequest(
    input: CreateApprovalRequestInput,
  ): Promise<CreateApprovalRequestResult> {
    // body extracted to `./channelHub/approvalOps.ts`. Persists
    // a `pending` row to `agent_tool_approvals` and returns the raw token
    // **once**; raw token never re-appears (inspect strips `token_hash`,
    // `redactApprovalRow` is the single egress point). `env` is `protected`
    // on the Agent base class, so the call site reads the HMAC-key env
    // pair and passes it in.
    const env = this.env as ApprovalHmacEnv;
    return createApprovalRequestImpl(this, env, input);
  }

  /**
   * reviewer grant/deny mutation.
   *
   * Drives the `pending → granted | denied` state machine. Persists
   * `reviewer_id`, optional `reviewer_signature_hash` (SHA-256 of the
   * raw signature; raw never stored), and `decided_at`. The raw
   * signature is intentionally absent from the response — `redactApprovalRow`
   * remains the single egress point.
   *
   * Pending guard: only rows whose current status is `pending` can be
   * decided. `granted` / `denied` / `consumed` / `expired` /
   * `replay_rejected` rows return 400 `approval_not_pending`. Unknown
   * `token_id` returns 400 `approval_not_found` here; the route layer
   * lifts that to 404.
   *
   * Skeleton scope (an earlier revision §D non-goals): no dispatcher, no replay
   * consumption, no real cryptographic signature verify — that lands in
   * 212e alongside dispatcher integration. The hash recorded here is
   * what 212e will prove against.
   *
   * Note on time-expired pending rows: a row whose `expires_at <= now`
   * but whose `status` is still `pending` (no sweeper yet) IS decidable
   * here. Even if granted, `verifyApprovalToken` will reject it as
   * `expired` at replay time, so this is safe; an explicit expiry guard
   * is deferred to the sweeper follow-up (an earlier revision §follow-up).
   */
  @callable()
  async decideApproval(
    input: DecideApprovalInput,
  ): Promise<DecideApprovalResult> {
    // body extracted to `./channelHub/approvalOps.ts`. Drives
    // the `pending → granted | denied` state machine. Raw signature is
    // hashed (SHA-256) before persist; raw is never stored.
    return decideApprovalImpl(this, input);
  }

  /**
   * replay consumption skeleton.
   *
   * Verifier/admin path that exercises the final `granted → consumed`
   * transition. Reuses `verifyApprovalToken`  to enforce all
   * binding rules and constant-time HMAC compare. Resolves the HMAC key
   * by `row.key_id` so v1 / legacy_shared rows verify against their
   * issue-time secret (an earlier revision §C).
   *
   * Success path: granted + unexpired + (agent_id, tool_id, input_hash)
   * match + raw token HMAC matches stored `token_hash` → status flips
   * to `consumed`, `consumed_at` set. The redacted row is returned.
   *
   * Failure paths: never mutate row state (an earlier revision §B). Reasons
   * propagate from `verifyApprovalToken`:
   *   - agent_mismatch / tool_mismatch / input_hash_mismatch
   *   - wrong_status   (covers pending / denied / consumed / expired
   *                     / replay_rejected — all rejected; second replay
   *                     of the same row falls here)
   *   - expired         (granted but `expires_at <= now`)
   *   - token_mismatch  (binding & status OK but raw token wrong)
   *
   * Skeleton scope (an earlier revision §D): does NOT execute any T4/T5 tool, does
   * NOT integrate the agent dispatcher, does NOT touch
   * write/commit/push/deploy. The point of this card is to prove the
   * state machine's last hop is mechanically verifiable end-to-end.
   *
   * Single-instance DO actor model serializes callables, so SELECT →
   * verify → UPDATE within one call is naturally atomic. The UPDATE
   * `WHERE … AND status='granted'` is defence-in-depth.
   */
  @callable()
  async consumeApprovalToken(
    input: ConsumeApprovalTokenInput,
  ): Promise<ConsumeApprovalTokenResult> {
    // body extracted to `./channelHub/approvalOps.ts`. Drives
    // the final `granted → consumed` transition with HMAC binding verify;
    // failure paths never mutate row state. Single-instance DO actor model
    // serializes callables so SELECT → verify → UPDATE is atomic. `env`
    // is `protected` on the Agent base class, so the call site reads the
    // HMAC-key env pair and passes it in.
    const env = this.env as ApprovalHmacEnv;
    return consumeApprovalTokenImpl(this, env, input);
  }

  /**
   * propose-patch artifact creation. Verifier-only path.
   *
   * Mechanizes an earlier revision ADR §D4 + §D7. Validates the input, runs
   * `evaluatePatchPolicy` (allowlist / denylist + redaction substring
   * scan), and on PASS persists a `status='proposed'` row. On FAIL the
   * call returns `{ ok: false, error: "policy_failed", detail }` and
   * **no row is inserted** — fail-closed at creation so inspect can
   * never leak a policy-failed artifact's body.
   *
   * Boundary (an earlier revision §1):
   *  - This is NOT the agent dispatcher path. The agent / agentD cannot
   *    write the working tree, commit, push, or deploy. Apply via
   *    approval replay belongs to an earlier revision+.
   *  - The route layer gates this with `requireSecret`; this callable
   *    enforces shape + policy, not auth.
   *
   * Status in v1: only `'proposed'` is ever written. The schema reserves
   * `'rejected' | 'superseded'` for forward-compat, but rejection in v1
   * is encoded as no-row-at-all (see fail-closed above).
   */
  @callable()
  async proposePatchArtifact(input: {
    tool_id?: unknown;
    target_paths?: unknown;
    patch_text?: unknown;
    summary?: unknown;
    agent_id?: unknown;
    task_id?: unknown;
    envelope_id?: unknown;
    conversation_id?: unknown;
    base_sha?: unknown;
  }): Promise<
    | {
        ok: true;
        artifact_id: string;
        row: PatchArtifactInspectRow;
      }
    | {
        ok: false;
        error: string;
        detail?: {
          denied_paths?: { path: string; reason: string }[];
          redaction_hits?: { category: string; count: number }[];
          policy_version?: string;
        };
      }
  > {
    return proposePatchArtifactImpl(this, input);
  }

  /**
   * propose-patch artifact inspect. List or single-row read.
   *
   * Mirrors `inspectApprovals` shape: optional `artifact_id` for single
   * lookup, otherwise list with `status` filter ("proposed" | "all";
   * default "proposed") and `limit` clamped to [1, 100].
   *
   * The inspect row strips `patch_text` (returns `patch_text_length`
   * only) so a multi-KiB diff body never lands in inspect responses.
   * Use a future apply-side surface  if patch body retrieval
   * is needed; v1 verifier-only smoke compares input_hash + policy
   * summary, not raw text.
   */
  @callable()
  async inspectPatchArtifacts(input: {
    artifact_id?: string;
    status?: "proposed" | "all";
    limit?: number;
  }): Promise<{ rows: PatchArtifactInspectRow[] }> {
    return inspectPatchArtifactsImpl(this, input);
  }

  /**
   * read-only `channel_inbox` inspect surface.
   *
   * Verifier / operator query of the inbox table by
   * `provider_message_id` (Discord snowflake or generic message id),
   * `conversation_id` (ChannelHub conv id), or single `inbox_id`.
   * Returns redacted rows: bounded `text_preview` + `text_length`,
   * attachments collapsed to `attachment_count + attachment_kinds[]`,
   * `raw_ref` bounded to 200 chars. Never returns raw payload JSON,
   * provider tokens, or unbounded attachment bodies.
   *
   * Body lives in `channelHub/inboxInspect.ts` so the redaction shape
   * can be unit-tested without the partyserver / cloudflare:workers
   * import chain.
   */
  @callable()
  async inspectChannelInbox(
    input: InspectChannelInboxInput,
  ): Promise<{ rows: ChannelInboxInspectRow[] }> {
    return inspectChannelInboxImpl(this, input);
  }

  /**
   * read-only `channel_conversations` ownership inspect.
   *
   * Answers agentP's 369a observability ask: surface "current workspace
   * agent vs channel route owner mismatch / unbound" without touching
   * the hot-polled `/api/workspace` payload. Two query forms:
   *   - `conversation_id` → single conversation owner + recent inbox.
   *   - `agent_id`        → conversations currently bound to that agent.
   *
   * Body lives in `channelHub/conversationOwnership.ts` so the shape
   * can be unit-tested without the partyserver / cloudflare:workers
   * import chain.
   */
  @callable()
  async inspectConversationOwnership(
    input: InspectConversationOwnershipInput,
  ): Promise<InspectConversationOwnershipResult> {
    return inspectConversationOwnershipImpl(this, input);
  }

  /**
   * write one outbox/evidence row for an apply attempt that
   * has already produced an event-log row. The outbox table is the
   * redaction-safe view of apply evidence — same fields the inspect
   * surface already exposes for the event log, plus a stable `outbox_id`
   * and a `delivery_status` (v1 `'ready'`, no external delivery yet).
   *
   * Writes are guarded by UNIQUE(event_id) + INSERT OR IGNORE so a
   * coding bug that called this twice for the same event would no-op
   * the second insert rather than corrupt the table. Cloudflare DOs are
   * single-threaded so a same-event retry within one apply call cannot
   * occur, but the guard makes intent explicit.
   *
   * Egress contract (matches an earlier revision inspect): no `patch_text`, no raw
   * token, no raw signature, no auth header, no worker secret.
   */
  private writePatchApplyOutbox(args: {
    event_id: string;
    artifact_id: string;
    token_id: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    status: string;
    error_code: string | null;
    gate_required: 0 | 1;
    dry_run_unavailable: 0 | 1;
    dry_run_exit_code: number | null;
    head_sha: string | null;
    target_paths_json: string;
    created_at: number;
  }): string {
    const outboxId = `out_patch_apply_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.sql`
      INSERT OR IGNORE INTO patch_apply_outbox (
        outbox_id, event_id, artifact_id, token_id,
        agent_id, tool_id, input_hash,
        status, error_code, gate_required, dry_run_unavailable,
        dry_run_exit_code, head_sha,
        target_paths, delivery_status, created_at
      ) VALUES (
        ${outboxId}, ${args.event_id}, ${args.artifact_id}, ${args.token_id},
        ${args.agent_id}, ${args.tool_id}, ${args.input_hash},
        ${args.status}, ${args.error_code}, ${args.gate_required}, ${args.dry_run_unavailable},
        ${args.dry_run_exit_code}, ${args.head_sha},
        ${args.target_paths_json}, 'ready', ${args.created_at}
      )
    `;
    return outboxId;
  }

  /**
   * approval-replay-driven apply with real dry-run + consume
   * (follow-up to an earlier revision's verify-only skeleton).
   *
   * Verifier-only callable. Drives the apply path with a real
   * `git apply --check` against a sandbox-resident shallow checkout —
   * no commit, push, deploy, or working-tree mutation. Approval state
   * is **only** consumed when the real dry-run passes, so a granted
   * approval mechanically binds to one specific patch artifact + one
   * successful structural-and-real check.
   *
   * Order of operations (each step fails closed without consume):
   *  1. Validate input shape; reject anything not matching expected ids.
   *  2. Reject any `tool_id` other than `APPLY_TOOL_ID`.
   *  3. Load the artifact row. `patch_text` is internal-only; it is
   *     written into the sandbox `/tmp` and is **never** echoed in any
   *     response, event row, log, or inspect surface.
   *  4. Re-derive the canonical apply input_hash from
   *     `(artifact_id, artifact_input_hash)` and require it to match
   *     both the caller's claimed `input_hash` and the approval row's
   *     stored value (§B binding).
   *  5. Resolve the HMAC key by `row.key_id` (matches an earlier revision) and
   *     `verifyApprovalToken` (pure — no row mutation).
   *  6. On verify-fail: write a `verify_failed` event row, return
   *     `{ok:false, error: <verdict.reason>}`. Approval untouched.
   *  7. On verify-ok: structurally parse the unified diff. Every
   *     `+++ b/<path>` must already be in `artifact.target_paths`.
   *     Mismatches fail closed (`verify_failed` /
   *     `diff_path_outside_target`); approval untouched.
   *  8. **Real dry-run**: get the `agentthursday-dev-shell` sandbox, ensure a
   *     shallow checkout via `ensureRepoCheckout` (records `head_sha`
   *     for provenance). On infra error: `dry_run_failed` /
   *     `sandbox_setup_failed` with `dry_run_unavailable=1`.
   *  9. `sandbox.writeFile('/tmp/<event>.diff', patch_text)` then
   *     `sandbox.exec('cd <repo> && git apply --check /tmp/<event>.diff')`.
   *     `exitCode === 0` → real dry-run pass.
   * 10. **Consume**: atomic `UPDATE … SET status='consumed' WHERE
   *     token_id=… AND status='granted'` — same pattern as
   *     `consumeApprovalToken`. Then write the
   *     `dry_run_passed_consumed` event with `head_sha` +
   *     `dry_run_exit_code=0`, `dry_run_unavailable=0`.
   * 11. On `git apply --check` non-zero exit: classify into a closed
   *     error_code enum from bounded stderr substrings (no raw stderr
   *     stored) and write `dry_run_failed` event with
   *     `dry_run_unavailable=0`. Approval untouched.
   *
   * Egress contract (preserved from 218/219, hardened):
   *  - Response, event row, inspect surface NEVER contain `patch_text`,
   *    raw token, raw signature, auth header, or worker secret.
   *  - Sandbox stderr is NOT stored; only a categorical `error_code`
   *    plus a numeric `dry_run_exit_code` and the resolved `head_sha`.
   *  - The `/tmp/<event>.diff` file is best-effort cleaned up; the
   *    sandbox is non-persistent across container restarts anyway.
   *
   * Boundaries (an earlier revision ADR + an earlier revision §3):
   *  - Caller is verifier-side via `requireSecret` on `/api/*`.
   *  - No commit / push / deploy. The dispatch never invokes
   *    `git apply` (write), only `git apply --check`.
   *  - Agent / agentD cannot reach this callable.
   */
  @callable()
  async applyPatchDryRun(input: {
    artifact_id?: unknown;
    token_id?: unknown;
    token?: unknown;
    agent_id?: unknown;
    tool_id?: unknown;
    input_hash?: unknown;
  }): Promise<
    | {
        ok: true;
        event_id: string;
        outbox_id: string;
        artifact_id: string;
        token_id: string;
        input_hash: string;
        target_paths: string[];
        declared_paths_in_diff: string[];
        hunks_parsed: number;
        status: "dry_run_passed_consumed";
        gate_required: true;
        dry_run_unavailable: false;
        consumed: true;
        head_sha: string | null;
        dry_run_exit_code: 0;
      }
    | {
        ok: false;
        error: string;
        detail?: string;
        event_id?: string;
        outbox_id?: string;
        status?: "verify_failed" | "dry_run_failed";
        dry_run_unavailable?: boolean;
        head_sha?: string | null;
        dry_run_exit_code?: number | null;
      }
  > {
    const TOKEN_ID_RE = /^tok_[a-f0-9]{8,64}$/i;
    const ID_RE = /^[A-Za-z0-9_.:\-\/]{1,256}$/;
    const HASH_RE = /^[a-f0-9]{64}$/i;

    const artifactId = typeof input.artifact_id === "string" ? input.artifact_id : "";
    if (!ARTIFACT_ID_RE.test(artifactId)) {
      return { ok: false, error: "artifact_id_invalid" };
    }
    const tokenId = typeof input.token_id === "string" ? input.token_id : "";
    if (!TOKEN_ID_RE.test(tokenId)) {
      return { ok: false, error: "token_id_invalid" };
    }
    const rawToken = typeof input.token === "string" ? input.token : "";
    if (!/^[a-f0-9]{1,256}$/i.test(rawToken) || rawToken.length === 0) {
      return { ok: false, error: "token_invalid" };
    }
    const agentId = typeof input.agent_id === "string" ? input.agent_id.trim() : "";
    if (!ID_RE.test(agentId)) {
      return { ok: false, error: "agent_id_invalid" };
    }
    const toolId = typeof input.tool_id === "string" ? input.tool_id.trim() : "";
    if (!ID_RE.test(toolId)) {
      return { ok: false, error: "tool_id_invalid" };
    }
    if (toolId !== APPLY_TOOL_ID) {
      // Apply approvals must use the dedicated apply tool id; rejecting
      // the artifact's tool_id here is what makes propose vs apply
      // distinguishable at the approval layer.
      return { ok: false, error: "tool_id_not_apply" };
    }
    const claimedInputHash =
      typeof input.input_hash === "string" ? input.input_hash : "";
    if (!HASH_RE.test(claimedInputHash)) {
      return { ok: false, error: "input_hash_invalid" };
    }
    const inputHash = claimedInputHash.toLowerCase();

    type ArtifactQRow = {
      artifact_id: string;
      status: string;
      tool_id: string;
      target_paths: string;
      input_hash: string;
      patch_text: string;
      base_sha: string | null;
    };
    const artifactRows = this.sql<ArtifactQRow>`
      SELECT artifact_id, status, tool_id, target_paths, input_hash, patch_text, base_sha
      FROM propose_patch_artifacts
      WHERE artifact_id = ${artifactId}
      LIMIT 1
    `;
    if (artifactRows.length === 0) {
      return { ok: false, error: "artifact_not_found" };
    }
    const artifact = artifactRows[0];
    if (artifact.status !== "proposed") {
      return { ok: false, error: "artifact_not_proposed", detail: artifact.status };
    }

    // Re-derive expected apply input_hash from artifact_id + artifact's
    // own input_hash. If caller's claim disagrees, fail closed before
    // we ever look at the approval row.
    const expectedInputHash = await computeApplyInputHash({
      artifact_id: artifact.artifact_id,
      artifact_input_hash: artifact.input_hash,
    });
    if (expectedInputHash !== inputHash) {
      return { ok: false, error: "input_hash_artifact_mismatch" };
    }

    type ApprovalQRowFull = {
      token_id: string;
      token_hash: string;
      agent_id: string;
      tool_id: string;
      input_hash: string;
      tier: number;
      status: string;
      reviewer_id: string | null;
      reviewer_signature_hash: string | null;
      agent_reason: string | null;
      summary: string | null;
      expires_at: number;
      created_at: number;
      decided_at: number | null;
      consumed_at: number | null;
      key_id: string | null;
    };
    const approvalRows = this.sql<ApprovalQRowFull>`
      SELECT token_id, token_hash, agent_id, tool_id, input_hash, tier, status,
             reviewer_id, reviewer_signature_hash,
             agent_reason, summary,
             expires_at, created_at, decided_at, consumed_at,
             key_id
      FROM agent_tool_approvals
      WHERE token_id = ${tokenId}
      LIMIT 1
    `;
    if (approvalRows.length === 0) {
      return { ok: false, error: "approval_not_found" };
    }
    const approvalRow = approvalRows[0];

    // Resolve HMAC key by row.key_id — same precedence as
    // consumeApprovalToken so v1 / legacy_shared rows verify against
    // their issue-time secret.
    const env = this.env as {
      AGENT_THURSDAY_APPROVAL_HMAC_KEY?: string;
      AGENT_THURSDAY_SHARED_SECRET?: string;
    };
    let hmacKey: string;
    if (approvalRow.key_id === "v1") {
      if (
        typeof env.AGENT_THURSDAY_APPROVAL_HMAC_KEY !== "string" ||
        env.AGENT_THURSDAY_APPROVAL_HMAC_KEY.length === 0
      ) {
        return {
          ok: false,
          error: "hmac_key_unconfigured",
          detail: "row.key_id=v1 but AGENT_THURSDAY_APPROVAL_HMAC_KEY not set",
        };
      }
      hmacKey = env.AGENT_THURSDAY_APPROVAL_HMAC_KEY;
    } else {
      if (
        typeof env.AGENT_THURSDAY_SHARED_SECRET !== "string" ||
        env.AGENT_THURSDAY_SHARED_SECRET.length === 0
      ) {
        return {
          ok: false,
          error: "hmac_key_unconfigured",
          detail: `row.key_id=${approvalRow.key_id ?? "null"} but AGENT_THURSDAY_SHARED_SECRET not set`,
        };
      }
      hmacKey = env.AGENT_THURSDAY_SHARED_SECRET;
    }

    const now = Date.now();
    const record: ApprovalRecord = {
      token_id: approvalRow.token_id,
      token_hash: approvalRow.token_hash,
      agent_id: approvalRow.agent_id,
      tool_id: approvalRow.tool_id,
      input_hash: approvalRow.input_hash,
      tier: approvalRow.tier as Tier,
      status: approvalRow.status as ApprovalStatus,
      reviewer_id: approvalRow.reviewer_id,
      reviewer_signature_hash: approvalRow.reviewer_signature_hash,
      agent_reason: approvalRow.agent_reason,
      summary: approvalRow.summary,
      expires_at: approvalRow.expires_at,
      created_at: approvalRow.created_at,
      decided_at: approvalRow.decided_at,
      consumed_at: approvalRow.consumed_at,
      key_id: approvalRow.key_id,
    };

    const targetPaths = safeParseArray<string>(artifact.target_paths);
    const targetPathsJson = JSON.stringify(targetPaths);

    const verdict = await verifyApprovalToken({
      hmacKey,
      presented_token: rawToken,
      record,
      agent_id: agentId,
      tool_id: toolId,
      input_hash: inputHash,
      now_ms: now,
    });

    if (!verdict.ok) {
      // Record verify-fail evidence; do NOT mutate approval state.
      const eventId = `evt_apply_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.sql`
        INSERT INTO patch_apply_events (
          event_id, event_type, artifact_id, token_id,
          agent_id, tool_id, input_hash, target_paths,
          declared_paths_in_diff, hunks_parsed,
          status, error_code, gate_required, dry_run_unavailable,
          created_at
        ) VALUES (
          ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
          ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
          NULL, NULL,
          'verify_failed', ${verdict.reason}, 1, 1,
          ${now}
        )
      `;
      const outboxId = this.writePatchApplyOutbox({
        event_id: eventId, artifact_id: artifactId, token_id: tokenId,
        agent_id: agentId, tool_id: toolId, input_hash: inputHash,
        status: "verify_failed", error_code: verdict.reason,
        gate_required: 1, dry_run_unavailable: 1,
        dry_run_exit_code: null, head_sha: null,
        target_paths_json: targetPathsJson, created_at: now,
      });
      return { ok: false, error: verdict.reason, event_id: eventId, outbox_id: outboxId };
    }

    // Verified. Now structural parse — each declared `+++ b/<path>` in
    // the diff must be in the artifact's target_paths. The body never
    // leaves this scope.
    const parsed = parseUnifiedDiffTargets(artifact.patch_text);
    if (!parsed.ok) {
      const eventId = `evt_apply_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.sql`
        INSERT INTO patch_apply_events (
          event_id, event_type, artifact_id, token_id,
          agent_id, tool_id, input_hash, target_paths,
          declared_paths_in_diff, hunks_parsed,
          status, error_code, gate_required, dry_run_unavailable,
          created_at
        ) VALUES (
          ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
          ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
          ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
          'verify_failed', 'diff_structure_invalid', 1, 1,
          ${now}
        )
      `;
      const outboxId = this.writePatchApplyOutbox({
        event_id: eventId, artifact_id: artifactId, token_id: tokenId,
        agent_id: agentId, tool_id: toolId, input_hash: inputHash,
        status: "verify_failed", error_code: "diff_structure_invalid",
        gate_required: 1, dry_run_unavailable: 1,
        dry_run_exit_code: null, head_sha: null,
        target_paths_json: targetPathsJson, created_at: now,
      });
      return { ok: false, error: "diff_structure_invalid", event_id: eventId, outbox_id: outboxId };
    }
    const allowed = new Set(targetPaths);
    const stray = parsed.paths.filter((p) => !allowed.has(p));
    if (stray.length > 0) {
      const eventId = `evt_apply_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.sql`
        INSERT INTO patch_apply_events (
          event_id, event_type, artifact_id, token_id,
          agent_id, tool_id, input_hash, target_paths,
          declared_paths_in_diff, hunks_parsed,
          status, error_code, gate_required, dry_run_unavailable,
          created_at
        ) VALUES (
          ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
          ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
          ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
          'verify_failed', 'diff_path_outside_target', 1, 1,
          ${now}
        )
      `;
      const outboxId = this.writePatchApplyOutbox({
        event_id: eventId, artifact_id: artifactId, token_id: tokenId,
        agent_id: agentId, tool_id: toolId, input_hash: inputHash,
        status: "verify_failed", error_code: "diff_path_outside_target",
        gate_required: 1, dry_run_unavailable: 1,
        dry_run_exit_code: null, head_sha: null,
        target_paths_json: targetPathsJson, created_at: now,
      });
      return { ok: false, error: "diff_path_outside_target", event_id: eventId, outbox_id: outboxId };
    }

    // real dry-run via the agentthursday-dev-shell sandbox.
    //
    // Base tree: `ensureRepoCheckout`  does an idempotent
    // shallow clone (depth 50) of `${AGENT_THURSDAY_REPO_URL}` at REPO_BASE_DIR.
    // The resolved `head_sha` is recorded as provenance on the event row
    // and in the response so the verifier can reason about which tree
    // the patch was checked against. Token (if any) is redacted by
    // `ensureRepoCheckout` before any error string surfaces.
    const eventId = `evt_apply_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const repoEnv = this.env as unknown as {
      AGENT_THURSDAY_REPO_URL?: string;
      AGENT_THURSDAY_GIT_TOKEN?: string;
      GITHUB_TOKEN?: string;
    };
    let head_sha: string | null = null;
    try {
      const sb = getSandbox(this.env.Sandbox, "agentthursday-dev-shell");
      const sandboxExec = async (command: string) => {
        const r = await sb.exec(command);
        return {
          stdout: typeof r.stdout === "string" ? r.stdout : "",
          stderr: typeof r.stderr === "string" ? r.stderr : "",
          exit_code: typeof r.exitCode === "number" ? r.exitCode : 0,
        };
      };
      const checkout = await ensureRepoCheckout(sandboxExec, {
        AGENT_THURSDAY_REPO_URL: repoEnv.AGENT_THURSDAY_REPO_URL,
        AGENT_THURSDAY_GIT_TOKEN: repoEnv.AGENT_THURSDAY_GIT_TOKEN,
        GITHUB_TOKEN: repoEnv.GITHUB_TOKEN,
      });
      if (checkout.error) {
        this.sql`
          INSERT INTO patch_apply_events (
            event_id, event_type, artifact_id, token_id,
            agent_id, tool_id, input_hash, target_paths,
            declared_paths_in_diff, hunks_parsed,
            status, error_code, gate_required, dry_run_unavailable,
            created_at, dry_run_exit_code, head_sha
          ) VALUES (
            ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
            ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
            ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
            'dry_run_failed', 'sandbox_setup_failed', 1, 1,
            ${now}, NULL, NULL
          )
        `;
        const outboxId = this.writePatchApplyOutbox({
          event_id: eventId, artifact_id: artifactId, token_id: tokenId,
          agent_id: agentId, tool_id: toolId, input_hash: inputHash,
          status: "dry_run_failed", error_code: "sandbox_setup_failed",
          gate_required: 1, dry_run_unavailable: 1,
          dry_run_exit_code: null, head_sha: null,
          target_paths_json: targetPathsJson, created_at: now,
        });
        return {
          ok: false,
          error: "sandbox_setup_failed",
          event_id: eventId,
          outbox_id: outboxId,
          status: "dry_run_failed",
          dry_run_unavailable: true,
          head_sha: null,
          dry_run_exit_code: null,
        };
      }
      head_sha = checkout.head_sha ?? null;

      // pinned base SHA check. If the artifact was proposed
      // with a non-null `base_sha`, the resolved sandbox `head_sha`
      // must match (case-insensitive) before we run `git apply --check`
      // — otherwise the dry-run is being evaluated on a different tree
      // than the patch was authored against, and a happy-path consume
      // would silently bind to a tree the proposer never saw. Null
      // base on the artifact (legacy / pre-223 rows) skips this check
      // and behaves as before. Failure path mirrors the other
      // `dry_run_failed` branches: sandbox is up so
      // `dry_run_unavailable=0`, `dry_run_exit_code=null` since
      // `git apply --check` was never invoked, approval untouched.
      if (
        artifact.base_sha !== null &&
        artifact.base_sha.toLowerCase() !== (head_sha ?? "").toLowerCase()
      ) {
        this.sql`
          INSERT INTO patch_apply_events (
            event_id, event_type, artifact_id, token_id,
            agent_id, tool_id, input_hash, target_paths,
            declared_paths_in_diff, hunks_parsed,
            status, error_code, gate_required, dry_run_unavailable,
            created_at, dry_run_exit_code, head_sha
          ) VALUES (
            ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
            ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
            ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
            'dry_run_failed', 'base_sha_mismatch', 1, 0,
            ${now}, NULL, ${head_sha}
          )
        `;
        const outboxId = this.writePatchApplyOutbox({
          event_id: eventId, artifact_id: artifactId, token_id: tokenId,
          agent_id: agentId, tool_id: toolId, input_hash: inputHash,
          status: "dry_run_failed", error_code: "base_sha_mismatch",
          gate_required: 1, dry_run_unavailable: 0,
          dry_run_exit_code: null, head_sha,
          target_paths_json: targetPathsJson, created_at: now,
        });
        return {
          ok: false,
          error: "base_sha_mismatch",
          event_id: eventId,
          outbox_id: outboxId,
          status: "dry_run_failed",
          dry_run_unavailable: false,
          head_sha,
          dry_run_exit_code: null,
        };
      }

      // Write patch into sandbox /tmp; the SDK's writeFile primitive
      // avoids any base64+printf shell-escape gymnastics on patch_text.
      const diffPath = `/tmp/${eventId}.diff`;
      await sb.writeFile(diffPath, artifact.patch_text);

      const checkRes = await sb.exec(
        `cd ${REPO_BASE_DIR} && git apply --check ${diffPath}`,
      );
      const exitCode = typeof checkRes.exitCode === "number" ? checkRes.exitCode : 1;
      const stderr = typeof checkRes.stderr === "string" ? checkRes.stderr : "";

      // Best-effort cleanup; failure is non-fatal — sandbox is
      // non-persistent and /tmp doesn't outlive the container restart.
      try { await sb.exec(`rm -f ${diffPath}`); } catch { /* ignore */ }

      if (exitCode === 0) {
        // Real dry-run pass → atomic consume. Pattern matches
        // `consumeApprovalToken`: UPDATE only when status='granted',
        // so a concurrent retry cannot double-consume.
        this.sql`
          UPDATE agent_tool_approvals
          SET status = 'consumed', consumed_at = ${now}
          WHERE token_id = ${tokenId} AND status = 'granted'
        `;
        this.sql`
          INSERT INTO patch_apply_events (
            event_id, event_type, artifact_id, token_id,
            agent_id, tool_id, input_hash, target_paths,
            declared_paths_in_diff, hunks_parsed,
            status, error_code, gate_required, dry_run_unavailable,
            created_at, dry_run_exit_code, head_sha
          ) VALUES (
            ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
            ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
            ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
            'dry_run_passed_consumed', NULL, 1, 0,
            ${now}, 0, ${head_sha}
          )
        `;
        const outboxId = this.writePatchApplyOutbox({
          event_id: eventId, artifact_id: artifactId, token_id: tokenId,
          agent_id: agentId, tool_id: toolId, input_hash: inputHash,
          status: "dry_run_passed_consumed", error_code: null,
          gate_required: 1, dry_run_unavailable: 0,
          dry_run_exit_code: 0, head_sha,
          target_paths_json: targetPathsJson, created_at: now,
        });
        return {
          ok: true,
          event_id: eventId,
          outbox_id: outboxId,
          artifact_id: artifactId,
          token_id: tokenId,
          input_hash: inputHash,
          target_paths: targetPaths,
          declared_paths_in_diff: parsed.paths,
          hunks_parsed: parsed.hunks,
          status: "dry_run_passed_consumed",
          gate_required: true,
          dry_run_unavailable: false,
          consumed: true,
          head_sha,
          dry_run_exit_code: 0,
        };
      }

      // Non-zero exit → derive a categorical error_code from bounded
      // stderr substring matches. Raw stderr is NEVER stored or
      // returned; only the closed enum value lands on the row.
      const stderrLower = stderr.toLowerCase();
      let errorCode = "git_apply_check_failed_unknown";
      if (stderrLower.includes("does not exist in index")
          || stderrLower.includes("no such file")) {
        errorCode = "target_file_missing";
      } else if (stderrLower.includes("does not apply")
          || stderrLower.includes("patch failed")) {
        errorCode = "patch_does_not_apply";
      } else if (stderrLower.includes("corrupt patch")) {
        errorCode = "corrupt_patch";
      } else if (stderrLower.includes("unrecognized input")
          || stderrLower.includes("not a git diff")) {
        errorCode = "unrecognized_diff";
      }

      this.sql`
        INSERT INTO patch_apply_events (
          event_id, event_type, artifact_id, token_id,
          agent_id, tool_id, input_hash, target_paths,
          declared_paths_in_diff, hunks_parsed,
          status, error_code, gate_required, dry_run_unavailable,
          created_at, dry_run_exit_code, head_sha
        ) VALUES (
          ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
          ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
          ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
          'dry_run_failed', ${errorCode}, 1, 0,
          ${now}, ${exitCode}, ${head_sha}
        )
      `;
      const outboxId = this.writePatchApplyOutbox({
        event_id: eventId, artifact_id: artifactId, token_id: tokenId,
        agent_id: agentId, tool_id: toolId, input_hash: inputHash,
        status: "dry_run_failed", error_code: errorCode,
        gate_required: 1, dry_run_unavailable: 0,
        dry_run_exit_code: exitCode, head_sha,
        target_paths_json: targetPathsJson, created_at: now,
      });
      return {
        ok: false,
        error: errorCode,
        event_id: eventId,
        outbox_id: outboxId,
        status: "dry_run_failed",
        dry_run_unavailable: false,
        head_sha,
        dry_run_exit_code: exitCode,
      };
    } catch (e) {
      // Anything that escapes the dry-run scope (sandbox unreachable,
      // RPC-level error, writeFile failure, exec throw) folds into
      // `sandbox_setup_failed` with `dry_run_unavailable=1`. Approval
      // state is untouched. Error message is intentionally NOT stored —
      // we cannot guarantee it is redaction-safe under all SDK shapes.
      this.sql`
        INSERT INTO patch_apply_events (
          event_id, event_type, artifact_id, token_id,
          agent_id, tool_id, input_hash, target_paths,
          declared_paths_in_diff, hunks_parsed,
          status, error_code, gate_required, dry_run_unavailable,
          created_at, dry_run_exit_code, head_sha
        ) VALUES (
          ${eventId}, 'patch.apply_dry_run', ${artifactId}, ${tokenId},
          ${agentId}, ${toolId}, ${inputHash}, ${targetPathsJson},
          ${JSON.stringify(parsed.paths)}, ${parsed.hunks},
          'dry_run_failed', 'sandbox_setup_failed', 1, 1,
          ${now}, NULL, ${head_sha}
        )
      `;
      const outboxId = this.writePatchApplyOutbox({
        event_id: eventId, artifact_id: artifactId, token_id: tokenId,
        agent_id: agentId, tool_id: toolId, input_hash: inputHash,
        status: "dry_run_failed", error_code: "sandbox_setup_failed",
        gate_required: 1, dry_run_unavailable: 1,
        dry_run_exit_code: null, head_sha,
        target_paths_json: targetPathsJson, created_at: now,
      });
      return {
        ok: false,
        error: "sandbox_setup_failed",
        event_id: eventId,
        outbox_id: outboxId,
        status: "dry_run_failed",
        dry_run_unavailable: true,
        head_sha,
        dry_run_exit_code: null,
      };
    }
  }

  /**
   * read-only inspect over `patch_apply_events`. Mirrors
   * `inspectPatchArtifacts`: optional `event_id` for single lookup, else
   * list with `limit` clamped to [1,100]. No raw token, no signature, no
   * patch body — the table never stored those.
   */
  @callable()
  async inspectPatchApplyEvents(input: {
    event_id?: string;
    artifact_id?: string;
    limit?: number;
  }): Promise<{ rows: PatchApplyEventInspectRow[] }> {
    return inspectPatchApplyEventsImpl(this, input);
  }

  /**
   * read-only inspect over `patch_apply_outbox`. Mirrors
   * `inspectPatchApplyEvents` ergonomics: optional `outbox_id` for
   * single-row lookup, optional `event_id` / `artifact_id` filters
   * (mutually exclusive — first matched wins, in that order), else
   * latest-first list with `limit` clamped to [1,100].
   *
   * Egress contract: identical to event-log inspect — no `patch_text`,
   * no raw token, no raw signature, no auth header, no worker secret.
   * The table itself never stored those.
   */
  @callable()
  async inspectPatchApplyOutbox(input: {
    outbox_id?: string;
    event_id?: string;
    artifact_id?: string;
    limit?: number;
  }): Promise<{ rows: PatchApplyOutboxInspectRow[] }> {
    return inspectPatchApplyOutboxImpl(this, input);
  }

  /**
   * redaction-safe latest-`patch_apply_outbox` summary for
   * `/cli/status.dashboard`. Single RPC: SELECT latest outbox row
   * (ORDER BY created_at DESC LIMIT 1), then if found SELECT the
   * matching event row by `event_id` and compute `matches_event` over
   * the redaction-safe core fields that must agree between the two
   * projections (event_id, artifact_id, token_id, status, error_code,
   * head_sha, dry_run_exit_code, dry_run_unavailable, gate_required,
   * input_hash). Skips `target_paths` (array compare is structurally
   * derived from artifact, not a written-to-row identity).
   *
   * No `patch_text`, raw token, raw signature, auth header, secret —
   * the table itself never stored those.
   */
  @callable()
  async getLatestPatchApplyOutboxSummary(): Promise<LatestPatchApplyOutboxSummary> {
    return getLatestPatchApplyOutboxSummaryImpl(this);
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
