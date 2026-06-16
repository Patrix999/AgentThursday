import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listAgentRuns, type AgentRunListRow } from "../api/agentRuns";
import { AgentRunsLayout } from "./AgentRunsLayout";
import { StartRunForm } from "./StartRunForm";
import { StatusBadge } from "./StatusBadge";

/**
 *  — list view at `/agent-runs`.
 *
 * Optional filter via `?profile_id=<id>` (linked from `/agents/:id`).
 * No polling — spec §4 commits to local-row data only; the user can
 * tap "Refresh" or open the detail page to pull fresh state.
 */
export function AgentRunsListRoute() {
  const [params] = useSearchParams();
  const profileId = params.get("profile_id") || undefined;

  const [rows, setRows] = useState<AgentRunListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    listAgentRuns({ profile_id: profileId })
      .then(r => {
        if (cancelled) return;
        setRows(r ?? []);
      })
      .catch(e => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, refreshTick]);

  const filterLabel = useMemo(
    () => (profileId ? `Filtered by profile ${profileId}` : null),
    [profileId],
  );

  return (
    <AgentRunsLayout
      label="List"
      actions={
        <button
          type="button"
          onClick={refresh}
          className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
        >
          Refresh
        </button>
      }
    >
      <div className="space-y-4">
        <StartRunForm onCreated={refresh} />

        {filterLabel && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>{filterLabel}</span>
            <Link to="/agent-runs" className="text-sky-300 hover:text-sky-200 underline">
              Clear filter
            </Link>
          </div>
        )}

        {error && <div className="text-sm text-rose-400">{error}</div>}
        {rows === null && !error && <div className="text-sm text-slate-500">Loading…</div>}
        {rows !== null && rows.length === 0 && !error && (
          <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
            No agent runs yet. Start one from the form above, or create a profile at{" "}
            <Link to="/agents/new" className="text-sky-300 hover:text-sky-200 underline">
              /agents/new
            </Link>
            .
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map(r => (
              <li key={r.run_id}>
                <Link
                  to={`/agent-runs/${encodeURIComponent(r.run_id)}`}
                  className="block rounded border border-slate-800 bg-slate-900/60 hover:border-slate-600 px-3 py-2"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm text-slate-100 font-mono">{r.run_id}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 flex gap-3 flex-wrap text-xs text-slate-400">
                    <span>
                      <span className="text-slate-500">profile</span>{" "}
                      {r.profile_name ?? r.profile_id}
                    </span>
                    <span>
                      <span className="text-slate-500">workflow</span>{" "}
                      <span className="font-mono">{r.workflow_instance_id}</span>
                    </span>
                  </div>
                  <div className="mt-1 flex gap-3 flex-wrap text-xs text-slate-500">
                    <span>created {r.created_at}</span>
                    <span>updated {r.updated_at}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AgentRunsLayout>
  );
}
