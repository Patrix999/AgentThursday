import type {
  ContextInspectResult,
  CompactContextResult,
  CompactionsList,
  CompactPlanInput,
  CompactPlanResult,
  CompactPlanApplyResult,
  ContextResetResult,
  ActiveContext,
  ContextHistoryList,
  NewContextResult,
  SwitchContextResult,
} from "../../shared/schema";
import { authHeaders, clearSecret, setActiveContextId } from "../auth/secret";
import { postJson } from "./client";

/**
 * backend `inspectContext` callable surfaced as a
 * read-only GET. No audit row is written server-side, so polling is
 * cheap. `lastN` is clamped server-side to [1, 200].
 */
export async function fetchContextInspect(lastN = 20): Promise<ContextInspectResult | null> {
  const url = `/cli/context/inspect?lastN=${encodeURIComponent(String(lastN))}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ContextInspectResult;
}

/**
 * auditable compact. Wraps `POST /cli/context/compact`.
 * Server emits `context.compact.requested` + `.completed`/`.failed`
 * audit rows. UI must confirm before calling — this helper does NOT
 * gate; the confirmation lives in the panel.
 */
export function compactContext(body: { reason?: string; lastN?: number; keepRecent?: number }) {
  return postJson<CompactContextResult>("/cli/context/compact", body);
}

export async function fetchCompactions(): Promise<CompactionsList | null> {
  const res = await fetch("/cli/context/compactions", { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CompactionsList;
}

/**
 *  v2  — anchor-aware plan / apply pair. `compactPlan`
 * proposes ID-based ranges built from a fresh snapshot + anchors;
 * `applyCompactPlan` re-runs all pre-flight checks against a fresh
 * snapshot before each `addCompaction`. Both helpers return the
 * standard `{ok, status, data}` envelope; UI confirms before apply.
 */
export function compactPlan(body?: CompactPlanInput) {
  return postJson<CompactPlanResult>("/cli/context/compact-plan", body ?? {});
}

export function applyCompactPlan(
  plan: CompactPlanResult,
  options?: {
    // /146 — optional opt-in to the semantic advisor scaffold.
    // When `semanticAdvisor:true` is sent and no model client is wired
    // server-side, the apply path falls back to the deterministic
    // summary and the response includes
    // `appliedRanges[i].semanticAdvisor` with the audit metadata so the
    // UI can show what was attempted.
    semanticAdvisor?: boolean;
    semanticAdvisorTrigger?: "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";
  },
) {
  const body: Record<string, unknown> = { plan };
  if (options?.semanticAdvisor) body.semanticAdvisor = true;
  if (options?.semanticAdvisorTrigger) body.semanticAdvisorTrigger = options.semanticAdvisorTrigger;
  return postJson<CompactPlanApplyResult>("/cli/context/apply-compact-plan", body);
}

/**
 *   — UI-driven reset. Wraps `POST /cli/context/reset`.
 * Server emits a `context.reset` audit row with before/after counts and
 * preserves all durable state (memory, checkpoints, workspace, event_log,
 * task metadata, model profile). UI must confirm before calling — this
 * helper does NOT gate.
 */
export function resetContext(body: { reason?: string }) {
  return postJson<ContextResetResult>("/cli/context/reset", body);
}

/**
 *   / 149 — `new context`.  promotes the call
 * from the v1 reset-style fallback into real per-context DO routing:
 * the previous context's transcripts stay on its own DO; the new
 * contextId routes to a fresh DO via the `X-AgentThursday-Context-Id` header.
 *
 *  — server-pinned active model. The optimistic
 * `setActiveContextId(...)` is kept so the very next `/api/workspace`
 * poll already targets the new context (no UI flicker), but it is no
 * longer the source of truth: `useWorkspace` will reconcile against
 * the registry-canonical `activeContextId` returned in the snapshot.
 * If a concurrent surface picked a different context between server
 * write and client poll, the reconcile step on the next poll
 * canonicalizes everything.
 */
export async function newContext(body: { reason?: string }) {
  const res = await postJson<NewContextResult>("/cli/context/new", body);
  if (res.ok && res.data?.newContextId) {
    // Optimistic — the canonical truth still flows through
    // `/api/workspace.activeContextId` reconcile.
    setActiveContextId(res.data.newContextId);
  }
  return res;
}

/**
 *   — switch the active context to an existing
 * context_history row. Server validates the contextId, updates the
 * registry pointer, and emits a `context.switch` audit event.
 *
 *  — same optimistic-but-not-authoritative model as
 * `newContext` above. The registry pointer write inside the server
 * handler is the real source of truth; the reconcile loop in
 * `useWorkspace` keeps every surface aligned within one poll.
 */
export async function switchContext(body: { contextId: string; reason?: string }) {
  const res = await postJson<SwitchContextResult>("/cli/context/switch", body);
  if (res.ok && res.data?.newContextId) {
    // Optimistic — see `newContext` note above.
    setActiveContextId(res.data.newContextId);
  }
  return res;
}

export async function fetchActiveContext(): Promise<ActiveContext | null> {
  const res = await fetch("/cli/context/active", { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ActiveContext;
}

export async function fetchContextHistory(): Promise<ContextHistoryList | null> {
  const res = await fetch("/cli/context/history", { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ContextHistoryList;
}
