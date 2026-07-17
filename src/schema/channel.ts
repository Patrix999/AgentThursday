import { z } from "zod";

/**
 * ChannelHub envelopes & storage row schemas.
 *
 * Provider-agnostic. Discord-first but no schema field is Discord-specific.
 * See `docs/milestones/multi-channel-communication-middle-layer.md`
 * and `docs/design/review-notes.md`.
 *
 * v1 P0 outbound is text-only — no `presentation.blocks/tone` (premature
 * pollution per review §5). Approval is reserved as a future `kind`
 * variant on the discriminated union.
 */

export const ChannelProviderSchema = z.enum(["discord", "email", "telegram", "whatsapp", "other"]);
export type ChannelProvider = z.infer<typeof ChannelProviderSchema>;

export const ChannelChatTypeSchema = z.enum(["dm", "group", "channel", "email-thread"]);
export type ChannelChatType = z.infer<typeof ChannelChatTypeSchema>;

export const ChannelAttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "file", "audio", "video", "link", "unknown"]),
  url: z.string().optional(),
  name: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().int().optional(),
});
export type ChannelAttachment = z.infer<typeof ChannelAttachmentSchema>;

export const ChannelSenderSchema = z.object({
  providerUserId: z.string(),
  displayName: z.string().nullable().optional(),
  isBot: z.boolean().optional(),
});
export type ChannelSender = z.infer<typeof ChannelSenderSchema>;

/**
 * Inbound envelope — what the bridge/adapter must produce.
 * `id` is filled by ChannelHub on persist (callers may omit it).
 */
export const ChannelMessageEnvelopeSchema = z.object({
  id: z.string().optional(),
  provider: ChannelProviderSchema,
  providerMessageId: z.string().min(1),
  providerThreadId: z.string().nullable().optional(),
  providerChannelId: z.string().nullable().optional(),
  conversationId: z.string().min(1),
  chatType: ChannelChatTypeSchema,
  sender: ChannelSenderSchema,
  addressedToAgent: z.boolean(),
  addressedSignals: z.array(z.string()).default([]),
  text: z.string(),
  attachments: z.array(ChannelAttachmentSchema).default([]),
  replyToProviderMessageId: z.string().nullable().optional(),
  rawRef: z.string().nullable().optional(),
  receivedAt: z.number().int().optional(),
});
export type ChannelMessageEnvelope = z.infer<typeof ChannelMessageEnvelopeSchema>;

/**
 * Outbound discriminated union. P0 has `text`  + `approval` .
 * No generic `presentation.blocks/tone` (review notes §5).
 */
const DeliveryPolicySchema = z.object({
  allowProactive: z.boolean(),
  silent: z.boolean().optional(),
  requireHumanApproval: z.boolean().optional(),
});

const OutboundTextMessageSchema = z.object({
  id: z.string(),
  kind: z.literal("text"),
  conversationId: z.string(),
  provider: ChannelProviderSchema,
  text: z.string().min(1).max(4000),
  replyToProviderMessageId: z.string().nullable().optional(),
  attachments: z.array(ChannelAttachmentSchema).optional(),
  deliveryPolicy: DeliveryPolicySchema,
});

/**
 * Hermes-style approval card. Rendered to Discord as a text
 * fallback + structured `approval` block so the bridge can attach buttons
 * if its surface supports them. Scope buttons mirror Hermes:
 * once / session / always / deny. `always` is gated behind an env flag
 * (an earlier revision §C-13); when gating is on, the bridge should hide/disable that
 * button and the resolve endpoint downgrades it to "session".
 */
export const ApprovalScopeSchema = z.enum(["once", "session", "always", "deny"]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalKindSchema = z.enum(["tool", "mutation", "command"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalWarningSchema = z.enum(["low", "medium", "high"]);
export type ApprovalWarning = z.infer<typeof ApprovalWarningSchema>;

export const ChannelApprovalCardSchema = z.object({
  id: z.string(),
  kind: ApprovalKindSchema,
  title: z.string().max(200),
  warning: ApprovalWarningSchema,
  reason: z.string().min(1).max(1000),
  payload: z.unknown(),
  payloadHash: z.string(),
  targetToolCallId: z.string().nullable().optional(),
  expiresAt: z.number().int(),
  alwaysAllowEnabled: z.boolean(),
});
export type ChannelApprovalCard = z.infer<typeof ChannelApprovalCardSchema>;

const OutboundApprovalMessageSchema = z.object({
  id: z.string(),
  kind: z.literal("approval"),
  conversationId: z.string(),
  provider: ChannelProviderSchema,
  approval: ChannelApprovalCardSchema,
  replyToProviderMessageId: z.string().nullable().optional(),
  deliveryPolicy: DeliveryPolicySchema,
});

export const OutboundChannelMessageSchema = z.discriminatedUnion("kind", [
  OutboundTextMessageSchema,
  OutboundApprovalMessageSchema,
]);
export type OutboundChannelMessage = z.infer<typeof OutboundChannelMessageSchema>;

/**
 * an earlier revision: `busy-skip` is distinct from `wait` — `wait` consumes the row
 * (status → deferred) because we need explicit human clarification; `busy-skip`
 * leaves the row at `received` so a later route attempt can pick it up when
 * the agent is free. The user's message must NOT be consumed just because
 * the agent happened to be mid-task.
 */
export const ChannelRouteDecisionSchema = z.object({
  action: z.enum(["process", "ignore", "wait", "escalate", "busy-skip"]),
  reason: z.string(),
  taskHint: z.string().optional(),
  memoryPolicy: z.enum(["none", "candidate", "remember"]).default("none"),
});
export type ChannelRouteDecision = z.infer<typeof ChannelRouteDecisionSchema>;

/**
 * Storage row reads (snapshot endpoint). Status enum mirrors §D-11.
 */
export const ChannelInboxStatusSchema = z.enum([
  "received", "routed", "processing", "handled", "ignored", "deferred", "failed",
]);
export type ChannelInboxStatus = z.infer<typeof ChannelInboxStatusSchema>;

export const ChannelInboxItemSchema = z.object({
  id: z.string(),
  provider: ChannelProviderSchema,
  conversationId: z.string(),
  providerMessageId: z.string(),
  senderProviderUserId: z.string(),
  chatType: ChannelChatTypeSchema,
  addressedToAgent: z.boolean(),
  addressedSignals: z.array(z.string()),
  text: z.string(),
  attachments: z.array(ChannelAttachmentSchema),
  rawRef: z.string().nullable(),
  status: ChannelInboxStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  // route metadata; null when row hasn't been routed yet.
  routeAction: z.enum(["process", "ignore", "wait", "escalate"]).nullable(),
  routeReason: z.string().nullable(),
  routedAt: z.number().int().nullable(),
  handoffTaskId: z.string().nullable(),
});
export type ChannelInboxItem = z.infer<typeof ChannelInboxItemSchema>;

export const ChannelOutboxStatusSchema = z.enum(["pending", "sent", "failed", "cancelled"]);
export type ChannelOutboxStatus = z.infer<typeof ChannelOutboxStatusSchema>;

export const ChannelOutboxItemSchema = z.object({
  id: z.string(),
  provider: ChannelProviderSchema,
  conversationId: z.string(),
  replyToProviderMessageId: z.string().nullable(),
  text: z.string(),
  status: ChannelOutboxStatusSchema,
  error: z.string().nullable(),
  attemptCount: z.number().int(),
  createdAt: z.number().int(),
  sentAt: z.number().int().nullable(),
  // kind and approval link.
  kind: z.enum(["text", "approval"]),
  approvalId: z.string().nullable(),
});
export type ChannelOutboxItem = z.infer<typeof ChannelOutboxItemSchema>;

export const ChannelApprovalStatusSchema = z.enum([
  "pending", "resolved-approved", "resolved-denied", "expired", "invalidated",
]);
export type ChannelApprovalStatus = z.infer<typeof ChannelApprovalStatusSchema>;

/**
 * Approval row exposed by snapshot/inspect. NOTE: full `payload` is reduced to
 * a truncated string preview; raw payload JSON would risk leaking sender input
 * verbatim. `payloadHash` is the audit anchor; full payload is in
 * `channel_approvals.payload_json` for SQLite-level inspection only.
 */
export const ChannelApprovalRowSchema = z.object({
  id: z.string(),
  kind: ApprovalKindSchema,
  title: z.string(),
  warning: ApprovalWarningSchema,
  reason: z.string(),
  status: ChannelApprovalStatusSchema,
  effectiveScope: ApprovalScopeSchema.nullable(),
  resolvedActor: z.string().nullable(),
  audit: z.string().nullable(),
  payloadPreview: z.string(),       // first 300 chars of JSON, never the secret
  payloadHash: z.string(),
  targetToolCallId: z.string().nullable(),
  conversationId: z.string(),
  provider: ChannelProviderSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  resolvedAt: z.number().int().nullable(),
});
export type ChannelApprovalRow = z.infer<typeof ChannelApprovalRowSchema>;

export const ChannelSnapshotSchema = z.object({
  counts: z.object({
    inbox: z.object({
      received: z.number().int(),
      routed: z.number().int(),
      processing: z.number().int(),
      handled: z.number().int(),
      ignored: z.number().int(),
      deferred: z.number().int(),
      failed: z.number().int(),
    }),
    outbox: z.object({
      pending: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
      cancelled: z.number().int(),
    }),
    approvals: z.object({
      pending: z.number().int(),
      "resolved-approved": z.number().int(),
      "resolved-denied": z.number().int(),
      expired: z.number().int(),
      invalidated: z.number().int(),
    }),
    conversations: z.number().int(),
    identities: z.number().int(),
  }),
  recentInbox: z.array(ChannelInboxItemSchema),
  recentOutbox: z.array(ChannelOutboxItemSchema),
  recentApprovals: z.array(ChannelApprovalRowSchema),
  /**
   * recently-seen conversations + their agent binding,
   * for the inspect-surface binding UI. Top-N by `last_seen_at` desc.
   * Optional for backward compatibility with old snapshots; new code
   * always populates it (possibly empty). Agent name is NOT included
   * here — UI joins against `/api/agent-profiles` on the client side.
   *
   * both `activeAgentId` (new, preferred) and
   * `activeProfileId` (legacy) carry the same value. Both are optional
   * so a snapshot written by either era still validates.
   */
  recentConversations: z.array(z.object({
    conversationId: z.string(),
    provider: z.string(),
    chatType: z.string(),
    activeAgentId: z.string().nullable().optional(),
    activeProfileId: z.string().nullable().optional(),
    lastSeenAt: z.number().int(),
  })).optional(),
});
export type ChannelSnapshot = z.infer<typeof ChannelSnapshotSchema>;

/**
 * Compact summary for the default user-layer panel — counts + last-inbound
 * timestamp, no raw rows. The user-layer should never need to render
 * `providerMessageId`, `payloadHash`, etc.
 */
export const ChannelCompactSummarySchema = z.object({
  inboxAddressedPending: z.number().int(),
  outboxPending: z.number().int(),
  approvalsPending: z.number().int(),
  lastInboundAt: z.number().int().nullable(),
  conversations: z.number().int(),
});
export type ChannelCompactSummary = z.infer<typeof ChannelCompactSummarySchema>;

export const ChannelInboundResultSchema = z.object({
  ok: z.boolean(),
  inserted: z.boolean(),
  id: z.string(),
  status: ChannelInboxStatusSchema,
});
export type ChannelInboundResult = z.infer<typeof ChannelInboundResultSchema>;

export const ChannelRoutePendingResultSchema = z.object({
  ok: z.boolean(),
  scanned: z.number().int(),
  /**
   * an earlier revision: number of rows whose decision was `busy-skip` — i.e. would
   * have processed but the agent was busy. These rows remain `received`
   * (not consumed) and will be reconsidered by the next routePending call.
   */
  busySkipped: z.number().int(),
  decisions: z.array(z.object({
    inboxId: z.string(),
    providerMessageId: z.string(),
    /**
     * `invalid-binding` is added for rows whose conversation
     * binding points to a missing / archived profile (or where the
     * registry RPC failed). Such rows MUST NOT silently fall back to
     * the canonical active context; they park as `deferred` so an
     * operator can correct or clear the binding.
     */
    action: z.enum(["process", "ignore", "wait", "escalate", "busy-skip", "invalid-binding"]),
    reason: z.string(),
    finalStatus: ChannelInboxStatusSchema,
    handoffTaskId: z.string().nullable(),
    /**
     * resolved route metadata so verifier / inspect can prove
     * which target the row was handed off to. Optional for backward
     * compatibility with batches that ran before the per-row resolver
     * landed; new rows always populate them.
     *
     * `agent_binding` is the corrected name for what an earlier revision
     * called `profile_binding`. Both values remain in the enum so old
     * persisted/parsed payloads still validate; new resolver emits
     * `agent_binding`. See docs/design/2026-05-24-m9.0-agent-centric-correction.md.
     */
    targetKind: z.enum([
      "agent_binding",
      "profile_binding",
      "active_context_fallback",
      "invalid_binding",
    ]).optional(),
    targetName: z.string().nullable().optional(),
  })),
});
export type ChannelRoutePendingResult = z.infer<typeof ChannelRoutePendingResultSchema>;

/**
 * outbound enqueue / deliver / approval-resolve API contracts.
 */

export const EnqueueOutboundTextRequestSchema = z.object({
  conversationId: z.string().min(1),
  provider: ChannelProviderSchema,
  text: z.string().min(1).max(4000),
  replyToProviderMessageId: z.string().nullable().optional(),
  allowProactive: z.boolean().optional(),
});
export type EnqueueOutboundTextRequest = z.infer<typeof EnqueueOutboundTextRequestSchema>;

export const EnqueueOutboundApprovalRequestSchema = z.object({
  conversationId: z.string().min(1),
  provider: ChannelProviderSchema,
  replyToProviderMessageId: z.string().nullable().optional(),
  approvalKind: ApprovalKindSchema,
  title: z.string().min(1).max(200),
  warning: ApprovalWarningSchema.default("medium"),
  reason: z.string().min(1).max(1000),
  payload: z.unknown(),
  targetToolCallId: z.string().nullable().optional(),
  ttlMs: z.number().int().min(10_000).max(24 * 60 * 60_000).optional(),
});
export type EnqueueOutboundApprovalRequest = z.infer<typeof EnqueueOutboundApprovalRequestSchema>;

export const EnqueueOutboundResultSchema = z.object({
  ok: z.boolean(),
  outboxId: z.string(),
  approvalId: z.string().nullable(),
});
export type EnqueueOutboundResult = z.infer<typeof EnqueueOutboundResultSchema>;

export const DeliverPendingResultSchema = z.object({
  ok: z.boolean(),
  scanned: z.number().int(),
  bridgeMode: z.enum(["http", "dry-run", "discord-direct"]),
  deliveries: z.array(z.object({
    outboxId: z.string(),
    kind: z.enum(["text", "approval"]),
    finalStatus: ChannelOutboxStatusSchema,
    error: z.string().nullable(),
  })),
});
export type DeliverPendingResult = z.infer<typeof DeliverPendingResultSchema>;

export const ApprovalResolveRequestSchema = z.object({
  approvalId: z.string().min(1),
  scope: ApprovalScopeSchema,
  actorProvider: ChannelProviderSchema,
  actorProviderUserId: z.string().min(1),
  payloadHashEcho: z.string().min(1),
});
export type ApprovalResolveRequest = z.infer<typeof ApprovalResolveRequestSchema>;

export const ApprovalResolveResultSchema = z.object({
  ok: z.boolean(),
  approvalId: z.string(),
  status: ChannelApprovalStatusSchema,
  effectiveScope: ApprovalScopeSchema,
  audit: z.string(),
  alreadyResolved: z.boolean(),
  // Set when the resolved approval triggered a downstream action (e.g. tool approval result).
  downstream: z.object({
    kind: z.literal("tool-approval"),
    toolCallId: z.string(),
    approved: z.boolean(),
    ok: z.boolean(),
  }).nullable(),
});
export type ApprovalResolveResult = z.infer<typeof ApprovalResolveResultSchema>;
