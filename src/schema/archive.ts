import { z } from "zod";

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
