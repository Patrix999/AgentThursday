/**
 * M7.5 Card 119 — per-task degradation summary.
 *
 * Consumes:
 *   - Card 117 in-memory `SupplierTaskSignals` + truthfulness verdict
 *   - Card 118 `ModelProfile` registry (via `getModelProfile`)
 *   - final task lifecycle from `submitTask`
 *
 * Produces a single compact `TaskDegradationSummary` answering:
 *   "Is this task result usable, suspicious, blocked, or waiting for human?"
 *
 * v1 invariants (per kanban + M7.5 milestone red lines):
 *   - state literal contract `/degraded/blocked/needs_human` preserved
 *   - `recommendedAction` is review-oriented prose; never an automatic
 *     routing instruction (no "switch to model X" / "retry with Y")
 *   - conservative: most abnormal cases land in `degraded`; `needs_human`
 *     only when truthfulness violation + risky/unknown ModelProfile;
 *     `blocked` only when meaningful output is prevented (stream-truncated
 *     with zero dispatch) or final lifecycle failed
 *   - pure function — no I/O, no env, no SDK; caller (`AgentThursdayAgent`) does
 *     the `logEvent("degradation.summary", payload)`
 *   - never references prompts, replies, or raw provider payloads
 */

import {
  detectSupplierDegradation,
  type SupplierTaskSignals,
} from "./supplierSignal";
import {
  getModelProfile,
  type ToolCallsCapability,
  type StreamingToolCallsCapability,
} from "./modelProfiles";

export type DegradationState = "normal" | "degraded" | "blocked" | "needs_human";

export type TaskDegradationSummary = {
  taskId: string;
  state: DegradationState;
  reasons: string[];
  evidenceRefs: string[];
  modelProfile: {
    modelId: string | null;
    provider: string | null;
    adapter: string | null;
    profileKnown: boolean;
    toolCalls?: ToolCallsCapability;
    streamingToolCalls?: StreamingToolCallsCapability;
  };
  recommendedAction: string | null;
  createdAt: number;
};

export type TruthfulnessVerdictInput = {
  violationSeen: boolean;
  category: string | null;
};

export type DegradationSummaryInput = {
  taskId: string;
  supplierSignals: SupplierTaskSignals;
  truthfulnessVerdict: TruthfulnessVerdictInput;
  modelId: string | null;
  provider: string | null;
  adapter: string | null;
  /**
   * Final task lifecycle as a string. Only `"failed"` is acted on
   * (treated as `blocked`); other values pass through cleanly. Accepts
   * the broader `TaskLifecycle` set without coupling this helper to
   * server-side types.
   */
  finalLifecycle: string | null;
  now: number;
};

/**
 * Derive the 4-state task summary. Pure function: same inputs → same
 * output, no SDK calls, no event_log read.
 */
export function deriveTaskDegradationSummary(
  input: DegradationSummaryInput,
): TaskDegradationSummary {
  const supplierVerdict = detectSupplierDegradation(input.supplierSignals);
  const profile = getModelProfile(input.modelId);

  const reasons: string[] = [];
  const evidenceSet = new Set<string>();

  for (const r of supplierVerdict.reasons) reasons.push(r);
  if (supplierVerdict.degraded || input.supplierSignals.steps.length > 0) {
    evidenceSet.add("supplier.signal.summary");
  }

  if (input.truthfulnessVerdict.violationSeen) {
    if (input.truthfulnessVerdict.category === "fabricated-claim") {
      reasons.push("truthfulness_fabricated_claim");
    } else if (input.truthfulnessVerdict.category === "inline-json-without-dispatch") {
      reasons.push("truthfulness_inline_json_without_dispatch");
    } else {
      reasons.push("truthfulness_violation");
    }
    evidenceSet.add("tool.truthfulness.violation");
  }

  if (input.modelId && !profile) {
    reasons.push("model_profile_unknown");
  }

  // ─── State decision (conservative ordering) ─────────────────────────
  // Priority: blocked > needs_human > degraded > normal.
  // - blocked: meaningful output prevented or lifecycle failed
  // - needs_human: truthfulness violation under risky/unknown model
  //   profile (reviewer must arbitrate; can't trust either side cheaply)
  // - degraded: any other supplier or truthfulness anomaly
  // - normal: clean
  let state: DegradationState;

  const everyStepZeroDispatch = input.supplierSignals.steps.length > 0
    && input.supplierSignals.steps.every(s => s.toolResultCount === 0);
  const blockedByStreamTruncation =
    input.supplierSignals.streamTruncatedSeen && everyStepZeroDispatch;

  if (input.finalLifecycle === "failed" || blockedByStreamTruncation) {
    state = "blocked";
  } else if (input.truthfulnessVerdict.violationSeen) {
    const streaming = profile?.capabilities.streamingToolCalls;
    const profileSuggestsAmbiguity = !profile
      || streaming === "risky"
      || streaming === "unknown"
      || streaming === "unsupported";
    state = profileSuggestsAmbiguity ? "needs_human" : "degraded";
  } else if (supplierVerdict.degraded) {
    state = "degraded";
  } else {
    state = "normal";
  }

  // ─── recommendedAction (review-oriented; never automatic routing) ───
  let recommendedAction: string | null = null;
  if (state === "blocked") {
    recommendedAction = blockedByStreamTruncation
      ? "Review supplier signal evidence; the round was stream-truncated with no usable tool dispatch."
      : "Review final lifecycle and supplier signal evidence; the task did not complete cleanly.";
  } else if (state === "needs_human") {
    recommendedAction = "Manual review required: a claimed tool result was emitted under a risky or unknown model profile. Decide whether to trust the reply or rerun.";
  } else if (state === "degraded") {
    if (input.truthfulnessVerdict.violationSeen) {
      recommendedAction = "Manually verify claimed tool results before acting on the reply.";
    } else {
      recommendedAction = "Review supplier signal evidence; do not auto-trust tool results from this round.";
    }
  }

  const modelProfile: TaskDegradationSummary["modelProfile"] = profile
    ? {
        modelId: input.modelId,
        provider: input.provider,
        adapter: input.adapter,
        profileKnown: true,
        toolCalls: profile.capabilities.toolCalls,
        streamingToolCalls: profile.capabilities.streamingToolCalls,
      }
    : {
        modelId: input.modelId,
        provider: input.provider,
        adapter: input.adapter,
        profileKnown: false,
      };

  return {
    taskId: input.taskId,
    state,
    reasons,
    evidenceRefs: [...evidenceSet],
    modelProfile,
    recommendedAction,
    createdAt: input.now,
  };
}
