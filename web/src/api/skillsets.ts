/**
 * Skillset Management UI client.
 *
 * Read-only wrappers around four existing inspect / runtime / options
 * endpoints. No new persistence, no mutation surface — see the card
 * non-goals for why enable/disable/reload are deferred to a later card.
 *
 *   GET  /api/agent-profiles/options       → closed-list skillsets (id/name/description)
 *   GET  /api/inspect/skillset/detail      → per-skillset skill rows (loaded / load_rejected)
 *   GET  /api/inspect/skillset/tools       → per-skillset tool table (loaded only)
 *   GET  /api/skillset/runtime             → active-agent-scoped runtime summary
 *                                            (loaded / disabled / rejected partition,
 *                                            disabled reasons, agent_tools, SOUL budget)
 *
 * Auth is the umbrella `X-AgentThursday-Secret` (via `authHeaders()`); on 401
 * we clear the secret and notify `SecretGate` — same pattern as the
 * an earlier revision agent-profiles client.
 */
import { authHeaders, clearSecret } from "../auth/secret";

export interface SkillsetOption {
  id: string;
  name: string;
  description: string;
}

export interface SkillsetDetailSkillRow {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4 | 5;
  tools: string[];
  capability_class: string;
  prompt_segment_present: boolean;
  source_ref?: unknown;
  evidence_requirements?: unknown;
}

export interface SkillsetDetailEntry {
  skillset_id: string;
  skillset_version: string;
  status: "loaded" | "load_rejected";
  skills: SkillsetDetailSkillRow[];
}

export interface SkillsetLoaderDetail {
  schema_version: string;
  loaded_at: string;
  entries: SkillsetDetailEntry[];
}

export interface SkillsetToolRow {
  name: string;
  tier: 1 | 2 | 3 | 4 | 5;
  approval_required: boolean;
  implemented: boolean;
  emit_events: string[];
}

export interface SkillsetToolsResponse {
  loaded_at: string;
  skillsets: Record<string, SkillsetToolRow[]>;
}

export interface SkillsetRuntimeDisabledEntry {
  skillset_id: string;
  disabled_at: string;
  reason: string | null;
}

export interface SkillsetRuntimeAgentToolBinding {
  ai_sdk_name: string;
  tool_id: string;
  skillset_id: string;
  skill_id: string;
  description: string;
  has_handler: boolean;
}

export interface SkillsetRuntimeSummary {
  loaded_at: string;
  reload_count: number;
  schema_version: string;
  source_shas: Record<string, string>;
  skillset_ids: {
    loaded: string[];
    disabled: string[];
    rejected: string[];
  };
  disabled: SkillsetRuntimeDisabledEntry[];
  tool_ids: string[];
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
  agent_tools: SkillsetRuntimeAgentToolBinding[];
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

export async function getSkillsetOptions(): Promise<SkillsetOption[] | null> {
  // Reuses `/api/agent-profiles/options`  rather than adding
  // a new "list selectable skillsets" endpoint. The options payload is
  // the canonical "selectable for new cloud agents" set per an earlier revision.
  const data = await authedGet<{
    skillsets: SkillsetOption[];
  }>("/api/agent-profiles/options");
  if (data === null) return null;
  return data.skillsets;
}

export async function getSkillsetLoaderDetail(): Promise<SkillsetLoaderDetail | null> {
  return authedGet<SkillsetLoaderDetail>("/api/inspect/skillset/detail");
}

export async function getSkillsetTools(
  skillsetId?: string,
): Promise<SkillsetToolsResponse | null> {
  const qs = skillsetId
    ? `?skillset=${encodeURIComponent(skillsetId)}`
    : "";
  return authedGet<SkillsetToolsResponse>(`/api/inspect/skillset/tools${qs}`);
}

// ── Edit (Stage 2) — read the full editable manifest + save via PATCH ──────

export interface ManagerSkillsetRead {
  status: string;
  source: "embedded" | "custom";
  loader_status: string;
  rejected_reason?: string;
  skillset: {
    id: string;
    name: string;
    description: string;
    version: string;
    manifest: unknown;
    created_at?: string;
    updated_at?: string;
  };
}

/** GET /api/manager/skillsets/:id — full manifest (the editable shape). */
export async function getManagerSkillset(id: string): Promise<ManagerSkillsetRead | null> {
  return authedGet<ManagerSkillsetRead>(`/api/manager/skillsets/${encodeURIComponent(id)}`);
}

/** PATCH /api/manager/skillsets/:id — owner-scoped update (admin edits system rows). */
export async function updateManagerSkillset(
  id: string,
  manifest: unknown,
): Promise<{ ok: boolean; status: number; errorCode?: string; errorMessage?: string }> {
  const res = await fetch(`/api/manager/skillsets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return { ok: false, status: 401, errorCode: "auth.required" };
  }
  let data: { error?: { code?: string; message?: string }; code?: string; message?: string } | null = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return {
    ok: res.ok,
    status: res.status,
    errorCode: data?.error?.code ?? data?.code,
    errorMessage: data?.error?.message ?? data?.message,
  };
}

export async function getSkillsetRuntime(): Promise<SkillsetRuntimeSummary | null> {
  // Routes through the canonical active AgentThursdayAgent  so the
  // summary reflects loaded / disabled / rejected ids and agent_tools
  // for the active agent — which is exactly what the active-agent
  // context strip needs to show on the skillsets UI.
  return authedGet<SkillsetRuntimeSummary>("/api/skillset/runtime");
}
