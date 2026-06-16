import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listAgentProfiles,
  type AgentProfileWithLifecycle,
} from "../api/agentProfiles";
import { AgentsLayout } from "./AgentsLayout";
import { LifecycleBadge, relativeTime } from "./LifecycleBadge";
import { useRuntimeModelLookup } from "./useRuntimeModelLookup";
import { GettingStarted } from "../dashboard/GettingStarted";

/**
 *  — list view at `/agents`.
 *  — UI copy reads "cloud agent instances"; data shape unchanged.
 * Each row is one cloud agent (a long-lived `AgentThursdayAgent` DO); the
 * underlying API route is still `/api/agent-profiles` (legacy persistence;
 * see ).
 */
export function AgentsListRoute() {
  const [agents, setAgents] = useState<AgentProfileWithLifecycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lookup: lookupModel } = useRuntimeModelLookup();

  useEffect(() => {
    let cancelled = false;
    listAgentProfiles()
      .then(r => {
        if (cancelled) return;
        setAgents(r ?? []);
      })
      .catch(e => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AgentsLayout
      label="List"
      actions={
        <div className="flex items-center gap-2">
          <Link
            to="/agent-runs"
            className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Runs
          </Link>
          <Link
            to="/agents/new"
            className="text-xs px-2.5 py-1 rounded bg-sky-700 hover:bg-sky-600 text-sky-50"
          >
            + New agent
          </Link>
        </div>
      }
    >
      {/*  (UX W3, D2-B) — Agents is the landing page; the
          getting-started checklist rides at the top until configured. */}
      <GettingStarted />
      {error && <div className="text-sm text-rose-400 mb-3">{error}</div>}
      {agents === null && !error && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {agents !== null && agents.length === 0 && (
        <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
          No cloud agent instances yet.{" "}
          <Link to="/agents/new" className="text-sky-300 hover:text-sky-200 underline">
            Create the first one.
          </Link>
        </div>
      )}
      {agents !== null && agents.length > 0 && (
        <ul className="space-y-2">
          {agents.map(p => (
            <li key={p.id}>
              <Link
                to={`/agents/${encodeURIComponent(p.id)}`}
                className="block rounded border border-slate-800 bg-slate-900/60 hover:border-slate-600 px-3 py-2"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm text-slate-100 font-medium">{p.name}</span>
                  <LifecycleBadge lifecycle={p.lifecycle} persistedFallback={p.status} />
                  <span className="text-xs text-slate-500 font-mono">{p.id}</span>
                </div>
                {/*  — activity row: current task summary + last
                    activity ago. Quiet empty state for idle / no-activity. */}
                <div className="mt-1 text-xs text-slate-400">
                  {p.lifecycle?.current_activity_summary ? (
                    <span className="text-slate-300">
                      {p.lifecycle.current_activity_summary}
                    </span>
                  ) : (
                    <span className="text-slate-500 italic">no active task</span>
                  )}
                  <span className="ml-2 text-slate-500">
                    · last activity {relativeTime(p.lifecycle?.last_activity_at ?? p.updated_at)}
                  </span>
                </div>
                <div className="mt-1 flex gap-3 flex-wrap text-xs text-slate-400">
                  <span>
                    <span className="text-slate-500">model</span> {p.model}
                    {(() => {
                      const m = lookupModel(p.model);
                      if (m && m.runtimeStatus !== "available") {
                        return (
                          <span className="ml-1 text-amber-400" title="model is not wired to a provider adapter in this build">
                            ⚠
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </span>
                  <span>
                    <span className="text-slate-500">skillset</span> {p.skillset}
                  </span>
                  <span>
                    <span className="text-slate-500">channel</span> {p.channel}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AgentsLayout>
  );
}
