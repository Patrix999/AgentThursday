import type { ContextInspectResult } from "../../shared/schema";

/**
 * Context pressure classifier.
 *
 * Pure helper, no React. Maps an earlier revision's `inspectContext` payload to a
 * legible pressure state plus a recommendation. Heuristic — does NOT
 * pretend to know the model's exact context window. Thresholds are
 * centralized here so dogfood tuning is a one-file change.
 *
 * Honesty rules:
 *   - if `data` is null → `unknown` (NOT pretending it's empty)
 *   - if token stats are null → don't claim 0; the caller renders
 *     "unavailable" via `tokenAvailability`
 */

export type ContextPressureLevel = "empty" | "normal" | "growing" | "high" | "unknown";

export type ContextPressure = {
  level: ContextPressureLevel;
  label: string;
  reason: string;
  recommendation?: string;
  tokenAvailability: "session-only" | "task-only" | "both" | "neither";
};

// Tunable thresholds — keep co-located so a single edit re-tunes the whole UI.
export const PRESSURE_THRESHOLDS = {
  growingMessages: 40,
  highMessages: 80,
  growingTaskTokens: 8_000,
  highTaskTokens: 24_000,
} as const;

const TONE = {
  empty: { label: "empty", color: "slate" },
  normal: { label: "normal", color: "emerald" },
  growing: { label: "growing", color: "amber" },
  high: { label: "high", color: "orange" },
  unknown: { label: "unknown", color: "slate" },
} as const;

export function classifyContextPressure(data: ContextInspectResult | null): ContextPressure {
  if (!data) {
    return {
      level: "unknown",
      label: TONE.unknown.label,
      reason: "Inspect data unavailable.",
      tokenAvailability: "neither",
    };
  }

  const tokenAvailability = pickTokenAvailability(data);
  const total = data.totalMessageCount;
  const taskTok = data.tokenTask?.total ?? null;

  if (total === 0) {
    return {
      level: "empty",
      label: TONE.empty.label,
      reason: "No messages yet.",
      tokenAvailability,
    };
  }

  const isHigh = total > PRESSURE_THRESHOLDS.highMessages
    || data.truncated
    || (taskTok !== null && taskTok > PRESSURE_THRESHOLDS.highTaskTokens);

  if (isHigh) {
    return {
      level: "high",
      label: TONE.high.label,
      reason: buildHighReason(total, data.truncated, taskTok),
      recommendation: "Consider reset or compact after preserving useful state.",
      tokenAvailability,
    };
  }

  const isGrowing = total > PRESSURE_THRESHOLDS.growingMessages
    || (taskTok !== null && taskTok > PRESSURE_THRESHOLDS.growingTaskTokens);

  if (isGrowing) {
    return {
      level: "growing",
      label: TONE.growing.label,
      reason: buildGrowingReason(total, taskTok),
      recommendation: "Context is growing; inspect before long runs.",
      tokenAvailability,
    };
  }

  return {
    level: "normal",
    label: TONE.normal.label,
    reason: `${total} message${total === 1 ? "" : "s"}, no truncation.`,
    tokenAvailability,
  };
}

function pickTokenAvailability(data: ContextInspectResult): ContextPressure["tokenAvailability"] {
  const hasSession = data.tokenSession !== null;
  const hasTask = data.tokenTask !== null;
  if (hasSession && hasTask) return "both";
  if (hasSession) return "session-only";
  if (hasTask) return "task-only";
  return "neither";
}

function buildHighReason(total: number, truncated: boolean, taskTok: number | null): string {
  const reasons: string[] = [];
  if (total > PRESSURE_THRESHOLDS.highMessages) reasons.push(`${total} messages`);
  if (truncated) reasons.push("inspect truncated");
  if (taskTok !== null && taskTok > PRESSURE_THRESHOLDS.highTaskTokens) {
    reasons.push(`task tokens ${taskTok.toLocaleString()}`);
  }
  return reasons.join(" · ");
}

function buildGrowingReason(total: number, taskTok: number | null): string {
  const reasons: string[] = [];
  if (total > PRESSURE_THRESHOLDS.growingMessages) reasons.push(`${total} messages`);
  if (taskTok !== null && taskTok > PRESSURE_THRESHOLDS.growingTaskTokens) {
    reasons.push(`task tokens ${taskTok.toLocaleString()}`);
  }
  return reasons.join(" · ");
}

/**
 * Tailwind classes for the pressure pill — co-located so the helper
 * stays the single source of truth for level → color.
 */
export function pressurePillClasses(level: ContextPressureLevel): string {
  switch (level) {
    case "empty":
      return "bg-slate-800/80 text-slate-400 border border-slate-700";
    case "normal":
      return "bg-emerald-900/50 text-emerald-200 border border-emerald-800/60";
    case "growing":
      return "bg-amber-900/50 text-amber-200 border border-amber-800/60";
    case "high":
      return "bg-orange-900/60 text-orange-200 border border-orange-700/70";
    case "unknown":
      return "bg-slate-800/80 text-slate-400 border border-slate-700";
  }
}
