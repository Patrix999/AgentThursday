import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../nav/PageHeader";
import { listAgentRuns, type AgentRunListRow } from "../api/agentRuns";
import { listWorkflowRuns, type WorkflowRunRow } from "../api/workflowRuns";
import { useAgentNameMap } from "../agents/useAgentNameMap";

/**
 * an earlier revision (UX W3, D3-C) — the single "what is happening" surface.
 * Replaces the separate Agent-runs / Workflow-runs / Inspect nav
 * entries: agent runs and workflow runs live here side by side, each
 * row deep-links to its existing detail view. (The legacy /workspace,
 * /inspect, /agent-runs, /workflow-runs routes stay reachable by URL.)
 */
type Tab = "agent" | "workflow";

function statusTone(s: string): string {
  if (/(replied|completed|ok|success|terminal)/i.test(s)) return "text-emerald-400";
  if (/(failed|error|timed_out)/i.test(s)) return "text-rose-400";
  if (/(running|active|received|in_progress)/i.test(s)) return "text-sky-400";
  return "text-slate-400";
}

export default function ActivityRoute() {
  const [tab, setTab] = useState<Tab>("agent");
  const [agentRuns, setAgentRuns] = useState<AgentRunListRow[] | null>(null);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunRow[] | null>(null);
  const names = useAgentNameMap();

  useEffect(() => {
    listAgentRuns({ limit: 100 }).then((r) => setAgentRuns(r ?? [])).catch(() => setAgentRuns([]));
    listWorkflowRuns(50).then((r) => setWorkflowRuns(r ?? [])).catch(() => setWorkflowRuns([]));
  }, []);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      <PageHeader title="Activity" />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <div className="mb-4 flex gap-2">
          <TabButton active={tab === "agent"} onClick={() => setTab("agent")}>
            Agent runs{agentRuns ? ` (${agentRuns.length})` : ""}
          </TabButton>
          <TabButton active={tab === "workflow"} onClick={() => setTab("workflow")}>
            Workflow runs{workflowRuns ? ` (${workflowRuns.length})` : ""}
          </TabButton>
        </div>

        {tab === "agent" && (
          <RunList
            loading={agentRuns === null}
            empty={agentRuns?.length === 0}
            emptyHint="No agent runs yet — send an agent a message from its page."
          >
            {(agentRuns ?? []).map((r) => (
              <Link
                key={r.run_id}
                to={`/agent-runs/${encodeURIComponent(r.run_id)}`}
                className="block rounded border border-slate-800 bg-slate-900/60 hover:border-slate-600 px-3 py-2"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm text-slate-100">
                    {r.profile_name ?? names[r.profile_id] ?? r.profile_id}
                  </span>
                  <span className={`text-xs ${statusTone(r.status)}`}>{r.status}</span>
                  <span className="ml-auto text-xs text-slate-500">{r.updated_at}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono">{r.run_id}</div>
              </Link>
            ))}
          </RunList>
        )}

        {tab === "workflow" && (
          <RunList
            loading={workflowRuns === null}
            empty={workflowRuns?.length === 0}
            emptyHint="No workflow runs yet."
          >
            {(workflowRuns ?? []).map((r) => (
              <Link
                key={r.run_id}
                to={`/workflow-runs`}
                className="block rounded border border-slate-800 bg-slate-900/60 hover:border-slate-600 px-3 py-2"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm text-slate-100">
                    {r.root_agent_id ? (names[r.root_agent_id] ?? r.root_agent_id) : "workflow"}
                  </span>
                  <span className={`text-xs ${statusTone(r.status)}`}>{r.status}</span>
                  <span className="ml-auto text-xs text-slate-500">{r.updated_at}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono">{r.run_id}</div>
              </Link>
            ))}
          </RunList>
        )}
      </main>
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`text-sm px-3 py-1 rounded ${
        props.active ? "bg-sky-700 text-sky-50" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {props.children}
    </button>
  );
}

function RunList(props: {
  loading: boolean;
  empty: boolean | undefined;
  emptyHint: string;
  children: React.ReactNode;
}) {
  if (props.loading) return <div className="text-sm text-slate-500">Loading…</div>;
  if (props.empty) {
    return (
      <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
        {props.emptyHint}
      </div>
    );
  }
  return <div className="space-y-2 max-w-3xl">{props.children}</div>;
}
