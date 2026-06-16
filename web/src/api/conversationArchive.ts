/**
 * read-only archive / retrieval Inspect surface.
 *
 * Wraps `GET /cli/context/archive/inspect` which always targets the
 * registry DO (DEMO_INSTANCE, the canonical archive owner) regardless
 * of the X-AgentThursday-Context-Id header. The response is hard-capped
 * server-side: at most `recentLimit` flush/retrieval rows and
 * `perContextLimit` aggregated counts. Default UI does not include
 * full archive text.
 */
import type { ArchiveInspectSummary } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

export async function fetchArchiveInspectSummary(opts?: {
  recentLimit?: number;
  perContextLimit?: number;
}): Promise<ArchiveInspectSummary | null> {
  const params = new URLSearchParams();
  if (opts?.recentLimit !== undefined) params.set("recentLimit", String(opts.recentLimit));
  if (opts?.perContextLimit !== undefined) params.set("perContextLimit", String(opts.perContextLimit));
  const qs = params.toString();
  const url = `/cli/context/archive/inspect${qs.length > 0 ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ArchiveInspectSummary;
}
