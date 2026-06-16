/**
 *  —  AgentProfile web API client.
 *
 * Wraps the  backend at `/api/agent-profiles`:
 *   GET    /api/agent-profiles              → list
 *   GET    /api/agent-profiles/options      → closed-list models / skillsets
 *   GET    /api/agent-profiles/<id>         → read
 *   POST   /api/agent-profiles              → create
 *   PATCH  /api/manager/agents/<id>         → update ( status actions)
 *
 * Auth is the umbrella `X-AgentThursday-Secret` (via `authHeaders()`); on 401
 * we clear the secret and notify SecretGate (same pattern as the
 * memory-candidates client).
 */
import type { AgentProfile, AgentProfileCreateInput } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";
import { postJson } from "./client";

/**
 *  — lifecycle view attached to list/detail responses.
 * Mirrors `AgentLifecycleView` in `src/agent/agentLifecycleView.ts`.
 * Optional on the wire — older servers omit it; UI must degrade
 * gracefully (badge falls back to persisted status only).
 */
export interface AgentLifecycleView {
  persisted: "initialized" | "archived" | "deleted_marker";
  derived: "healthy" | "running" | "stale" | null;
  reason: string | null;
  current_task_id: string | null;
  current_activity_summary: string | null;
  last_activity_at: string | null;
  accepts_tasks: boolean;
  dispatch_priority: number;
  retention_policy: "durable" | "task_scoped" | "ephemeral";
  origin: "user_created" | "spawned";
  parent_agent_id: string | null;
  parent_task_id: string | null;
  migrating: boolean;
}

export interface AgentProfileListRow extends Omit<AgentProfile, "persona"> {
  persona?: string;
}

export interface AgentProfileWithLifecycle extends AgentProfileListRow {
  lifecycle?: AgentLifecycleView;
}

/**
 *  — server-augmented profile shape returned by
 * `GET /api/agent-profiles/<id>`. The base `AgentProfile` shape is
 * unchanged (storage carries only `skillset`); the route handler
 * decorates the response with the resolver's view of which skillset
 * ids will actually contribute callable tools to the next session/run.
 * Older callers that don't read `skillset_runtime` still work; new
 * callers must be defensive about the field being absent on a list
 * endpoint (`GET /api/agent-profiles` returns the bare shape).
 */
export interface AgentProfileSkillsetRuntime {
  status:
    | "ok"
    | "unknown_skillset"
    | "rejected_skillset"
    | "disabled_skillset"
    | "empty_selection";
  effective_ids: string[];
  reason: string | null;
}

export interface AgentProfileWithRuntime extends AgentProfile {
  skillset_runtime?: AgentProfileSkillsetRuntime;
  //  — same lifecycle block also attached to detail responses.
  lifecycle?: AgentLifecycleView;
}

/**
 *  — structured runtime-model option. Mirrors the server-side
 * `AgentRuntimeModelOption` in `src/agent/agentModelRuntime.ts`. The
 * executable `target` string is server-side only and intentionally
 * absent here.
 */
export interface AgentRuntimeModelOption {
  id: string;
  label: string;
  provider: "workers-ai" | "anthropic" | "openai" | "google";
  runtimeStatus: "available" | "not_configured";
}

export interface AgentProfileOptions {
  /**
   *  — was `string[]`. The UI uses `runtimeStatus` to disable
   * non-runnable choices instead of hiding them entirely.
   */
  models: AgentRuntimeModelOption[];
  skillsets: Array<{ id: string; name: string; description: string }>;
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

export async function listAgentProfiles(): Promise<AgentProfileWithLifecycle[] | null> {
  //  added `agents:` alongside legacy `profiles:`. Prefer the
  // agent-centric field; fall back to `profiles` if an older server
  // is in front.  attaches an optional `lifecycle` block per row.
  //  asks for a list-only summary: no `persona` and no duplicate
  // `profiles` array. Older servers ignore the query and still work.
  const data = await authedGet<{
    agents?: AgentProfileWithLifecycle[];
    profiles?: AgentProfileWithLifecycle[];
  }>("/api/agent-profiles?view=summary");
  if (data === null) return null;
  return data.agents ?? data.profiles ?? [];
}

export async function getAgentProfile(
  id: string,
): Promise<AgentProfileWithRuntime | null> {
  return authedGet<AgentProfileWithRuntime>(
    `/api/agent-profiles/${encodeURIComponent(id)}`,
  );
}

export async function getAgentProfileOptions(): Promise<AgentProfileOptions | null> {
  return authedGet<AgentProfileOptions>("/api/agent-profiles/options");
}

export interface CreateAgentProfileError {
  code: string;
  message: string;
  issues?: unknown;
}

export interface CreateAgentProfileResult {
  ok: boolean;
  status: number;
  profile: AgentProfile | null;
  error: CreateAgentProfileError | null;
}

/**
 *  — state-action PATCH. Reuses the existing
 * `PATCH /api/manager/agents/:agent_id` endpoint (no manager-only gate;
 * shares validation with `manager.agent_update` dispatch tool). The UI
 * sends only `{ status }` to scope the call to lifecycle button intent;
 * the route ignores any field omitted.
 */
export type AgentLifecyclePersistedStatus = AgentLifecycleView["persisted"];

export async function updateAgentStatus(
  agentId: string,
  status: AgentLifecyclePersistedStatus,
): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  const res = await fetch(`/api/manager/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ status }),
  });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return { ok: false, status: 401, code: "unauthorized", message: "unauthorized" };
  }
  if (!res.ok) {
    let code = "request_failed";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch { /* ignore — keep generic message */ }
    return { ok: false, status: res.status, code, message };
  }
  return { ok: true };
}

export async function createAgentProfile(
  input: AgentProfileCreateInput,
): Promise<CreateAgentProfileResult> {
  const res = await postJson<AgentProfile | CreateAgentProfileError>(
    "/api/agent-profiles",
    input,
  );
  if (res.ok && res.data && "id" in (res.data as AgentProfile)) {
    return { ok: true, status: res.status, profile: res.data as AgentProfile, error: null };
  }
  const err = (res.data ?? { code: "request_failed", message: res.error ?? "request failed" }) as
    | CreateAgentProfileError
    | { code?: string; message?: string };
  return {
    ok: false,
    status: res.status,
    profile: null,
    error: {
      code: err.code ?? "request_failed",
      message: err.message ?? "request failed",
      issues: (err as CreateAgentProfileError).issues,
    },
  };
}
