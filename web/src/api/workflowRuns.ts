/**
 * M9.1 observable workflow run model web API client.
 *
 * Wraps the read-only inspect endpoints:
 *   GET /api/inspect/workflow-runs           → list of run rows
 *   GET /api/inspect/workflow-runs/<run_id>  → run -> phases -> agents tree
 *
 * Auth is the umbrella `X-AgentThursday-Secret`; on 401 clear + notify
 * (same pattern as agentRuns.ts). Read-only — no POST surface.
 */
import { authHeaders, clearSecret } from "../auth/secret";

export interface WorkflowRunRow {
  run_id: string;
  source_task_id: string | null;
  root_agent_id: string | null;
  status: string;
  caps: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowCaps {
  max_agents: number | null;
  max_concurrency: number | null;
}

export interface WorkflowAgentNode {
  agent_node_id: string;
  agent_id: string | null;
  task_id: string | null;
  status: string;
  prompt_preview: string | null;
  result_summary: string | null;
  failure_reason: string | null;
  retry_state: string | null;
  rough_token_count: number | null;
  rough_cost: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowPhaseNode {
  phase_id: string;
  name: string;
  status: string;
  order: number;
  depends_on_phase_ids: string[];
  agents: WorkflowAgentNode[];
}

export interface WorkflowRunTree {
  run_id: string;
  source_task_id: string | null;
  root_agent_id: string | null;
  status: string;
  caps: WorkflowCaps | null;
  created_at: string;
  updated_at: string;
  phases: WorkflowPhaseNode[];
}

async function authedGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function listWorkflowRuns(limit?: number): Promise<WorkflowRunRow[] | null> {
  const qs = typeof limit === "number" ? `?limit=${limit}` : "";
  const data = await authedGet<{ runs: WorkflowRunRow[] }>(`/api/inspect/workflow-runs${qs}`);
  return data === null ? null : data.runs;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunTree | null> {
  return authedGet<WorkflowRunTree>(`/api/inspect/workflow-runs/${encodeURIComponent(runId)}`);
}
