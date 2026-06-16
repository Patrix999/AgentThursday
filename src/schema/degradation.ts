import { z } from "zod";

// degradation diagnostics surface compact view schemas.
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
