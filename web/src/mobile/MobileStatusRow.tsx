import { useEffect, useState } from "react";
import { PrimaryNav } from "../nav/PrimaryNav";
import type { InspectSnapshot, WorkspaceSnapshot } from "../../shared/schema";
import { GithubLink } from "../components/GithubLink";
import { ContextIndicatorChip } from "../context/ContextIndicatorDialog";
import { ActiveAgentSelector } from "../agents/ActiveAgentSelector";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  lastRefreshedAt: number | null;
  inspectSnapshot: InspectSnapshot | null;
};

const STALE_AFTER_MS = 10_000;

/**
 * mobile-only compact status row.
 *
 * Replaces the desktop `TopStatusBar` on the mobile branch of
 * `Workspace.tsx`. Single row, target ≤ 56px height, four signals
 * plus a context indicator chip. the operator's non-negotiable for 156b:
 * mobile home must show a context indicator and it must be
 * tap-accessible (not hover-driven). an earlier revision — the chip
 * opens the read-only `ContextIndicatorDialog` (which mirrors the
 * desktop ContextRail's information density); it does NOT navigate
 * to `/inspect#context` and is unaffected by `AGENT_THURSDAY_DEBUG_SURFACE_MODE`.
 *
 * Data sources match the desktop `TopStatusBar`:
 *   - `WorkspaceSnapshot.session.{instanceName, agentState}` and `currentTask`
 *   - shared `InspectSnapshot.degradationDiagnostics.latestSummary`
 *     for model + degradation state.
 *
 * Privacy: reads only metadata (instance name, model id, degradation
 * label, lifecycle, agent state). No prompt / SOUL / tool payload.
 */
export function MobileStatusRow({ snapshot, lastRefreshedAt, inspectSnapshot }: Props) {
  const session = snapshot?.session;
  const task = snapshot?.currentTask;
  const stateLabel = session?.agentState ?? "loading";
  const stale = useStale(lastRefreshedAt);
  const summary = inspectSnapshot?.degradationDiagnostics?.latestSummary ?? null;
  const modelId = summary?.modelProfile?.modelId ?? null;
  const degradationState = summary?.state ?? null;

  return (
    <header
      className="sticky top-0 z-10 px-3 py-2 bg-slate-900 border-b border-slate-800 lg:hidden"
      data-testid="mobile-status-row"
    >
      {/* context chip lives in its own non-scrolling slot
          at the leading edge of the row so it is *always* visible at
          360px without horizontal scroll. The remaining pills go into
          a separate `min-w-0 overflow-x-auto` track to its right;
          when they don't fit, that track scrolls — the chip never
          moves. the operator reviewed 156b1 and said "没有看到 context indicator";
          this restructure fixes the discoverability gap. */}
      <div className="flex items-center gap-2 text-xs">
        {/* active cloud agent selector in the leading
            non-scrolling slot, before the context chip. Same
            semantics as desktop: picking flips composer/snapshot
            routing to the picked agent's DO. */}
        <ActiveAgentSelector variant="mobile" />
        {/* context chip is an always-visible indicator, not debug surface. */}
        <ContextIndicatorChip
          instanceName={session?.instanceName}
          testId="mobile-context-chip"
          className="shrink-0 inline-flex items-center gap-1 rounded border border-cyan-700/60 bg-cyan-950/60 px-2 py-1 text-cyan-200 hover:bg-cyan-900/60 active:bg-cyan-900/80"
        />
        <div className="min-w-0 flex-1 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <AgentStateDot state={stateLabel} />
          <DegradationPill state={degradationState} />
          {task?.lifecycle && <Pill label="task" value={task.lifecycle} tone="slate" />}
          {modelId && (
            <Pill label="model" value={shortModelLabel(modelId)} />
          )}
          {stale && (
            <span
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200"
              title="No update in 10s+"
            >
              stale
            </span>
          )}
        </div>
        {/* unified primary nav in the non-scrolling trailing
            slot, alongside GitHub, so it stays tappable on 360px. */}
        <PrimaryNav variant="mobile" />
        {/* an earlier revision §D — keep the GitHub link in a non-scrolling
            trailing slot so it's always tappable on 360px without
            being pushed out by overflowing pills. */}
        <GithubLink className="shrink-0 inline-flex items-center justify-center text-slate-400 hover:text-slate-100 active:text-slate-100 px-1.5 py-1 rounded" />
      </div>
    </header>
  );
}

function Pill({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" }) {
  return (
    <span className="shrink-0 inline-flex items-baseline gap-1 rounded bg-slate-800/80 px-2 py-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className={`font-mono text-slate-200 ${tone === "slate" ? "" : ""}`}>{value}</span>
    </span>
  );
}

function AgentStateDot({ state }: { state: string }) {
  const cls =
    state === "running" ? "bg-sky-500"
    : state === "waiting" ? "bg-amber-400"
    : state === "completed" ? "bg-emerald-500"
    : state === "loading" ? "bg-slate-500"
    : "bg-slate-600";
  return (
    <span className="shrink-0 inline-flex items-center gap-1" title={`agent state: ${state}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
      <span className="text-slate-300">{state}</span>
    </span>
  );
}

function DegradationPill({ state }: { state: string | null }) {
  const label = state ?? "—";
  const cls =
    state === "normal" ? "bg-emerald-950/60 text-emerald-300"
    : state === "degraded" ? "bg-amber-900/60 text-amber-200"
    : state === "blocked" ? "bg-rose-900/60 text-rose-200"
    : state === "needs_human" ? "bg-sky-900/60 text-sky-200"
    : "bg-slate-800 text-slate-400";
  return (
    <span
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono ${cls}`}
      title={`Runtime degradation: ${label}`}
    >
      deg:{label === "—" ? "—" : label.slice(0, 3)}
    </span>
  );
}

function shortModelLabel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

// `contextChipLabel` / `shortContextId` / `shortInstanceName`
// moved to `web/src/components/contextChip.ts` for reuse with the
// desktop `TopStatusBar` chip. Mobile keeps the existing tight 10-char
// `ctx_<6>…` form by leaving `maxLen` at the helper's default.

function useStale(lastAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (lastAt === null) return false;
  return now - lastAt > STALE_AFTER_MS;
}
