import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { useInspect } from "../hooks/useInspect";
import { contextChipLabel } from "../components/contextChip";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  lastRefreshedAt: number | null;
  onToggleInspect?: () => void; // desktop only
  inspectOpen?: boolean;
};

const STALE_AFTER_MS = 10_000;

/**
 * Top status bar. v2.5 ( v2.5) — relocated the task badges
 * (lifecycle / loopStage / ladderTier / readyForNextRound) here and
 * pulled in agent identity (instance name) + model (provider/model id)
 * + the  degradation summary state, so the bar is the single
 * place to check "what's running, on what model, in what state". The
 * task title itself is no longer rendered here — it's surfaced in the
 * main dialog (`SummaryStream`) as a user message instead.
 */
export function TopStatusBar({ snapshot, lastRefreshedAt, onToggleInspect, inspectOpen }: Props) {
  const session = snapshot?.session;
  const task = snapshot?.currentTask;
  const stateLabel = session?.agentState ?? "loading";
  const stale = useStale(lastRefreshedAt);

  // Pull model + degradation state from the inspect snapshot. We
  // already poll inspect from `ActivityFeed`; doing it here is a
  // duplicate poll for now (acceptable cost for v1; lift to a shared
  // hook later if it shows up in profiling).
  const inspect = useInspect(true);
  const summary = inspect.data?.degradationDiagnostics?.latestSummary ?? null;
  const modelId = summary?.modelProfile?.modelId ?? null;
  const provider = summary?.modelProfile?.provider ?? null;
  const degradationState = summary?.state ?? null;

  return (
    <header className="sticky top-0 z-10 px-4 py-2 bg-slate-900 border-b border-slate-800">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs uppercase tracking-wide font-semibold text-sky-300">AgentThursday</span>
        {session?.instanceName && (
          <Pill label="agent" value={session.instanceName} />
        )}
        {/* desktop active context chip. Same semantic
            entry point as `MobileStatusRow`: shows the active context
            id (preferring
            `getActiveContextId()` localStorage), links one-tap to
            `/inspect#context`. Without this, mobile would have a
            user-visible identity / discoverability surface that
            desktop lacks — the operator's "mobile ⊆ desktop" violation. The
            shared `contextChipLabel` helper enforces matching label
            rules between the two surfaces; desktop opts into a
            slightly longer 16-char budget given the wider header. */}
        <Link
          to="/inspect#context"
          data-testid="desktop-context-chip"
          className="text-xs inline-flex items-baseline gap-1 rounded border border-cyan-700/60 bg-cyan-950/60 px-2 py-1 text-cyan-200 hover:bg-cyan-900/60 active:bg-cyan-900/80"
          aria-label="Open context details"
        >
          <span className="text-[10px] uppercase tracking-wide text-cyan-500">ctx</span>
          <span className="font-mono truncate max-w-[14rem]">
            {contextChipLabel(session?.instanceName, { maxLen: 16 })}
          </span>
        </Link>
        {modelId && (
          <Pill
            label="model"
            value={shortModelLabel(modelId)}
            sub={provider ?? undefined}
          />
        )}
        <AgentStateBadge state={stateLabel} />
        <DegradationBadge state={degradationState} />
        {task?.lifecycle && <Badge color="slate">{task.lifecycle}</Badge>}
        {task?.loopStage && <Badge color="sky">{task.loopStage}</Badge>}
        {task?.ladderTier !== null && task?.ladderTier !== undefined && (
          <Badge color="violet">tier {task.ladderTier}</Badge>
        )}
        {task?.readyForNextRound && <Badge color="emerald">ready</Badge>}
        {stale && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-900/60 text-amber-200" title="No update in 10s+">
            stale
          </span>
        )}
        <div className="flex-1" />
        {onToggleInspect && (
          <button
            onClick={onToggleInspect}
            className="hidden lg:inline-block text-xs px-3 py-1 rounded border border-slate-700 hover:bg-slate-800"
          >
            {inspectOpen ? "Close inspect" : "Inspect"}
          </button>
        )}
      </div>
    </header>
  );
}

function Pill({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <span className="text-xs flex items-baseline gap-1 min-w-0">
      <span className="text-slate-500 uppercase tracking-wide">{label}</span>
      <span className="text-slate-200 font-mono truncate max-w-[14rem]" title={sub ? `${value} · ${sub}` : value}>
        {value}
      </span>
    </span>
  );
}

function shortModelLabel(modelId: string): string {
  // "@cf/moonshotai/kimi-k2.6" → "kimi-k2.6"
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

function useStale(lastAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (lastAt === null) return false;
  return now - lastAt > STALE_AFTER_MS;
}

function AgentStateBadge({ state }: { state: string }) {
  const cls =
    state === "running" ? "bg-sky-700 text-sky-100"
    : state === "waiting" ? "bg-amber-700 text-amber-100"
    : state === "completed" ? "bg-emerald-700 text-emerald-100"
    : state === "loading" ? "bg-slate-700 text-slate-300"
    : "bg-slate-800 text-slate-400";
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{state}</span>;
}

function DegradationBadge({ state }: { state: string | null }) {
  // Always render — the operator asked for the degradation state to be visible
  // in the title bar at all times, including when it's `normal`.
  // Subdued color when normal so it doesn't draw attention.
  const label = state ?? "—";
  const cls =
    state === "normal" ? "bg-emerald-950/60 text-emerald-300"
    : state === "degraded" ? "bg-amber-900/60 text-amber-200"
    : state === "blocked" ? "bg-rose-900/60 text-rose-200"
    : state === "needs_human" ? "bg-sky-900/60 text-sky-200"
    : "bg-slate-800 text-slate-400";
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded font-mono ${cls}`}
      title={`Runtime degradation state: ${label} ()`}
    >
      deg: {label}
    </span>
  );
}

function Badge({ color, children }: { color: "slate" | "sky" | "violet" | "emerald"; children: React.ReactNode }) {
  const cls = {
    slate: "bg-slate-800 text-slate-300",
    sky: "bg-sky-900/60 text-sky-200",
    violet: "bg-violet-900/60 text-violet-200",
    emerald: "bg-emerald-900/60 text-emerald-200",
  }[color];
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{children}</span>;
}
