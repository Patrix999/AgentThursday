import type { InspectSnapshot } from "../../shared/schema";

/**
 * M7.5 Card 121 — small banner showing the latest task's degradation
 * summary above the inspect tabs. Read-only: renders state, reasons,
 * model profile, evidenceRefs, and recommendedAction. No interactivity,
 * no behavior change. State color-codes are visual only — they don't
 * trigger any pause/retry/switch in v1 (Card 120 will own that).
 */
export function DegradationBanner({
  diagnostics,
}: {
  diagnostics: InspectSnapshot["degradationDiagnostics"] | null | undefined;
}) {
  if (!diagnostics || !diagnostics.latestSummary) {
    return null;
  }
  const s = diagnostics.latestSummary;
  const tone = stateTone(s.state);
  const profile = s.modelProfile;
  return (
    <div className={`border-b ${tone.border} ${tone.bg} px-4 py-2 text-xs`}>
      <div className="flex items-center gap-2">
        <span className={`uppercase font-mono px-1.5 py-0.5 rounded ${tone.badge}`}>
          {s.state}
        </span>
        <span className="text-slate-400 font-mono">runtime degradation</span>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {s.reasons.length > 0 && (
          <>
            <dt className="text-slate-500">reasons</dt>
            <dd className={`${tone.text} font-mono break-all`}>
              {s.reasons.join(", ")}
            </dd>
          </>
        )}
        <dt className="text-slate-500">model</dt>
        <dd className="text-slate-300 font-mono break-all">
          {profile.modelId ?? "—"}{" "}
          <span className="text-slate-500">
            ({profile.profileKnown ? "profile known" : "profile unknown"}
            {profile.toolCalls && `, toolCalls ${profile.toolCalls}`}
            {profile.streamingToolCalls && `, streaming ${profile.streamingToolCalls}`}
            )
          </span>
        </dd>
        {s.evidenceRefs.length > 0 && (
          <>
            <dt className="text-slate-500">evidence</dt>
            <dd className="text-slate-400 font-mono break-all">
              {s.evidenceRefs.join(", ")}
            </dd>
          </>
        )}
        {s.recommendedAction && (
          <>
            <dt className="text-slate-500">action</dt>
            <dd className="text-slate-200 break-words">{s.recommendedAction}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function stateTone(state: "normal" | "degraded" | "blocked" | "needs_human"): {
  border: string;
  bg: string;
  badge: string;
  text: string;
} {
  switch (state) {
    case "normal":
      return {
        border: "border-slate-800",
        bg: "bg-slate-900/40",
        badge: "bg-slate-800 text-slate-300",
        text: "text-slate-300",
      };
    case "degraded":
      return {
        border: "border-amber-800/60",
        bg: "bg-amber-950/20",
        badge: "bg-amber-900/60 text-amber-200",
        text: "text-amber-200",
      };
    case "blocked":
      return {
        border: "border-rose-800/60",
        bg: "bg-rose-950/20",
        badge: "bg-rose-900/60 text-rose-200",
        text: "text-rose-200",
      };
    case "needs_human":
      return {
        border: "border-sky-800/60",
        bg: "bg-sky-950/20",
        badge: "bg-sky-900/60 text-sky-200",
        text: "text-sky-200",
      };
  }
}
