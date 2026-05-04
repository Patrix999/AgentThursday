/**
 * web client side of 's `X-AgentThursday-Secret` contract.
 *
 * Stored in localStorage so a refresh keeps you logged in. Cleared on 401.
 *
 * v3 `X-AgentThursday-Context-Id` header carries the active
 * context for per-context DO routing. Stored in localStorage so the UI
 * remembers the active context across reloads. Cleared via
 * `clearActiveContextId()` if needed.
 */
const SECRET_KEY = "agent-thursday.secret";
const CONTEXT_KEY = "agent-thursday.contextId";

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
