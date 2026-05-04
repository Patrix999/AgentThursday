import { z } from "zod";

/**
 * Unified Object Model Schema and Worker Contract
 *
 * Single source of truth for the data the new Web shell (),
 * Current Task View (), and inspect surface () consume.
 * Built so 76 → 77/78 → 79 → 80/81 do not have to invent shapes.
 *
 * Legacy → new mapping (kept here so future readers can navigate):
 *
 *   legacy name                      | source module          | new location
 *   ---------------------------------|------------------------|-------------------------------------
 *   taskObject (TaskObject)          | M2 task lifecycle      | TaskView
 *   cliSession (CliSession)          | M3 cli session         | SessionView
 *   lastActionResult (ActionResult)  |  action result     | ArtifactView (kind="actionResult")
 *   developerLoopReview              | M2 reviewer            | summary text → MessageView (kind="summary")
 *                                    |                        | + traces → TraceEvent[] (inspect)
 *   pendingToolApproval              |  tool approval     | ApprovalView (kind="tool")
 *   pendingKanbanMutations[]         | M2 mutation            | ApprovalView (kind="mutation")
 *   debugTrace.recentToolEvents[]    |  trace             | ToolEvent[] (inspect only)
 *   debugTrace.lastLadderTier        |  ladder            | TaskView.ladderTier + .ladderReason
 *   debugTrace.lastAssistantSummary  |                    | MessageView (kind="assistant")
 *   deliverableGate.deliverable      | M2 deliverable         | ArtifactView (kind="deliverable")
 *
 *  user-layer reads only:
 *   session, currentTask, summaryStream, pendingApproval, replyNeed, latestResult
 *  inspect-layer reads only:
 *   inspectEntry (presence flags) + GET /api/inspect (full data)
 *
 * The /cli/* legacy endpoints stay live for TUI; a follow-up cleanup card
 * will retire them after  ships.
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
  // canonical active context identity (registry
  // `context_active` pointer). The client uses this to reconcile its
  // localStorage cache: if the value differs, the client updates
  // `agent-thursday.contextId` and re-fetches under the canonical id. Carries
  // ONLY the identity string; never any system prompt / SOUL / tool
  // payload / hidden context content.
  activeContextId: z.string(),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/**
 * Inspect surface shapes — the real data producer arrives in .
 *  only declares the contract and ships a stub returning empty arrays.
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

// ContentHub audit events surfaced via /api/inspect. Field shape
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

// ContentHub evidence pack (aggregated audit summary). Sits next
// to 's raw `contentAudit` rows, NOT replacing them. Three pivot
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

// degradation diagnostics surface compact view schemas.
// These mirror the JSON payloads emitted by  events.
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

// Action UI Intent backend view-model schemas. Mirror
// the types in `src/actionUiIntents.ts`; both kept in sync. The
// component.props field is `z.unknown()` because each component name
// has its own loose shape (DegradationCard sees a different prop set
// than PauseCard); v1 trusts the backend builder and renders defensively.
// Context lifecycle (inspect / reset) view-model schemas.
// Mirror the types in `src/contextLifecycle.ts`. `parts` is a discriminated
// union in the helper; expressed here as one passthrough object so future
// part shapes ride forward without breaking the API.
export const ContextInspectMessagePartSchema = z.object({
  type: z.enum(["text", "tool", "other"]),
}).passthrough();

export const ContextInspectMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(ContextInspectMessagePartSchema),
  partsDropped: z.number().int().nonnegative(),
});

export const ContextInspectResultSchema = z.object({
  totalMessageCount: z.number().int().nonnegative(),
  byRole: z.object({
    user: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    system: z.number().int().nonnegative(),
  }),
  visibleMessages: z.array(ContextInspectMessageSchema),
  visibleStartIndex: z.number().int().nonnegative(),
  truncated: z.boolean(),
  sanitizedAt: z.number().int(),
  // Token / pressure stats are deferred to . v1 returns null so
  // the panel can render a placeholder without a schema break later.
  tokenSession: z.object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).nullable(),
  tokenTask: z.object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).nullable(),
  // context budget surface. Rail displays "全高 = 模型
  // context window"; numbers only, no SOUL / system prompt / tool schema
  // text leaks here. v1 uses chars/4 estimation (no tokenizer dep) and
  // a small per-model max-window mapping; unknown models report
  // `source:"unavailable"` and the UI falls back to message-stack mode.
  contextBudget: z.object({
    modelMaxTokens: z.number().int().nonnegative().nullable(),
    // three-layer threshold policy from
    // `contextWindowRegistry.ts`. `softCompactAt` (default ratio 0.5)
    // is a UI hint only; `autoCompactAt` (0.7) is the hygiene loop
    // trigger; `dangerAt` (0.85) is the red line. Old clients that
    // only know `autoCompactAt` / `dangerAt` keep working; new client
    // reads `softCompactAt` to draw the third threshold line.
    softCompactAt: z.number().int().nonnegative().nullable().optional(),
    autoCompactAt: z.number().int().nonnegative().nullable(),
    dangerAt: z.number().int().nonnegative().nullable(),
    usedTokens: z.number().int().nonnegative().nullable(),
    visibleDialogTokens: z.number().int().nonnegative().nullable(),
    systemOverheadTokens: z.number().int().nonnegative().nullable(),
    systemOverheadBreakdown: z.object({
      systemPrompt: z.number().int().nonnegative().optional(),
      soul: z.number().int().nonnegative().optional(),
      tools: z.number().int().nonnegative().optional(),
      skills: z.number().int().nonnegative().optional(),
      other: z.number().int().nonnegative().optional(),
    }),
    source: z.enum(["estimated", "provider", "unavailable"]),
  }),
});
export type ContextInspectResult = z.infer<typeof ContextInspectResultSchema>;

export const ContextResetResultSchema = z.object({
  ok: z.boolean(),
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nonnegative(),
  reason: z.string().nullable(),
  preservedDurableState: z.boolean(),
  timestamp: z.number().int(),
});
export type ContextResetResult = z.infer<typeof ContextResetResultSchema>;

// v3 Context history / new-context (v1 reset-style fallback).
// True multi-DO context switching is deferred to ; v1 closes the
// active context_history row, opens a new one with a fresh contextId, and
// clears messages in the same DO. Old transcripts are NOT preserved (only
// the audit row + per-context event_log entries survive); this limitation
// is recorded explicitly in `rawMessagesPreservedInOldContext`.
export const ActiveContextSchema = z.object({
  contextId: z.string(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
});
export type ActiveContext = z.infer<typeof ActiveContextSchema>;

export const ContextHistoryEntrySchema = z.object({
  contextId: z.string(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  messageCountAtEnd: z.number().int().nullable(),
  isActive: z.boolean(),
});
export type ContextHistoryEntry = z.infer<typeof ContextHistoryEntrySchema>;

export const ContextHistoryListSchema = z.object({
  contexts: z.array(ContextHistoryEntrySchema),
});
export type ContextHistoryList = z.infer<typeof ContextHistoryListSchema>;

export const NewContextResultSchema = z.object({
  ok: z.boolean(),
  previousContextId: z.string(),
  newContextId: z.string(),
  reason: z.string().nullable(),
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nonnegative(),
  preservedDurableState: z.boolean(),
  // v3 per-context DO routing flips this to `true` for
  // contexts created from v2 onwards. v1-era contexts (created before
  // routing was in place) are still flagged `false` in their original
  // audit rows because their raw transcripts were cleared in the
  // single-DO model. Live result of `newContext` always reports `true`
  // under v2 because it never clears messages.
  rawMessagesPreservedInOldContext: z.boolean(),
  // Free-form note for forward compatibility — v1 used this to flag the
  // reset-style fallback; v2 uses it to confirm per-context routing is
  // active and to point at the routing semantics.
  v1FallbackNote: z.string(),
  timestamp: z.number().int(),
});
export type NewContextResult = z.infer<typeof NewContextResultSchema>;

// v3 switch active context to an existing context_history
// id. Audit-only on the registry DO; per-context DOs continue to own
// their messages independently. `previousContextId` may equal
// `newContextId` if the operator switches to the already-active context
// (no-op success).
export const SwitchContextResultSchema = z.object({
  ok: z.boolean(),
  previousContextId: z.string(),
  newContextId: z.string(),
  reason: z.string().nullable(),
  activatedAt: z.number().int(),
});
export type SwitchContextResult = z.infer<typeof SwitchContextResultSchema>;

// Conversation Archive ingestion. `drainForArchive`
// runs on a per-context DO and returns its full sanitized message log
// (no `lastN` cap, intentionally — the  public snapshot caps
// at 200 which would silently truncate older contexts during
// archival). `archiveChunks` runs on the registry DO and writes the
// chunks into the canonical `conversation_archive` table.
export const ArchiveChunkInputSchema = z.object({
  messageId: z.string(),
  messageIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  indexText: z.string(),
  isSyntheticCompaction: z.boolean(),
});
export type ArchiveChunkInput = z.infer<typeof ArchiveChunkInputSchema>;

export const DrainForArchiveResultSchema = z.object({
  contextId: z.string(),
  snapshotAt: z.number().int(),
  chunks: z.array(ArchiveChunkInputSchema),
  totalMessageCount: z.number().int().nonnegative(),
});
export type DrainForArchiveResult = z.infer<typeof DrainForArchiveResultSchema>;

export const ArchiveTriggerSchema = z.enum(["context.new", "context.reset", "manual"]);
export type ArchiveTrigger = z.infer<typeof ArchiveTriggerSchema>;

export const ArchiveChunksInputSchema = z.object({
  contextId: z.string(),
  trigger: ArchiveTriggerSchema,
  chunks: z.array(ArchiveChunkInputSchema),
  reason: z.string().nullable().optional(),
});
export type ArchiveChunksInput = z.infer<typeof ArchiveChunksInputSchema>;

export const ArchiveFlushResultSchema = z.object({
  flushId: z.string(),
  contextId: z.string(),
  trigger: z.string(),
  chunkCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  status: z.enum(["ok", "failed", "skipped"]),
  error: z.string().nullable(),
  archivedAt: z.number().int(),
});
export type ArchiveFlushResult = z.infer<typeof ArchiveFlushResultSchema>;

// `conversation_search` over the registry's
// `conversation_archive`. Defaults: cross-context (no `contextId`
// filter); topK clamped to [1, 10] with default 3; snippet cap 300
// chars per hit. Hits include source refs but NOT raw tool payloads
// or system content ( sanitization preserved upstream during
// archive ingestion).
export const ConversationSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  contextId: z.string().optional(),
  fromTimestamp: z.number().int().optional(),
  toTimestamp: z.number().int().optional(),
  role: z.enum(["user", "assistant", "system"]).optional(),
  topK: z.number().int().positive().max(10).optional(),
  snippetCap: z.number().int().positive().max(2000).optional(),
  // Caller-supplied audit identity; logged but not used for filtering.
  callerContextId: z.string().optional(),
  callerTaskId: z.string().optional(),
  traceId: z.string().optional(),
});
export type ConversationSearchInput = z.infer<typeof ConversationSearchInputSchema>;

export const ConversationSearchHitSchema = z.object({
  chunkId: z.string(),
  contextId: z.string(),
  messageId: z.string().nullable(),
  messageIndex: z.number().int().nonnegative().nullable(),
  role: z.string().nullable(),
  trigger: z.string(),
  archivedAt: z.number().int(),
  snippet: z.string(),
  matchReason: z.string(),
  isSyntheticCompaction: z.boolean(),
});
export type ConversationSearchHit = z.infer<typeof ConversationSearchHitSchema>;

export const ConversationSearchResultSchema = z.object({
  ok: z.boolean(),
  retrievalId: z.string(),
  query: z.string(),
  topK: z.number().int().positive(),
  snippetCap: z.number().int().positive(),
  hits: z.array(ConversationSearchHitSchema),
  resultCount: z.number().int().nonnegative(),
  searchedAt: z.number().int(),
  // Echoed back for caller transparency. The audit row records the
  // same values plus filters_json.
  filters: z.object({
    contextId: z.string().nullable(),
    fromTimestamp: z.number().int().nullable(),
    toTimestamp: z.number().int().nullable(),
    role: z.string().nullable(),
  }),
});
export type ConversationSearchResult = z.infer<typeof ConversationSearchResultSchema>;

// archive / retrieval Inspect surface. Read-only
// summary the operator inspects to see what was archived, what was
// searched, and where failures landed. Hard-capped so the default
// payload never carries full archive text.
export const ArchiveFlushRowSchema = z.object({
  flushId: z.string(),
  contextId: z.string(),
  trigger: z.string(),
  chunkCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  status: z.enum(["ok", "failed", "skipped"]),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
});
export type ArchiveFlushRow = z.infer<typeof ArchiveFlushRowSchema>;

export const RetrievalLogRowSchema = z.object({
  retrievalId: z.string(),
  query: z.string(), // already capped server-side
  filtersJson: z.string().nullable(),
  returnedRefs: z.array(z.object({
    chunkId: z.string(),
    contextId: z.string(),
  })),
  callerContextId: z.string().nullable(),
  callerTaskId: z.string().nullable(),
  traceId: z.string().nullable(),
  resultCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type RetrievalLogRow = z.infer<typeof RetrievalLogRowSchema>;

export const ArchiveContextCountSchema = z.object({
  contextId: z.string(),
  trigger: z.string(),
  chunkCount: z.number().int().nonnegative(),
  latestArchivedAt: z.number().int(),
});
export type ArchiveContextCount = z.infer<typeof ArchiveContextCountSchema>;

export const ArchiveInspectSummarySchema = z.object({
  // Aggregated counters for the dashboard top.
  totals: z.object({
    archiveChunkTotal: z.number().int().nonnegative(),
    archiveContextCount: z.number().int().nonnegative(),
    flushTotal: z.number().int().nonnegative(),
    flushFailedTotal: z.number().int().nonnegative(),
    retrievalTotal: z.number().int().nonnegative(),
  }),
  recentFlushes: z.array(ArchiveFlushRowSchema),
  recentRetrievals: z.array(RetrievalLogRowSchema),
  countsByContext: z.array(ArchiveContextCountSchema),
  generatedAt: z.number().int(),
});
export type ArchiveInspectSummary = z.infer<typeof ArchiveInspectSummarySchema>;

// Continuous Context Hygiene loop v1.
// `runContextHygiene` evaluates context pressure and decides:
//   - skipped: pressure below threshold, nothing to do
//   - proposed: pressure high but a risk gate fired; plan recorded but
//     not applied
//   - auto-applied: pressure high, all gates clear; 
//     applyCompactPlan succeeded
//   - failed: applyCompactPlan threw or returned partial rejection
// Manual-trigger only in v1; scheduled triggers are opt-in via a
// future card.
export const HygieneTriggerSchema = z.enum([
  "manual-check",
  "scheduled",
  "pressure-threshold",
]);
export type HygieneTrigger = z.infer<typeof HygieneTriggerSchema>;

export const HygieneRunInputSchema = z.object({
  trigger: HygieneTriggerSchema.optional(),
  pressureThreshold: z.number().int().positive().optional(),
  // When true (default), apply when safe; when false, always
  // produce a proposal without applying. Useful for dry-run probes
  // that just want to see what hygiene would do.
  autoApply: z.boolean().optional(),
});
export type HygieneRunInput = z.infer<typeof HygieneRunInputSchema>;

export const HygieneDecisionSchema = z.enum([
  "skipped",
  "proposed",
  "auto-applied",
  "failed",
]);
export type HygieneDecision = z.infer<typeof HygieneDecisionSchema>;

export const HygieneRiskConditionSchema = z.enum([
  "pending_tool_approval",
  "waiting_for_human",
  "current_obstacle_blocked",
  "auto_apply_disabled",
  "no_compactable_ranges",
  "below_pressure_threshold",
]);
export type HygieneRiskCondition = z.infer<typeof HygieneRiskConditionSchema>;

export const HygieneProposedRangeSchema = z.object({
  rangeId: z.string(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  messageCount: z.number().int().positive(),
  estimatedReduction: z.number().int().nonnegative(),
});

export const HygieneRunResultSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  trigger: HygieneTriggerSchema,
  decision: HygieneDecisionSchema,
  reason: z.string().nullable(),
  pressureMessageCount: z.number().int().nonnegative(),
  pressureThreshold: z.number().int().nonnegative(),
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nullable(),
  archiveFlushId: z.string().nullable(),
  appliedCompactPlanId: z.string().nullable(),
  riskConditions: z.array(HygieneRiskConditionSchema),
  proposedRanges: z.array(HygieneProposedRangeSchema),
  createdAt: z.number().int(),
});
export type HygieneRunResult = z.infer<typeof HygieneRunResultSchema>;

// auditable compact MVP. Mirrors `Session.addCompaction`
// shape; the `summaryPreview` here is capped server-side so a long
// summary doesn't bloat the inspect API. `compactedRangeSize` is the
// authoritative count of messages folded into this overlay (always
// meaningful even when `getMessages()` length is unchanged because
// the SDK overlay leaves the tree intact).
export const StoredCompactionViewSchema = z.object({
  id: z.string(),
  summaryPreview: z.string(),
  summaryLength: z.number().int().nonnegative(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  createdAt: z.string(),
});
export type StoredCompactionView = z.infer<typeof StoredCompactionViewSchema>;

export const CompactContextResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  // Range that was compacted (indices into `getMessages()` snapshot at
  // call time, inclusive on both ends).
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  compactedRangeSize: z.number().int().positive(),
  // Pre/post snapshots from the app-visible message view. Runtime smoke
  // showed this Think integration applies compaction overlays to
  // `getMessages()` as well as `Session.getHistory()`, while the SDK still
  // preserves the underlying stored message tree. Both values are surfaced
  // honestly so reviewers see exactly what happened.
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nonnegative(),
  modelVisibleAfter: z.number().int().nonnegative().nullable(),
  // Compaction record returned by `Session.addCompaction`.
  compaction: StoredCompactionViewSchema,
  summaryTruncated: z.boolean(),
  preservedDurableState: z.boolean(),
  timestamp: z.number().int(),
});
export type CompactContextResult = z.infer<typeof CompactContextResultSchema>;

export const CompactionsListSchema = z.object({
  compactions: z.array(StoredCompactionViewSchema),
});
export type CompactionsList = z.infer<typeof CompactionsListSchema>;

//  v2 Context snapshot for anchor-aware planning. Mirrors
// `buildContextSnapshot` in `src/contextLifecycle.ts`. `parts` reuses the
// passthrough  schema so any future part shapes ride forward
// without breaking the API. `compactedRanges` resolves message-ID
// endpoints against the FULL message log so unresolved entries
// (synthetic-as-from / no longer present) are surfaced honestly via
// `isResolvableInCurrentView:false` rather than silently dropped.
export const ContextSnapshotMessageSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(ContextInspectMessagePartSchema),
  partsDropped: z.number().int().nonnegative(),
  isSyntheticCompaction: z.boolean(),
  anchorEligible: z.boolean(),
});

export const ContextSnapshotCompactedRangeSchema = z.object({
  id: z.string(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  summaryPreview: z.string(),
  summaryLength: z.number().int().nonnegative(),
  createdAt: z.string(),
  fromIndex: z.number().int().nonnegative().nullable(),
  toIndex: z.number().int().nonnegative().nullable(),
  isResolvableInCurrentView: z.boolean(),
});

export const ContextSnapshotResultSchema = z.object({
  totalMessageCount: z.number().int().nonnegative(),
  visibleStartIndex: z.number().int().nonnegative(),
  messages: z.array(ContextSnapshotMessageSchema),
  compactedRanges: z.array(ContextSnapshotCompactedRangeSchema),
  messageIsSyntheticCompaction: z.record(z.string(), z.boolean()),
  sanitizedAt: z.number().int(),
});
export type ContextSnapshotResult = z.infer<typeof ContextSnapshotResultSchema>;

//  v2 deterministic anchor classifier output. Per-message
// classification (anchors AND non-anchors) so the planner can also see
// which messages are NOT preserved. `reasons` is a list, not a single
// label, so callers can audit every rule that fired.
export const ContextAnchorReasonSchema = z.enum([
  "first-k",
  "explicit-anchor",
  "rule-or-constraint",
  "long-user-briefing",
  "memory-or-workflow-instruction",
  "handoff-or-version-marker",
]);

export const ContextAnchorClassificationSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system"]),
  isAnchor: z.boolean(),
  reasons: z.array(ContextAnchorReasonSchema),
  confidence: z.enum(["high", "medium", "low"]),
  preview: z.string(),
});

export const ContextAnchorsResultSchema = z.object({
  snapshot: z.object({
    totalMessageCount: z.number().int().nonnegative(),
    visibleStartIndex: z.number().int().nonnegative(),
    sanitizedAt: z.number().int(),
  }),
  options: z.object({
    firstK: z.number().int().nonnegative(),
    lastN: z.number().int().positive(),
  }),
  anchors: z.array(ContextAnchorClassificationSchema),
  anchorCount: z.number().int().nonnegative(),
  classifiedAt: z.number().int(),
});
export type ContextAnchorsResult = z.infer<typeof ContextAnchorsResultSchema>;

//  v2 compact plan / apply split. The plan is a read-only
// dry-run proposal of safe ID-based compaction ranges; apply takes a plan
// back and re-runs all pre-flight checks against a fresh snapshot before
// each `addCompaction` call. No automatic compaction; no LLM summary.
export const CompactPlanInputSchema = z.object({
  lastN: z.number().int().positive().optional(),
  firstK: z.number().int().nonnegative().optional(),
  keepRecent: z.number().int().nonnegative().optional(),
  minRangeMessages: z.number().int().positive().optional(),
  pressureThreshold: z.number().int().nonnegative().optional(),
});
export type CompactPlanInput = z.infer<typeof CompactPlanInputSchema>;

export const CompactPlanStrategySchema = z.object({
  lastN: z.number().int().positive(),
  firstK: z.number().int().nonnegative(),
  keepRecent: z.number().int().nonnegative(),
  minRangeMessages: z.number().int().positive(),
  pressureThreshold: z.number().int().nonnegative(),
});

export const CompactPlanPreservedSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  preview: z.string(),
});

//  v2 medium-tier anchors lifted into the compact
// summary. Optional + omitted when empty so older plans / clients
// continue to parse cleanly.
export const SummaryPreservedAnchorSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  preview: z.string(),
});

export const CompactPlanRangeSchema = z.object({
  rangeId: z.string(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  messageCount: z.number().int().positive(),
  estimatedReduction: z.number().int().nonnegative(),
  previews: z.array(z.string()),
  summaryPreservedAnchors: z.array(SummaryPreservedAnchorSchema).optional(),
});

export const CompactPlanRejectionSchema = z.object({
  reason: z.string(),
  detail: z.string(),
});

export const CompactPlanResultSchema = z.object({
  planId: z.string(),
  strategy: CompactPlanStrategySchema,
  snapshot: z.object({
    totalMessageCount: z.number().int().nonnegative(),
    visibleStartIndex: z.number().int().nonnegative(),
    sanitizedAt: z.number().int(),
  }),
  pressure: z.object({
    beforeMessages: z.number().int().nonnegative(),
    estimatedAfterMessages: z.number().int().nonnegative(),
    estimatedReduction: z.number().int().nonnegative(),
  }),
  preserved: z.array(CompactPlanPreservedSchema),
  ranges: z.array(CompactPlanRangeSchema),
  rejected: z.array(CompactPlanRejectionSchema),
  createdAt: z.string(),
});
export type CompactPlanResult = z.infer<typeof CompactPlanResultSchema>;

//  v2 semantic summary advisor audit. Optional + emitted
// only when the advisor was invoked (input.semanticAdvisor === true on
// apply). `qualityFlags` documents validator outcomes; `fallbackReason`
// is null on success and populated when the deterministic summary was
// used instead.
export const SemanticSummaryAuditSchema = z.object({
  sourceCompactionId: z.string().nullable(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  deterministicSummaryHash: z.string(),
  semanticModel: z.string().nullable(),
  semanticPromptVersion: z.string(),
  trigger: z.enum(["manual", "high_pressure", "phase_boundary", "degradation_suspicion"]).nullable(),
  createdAt: z.string(),
  fallbackReason: z.string().nullable(),
  qualityFlags: z.array(z.string()),
  latencyMs: z.number().int().nullable(),
});

export const SemanticAdvisorAppliedSchema = z.object({
  ok: z.boolean(),
  audit: SemanticSummaryAuditSchema,
});

export const CompactPlanAppliedRangeSchema = z.object({
  rangeId: z.string(),
  compactionId: z.string(),
  fromMessageId: z.string(),
  toMessageId: z.string(),
  beforeCount: z.number().int().nonnegative(),
  afterCount: z.number().int().nonnegative(),
  semanticAdvisor: SemanticAdvisorAppliedSchema.optional(),
});

export const CompactPlanRejectedRangeSchema = z.object({
  rangeId: z.string(),
  reason: z.string(),
  detail: z.string(),
});

export const CompactPlanApplyResultSchema = z.object({
  ok: z.boolean(),
  planId: z.string(),
  appliedRanges: z.array(CompactPlanAppliedRangeSchema),
  rejectedRanges: z.array(CompactPlanRejectedRangeSchema),
  beforeCount: z.number().int().nonnegative(),
  afterCount: z.number().int().nonnegative(),
  deadRecordDetected: z.boolean(),
  timestamp: z.number().int(),
});
export type CompactPlanApplyResult = z.infer<typeof CompactPlanApplyResultSchema>;

export const ActionUiIntentSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  sourceEventType: z.string(),
  sourceEventAt: z.number().int(),
  // added 3 tool-specific intent types alongside 's
  // 4 baseline types. The new types upgrade specific tool families
  // (content_search / content_read / execute / sandbox_exec) from the
  // generic chrome to dedicated panels with whitelisted props.
  // added `tool.workspace_mutation` for write/edit-shaped
  // events (checkpoint writes and future tool.workspace.* prefix).
  type: z.enum([
    "agent.degradation",
    "agent.pause",
    "generic.tool_event",
    "generic.event",
    "tool.search_results",
    "tool.file_read",
    "tool.execution_result",
    "tool.workspace_mutation",
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
      "SearchResultsPanel",
      "FilePreviewPanel",
      "ExecutionResultPanel",
      "WorkspaceChangePanel",
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
  // most-recent ContentHub audit events. Newest-first. Empty
  // array when ContentHub has not been touched in the visible window.
  contentAudit: z.array(ContentAuditEventSchema).optional(),
  // aggregated evidence-pack view computed by ContentHubAgent
  // over the same audit rows. Best-effort: cross-DO fetch failures leave
  // this field undefined without breaking the rest of the snapshot.
  contentEvidence: ContentAuditSummarySchema.optional(),
  // read-only degradation diagnostics. Indexed view of
  // events  already log into event_log. Optional so a DO
  // with no degradation events yet returns clean.
  degradationDiagnostics: DegradationDiagnosticsSchema.optional(),
  // Action UI Intent index for Action-aware Gen UI.
  // Derived on read from event_log; capped at 30 newest-first. Optional
  // so older clients ignore the field;  frontend will consume.
  actionUiIntents: z.array(ActionUiIntentSchema).optional(),
});
export type InspectSnapshot = z.infer<typeof InspectSnapshotSchema>;

/**
 * workspace file manager (read-only).
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
 * Tier 3 headless browser tool contract.
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
 * Agent Memory v1.
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
 *  §F-18: "show active facts/instructions and recent events/tasks".
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
 * ChannelHub envelopes & storage row schemas.
 *
 * Provider-agnostic. Discord-first but no schema field is Discord-specific.
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
 * Outbound discriminated union. P0 has `text` () + `approval` ().
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
 * ( §C-13); when gating is on, the bridge should hide/disable that
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
 * : `busy-skip` is distinct from `wait` — `wait` consumes the row
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
   * : number of rows whose decision was `busy-skip` — i.e. would
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

// ============================================================================
// ContentHub: provider-agnostic content source layer.
//
//  ships schemas + a hardcoded `agentthursday-github` registry entry only.
// /109 fill in real GitHub network reads/list/search.
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

//  v2 explicit per-source capability declaration. Forward
// compatible: undefined `capabilities` on existing v1 sources is permitted
// and treated as "all true" by callers that haven't adopted the field yet.
//  fan-out search will filter sources by `capabilities.search:true`
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
  // v1 = "registry-only" (no network probe). /109 will add "live"
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

// File entry for list results — used by +.
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
  content: z.string(),                    // v1 utf-8 text only; binary path is v1.5+ ()
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

// request/response envelopes for content_list and content_read.
// Discriminated `{ ok: true, result } | { ok: false, error }` shape so both
// the API endpoint and the LLM tool wrapper can forward without exception
// machinery. `error.code` enumerates the structured failure modes 
// produces; the list grows in +.

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
  // search
  "quota-exhausted",
  "code-search-failed",
  "search-failed",
  // multi-source fan-out
  "capability-not-supported",
  // Generic fallback
  "internal",
]);
export type ContentErrorCode = z.infer<typeof ContentErrorCodeSchema>;

// per-source result/error state for multi-source fan-out.
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
  // multi-source fan-out result. Present iff the request used
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
  //  §7.1 — quota / upstream-failure errors carry an explicit
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

// request/response envelopes for content_search. Mirrors the
//  read/list discriminated-union pattern so clients forward errors
// without exception machinery. Default strategy is `api-search` (fail-loud
// on quota); `bounded-local` is opt-in degraded grep over the connector's
// list+read path, always carries `searchCoverage:"partial"`.
export const ContentSearchRequestSchema = z.object({
  // `sourceId` and `sourceIds` are mutually exclusive, fail-loud:
  //  - exactly one must be provided
  //  - presenting both, or neither, is a 400 at the request boundary
  // Single-source mode (`sourceId`) keeps  behavior unchanged.
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

// ────────────────────────────────────────────────────────────────────
// read-only memory candidate inspect surface.
//
// View-only schema for "things that *might* be worth promoting to
// long-term memory, but the operator hasn't acted on yet". v1 is a
// pure inspect surface: the candidates are derived from
// conversation_archive / message log / local conversation_search and
// returned to the caller, but **never written** to `agent_memories`.
// Promote / dismiss flows are explicitly out of scope ().
// ────────────────────────────────────────────────────────────────────

export const MemoryCandidateTypeSchema = z.enum([
  "fact",
  "instruction",
  "decision",
  "task",
  "event",
  "preference",
]);
export type MemoryCandidateType = z.infer<typeof MemoryCandidateTypeSchema>;

export const MemoryCandidateSourceRefSchema = z.object({
  /** Where the evidence came from. */
  kind: z.enum(["archive", "dialog", "search", "memory"]),
  /** Stable identifier within that source — archive `chunk_id`,
   *  dialog message index (stringified), search retrievalId, memory id. */
  ref: z.string(),
  /** Optional capped preview of the source content (caller-side
   *  windowing rules apply downstream; no raw payload here). */
  preview: z.string().optional(),
});
export type MemoryCandidateSourceRef = z.infer<typeof MemoryCandidateSourceRefSchema>;

export const MemoryCandidateDedupeHintSchema = z.object({
  /** Existing memory id this candidate likely supersedes / overlaps
   *  with. Read-only signal — v1 does not auto-supersede. */
  maybeExistingMemoryId: z.string().optional(),
  /** Short human-readable why we think they overlap (e.g. "shared
   *  key prefix" / "content substring match"). */
  similarityReason: z.string().optional(),
});
export type MemoryCandidateDedupeHint = z.infer<typeof MemoryCandidateDedupeHintSchema>;

export const MemoryCandidateInspectItemSchema = z.object({
  /** Stable id within this listing — caller can use for UI keys. */
  candidateId: z.string(),
  type: MemoryCandidateTypeSchema,
  /** Human-readable candidate text — already sanitized server-side
   *  (no SOUL / tool inputPreview / outputPreview / secrets). Capped
   *  by the candidate generator. */
  text: z.string(),
  sourceRefs: z.array(MemoryCandidateSourceRefSchema),
  /** Why the heuristic flagged this as candidate-worthy. Free-form
   *  short string, e.g. "explicit `请记下` request" / "repeated 3 times
   *  across archive". */
  reason: z.string(),
  /** 0..1 inclusive. Repetition / explicit-ask boost up; idle chatter
   *  pushed down. v1 thresholds are heuristic. */
  confidence: z.number().min(0).max(1),
  /** Null when no overlap with existing memory was found. */
  dedupeHint: MemoryCandidateDedupeHintSchema.nullable(),
});
export type MemoryCandidateInspectItem = z.infer<typeof MemoryCandidateInspectItemSchema>;

export const MemoryCandidatesResultSchema = z.object({
  ok: z.boolean(),
  /** When `ok === false` or generator chose to fail-safe, this
   *  describes why (e.g. "archive table empty" / "internal error"). */
  blockedReason: z.string().nullable(),
  /** Empty array on failure / no candidates / fail-safe path. */
  items: z.array(MemoryCandidateInspectItemSchema),
  /** Server timestamp (ms). */
  generatedAt: z.number().int(),
});
export type MemoryCandidatesResult = z.infer<typeof MemoryCandidatesResultSchema>;

// Connector contract — TS interface, not zod (it's an internal shape, not
// API-surface JSON).  adds the GitHub implementation.
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
