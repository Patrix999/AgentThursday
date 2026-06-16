/**
 *  —  AgentRun web API client.
 *
 * Wraps the -347 +  list backend at `/api/agent-runs`:
 *   GET  /api/agent-runs                    → list (optional ?profile_id, ?limit)
 *   GET  /api/agent-runs/<id>               → read (row + workflow_status)
 *   POST /api/agent-runs                    → start
 *   POST /api/agent-runs/<id>/events        → send user-reply event
 *
 * Auth is the umbrella `X-AgentThursday-Secret`; on 401 we clear the secret
 * and notify SecretGate (same pattern as `agentProfiles.ts`).
 */
import { authHeaders, clearSecret } from "../auth/secret";
import { postJson } from "./client";

export type AgentRunStatus =
  | "started"
  | "awaiting_event"
  | "ok"
  | "failed"
  | "timeout";

export interface AgentRunRow {
  run_id: string;
  profile_id: string;
  workflow_instance_id: string;
  status: AgentRunStatus;
  turn_id: string | null;
  envelope_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunListRow extends AgentRunRow {
  profile_name: string | null;
}

export interface AgentRunDetail {
  run: AgentRunRow;
  workflow_status: string | null;
}

export interface CreateAgentRunResult {
  run_id: string;
  workflow_instance_id: string;
  status: "started";
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

export interface ListAgentRunsParams {
  profile_id?: string;
  limit?: number;
}

export async function listAgentRuns(
  params: ListAgentRunsParams = {},
): Promise<AgentRunListRow[] | null> {
  const search = new URLSearchParams();
  if (params.profile_id) search.set("profile_id", params.profile_id);
  if (typeof params.limit === "number") search.set("limit", String(params.limit));
  const qs = search.toString();
  const url = qs ? `/api/agent-runs?${qs}` : "/api/agent-runs";
  const data = await authedGet<{ runs: AgentRunListRow[] }>(url);
  return data === null ? null : data.runs;
}

export async function getAgentRun(runId: string): Promise<AgentRunDetail | null> {
  return authedGet<AgentRunDetail>(`/api/agent-runs/${encodeURIComponent(runId)}`);
}

export interface CreateAgentRunError {
  code: string;
  message: string;
  issues?: unknown;
}

export interface CreateAgentRunOutcome {
  ok: boolean;
  status: number;
  result: CreateAgentRunResult | null;
  error: CreateAgentRunError | null;
}

export async function createAgentRun(input: {
  profile_id: string;
  input?: unknown;
}): Promise<CreateAgentRunOutcome> {
  const res = await postJson<CreateAgentRunResult | CreateAgentRunError>(
    "/api/agent-runs",
    input,
  );
  if (res.ok && res.data && "run_id" in (res.data as CreateAgentRunResult)) {
    return {
      ok: true,
      status: res.status,
      result: res.data as CreateAgentRunResult,
      error: null,
    };
  }
  const err = (res.data ?? { code: "request_failed", message: res.error ?? "request failed" }) as
    | CreateAgentRunError
    | { code?: string; message?: string };
  return {
    ok: false,
    status: res.status,
    result: null,
    error: {
      code: err.code ?? "request_failed",
      message: err.message ?? "request failed",
      issues: (err as CreateAgentRunError).issues,
    },
  };
}

export interface SendAgentRunEventError {
  code: string;
  message: string;
}

export interface SendAgentRunEventOutcome {
  ok: boolean;
  status: number;
  error: SendAgentRunEventError | null;
}

export async function sendAgentRunUserReply(
  runId: string,
  payload: unknown,
): Promise<SendAgentRunEventOutcome> {
  const res = await postJson<{ run_id: string; accepted: true } | SendAgentRunEventError>(
    `/api/agent-runs/${encodeURIComponent(runId)}/events`,
    { type: "user-reply", payload },
  );
  if (res.ok) {
    return { ok: true, status: res.status, error: null };
  }
  const err = (res.data ?? { code: "request_failed", message: res.error ?? "request failed" }) as
    | SendAgentRunEventError
    | { code?: string; message?: string };
  return {
    ok: false,
    status: res.status,
    error: {
      code: err.code ?? "request_failed",
      message: err.message ?? "request failed",
    },
  };
}
