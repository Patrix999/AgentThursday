/**
 * web client side of an earlier revision's `X-AgentThursday-Secret` contract.
 *
 * Stored in localStorage so a refresh keeps you logged in. Cleared on 401.
 *
 * M7.7v3 `X-AgentThursday-Context-Id` header carries the active
 * context for per-context DO routing. Stored in localStorage so the UI
 * remembers the active context across reloads. Cleared via
 * `clearActiveContextId()` if needed.
 *
 * `agentthursday.activeAgentPin.id` records the user's explicit
 * selector pick (a cloud `agent_id`, which per an earlier revision equals the DO
 * name). When set, `useWorkspace` suppresses the canonical-pointer
 * reconcile so the pick isn't reverted to whatever the server registry
 * thinks is canonical. The pin and `agentthursday.contextId` carry the same
 * value while pinned; clearing the pin leaves the context cache alone.
 */
const SECRET_KEY = "agentthursday.secret";
const CONTEXT_KEY = "agentthursday.contextId";
const AGENT_PIN_KEY = "agentthursday.activeAgentPin.id";

export function getSecret(): string {
  try {
    return window.localStorage.getItem(SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSecret(value: string): void {
  try {
    window.localStorage.setItem(SECRET_KEY, value);
  } catch {
    // Storage may be disabled (private mode). The next request will 401 and the
    // user will be re-prompted; nothing useful to recover here.
  }
}

export function clearSecret(): void {
  try {
    window.localStorage.removeItem(SECRET_KEY);
  } catch {
    // see setSecret
  }
}

export function getActiveContextId(): string {
  try {
    return window.localStorage.getItem(CONTEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setActiveContextId(value: string): void {
  try {
    if (!value) {
      window.localStorage.removeItem(CONTEXT_KEY);
    } else {
      window.localStorage.setItem(CONTEXT_KEY, value);
    }
  } catch {
    // see setSecret — degraded behavior is acceptable; the request
    // simply falls back to DEMO_INSTANCE on the server side.
  }
}

export function clearActiveContextId(): void {
  try {
    window.localStorage.removeItem(CONTEXT_KEY);
  } catch {
    // see setSecret
  }
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const s = getSecret();
  if (s) headers["X-AgentThursday-Secret"] = s;
  const ctx = getActiveContextId();
  if (ctx) headers["X-AgentThursday-Context-Id"] = ctx;
  return headers;
}

/**
 * user's explicit selector pick. When non-null, the
 * `useWorkspace` reconcile skips revert-to-canonical-pointer so the
 * pick is sticky across polls until the user changes it (or the
 * pinned agent disappears from the list).
 */
export function getActiveAgentPin(): string | null {
  try {
    const v = window.localStorage.getItem(AGENT_PIN_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setActiveAgentPin(agentId: string): void {
  try {
    window.localStorage.setItem(AGENT_PIN_KEY, agentId);
    window.localStorage.setItem(CONTEXT_KEY, agentId);
  } catch {
    // see setSecret — degraded behavior is acceptable.
  }
  try {
    window.dispatchEvent(
      new CustomEvent("agentthursday:active-agent:changed", { detail: { agentId } }),
    );
  } catch {
    // window unavailable (SSR / tests) — events are best-effort.
  }
}

export function clearActiveAgentPin(): void {
  try {
    window.localStorage.removeItem(AGENT_PIN_KEY);
  } catch {
    // see setSecret
  }
  try {
    window.dispatchEvent(
      new CustomEvent("agentthursday:active-agent:changed", { detail: { agentId: null } }),
    );
  } catch {
    // see setActiveAgentPin
  }
}
