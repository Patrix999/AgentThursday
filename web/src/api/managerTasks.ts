/**
 * manager merge UI v1.
 *
 * Typed client for `GET /api/manager/tasks/:task_id/merge` (an earlier revision
 * reader). Mirrors `agentProfiles.ts`:
 *   - sends `X-AgentThursday-Secret` via `authHeaders()`
 *   - on 401: clearSecret + dispatch `agentthursday:unauthorized` (SecretGate
 *     re-prompts)
 *   - on 404: returns `null` (route is task-id parametric and the
 *     server treats unknown ids as 404)
 *   - tolerant of unknown / missing payload fields so a future
 *     server addition does not crash older clients
 *
 * No backend contract changes — the response shape is exactly what
 * an earlier revision §3.1 ships.
 */
import { authHeaders, clearSecret } from "../auth/secret";

export type MergeVerdict = "success" | "partial" | "failed";
export type SubagentRefVerdict = "success" | "partial" | "failed" | "ignored";

export interface ManagerTaskMergedRef {
  task_id: string;
  agent_id: string;
  summary_id: string;
  verdict: SubagentRefVerdict;
  superseded_by: string | null;
  reason?: string;
}

export interface ManagerTaskMergedPayload {
  parent_task_id: string;
  manager_agent_id: string;
  subagent_task_refs: ManagerTaskMergedRef[];
  merge_verdict: MergeVerdict;
  merged_at: string;
  note?: string;
}

export interface MergeReaderEntry {
  event_id: number;
  created_at: string;
  payload: ManagerTaskMergedPayload | null;
}

export interface MergeReaderLatest {
  event_id: number;
  created_at: string;
  merge_verdict: MergeVerdict | null;
  merged_at: string | null;
  subagent_count: number;
}

export interface MergeReaderResponse {
  ok: true;
  task_id: string;
  merged: boolean;
  merge_count: number;
  latest: MergeReaderLatest | null;
  merges: MergeReaderEntry[];
}

/**
 * Reads the merge reader. Returns `null` on 404 (unknown task) or 401
 * (secret missing/expired — SecretGate will pick up the dispatched
 * event). Throws on other network/HTTP errors so the caller can
 * surface a malformed/fetch-failed state.
 */
export async function getManagerTaskMerge(
  taskId: string,
): Promise<MergeReaderResponse | null> {
  const res = await fetch(
    `/api/manager/tasks/${encodeURIComponent(taskId)}/merge`,
    { headers: authHeaders() },
  );
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MergeReaderResponse;
}
