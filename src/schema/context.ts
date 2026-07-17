import { z } from "zod";

// Action UI Intent backend view-model schemas live in `./agent`.
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
  // Token / pressure stats are deferred to an earlier revision. v1 returns null so
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
  // current model resolution surface. Makes the four
  // semantic layers (configured / lastObserved / effective / per-use
  // selection) visible to inspect/debug so a future routing policy
  // landing won't surprise consumers. Optional so older clients keep
  // working; new client reads it from inspect.
  currentModelResolution: z
    .object({
      configured: z.object({
        provider: z.string().nullable(),
        modelId: z.string().nullable(),
      }).nullable(),
      lastObserved: z.object({
        provider: z.string().nullable(),
        modelId: z.string().nullable(),
      }).nullable(),
      effective: z.object({
        provider: z.string().nullable(),
        modelId: z.string().nullable(),
      }).nullable(),
      budgetModel: z.object({
        provider: z.string().nullable(),
        modelId: z.string().nullable(),
        source: z.enum(["configured", "observed", "effective", "fallback", "conservative"]),
      }).nullable(),
      awarenessModel: z.object({
        provider: z.string().nullable(),
        modelId: z.string().nullable(),
        source: z.enum(["configured", "observed", "effective", "fallback"]),
      }).nullable(),
    })
    .optional(),
});
export type ContextInspectResult = z.infer<typeof ContextInspectResultSchema>;
export type CurrentModelResolution = NonNullable<ContextInspectResult["currentModelResolution"]>;

export const ContextResetResultSchema = z.object({
  ok: z.boolean(),
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nonnegative(),
  reason: z.string().nullable(),
  preservedDurableState: z.boolean(),
  timestamp: z.number().int(),
});
export type ContextResetResult = z.infer<typeof ContextResetResultSchema>;

// M7.7v3 Context history / new-context (v1 reset-style fallback).
// True multi-DO context switching is deferred to an earlier revision; v1 closes the
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
  // M7.7v3 per-context DO routing flips this to `true` for
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

// M7.7v3 switch active context to an existing context_history
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

// M7.7 v2 Context snapshot for anchor-aware planning. Mirrors
// `buildContextSnapshot` in `src/contextLifecycle.ts`. `parts` reuses the
// passthrough an earlier revision schema so any future part shapes ride forward
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

// M7.7 v2 deterministic anchor classifier output. Per-message
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

// M7.7 v2 compact plan / apply split. The plan is a read-only
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

// M7.7 v2 medium-tier anchors lifted into the compact
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

// M7.7 v2 semantic summary advisor audit. Optional + emitted
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
