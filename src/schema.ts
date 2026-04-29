import { z } from "zod";

/**
 * M7.1 Card 76 — Unified Object Model Schema and Worker Contract
 *
 * Single source of truth for the data the new Web shell (Card 78),
 * Current Task View (Card 79), and inspect surface (Card 81) consume.
 * Built so 76 → 77/78 → 79 → 80/81 do not have to invent shapes.
 *
 * Legacy → new mapping (kept here so future readers can navigate):
 *
 *   legacy name                      | source module          | new location
 *   ---------------------------------|------------------------|-------------------------------------
 *   taskObject (TaskObject)          | M2 task lifecycle      | TaskView
 *   cliSession (CliSession)          | M3 cli session         | SessionView
 *   lastActionResult (ActionResult)  | M1.3 action result     | ArtifactView (kind="actionResult")
 *   developerLoopReview              | M2 reviewer            | summary text → MessageView (kind="summary")
 *                                    |                        | + traces → TraceEvent[] (inspect)
 *   pendingToolApproval              | M5.1 tool approval     | ApprovalView (kind="tool")
 *   pendingKanbanMutations[]         | M2 mutation            | ApprovalView (kind="mutation")
 *   debugTrace.recentToolEvents[]    | M5.1 trace             | ToolEvent[] (inspect only)
 *   debugTrace.lastLadderTier        | M6.1 ladder            | TaskView.ladderTier + .ladderReason
 *   debugTrace.lastAssistantSummary  | M5.1                   | MessageView (kind="assistant")
 *   deliverableGate.deliverable      | M2 deliverable         | ArtifactView (kind="deliverable")
 *
 * Card 79 user-layer reads only:
 *   session, currentTask, summaryStream, pendingApproval, replyNeed, latestResult
 * Card 81 inspect-layer reads only:
 *   inspectEntry (presence flags) + GET /api/inspect (full data)
 *
 * The /cli/* legacy endpoints stay live for TUI; a follow-up cleanup card
 * will retire them after Card 79 ships.
 */

export const SessionViewSchema = z.object({
  sessionId: z.string(),
  instanceName: z.string(),
  agentState: z.enum(["idle", "running", "waiting", "completed"]),
  loopStage: z.string(),
  autoContinue: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const TaskViewSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  lifecycle: z.enum(["draft", "active", "waiting", "review", "completed", "failed"]),
  loopStage: z.string(),
  readyForNextRound: z.boolean(),
  ladderTier: z.number().int().nullable(),
  ladderReason: z.string().nullable(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const MessageViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["system", "assistant", "user", "summary"]),
  text: z.string(),
  at: z.number().int(),
});
export type MessageView = z.infer<typeof MessageViewSchema>;

const ApprovalViewMutationSchema = z.object({
  id: z.string(),
  kind: z.literal("mutation"),
  reason: z.string(),
  diffSnippet: z.string(),
  cardRef: z.string().nullable(),
  mutationId: z.number().int(),
  createdAt: z.number().int(),
});
const ApprovalViewToolSchema = z.object({
  id: z.string(),
  kind: z.literal("tool"),
  reason: z.string(),
  toolName: z.string(),
  toolCallId: z.string(),
  createdAt: z.number().int(),
});
export const ApprovalViewSchema = z.discriminatedUnion("kind", [
  ApprovalViewMutationSchema,
  ApprovalViewToolSchema,
]);
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const ArtifactViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["deliverable", "actionResult", "checkpoint", "note"]),
  title: z.string(),
  textSummary: z.string(),
  createdAt: z.number().int(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ReplyNeedSchema = z.object({
  question: z.string(),
  sinceAt: z.number().int(),
});
export type ReplyNeed = z.infer<typeof ReplyNeedSchema>;

export const InspectEntrySchema = z.object({
  hasLadder: z.boolean(),
  hasTrace: z.boolean(),
  hasToolEvents: z.boolean(),
});
export type InspectEntry = z.infer<typeof InspectEntrySchema>;

export const WorkspaceSnapshotSchema = z.object({
  session: SessionViewSchema,
  currentTask: TaskViewSchema.nullable(),
  summaryStream: z.array(MessageViewSchema),
  pendingApproval: ApprovalViewSchema.nullable(),
  replyNeed: ReplyNeedSchema.nullable(),
  latestResult: ArtifactViewSchema.nullable(),
  inspectEntry: InspectEntrySchema,
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/**
 * Inspect surface shapes — the real data producer arrives in Card 81.
 * Card 76 only declares the contract and ships a stub returning empty arrays.
 */

export const TraceEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  at: z.number().int(),
  traceId: z.string().nullable(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const LadderTierEntrySchema = z.object({
  tier: z.number().int(),
  toolName: z.string(),
  reason: z.string(),
  at: z.number().int(),
});
export type LadderTierEntry = z.infer<typeof LadderTierEntrySchema>;

export const ToolEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["call", "result"]),
  toolName: z.string(),
  payload: z.unknown(),
  at: z.number().int(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

// Card 110 — ContentHub audit events surfaced via /api/inspect. Field shape
// is intentionally permissive (`payload: z.unknown()`) because the producer
// (ContentHubAgent.logAudit) already capped/redacted before persisting; the
// inspect surface just relays. `type` is one of `content.sources`,
// `content.list`, `content.read`, `content.search`.
export const ContentAuditEventSchema = z.object({
  type: z.string(),
  at: z.number().int(),
  payload: z.unknown(),
  traceId: z.string().nullable().optional(),
});
export type ContentAuditEvent = z.infer<typeof ContentAuditEventSchema>;

// Card 114 — ContentHub evidence pack (aggregated audit summary). Sits next
// to Card 110's raw `contentAudit` rows, NOT replacing them. Three pivot
// views answer the reviewer's recurring questions:
//   - byTraceId: in this agent round, what did it touch?
//   - bySourceId: what's the cumulative usage of this source?
//   - byOperation: which operation paths fired and at what cost/error rate?
// All counters derive from already-redacted audit row metadata; no raw
// content / hits / tokens are aggregated.
export const ContentAuditOperationCountsSchema = z.object({
  sources: z.number().int().nonnegative(),
  list: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  search: z.number().int().nonnegative(),
});
export type ContentAuditOperationCounts = z.infer<typeof ContentAuditOperationCountsSchema>;

export const ContentAuditByTraceSchema = z.object({
  traceId: z.string(),
  opCounts: ContentAuditOperationCountsSchema,
  sourceIds: z.array(z.string()),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type ContentAuditByTrace = z.infer<typeof ContentAuditByTraceSchema>;

export const ContentAuditBySourceSchema = z.object({
  sourceId: z.string(),
  opCounts: ContentAuditOperationCountsSchema,
  // Distinct LLM-driven traces touching this source (traceId-non-null rows).
  // Direct API rows (traceId null) are tallied separately so reviewers can
  // distinguish agent activity from operator/curl smoke against this source.
  traceIdCount: z.number().int().nonnegative(),
  directApiCount: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type ContentAuditBySource = z.infer<typeof ContentAuditBySourceSchema>;

export const ContentAuditByOperationSchema = z.object({
  operation: z.enum(["sources", "list", "read", "search"]),
  count: z.number().int().nonnegative(),
  sourceIdCount: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
});
export type ContentAuditByOperation = z.infer<typeof ContentAuditByOperationSchema>;

export const ContentAuditSummarySchema = z.object({
  totalRows: z.number().int().nonnegative(),
  windowStart: z.number().int().nullable(),
  windowEnd: z.number().int().nullable(),
  byTraceId: z.array(ContentAuditByTraceSchema),
  bySourceId: z.array(ContentAuditBySourceSchema),
  byOperation: z.array(ContentAuditByOperationSchema),
});
export type ContentAuditSummary = z.infer<typeof ContentAuditSummarySchema>;

// M7.5 Card 121 — degradation diagnostics surface compact view schemas.
// These mirror the JSON payloads emitted by Cards 117/119/102 events.
// `.passthrough()` lets the panel ride forward when those payloads grow;
// it does NOT promote unknown fields into the typed view, just keeps them
// for the raw `trace` consumer that already lives in `InspectSnapshot`.

export const TaskDegradationSummaryViewSchema = z.object({
  taskId: z.string(),
  state: z.enum(["normal", "degraded", "blocked", "needs_human"]),
  reasons: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  modelProfile: z.object({
    modelId: z.string().nullable(),
    provider: z.string().nullable(),
    adapter: z.string().nullable(),
    profileKnown: z.boolean(),
    toolCalls: z.string().optional(),
    streamingToolCalls: z.string().optional(),
  }),
  recommendedAction: z.string().nullable(),
  createdAt: z.number().int(),
  // event_log row created_at (joined-in by the diagnostics builder so the
  // panel can sort by occurrence even when payload createdAt drifts).
  eventAt: z.number().int(),
});
export type TaskDegradationSummaryView = z.infer<typeof TaskDegradationSummaryViewSchema>;

export const SupplierSignalSummaryViewSchema = z.object({
  taskId: z.string(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  adapter: z.string().nullable(),
  degraded: z.boolean(),
  reasons: z.array(z.string()),
  streamTruncatedSeen: z.boolean(),
  truthfulnessViolationSeen: z.boolean(),
  truthfulnessCategory: z.string().nullable(),
  eventAt: z.number().int(),
}).passthrough();
export type SupplierSignalSummaryView = z.infer<typeof SupplierSignalSummaryViewSchema>;

export const TruthfulnessViolationViewSchema = z.object({
  taskId: z.string(),
  category: z.string(),
  fabricatedTools: z.array(z.string()),
  claimsCount: z.number().int().nonnegative(),
  eventAt: z.number().int(),
}).passthrough();
export type TruthfulnessViolationView = z.infer<typeof TruthfulnessViolationViewSchema>;

export const DegradationDiagnosticsSchema = z.object({
  latestSummary: TaskDegradationSummaryViewSchema.nullable(),
  latestSupplierSignal: SupplierSignalSummaryViewSchema.nullable(),
  latestTruthfulnessViolation: TruthfulnessViolationViewSchema.nullable(),
  recentSummaries: z.array(TaskDegradationSummaryViewSchema),
});
export type DegradationDiagnostics = z.infer<typeof DegradationDiagnosticsSchema>;

// M7.6 Card 125 — Action UI Intent backend view-model schemas. Mirror
// the types in `src/actionUiIntents.ts`; both kept in sync. The
// component.props field is `z.unknown()` because each component name
// has its own loose shape (DegradationCard sees a different prop set
// than PauseCard); v1 trusts the backend builder and renders defensively.
export const ActionUiIntentSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  sourceEventType: z.string(),
  sourceEventAt: z.number().int(),
  type: z.enum([
    "agent.degradation",
    "agent.pause",
    "generic.tool_event",
    "generic.event",
  ]),
  priority: z.enum(["primary", "secondary", "debug"]),
  title: z.string(),
  summary: z.string().optional(),
  component: z.object({
    name: z.enum([
      "DegradationCard",
      "PauseCard",
      "GenericToolEventCard",
      "GenericEventCard",
    ]),
    props: z.unknown(),
  }),
  placementHint: z.object({
    region: z.enum(["top", "feed", "debug"]),
    size: z.enum(["compact", "medium", "large"]),
    focusPath: z.string().nullable().optional(),
  }),
  safety: z.object({
    rawPayloadHidden: z.boolean(),
    truncated: z.boolean(),
  }),
  createdAt: z.number().int(),
});
export type ActionUiIntent = z.infer<typeof ActionUiIntentSchema>;

export const InspectSnapshotSchema = z.object({
  ladder: z.array(LadderTierEntrySchema),
  trace: z.array(TraceEventSchema),
  toolEvents: z.array(ToolEventSchema),
  debugRaw: z.unknown(),
  // Card 110 — most-recent ContentHub audit events. Newest-first. Empty
  // array when ContentHub has not been touched in the visible window.
  contentAudit: z.array(ContentAuditEventSchema).optional(),
  // Card 114 — aggregated evidence-pack view computed by ContentHubAgent
  // over the same audit rows. Best-effort: cross-DO fetch failures leave
  // this field undefined without breaking the rest of the snapshot.
  contentEvidence: ContentAuditSummarySchema.optional(),
  // M7.5 Card 121 — read-only degradation diagnostics. Indexed view of
  // events Cards 117/119/102 already log into event_log. Optional so a DO
  // with no degradation events yet returns clean.
  degradationDiagnostics: DegradationDiagnosticsSchema.optional(),
  // M7.6 Card 125 — Action UI Intent index for Action-aware Gen UI.
  // Derived on read from event_log; capped at 30 newest-first. Optional
  // so older clients ignore the field; Card 126 frontend will consume.
  actionUiIntents: z.array(ActionUiIntentSchema).optional(),
});
export type InspectSnapshot = z.infer<typeof InspectSnapshotSchema>;

/**
 * M7.2 Card 82 — workspace file manager (read-only).
 * Maps `@cloudflare/shell` `Workspace.readDir` / `readFile` / `stat` outputs
 * into a stable contract the web client consumes. Hidden paths
 * (`.dev.vars`, `.env`, `.wrangler`, `node_modules`, `.git`) are filtered
 * server-side so the web never sees them — see `src/workspaceFiles.ts`.
 */

export const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

export const WorkspaceFileListSchema = z.object({
  path: z.string(),
  entries: z.array(WorkspaceFileEntrySchema),
});
export type WorkspaceFileList = z.infer<typeof WorkspaceFileListSchema>;

export const WorkspaceFileContentSchema = z.object({
  path: z.string(),
  text: z.string(),
  size: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type WorkspaceFileContent = z.infer<typeof WorkspaceFileContentSchema>;

/**
 * M7.2 Card 83 — Tier 3 headless browser tool contract.
 *
 * The agent (and the smoke endpoint) sends `BrowserRunRequest` and gets back
 * `BrowserRunResult`. SSRF defenses + size caps live in `src/browser.ts`.
 */

export const BrowserRunRequestSchema = z.object({
  url: z.string().url().max(2048),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  extract: z.array(z.enum(["summary", "text", "links", "screenshot"])).max(4).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});
export type BrowserRunRequest = z.infer<typeof BrowserRunRequestSchema>;

export const BrowserLinkSchema = z.object({
  text: z.string(),
  href: z.string(),
});
export type BrowserLink = z.infer<typeof BrowserLinkSchema>;

export const BrowserRunResultSchema = z.object({
  url: z.string(),
  finalUrl: z.string().nullable(),
  status: z.number().int().nullable(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  links: z.array(BrowserLinkSchema).nullable(),
  screenshotBase64: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});
export type BrowserRunResult = z.infer<typeof BrowserRunResultSchema>;

/**
 * M7.2 Card 84 — Agent Memory v1.
 * See docs/design/agent-memory-v1.md for the full design.
 *
 * Taxonomy mirrors Cloudflare's Agent Memory blog (2026-04-17): facts,
 * instructions, events, tasks. Profile boundary = DO instance (single
 * `agent-thursday-dev` today). No vector / RRF / ingest in v1.
 */

export const MemoryTypeSchema = z.enum(["fact", "instruction", "event", "task"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryEntrySchema = z.object({
  id: z.number().int(),
  type: MemoryTypeSchema,
  key: z.string().nullable(),
  content: z.string(),
  source: z.string(),
  confidence: z.number().nullable(),
  active: z.boolean(),
  supersedesId: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MemoryRecallMatchSchema = z.object({
  id: z.number().int(),
  type: MemoryTypeSchema,
  key: z.string().nullable(),
  content: z.string(),
  score: z.number(),
  createdAt: z.number().int(),
});
export type MemoryRecallMatch = z.infer<typeof MemoryRecallMatchSchema>;

/**
 * GET /api/memory snapshot. Compact, leak-free shape for Web user layer.
 * Counts by type + recent active facts/instructions/events/tasks.
 * Card 84 §F-18: "show active facts/instructions and recent events/tasks".
 */
export const MemorySnapshotSchema = z.object({
  counts: z.object({
    fact: z.number().int(),
    instruction: z.number().int(),
    event: z.number().int(),
    task: z.number().int(),
    inactive: z.number().int(),
  }),
  recentFacts: z.array(MemoryEntrySchema),
  recentInstructions: z.array(MemoryEntrySchema),
  recentEvents: z.array(MemoryEntrySchema),
  recentTasks: z.array(MemoryEntrySchema),
});
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

/**
 * M7.3 Card 85 — ChannelHub envelopes & storage row schemas.
 *
 * Provider-agnostic. Discord-first but no schema field is Discord-specific.
 * See `docs/milestones/M7.3-multi-channel-communication-middle-layer.md`
 * and `docs/design/M7.3-review-notes.md`.
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
 * Outbound discriminated union. P0 has `text` (Card 85) + `approval` (Card 88).
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
 * Card 88 — Hermes-style approval card. Rendered to Discord as a text
 * fallback + structured `approval` block so the bridge can attach buttons
 * if its surface supports them. Scope buttons mirror Hermes:
 * once / session / always / deny. `always` is gated behind an env flag
 * (Card 88 §C-13); when gating is on, the bridge should hide/disable that
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
 * Card 93: `busy-skip` is distinct from `wait` — `wait` consumes the row
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
 * Storage row reads (snapshot endpoint). Status enum mirrors §D-11 in card 85.
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
  // Card 87 — route metadata; null when row hasn't been routed yet.
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
  // Card 88 — kind and approval link.
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
   * Card 93: number of rows whose decision was `busy-skip` — i.e. would
   * have processed but the agent was busy. These rows remain `received`
   * (not consumed) and will be reconsidered by the next routePending call.
   */
  busySkipped: z.number().int(),
  decisions: z.array(z.object({
    inboxId: z.string(),
    providerMessageId: z.string(),
    action: z.enum(["process", "ignore", "wait", "escalate", "busy-skip"]),
    reason: z.string(),
    finalStatus: ChannelInboxStatusSchema,
    handoffTaskId: z.string().nullable(),
  })),
});
export type ChannelRoutePendingResult = z.infer<typeof ChannelRoutePendingResultSchema>;

/**
 * Card 88 — outbound enqueue / deliver / approval-resolve API contracts.
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

// ============================================================================
// M7.4 Card 107 — ContentHub: provider-agnostic content source layer.
//
// Card 107 ships schemas + a hardcoded `agentthursday-github` registry entry only.
// Card 108/109 fill in real GitHub network reads/list/search.
//
// Design constraints (ADR §3, §4):
//   - `ContentRevision` is a discriminated union from day 1, never a bare
//     string — cache key uses JSON.stringify(revision).
//   - `ContentRef` provenance is mandatory on every future read/list/search
//     result (ADR §3.2: "agent 可信引用外部资料"的能力).
//   - Connector contract stays MCP-tool-shape compatible so v2+ can split
//     OAuth/multi-tenant connectors into independent MCP server Workers
//     without changing the agent-facing tool model.
// ============================================================================

export const ContentProviderSchema = z.enum([
  "github", "artifact", "onedrive", "dropbox", "gdrive",
  "notion", "confluence", "email", "web", "local-fs", "other",
]);
export type ContentProvider = z.infer<typeof ContentProviderSchema>;

export const ContentRevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git-sha"), sha: z.string(), ref: z.string().optional() }),
  z.object({ kind: z.literal("etag"), etag: z.string() }),
  z.object({ kind: z.literal("provider-version"), versionId: z.string() }),
  z.object({ kind: z.literal("updated-at"), updatedAt: z.number().int(), weak: z.literal(true) }),
  z.object({ kind: z.literal("snapshot"), snapshotId: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type ContentRevision = z.infer<typeof ContentRevisionSchema>;

export const ContentPermissionScopeSchema = z.enum(["read", "write-request", "write"]);
export type ContentPermissionScope = z.infer<typeof ContentPermissionScopeSchema>;

export const ContentCacheStatusSchema = z.enum(["hit", "miss", "fresh"]);
export type ContentCacheStatus = z.infer<typeof ContentCacheStatusSchema>;

export const ContentRefSchema = z.object({
  sourceId: z.string(),
  provider: ContentProviderSchema,
  pathOrId: z.string(),
  title: z.string().optional(),
  revision: ContentRevisionSchema,
  revisionLabel: z.string().optional(),
  fetchedAt: z.number().int(),
  permissionScope: ContentPermissionScopeSchema,
  cacheStatus: ContentCacheStatusSchema.optional(),
});
export type ContentRef = z.infer<typeof ContentRefSchema>;

export const ContentSourceScopeSchema = z.enum(["project", "personal", "team", "channel", "public", "fixture"]);
export type ContentSourceScope = z.infer<typeof ContentSourceScopeSchema>;

export const ContentSourceAuthModeSchema = z.enum(["public", "secret", "oauth", "mcp", "browser", "none"]);
export type ContentSourceAuthMode = z.infer<typeof ContentSourceAuthModeSchema>;

// M7.4 v2 Card 112 — explicit per-source capability declaration. Forward
// compatible: undefined `capabilities` on existing v1 sources is permitted
// and treated as "all true" by callers that haven't adopted the field yet.
// Card 113 fan-out search will filter sources by `capabilities.search:true`
// instead of provider-name matching, so honest declarations matter.
export const ContentSourceCapabilitiesSchema = z.object({
  read: z.boolean(),
  list: z.boolean(),
  search: z.boolean(),
  health: z.boolean(),
});
export type ContentSourceCapabilities = z.infer<typeof ContentSourceCapabilitiesSchema>;

export const ContentSourceSchema = z.object({
  id: z.string(),
  provider: ContentProviderSchema,
  label: z.string(),
  scope: ContentSourceScopeSchema,
  access: ContentPermissionScopeSchema,
  authMode: ContentSourceAuthModeSchema,
  defaultRef: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  maxFileBytes: z.number().int().positive().optional(),
  capabilities: ContentSourceCapabilitiesSchema.optional(),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const ContentSourceHealthSchema = z.object({
  ok: z.boolean(),
  // v1 = "registry-only" (no network probe). Card 108/109 will add "live"
  // (real GitHub probe) and "degraded" (rate-limited / partial).
  mode: z.enum(["registry-only", "live", "degraded"]),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  checkedAt: z.number().int(),
});
export type ContentSourceHealth = z.infer<typeof ContentSourceHealthSchema>;

export const ContentSourceWithHealthSchema = z.object({
  source: ContentSourceSchema,
  health: ContentSourceHealthSchema.optional(),
});
export type ContentSourceWithHealth = z.infer<typeof ContentSourceWithHealthSchema>;

export const ContentSourcesResponseSchema = z.object({
  sources: z.array(ContentSourceWithHealthSchema),
});
export type ContentSourcesResponse = z.infer<typeof ContentSourcesResponseSchema>;

// File entry for list results — used by Card 108+.
export const ContentFileEntrySchema = z.object({
  name: z.string(),
  pathOrId: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().optional(),
});
export type ContentFileEntry = z.infer<typeof ContentFileEntrySchema>;

export const ContentRedactionSchema = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  kind: z.enum(["api-key", "oauth-token", "pem-block", "other"]),
});
export type ContentRedaction = z.infer<typeof ContentRedactionSchema>;

export const ContentReadResultSchema = z.object({
  ref: ContentRefSchema,
  content: z.string(),                    // v1 utf-8 text only; binary path is v1.5+ (Card 115)
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  truncatedBytes: z.number().int().nonnegative().optional(),
  redactions: z.array(ContentRedactionSchema).optional(),
});
export type ContentReadResult = z.infer<typeof ContentReadResultSchema>;

export const ContentListResultSchema = z.object({
  ref: ContentRefSchema,
  entries: z.array(ContentFileEntrySchema),
  truncated: z.boolean().optional(),
});
export type ContentListResult = z.infer<typeof ContentListResultSchema>;

export const ContentSearchHitSchema = z.object({
  ref: ContentRefSchema,
  line: z.number().int().positive().optional(),
  preview: z.string(),
});
export type ContentSearchHit = z.infer<typeof ContentSearchHitSchema>;

// Search modes per ADR §7.1: default `api-search` is fail-loud on quota
// exhaustion; `degraded-grep` is opt-in via `strategy: "bounded-local"` and
// always carries `searchCoverage: "partial"`.
export const ContentSearchModeSchema = z.enum(["api-search", "degraded-grep"]);
export type ContentSearchMode = z.infer<typeof ContentSearchModeSchema>;

export const ContentSearchCoverageSchema = z.enum(["full", "partial"]);
export type ContentSearchCoverage = z.infer<typeof ContentSearchCoverageSchema>;

// Card 108 — request/response envelopes for content_list and content_read.
// Discriminated `{ ok: true, result } | { ok: false, error }` shape so both
// the API endpoint and the LLM tool wrapper can forward without exception
// machinery. `error.code` enumerates the structured failure modes Card 108
// produces; the list grows in Card 109+.

export const ContentErrorCodeSchema = z.enum([
  // Path policy
  "path-traversal",
  "absolute-path",
  "backslash",
  "null-byte",
  "denied",
  "not-allowed",
  // Source / config
  "source-not-found",
  "no-repo-mapping",
  "token-missing",
  // GitHub
  "ref-not-found",
  "unauthorized",
  "forbidden-or-rate-limited",
  "ref-resolve-failed",
  "not-found",
  "fetch-failed",
  "list-failed",
  "not-a-directory",
  "no-body",
  // Card 109 — search
  "quota-exhausted",
  "code-search-failed",
  "search-failed",
  // Card 113 — multi-source fan-out
  "capability-not-supported",
  // Generic fallback
  "internal",
]);
export type ContentErrorCode = z.infer<typeof ContentErrorCodeSchema>;

// Card 113 — per-source result/error state for multi-source fan-out.
// Each entry carries provenance even on failure so the agent can tell which
// source succeeded and which didn't, without a single source's failure
// silently swallowing another source's hits. `ok:true` populates `hits` (+
// the optional searchMode/coverage fields); `ok:false` populates errorCode
// + reason and leaves hits absent (NOT empty array — absence is the signal).
export const ContentSearchPerSourceStateSchema = z.object({
  sourceId: z.string(),
  provider: ContentProviderSchema.optional(),
  ok: z.boolean(),
  hits: z.array(ContentSearchHitSchema).optional(),
  searchMode: ContentSearchModeSchema.optional(),
  searchCoverage: ContentSearchCoverageSchema.optional(),
  searchedPaths: z.array(z.string()).optional(),
  omittedReason: z.string().optional(),
  errorCode: ContentErrorCodeSchema.optional(),
  reason: z.string().optional(),
  httpStatus: z.number().int().nullable().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type ContentSearchPerSourceState = z.infer<typeof ContentSearchPerSourceStateSchema>;

export const ContentSearchResultSchema = z.object({
  hits: z.array(ContentSearchHitSchema),
  searchMode: ContentSearchModeSchema.optional(),
  searchCoverage: ContentSearchCoverageSchema.optional(),
  searchedPaths: z.array(z.string()).optional(),
  omittedReason: z.string().optional(),
  // Card 113 — multi-source fan-out result. Present iff the request used
  // `sourceIds`. In that mode top-level `hits` is an empty array and the
  // agent MUST consume `perSource[]` for grouped results — flat aggregation
  // would lose source-level provenance, which the audit and ContentRef
  // contract both depend on.
  perSource: z.array(ContentSearchPerSourceStateSchema).optional(),
});
export type ContentSearchResult = z.infer<typeof ContentSearchResultSchema>;

export const ContentErrorSchema = z.object({
  code: ContentErrorCodeSchema,
  reason: z.string(),
  sourceId: z.string().optional(),
  path: z.string().optional(),
  status: z.number().int().nullable().optional(),
  // Card 109 §7.1 — quota / upstream-failure errors carry an explicit
  // fallback hint so the caller can opt in to `strategy: "bounded-local"`.
  // Only set on search errors; other endpoints leave these undefined.
  fallbackAvailable: z.boolean().optional(),
  fallbackHint: z.string().optional(),
});
export type ContentError = z.infer<typeof ContentErrorSchema>;

export const ContentReadResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentReadResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentReadResponse = z.infer<typeof ContentReadResponseSchema>;

export const ContentListResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentListResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentListResponse = z.infer<typeof ContentListResponseSchema>;

export const ContentReadRequestSchema = z.object({
  sourceId: z.string().min(1),
  path: z.string().min(1).max(1024),
  ref: z.string().min(1).max(200).optional(),
  maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
});
export type ContentReadRequest = z.infer<typeof ContentReadRequestSchema>;

export const ContentListRequestSchema = z.object({
  sourceId: z.string().min(1),
  path: z.string().max(1024),                 // "" or "/" allowed for top-level
  ref: z.string().min(1).max(200).optional(),
});
export type ContentListRequest = z.infer<typeof ContentListRequestSchema>;

// Card 109 — request/response envelopes for content_search. Mirrors the
// Card 108 read/list discriminated-union pattern so clients forward errors
// without exception machinery. Default strategy is `api-search` (fail-loud
// on quota); `bounded-local` is opt-in degraded grep over the connector's
// list+read path, always carries `searchCoverage:"partial"`.
export const ContentSearchRequestSchema = z.object({
  // Card 113 — `sourceId` and `sourceIds` are mutually exclusive, fail-loud:
  //  - exactly one must be provided
  //  - presenting both, or neither, is a 400 at the request boundary
  // Single-source mode (`sourceId`) keeps Card 109 behavior unchanged.
  // Multi-source mode (`sourceIds`) returns a `perSource` array; top-level
  // `hits` is empty stub to preserve schema shape.
  sourceId: z.string().min(1).optional(),
  sourceIds: z.array(z.string().min(1)).min(1).max(10).optional(),
  query: z.string().min(1).max(500),
  path: z.string().max(1024).optional(),
  ref: z.string().min(1).max(200).optional(),
  strategy: z.enum(["api-search", "bounded-local"]).optional(),
  maxResults: z.number().int().positive().max(100).optional(),
}).refine(
  d => (d.sourceId !== undefined) !== (d.sourceIds !== undefined),
  { message: "must provide exactly one of `sourceId` or `sourceIds`, not both and not neither" },
);
export type ContentSearchRequest = z.infer<typeof ContentSearchRequestSchema>;

export const ContentSearchResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentSearchResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentSearchResponse = z.infer<typeof ContentSearchResponseSchema>;

// Connector contract — TS interface, not zod (it's an internal shape, not
// API-surface JSON). Card 108 adds the GitHub implementation.
export interface ContentSourceConnector {
  readonly meta: ContentSource;

  readonly capabilities: {
    read: boolean;
    list: boolean;
    search: boolean;
    write: boolean;       // v2+
    watch: boolean;       // v2+
  };

  read(params: { path: string; ref?: string; maxBytes?: number }): Promise<ContentReadResult>;

  list(params: { path: string; ref?: string; recursive?: boolean }): Promise<ContentListResult>;

  search(params: {
    pattern: string;
    path?: string;
    ref?: string;
    maxResults?: number;
    strategy?: "api-search" | "bounded-local";
  }): Promise<ContentSearchResult>;

  health(): Promise<ContentSourceHealth>;
}
