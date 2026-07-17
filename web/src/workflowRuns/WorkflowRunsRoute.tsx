import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../nav/PageHeader";
import {
  listWorkflowRuns,
  getWorkflowRun,
  type WorkflowRunRow,
  type WorkflowRunTree,
} from "../api/workflowRuns";

/**
 * minimal observable workflow run model debug surface at
 * `/workflow-runs`. Read-only: lists `workflow_run` rows from the
 * ledger, and on selection shows the `run -> phases -> agents` tree.
 * This is an operational debug surface (not a marketing card); it does
 * not poll and stays out of the primary controls on mobile.
 */
export function WorkflowRunsRoute() {
  const [rows, setRows] = useState<WorkflowRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [tree, setTree] = useState<WorkflowRunTree | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    listWorkflowRuns()
      .then((r) => !cancelled && setRows(r ?? []))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (selected === null) {
      setTree(null);
      return;
    }
    let cancelled = false;
    setTree(null);
    setTreeError(null);
    getWorkflowRun(selected)
      .then((t) => !cancelled && setTree(t))
      .catch((e) => !cancelled && setTreeError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected, tick]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-200">
      <PageHeader
        title="Workflow Runs"
        backTo="/"
        backLabel="← Dashboard"
        actions={
          <button
            type="button"
            onClick={refresh}
            className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Refresh
          </button>
        }
      />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-4xl">
      <p className="text-[11px] text-slate-500 mb-3">
        observable workflow run model (debug). A run = one manager
        dispatch invocation (<code>wfr-&lt;parent_task_id&gt;</code>). Tree is
        read from the structured workflow ledger.
      </p>

      {error && <div className="text-xs text-rose-400">Error: {error}</div>}
      {rows === null && !error && <div className="text-xs text-slate-500">Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div className="text-xs text-slate-500">
          No workflow runs yet. Dispatch a manager multi-subagent task to create one.
        </div>
      )}

      <ul className="space-y-1">
        {(rows ?? []).map((r) => (
          <li key={r.run_id}>
            <button
              type="button"
              onClick={() => setSelected(selected === r.run_id ? null : r.run_id)}
              className={`w-full text-left text-xs px-2.5 py-2 rounded border ${
                selected === r.run_id
                  ? "border-sky-700 bg-slate-900"
                  : "border-slate-800 bg-slate-900/40 hover:bg-slate-900"
              }`}
            >
              <span className="font-mono text-sky-300">{r.run_id}</span>
              <span className="ml-2 text-slate-400">status={r.status}</span>
              <span className="ml-2 text-slate-500">root={r.root_agent_id ?? "—"}</span>
              <span className="ml-2 text-slate-600">{r.updated_at}</span>
            </button>
            {selected === r.run_id && (
              <div className="mt-1 ml-2 pl-2 border-l border-slate-800">
                {treeError && <div className="text-xs text-rose-400">Error: {treeError}</div>}
                {tree === null && !treeError && (
                  <div className="text-xs text-slate-500">Loading tree…</div>
                )}
                {tree && <RunTree tree={tree} />}
              </div>
            )}
          </li>
        ))}
      </ul>
        </div>
      </main>
    </div>
  );
}

function RunTree({ tree }: { tree: WorkflowRunTree }) {
  return (
    <div className="py-1 text-xs">
      <div className="text-slate-400">
        caps:{" "}
        {tree.caps
          ? `max_agents=${tree.caps.max_agents ?? "—"} max_concurrency=${tree.caps.max_concurrency ?? "—"}`
          : "—"}
      </div>
      {tree.phases.length === 0 && (
        <div className="text-slate-500">No phases recorded.</div>
      )}
      {tree.phases.map((p) => (
        <div key={p.phase_id} className="mt-1">
          <div className="text-slate-300">
            ▸ phase <span className="font-mono text-emerald-300">{p.name}</span>{" "}
            <span className="text-slate-500">(order {p.order}, status {p.status})</span>
          </div>
          <ul className="ml-4 mt-0.5 space-y-0.5">
            {p.agents.length === 0 && <li className="text-slate-500">no agents</li>}
            {p.agents.map((a) => (
              <li key={a.agent_node_id} className="text-slate-300">
                • <span className="font-mono text-sky-300">{a.agent_id ?? "—"}</span>{" "}
                <span className="text-slate-400">[{a.status}]</span>
                {a.result_summary && (
                  <span className="text-slate-400"> — {a.result_summary}</span>
                )}
                {a.failure_reason && (
                  <span className="text-rose-400"> — fail: {a.failure_reason}</span>
                )}
                <span className="ml-1 text-slate-600">
                  tok={a.rough_token_count ?? "—"} cost={a.rough_cost ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
