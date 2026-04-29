import { useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  lastRefreshedAt: number | null;
  onToggleInspect?: () => void; // desktop only
  inspectOpen?: boolean;
};

const STALE_AFTER_MS = 10_000;

export function TopStatusBar({ snapshot, lastRefreshedAt, onToggleInspect, inspectOpen }: Props) {
  const session = snapshot?.session;
  const task = snapshot?.currentTask;
  const sessionId = session?.sessionId ? truncateId(session.sessionId) : "—";
  const stateLabel = session?.agentState ?? "loading";
  const stale = useStale(lastRefreshedAt);

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-slate-900 border-b border-slate-800">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs uppercase tracking-wide text-slate-400">AgentThursday</span>
        <span className="text-xs text-slate-500">{sessionId}</span>
        <AgentStateBadge state={stateLabel} />
        <span className="truncate text-sm text-slate-200">{task?.title ?? "No active task"}</span>
        {task?.ladderTier !== null && task?.ladderTier !== undefined && (
          <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">tier {task.ladderTier}</span>
        )}
        {stale && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-900/60 text-amber-200" title="No update in 10s+">
            stale
          </span>
        )}
      </div>
      {onToggleInspect && (
        <button
          onClick={onToggleInspect}
          className="hidden lg:inline-block text-xs px-3 py-1 rounded border border-slate-700 hover:bg-slate-800"
        >
          {inspectOpen ? "Close inspect" : "Inspect"}
        </button>
      )}
    </header>
  );
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

function truncateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…` : id;
}
