/**
 * `ChannelHubAgent` outbound enqueue helpers extracted
 * from `src/channelHub.ts`.
 *
 * `enqueueOutboundTextImpl(agent, input)` and
 * `enqueueOutboundApprovalImpl(agent, input, alwaysAllowEnabled)` carry
 * the same body the inline `@callable()` methods had. The decorators +
 * public method signatures stay on `ChannelHubAgent`; only the bodies
 * delegate here.
 *
 * `env` is `protected` on the Agent base class. The approval enqueue
 * needs `AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS`; the caller reads it once (at
 * the @callable wrapper) and passes the boolean result in. Everything
 * else is `agent.sql` (public) + crypto.randomUUID + JSON.
 *
 * Behavior preserved verbatim:
 *  - Text enqueue: proactive-not-allowed gate (an earlier revision §D-21), one INSERT
 *    into `channel_outbox` with `kind='text'`.
 *  - Approval enqueue: payload hash, optional `targetToolCallId`,
 *    paired INSERTs into `channel_approvals` + `channel_outbox`
 *    (kind='approval', approval_id linkage), `alwaysAllowEnabled` from
 *    env stamped into the card.
 *
 * Out of scope (kept inline in `channelHub.ts`): `deliverPendingOutbound`
 * touches direct Discord sender, OpenClaw bridge HTTP, post-reply poll
 * (cross-DO RPC), and reads multiple env vars. Bridge delivery semantics
 * are an explicit non-goal for 242z5.
 */

import type { Agent } from "agents";
import {
  type ChannelApprovalCard,
  type EnqueueOutboundApprovalRequest,
  type EnqueueOutboundResult,
  type EnqueueOutboundTextRequest,
  type OutboundChannelMessage,
} from "../schema";
import { APPROVAL_DEFAULTS, hashApprovalPayload } from "../channelOutbound";

export type ChannelHubOutboundHost = Agent<Env, Record<string, never>>;

export async function enqueueOutboundTextImpl(
  agent: ChannelHubOutboundHost,
  input: EnqueueOutboundTextRequest,
): Promise<EnqueueOutboundResult> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const allowProactive = input.allowProactive === true;

  // an earlier revision §D-21: proactive outbound (no reply target) is gated. Without
  // an existing conversation OR replyToProviderMessageId we treat this as
  // proactive and refuse unless caller explicitly opted in.
  if (input.replyToProviderMessageId == null && !allowProactive) {
    const known = agent.sql<{ n: number }>`
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

  agent.sql`
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

export async function enqueueOutboundApprovalImpl(
  agent: ChannelHubOutboundHost,
  input: EnqueueOutboundApprovalRequest,
  alwaysAllowEnabled: boolean,
): Promise<EnqueueOutboundResult> {
  const now = Date.now();
  const approvalId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const expiresAt = now + (input.ttlMs ?? APPROVAL_DEFAULTS.ttlMs);
  const payloadHash = await hashApprovalPayload(input.payload);

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

  agent.sql`
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
  agent.sql`
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
