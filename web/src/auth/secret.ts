/**
 * web client side of 's `X-AgentThursday-Secret` contract.
 *
 * Stored in localStorage so a refresh keeps you logged in. Cleared on 401.
 */
const KEY = "agent-thursday.secret";

export function getSecret(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSecret(value: string): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    // Storage may be disabled (private mode). The next request will 401 and the
    // user will be re-prompted; nothing useful to recover here.
  }
}

export function clearSecret(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // see setSecret
  }
}

export function authHeaders(): Record<string, string> {
  const s = getSecret();
  return s ? { "X-AgentThursday-Secret": s } : {};
}
