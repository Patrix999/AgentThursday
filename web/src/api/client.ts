import { authHeaders, clearSecret } from "../auth/secret";

/**
 * M7.1 Card 79 — single POST helper for all mutating actions.
 *
 * - Always attaches `X-AgentThursday-Secret` (via authHeaders())
 * - On 401: clearSecret + dispatch `agent-thursday:unauthorized` so SecretGate re-prompts
 *   (mirrors useWorkspace polling behavior)
 * - Returns { ok, status, data } so callers can show inline errors without
 *   throwing — a failed mutation must not blow up its sibling cards.
 */
export async function postJson<T = unknown>(
  endpoint: string,
  body?: object,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const headers: Record<string, string> = { ...authHeaders() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      clearSecret();
      window.dispatchEvent(new Event("agent-thursday:unauthorized"));
      return { ok: false, status: 401, data: null, error: "auth.required" };
    }
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}
