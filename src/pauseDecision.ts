/**
 * dialogue-style pause-loop decision helpers.
 *
 * Pure functions for:
 *   - reading the runtime config gate (`AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN`)
 *   - deciding whether the current task should pause based on its
 *     freshly-derived `TaskDegradationSummary` () — task-local
 *     scope only, no global-latest joins (per  verifier patch
 *     invariant)
 *   - rendering the conversational pause message that the agent appends
 *     to the user-facing reply (operator hard requirement: no new buttons,
 *     no approval-card UI; resume must be natural-language reply)
 *   - detecting whether a follow-up user message is a natural-language
 *     resume confirmation (`继续` / `proceed` / `resume` / etc.)
 *   - rendering a short reminder when the user sends non-resume text while
 *     the loop is paused
 *
 * v1 invariants (per kanban + milestone red lines):
 *   - Only `state === "needs_human"` triggers pause; never `degraded`,
 *     never `blocked`, never `normal`.
 *   - Config must be read at decision time, not cached at module load,
 *     so a `wrangler secret put` change is effective on the next loop
 *     decision without a code redeploy.
 *   - No automatic routing changes (no retry / switch / fallback).
 *   - Pause text never includes prompts, raw replies, raw provider
 *     payloads, raw Discord messages, or secrets — only enum/short-id
 *     fields already vetted by Cards 117/119.
 */

import type { TaskDegradationSummary } from "./degradationSummary";

/**
 * Read the pause feature gate from the worker env. Truthy values:
 * `"true"` / `"1"` / `"yes"` / `"enabled"` (case-insensitive, trimmed).
 * Anything else (including undefined) → disabled.
 *
 * Read at decision time so a secret/var rotation takes effect on the
 * next relevant `submitTask` call without redeploying code.
 */
export function isPauseEnabled(env: { AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN?: string }): boolean {
  const v = env.AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "true" || norm === "1" || norm === "yes" || norm === "enabled";
}

/**
 * Decide whether the current task's loop should pause for human
 * confirmation. Three conditions, all required:
 *   1. config enabled
 *   2. summary belongs to the current task (task-local scope; never
 *      pause on a stale `needs_human` summary from a prior task)
 *   3. `state === "needs_human"`
 */
export function shouldPauseForNeedsHuman(
  configEnabled: boolean,
  summary: TaskDegradationSummary,
  currentTaskId: string,
): boolean {
  if (!configEnabled) return false;
  if (summary.taskId !== currentTaskId) return false;
  return summary.state === "needs_human";
}

/**
 * Resume-intent patterns. Strict so casual reply text doesn't accidentally
 * resume — the user must explicitly confirm in a short, mechanical phrase.
 * Non-resume text while paused should receive a conversational reminder,
 * not advance the current loop.
 */
const RESUME_PATTERNS: readonly RegExp[] = [
  /^\s*(?:继续|确认继续|我确认继续|同意继续|确认|确认。|继续。)\s*$/,
  /^\s*(?:proceed|resume|continue|go|go ahead|ok\s+proceed|ok\s+continue)\s*\.?$/i,
];

export function isResumeIntent(userText: string | null | undefined): boolean {
  if (!userText) return false;
  const trimmed = userText.trim();
  if (!trimmed) return false;
  return RESUME_PATTERNS.some(re => re.test(trimmed));
}

/**
 * Render the user-visible pause message. Appended to `replyText` after
 * the supplier marker () and truthfulness marker (),
 * so the user sees the full diagnostic stack from broad to specific:
 *   1.  supplier marker (if any)
 *   2.  truthfulness marker (if any)
 *   3. Original assistant reply
 *   4.  pause message (this one)
 *
 * The pause message is structured but conversational — no buttons, no
 * inline JSON; just plain prose so it works identically over Discord,
 * CLI, and web surfaces.
 */
export function renderAwaitingResumeMessage(taskId: string | null | undefined): string {
  return [
    "当前任务仍处于暂停状态，我还没有继续执行。",
    taskId ? `Task: ${taskId}` : null,
    "如果你确认继续，请直接回复「继续」或「proceed」。",
    "如果你想修改任务，请先说明“取消当前暂停任务”或重新给出明确指令。",
  ].filter(Boolean).join("\n");
}

export function renderPauseMessage(summary: TaskDegradationSummary): string {
  const reasons = summary.reasons.length > 0 ? summary.reasons.join(", ") : "—";
  const evidence = summary.evidenceRefs.length > 0 ? summary.evidenceRefs.join(", ") : "—";
  const action = summary.recommendedAction ?? "—";
  const profile = summary.modelProfile;
  const profileLine = profile.profileKnown
    ? `Model: ${profile.modelId ?? "—"} (toolCalls=${profile.toolCalls ?? "?"}, streaming=${profile.streamingToolCalls ?? "?"})`
    : `Model: ${profile.modelId ?? "—"} (profile unknown)`;
  return [
    "⏸ 我暂停了当前任务，需要你确认后再继续。",
    "",
    "原因：运行时降级判断为 needs_human",
    `Task: ${summary.taskId}`,
    `Reasons: ${reasons}`,
    `Evidence: ${evidence}`,
    profileLine,
    `Action: ${action}`,
    "",
    "如果你确认继续，请回复「继续」或「proceed」。"
  ].join("\n");
}
