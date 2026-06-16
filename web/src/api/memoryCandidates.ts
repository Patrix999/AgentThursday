/**
 * read-only memory candidate inspect API client.
 *
 * Wraps `GET /cli/memory/candidates`. Read-only; the server callable
 * never writes `agent_memories`.
 */
import type { MemoryCandidatesResult } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

export async function fetchMemoryCandidates(opts?: {
  limit?: number;
}): Promise<MemoryCandidatesResult | null> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = `/cli/memory/candidates${qs.length > 0 ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MemoryCandidatesResult;
}
