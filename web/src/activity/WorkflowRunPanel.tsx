import { Link } from "react-router-dom";

/**
 *  — body panel for `workflow.run` intents: run started /
 * terminal and executor-dispatched subagent terminal events. Links the
 * activity feed to the Workflow Runs page.
 */
export function WorkflowRunPanel({
  runId,
  status,
  sourceTaskId,
  agentId,
}: {
  runId: string | null;
  status: string | null;
  sourceTaskId: string | null;
  agentId: string | null;
}) {
  return (
    <div className="text-xs text-slate-400 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {runId !== null && (
          <span className="font-mono text-slate-300">{runId}</span>
        )}
        {status !== null && <span>status: {status}</span>}
        {agentId !== null && (
          <span className="font-mono">{agentId.slice(0, 18)}…</span>
        )}
      </div>
      {sourceTaskId !== null && <div>descriptor: {sourceTaskId}</div>}
      {runId !== null && (
        <Link to="/workflow-runs" className="inline-block text-sky-400 hover:underline">
          View runs →
        </Link>
      )}
    </div>
  );
}
