/**
 * supplier-side degradation signal helpers.
 *
 *  (truthfulness gate) catches **user-facing claims** that don't
 * match dispatched tools. This module catches the complementary failure:
 * **supplier-side anomalies** in the model/adapter path itself
 * (missing finish_reason, tool calls extracted but not dispatched, stream
 * truncation errors). The two markers coexist; both can appear on the same
 * reply.
 *
 * Pure functions only. No I/O, no env access — the caller (AgentThursdayAgent)
 * collects per-step signals via `onStepFinish` and `onError`, then asks
 * `detectSupplierDegradation` for a verdict at reply finalization.
 */

export type SupplierDegradationReason =
  | "finish_reason_missing"
  | "tool_calls_present_but_not_dispatched"
  | "tool_calls_errored"
  | "stream_truncated_error";

/** One step's worth of supplier-side signal, captured from StepContext. */
export type SupplierStepSignal = {
  /**
   * The Think/AI-SDK finishReason for this step. The saga proved Workers AI
   * streaming on Llama family can drop this entirely; the adapter then
   * either reports `"unknown"` / `"other"` / `""` or raises a
   * stream-truncated error (see `errorPatternMatched`).
   */
  finishReason: string | undefined;
  toolCallCount: number;
  toolResultCount: number;
  /**
   *  (2a) — `tool-error` parts emitted by the AI SDK when a
   * tool's `execute()` throws (e.g. codemode `Code execution failed:
   * …` from a Workers Loader sandbox throw). `step.toolResults` (used
   * to derive `toolResultCount`) is a getter that filters
   * `step.content` to `type === "tool-result"` only — it excludes
   * `tool-error` by design (ai/dist/index.js:3913-3915). Counting
   * these separately stops `detectSupplierDegradation` from flagging
   * dispatched-and-errored tools as
   * `tool_calls_present_but_not_dispatched` (which previously fired
   * on  small-d traces where `execute` ran Node-only code and
   * threw inside the sandbox).
   */
  toolErrorCount: number;
  toolErrorNames: string[];
  /**
   * -1 — `needsApproval: true` tool calls (e.g.
   * `advance_kanban_card`) legitimately pause the round: the AI SDK
   * builds a `tool-approval-request` content part in place of a
   * `tool-result` / `tool-error` part, and `execute()` never fires
   * until the user confirms. Previously this module saw
   * `toolResultCount=0` / `toolErrorCount=0` on a step that did emit
   * a tool call, and tagged `tool_calls_present_but_not_dispatched`
   * — misclassifying the pause as supplier degradation (
   * RCA: prod task `task-mpby4jjw`). Counting approval-pending
   * separately, and adding it to the dispatched threshold, keeps the
   * real supplier-side dispatch gap detection working while letting
   * legitimate pauses pass.
   */
  toolApprovalPendingCount: number;
  /**
   *  — names extracted from `ctx.toolCalls` / `ctx.toolResults`.
   * Empty when the SDK didn't expose names (older versions, or shapes
   * the safe-access path couldn't resolve). Capped at the call site so
   * the persisted event payload stays compact and grep-friendly.
   */
  toolCallNames: string[];
  toolResultNames: string[];
};

/** Aggregate per-task supplier-side signals across all steps in one round. */
export type SupplierTaskSignals = {
  steps: SupplierStepSignal[];
  /**
   * Set true if `onError` saw a stream-truncated-shaped error during the
   * round. Matched against a small allowlist of substrings; we never store
   * the raw error string in state to avoid leaking provider payload.
   */
  streamTruncatedSeen: boolean;
};

export function emptySupplierTaskSignals(): SupplierTaskSignals {
  return { steps: [], streamTruncatedSeen: false };
}

/**
 * Substrings on the error message that indicate a stream-truncated /
 * finish_reason regression. Kept tight to avoid false positives — only
 * flag patterns we've actually seen in the Llama saga or the
 * workers-ai-provider source.
 */
const STREAM_TRUNCATED_PATTERNS = [
  "stream-truncated",
  "stream truncated",
  "no finish reason",
  "finish_reason missing",
] as const;

export function isStreamTruncatedError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const msg = (typeof err === "string" ? err : (err as { message?: string })?.message) ?? "";
  if (!msg) return false;
  const lc = msg.toLowerCase();
  return STREAM_TRUNCATED_PATTERNS.some(p => lc.includes(p));
}

/**
 * A finishReason value is treated as "missing" only when the adapter
 * returned us nothing actionable. We do NOT flag "stop" / "tool-calls" /
 * "length" / "content-filter" — those are real, normal terminal reasons.
 *
 * Conservative on purpose: kanban specifies "no marker is better than
 * noisy marker in v1". Models that legitimately end on "unknown" or
 * "other" should not trigger; we flag those only when paired with a
 * tool-call presence signal (handled in detectSupplierDegradation).
 */
function isFinishReasonAbsent(fr: string | undefined): boolean {
  if (fr === undefined || fr === null) return true;
  const norm = String(fr).trim().toLowerCase();
  if (norm === "") return true;
  return false;
}

function isFinishReasonAmbiguous(fr: string | undefined): boolean {
  if (isFinishReasonAbsent(fr)) return false;
  const norm = String(fr).trim().toLowerCase();
  return norm === "unknown" || norm === "other" || norm === "error";
}

export function detectSupplierDegradation(t: SupplierTaskSignals): {
  degraded: boolean;
  reasons: SupplierDegradationReason[];
} {
  const reasons = new Set<SupplierDegradationReason>();

  if (t.streamTruncatedSeen) {
    reasons.add("stream_truncated_error");
  }

  for (const step of t.steps) {
    //  (2a) + 279c-1 — count dispatched-and-resulted,
    // dispatched-and-errored, and approval-pending tool calls alongside
    // each other before deciding whether the call was *not dispatched*.
    //
    // - `step.toolResults` filters to `type === "tool-result"` (AI SDK
    //   ai/dist/index.js:3913); tool-error parts (execute() threw) and
    //   approval-pending parts (`needsApproval: true`, execute() didn't
    //   fire) are excluded from that getter.
    // - Before , a thrown tool was misclassified as not
    //   dispatched; before -1, an approval-pending tool was
    //   misclassified the same way (prod task `task-mpby4jjw`).
    //
    // The dispatched-or-pending count covers all three "the call was
    // accounted for" outcomes; only a tool-call with no matching part
    // (i.e. the supplier emitted a call structurally but the framework
    // never produced a corresponding state) still trips the reason.
    const dispatchedCount =
      step.toolResultCount + step.toolErrorCount + step.toolApprovalPendingCount;

    // Reason 1: model emitted tool_calls but the framework didn't end up
    // dispatching them at all. The saga's defining symptom — adapter
    // saw the call structurally, dispatch never landed.
    if (step.toolCallCount > 0 && dispatchedCount < step.toolCallCount) {
      reasons.add("tool_calls_present_but_not_dispatched");
    }

    // Reason 1b ( 2a): at least one tool was dispatched and
    // its `execute()` threw. The call DID happen; the throw is real
    // (e.g. codemode "Code execution failed: …" from a sandbox
    // violation). Surfacing this as a distinct reason lets reviewers
    // distinguish "supplier didn't dispatch" (the original failure
    // mode) from "tool dispatched and errored" (often a legitimate
    // bug in the agent-generated code).
    if (step.toolErrorCount > 0) {
      reasons.add("tool_calls_errored");
    }

    // Reason 2: finishReason is absent/ambiguous AND the step had tool
    // intent. Bare "unknown" on a content-only step isn't worth flagging
    // (too noisy); paired with a tool_call_count > 0 it matches the
    // Llama-streaming finish_reason regression shape almost exactly.
    if (
      step.toolCallCount > 0 &&
      (isFinishReasonAbsent(step.finishReason) || isFinishReasonAmbiguous(step.finishReason))
    ) {
      reasons.add("finish_reason_missing");
    }
  }

  const reasonsArr: SupplierDegradationReason[] = [];
  for (const r of ["finish_reason_missing", "tool_calls_present_but_not_dispatched", "tool_calls_errored", "stream_truncated_error"] as const) {
    if (reasons.has(r)) reasonsArr.push(r);
  }
  return { degraded: reasonsArr.length > 0, reasons: reasonsArr };
}

/**
 * Render the user-facing warning marker. Chinese by default per kanban
 * §"Suggested marker text" — operator's primary operating language for this
 * project is Chinese, and this aligns with the  warning style.
 *
 * `reasons` go in as compact enum tokens (already grep-friendly), comma-
 * joined. We deliberately don't expand into natural language — the goal
 * is mechanical scannability for reviewers, not user-friendly prose.
 */
export function renderSupplierDegradationWarning(reasons: SupplierDegradationReason[]): string {
  return `⚠️ 本轮模型 supplier 侧信号异常（${reasons.join(", ")}）— 结果可能不可靠，请复核后再采纳。`;
}
