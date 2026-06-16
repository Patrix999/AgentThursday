/**
 *  — minimal manager merge UI panel.
 *
 * Reads `GET /api/manager/tasks/:task_id/merge` () and renders
 * one of: idle / loading / error / not_found / no_merge / merged.
 * All state logic lives in the pure helper at
 * `src/agent/managerMergePanelState.ts`; this component only renders.
 *
 * Placement: AgentDetailRoute (`/agents/:id`). When
 * `lifecycle.current_task_id` is non-null the panel auto-targets that
 * task; otherwise the operator pastes a task_id. The paste field
 * exists because `manager.task.merged` is non-terminal and usually
 * fires near `manager.task.replied`, which is terminal — so by the
 * time merge audit matters most, `current_task_id` has cleared.
 */
import { useCallback, useEffect, useState } from "react";
import {
  getManagerTaskMerge,
  type MergeReaderResponse,
} from "../api/managerTasks";
import {
  deriveMergePanelState,
  MAX_REFS,
  type MergePanelState,
} from "../../../src/agent/managerMergePanelState";

interface MergePanelProps {
  /** Auto-target this task_id when non-null (e.g. lifecycle.current_task_id). */
  defaultTaskId: string | null;
}

export function MergePanel(props: MergePanelProps) {
  const [pastedTaskId, setPastedTaskId] = useState("");
  const [committedTaskId, setCommittedTaskId] = useState<string | null>(null);
  const [reader, setReader] = useState<MergeReaderResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Auto-target the lifecycle current_task_id when present. The paste
  // input takes precedence — once the user types and submits, the
  // committed id sticks even if lifecycle later changes.
  const effectiveTaskId = committedTaskId ?? props.defaultTaskId;

  useEffect(() => {
    if (effectiveTaskId === null || effectiveTaskId.length === 0) {
      setReader(null);
      setFetchError(null);
      return;
    }
    const ref = { cancelled: false };
    setLoading(true);
    setFetchError(null);
    getManagerTaskMerge(effectiveTaskId)
      .then(r => {
        if (ref.cancelled) return;
        setReader(r);
        setLoading(false);
      })
      .catch(e => {
        if (ref.cancelled) return;
        setFetchError(String(e));
        setLoading(false);
      });
    return () => {
      ref.cancelled = true;
    };
  }, [effectiveTaskId]);

  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pastedTaskId.trim();
    setCommittedTaskId(trimmed.length === 0 ? null : trimmed);
  }, [pastedTaskId]);

  const onClear = useCallback(() => {
    setPastedTaskId("");
    setCommittedTaskId(null);
  }, []);

  const state = deriveMergePanelState({
    taskId: effectiveTaskId,
    loading,
    fetchError,
    reader,
  });

  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs uppercase tracking-wide text-slate-500">
          Merge audit
        </div>
        {committedTaskId !== null && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-slate-400 hover:text-slate-200 underline decoration-dotted"
          >
            clear
          </button>
        )}
      </div>
      <form onSubmit={onSubmit} className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={pastedTaskId}
          onChange={e => setPastedTaskId(e.target.value)}
          placeholder={props.defaultTaskId ?? "paste task_id…"}
          className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 font-mono placeholder:text-slate-600 focus:outline-none focus:border-sky-700"
        />
        <button
          type="submit"
          className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
        >
          inspect
        </button>
      </form>
      <MergePanelBody state={state} />
    </section>
  );
}

function MergePanelBody(props: { state: MergePanelState }) {
  const s = props.state;
  if (s.kind === "idle") {
    return (
      <div className="text-xs text-slate-500 italic">
        No task selected. Paste a manager task_id above to inspect merge audit.
      </div>
    );
  }
  if (s.kind === "loading") {
    return (
      <div className="text-xs text-slate-500" data-testid="merge-loading">
        Loading <span className="font-mono">{s.taskId}</span>…
      </div>
    );
  }
  if (s.kind === "error") {
    return (
      <div className="text-xs text-rose-400 break-all">
        Failed to load merge for <span className="font-mono">{s.taskId}</span>: {s.message}
      </div>
    );
  }
  if (s.kind === "not_found") {
    return (
      <div className="text-xs text-slate-500">
        Unknown task <span className="font-mono">{s.taskId}</span>.
      </div>
    );
  }
  if (s.kind === "no_merge") {
    return (
      <div className="space-y-1">
        <div className="text-sm text-slate-300">
          No structured merge for <span className="font-mono text-xs">{s.taskId}</span>.
        </div>
        <div className="text-xs text-slate-500">
          Manager replied without emitting <code>manager.task.merged</code>.
        </div>
      </div>
    );
  }
  // merged
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3 flex-wrap text-sm">
        <span className="text-slate-200">
          merged
        </span>
        <VerdictPill verdict={s.latestVerdict} />
        <span className="text-xs text-slate-500">
          {s.mergeCount} merge{s.mergeCount === 1 ? "" : "s"} · {s.subagentCount} subagent{s.subagentCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="text-xs text-slate-500">
        <span className="font-mono">{s.taskId}</span> · merged at{" "}
        <span className="font-mono">{s.latestMergedAt ?? "—"}</span>
      </div>
      {s.malformedLatest && (
        <div className="text-xs text-amber-300">
          Latest merge row has a malformed payload; verdict/refs unavailable.
        </div>
      )}
      {s.refs.length === 0 ? (
        <div className="text-xs text-slate-500 italic">
          (no subagent refs in latest merge)
        </div>
      ) : (
        <RefList refs={s.refs} truncated={s.truncated} />
      )}
    </div>
  );
}

function VerdictPill(props: { verdict: "success" | "partial" | "failed" | null }) {
  const v = props.verdict;
  const tone =
    v === "success"
      ? "bg-emerald-900/60 text-emerald-200 border-emerald-800"
      : v === "partial"
        ? "bg-amber-900/60 text-amber-200 border-amber-800"
        : v === "failed"
          ? "bg-rose-900/60 text-rose-200 border-rose-800"
          : "bg-slate-800 text-slate-400 border-slate-700";
  return (
    <span className={`text-xs px-2 py-0.5 rounded border ${tone}`}>
      verdict: {v ?? "—"}
    </span>
  );
}

function RefList(props: {
  refs: import("../api/managerTasks").ManagerTaskMergedRef[];
  truncated: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        Subagent refs
      </div>
      <ul className="space-y-1">
        {props.refs.map((r, i) => (
          <li
            key={`${r.task_id}-${i}`}
            className="text-xs text-slate-300 font-mono break-all flex flex-wrap items-baseline gap-x-2"
          >
            <span className="text-slate-500">{r.agent_id}</span>
            <span>·</span>
            <span>{r.task_id}</span>
            <RefVerdictTag verdict={r.verdict} />
            {r.superseded_by !== null && (
              <span className="text-amber-300">
                superseded → {r.superseded_by}
              </span>
            )}
            {r.reason !== undefined && r.reason !== "" && (
              <span className="text-slate-400 italic">— {r.reason}</span>
            )}
          </li>
        ))}
      </ul>
      {props.truncated && (
        <div className="text-xs text-slate-500 italic">
          (only the first {MAX_REFS} refs shown)
        </div>
      )}
    </div>
  );
}

function RefVerdictTag(props: { verdict: "success" | "partial" | "failed" | "ignored" }) {
  const tone =
    props.verdict === "success"
      ? "text-emerald-300"
      : props.verdict === "partial"
        ? "text-amber-300"
        : props.verdict === "failed"
          ? "text-rose-300"
          : "text-slate-500";
  return <span className={tone}>[{props.verdict}]</span>;
}
