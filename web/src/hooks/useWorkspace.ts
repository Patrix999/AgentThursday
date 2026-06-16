import { useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import {
  authHeaders,
  clearSecret,
  getActiveAgentPin,
  getActiveContextId,
  setActiveContextId,
} from "../auth/secret";

type WorkspaceState = {
  data: WorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
};

/**
 * Polls `/api/workspace` every 3s.  contract.
 * On 401, clears the stored secret and dispatches `agentthursday:unauthorized` so
 * `SecretGate` re-prompts. Other errors stay inline.
 *
 *  — server-pinned active context reconcile. Each response
 * carries `activeContextId` (the registry's canonical pointer). When
 * it differs from the client's localStorage cache (`agentthursday.contextId`),
 * the hook updates the cache and immediately re-fetches under the
 * canonical id so the UI converges within a single reconcile step
 * instead of waiting for the next poll. A `lastReconciledRef` guard
 * prevents an infinite re-fetch loop if the server happens to keep
 * returning a different value (it shouldn't, but the guard ensures
 * one-shot reconcile per id even under bugs).
 */
export function useWorkspace(intervalMs = 3000): WorkspaceState {
  const [state, setState] = useState<WorkspaceState>({
    data: null,
    loading: true,
    error: null,
    lastRefreshedAt: null,
  });

  // Track the most recent `activeContextId` we already reconciled
  // against, scoped to this hook instance. Prevents the immediate
  // re-fetch from re-firing reconcile if the server returns the same
  // canonical id again.
  const lastReconciledRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function poll(): Promise<{ reconciled: boolean }> {
      try {
        const res = await fetch("/api/workspace", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agentthursday:unauthorized"));
          return { reconciled: false };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as WorkspaceSnapshot;
        if (!active) return { reconciled: false };

        //  — reconcile localStorage cache against the
        // canonical active pointer. We only act when (a) the values
        // differ AND (b) we haven't already reconciled to this id in
        // this hook's lifetime — avoids loops if the response keeps
        // disagreeing.
        //
        //  — when the user has explicitly pinned an agent via
        // the workspace selector, the pin is the source of truth for
        // this client. The server registry pointer may legitimately
        // disagree (it tracks the canonical single-active context for
        // unscoped callers like cron/Discord); we must not revert the
        // user's pick under it. The pinned agent itself was already
        // written into `agentthursday.contextId` by `setActiveAgentPin`, so
        // `authHeaders()` routes subsequent fetches to it.
        const canonical = json.activeContextId;
        const localCached = getActiveContextId();
        const pinned = getActiveAgentPin();
        const shouldReconcile =
          canonical.length > 0
          && canonical !== localCached
          && lastReconciledRef.current !== canonical
          && pinned === null;
        if (shouldReconcile) {
          setActiveContextId(canonical);
          lastReconciledRef.current = canonical;
          // Don't surface the stale snapshot — the immediate re-fetch
          // below will land on the canonical context. Dispatch an
          // event so other surfaces (drawer, banner) can react.
          window.dispatchEvent(new CustomEvent("agentthursday:context:reconciled", {
            detail: { activeContextId: canonical, previous: localCached || null },
          }));
          return { reconciled: true };
        }

        const refreshedAt = Date.now();
        setState({ data: json, loading: false, error: null, lastRefreshedAt: refreshedAt });
        window.dispatchEvent(new CustomEvent("agentthursday:workspace:refreshed", {
          detail: { activeContextId: json.activeContextId, refreshedAt },
        }));
        return { reconciled: false };
      } catch (e) {
        if (active) {
          setState((s) => ({ ...s, loading: false, error: String(e) }));
        }
        return { reconciled: false };
      }
    }

    async function pollAndReconcile(showLoading = false) {
      if (showLoading) setState((s) => ({ ...s, loading: true, error: null }));
      const first = await poll();
      // If we just reconciled the localStorage to a new canonical id,
      // re-fetch immediately under the new header so the user sees
      // canonical-context data without waiting for the next interval.
      if (first.reconciled) await poll();
    }

    void pollAndReconcile();
    const timer = window.setInterval(pollAndReconcile, intervalMs);
    function refreshActiveAgent() {
      void pollAndReconcile(true);
    }
    window.addEventListener("agentthursday:active-agent:changed", refreshActiveAgent);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("agentthursday:active-agent:changed", refreshActiveAgent);
    };
  }, [intervalMs]);

  return state;
}
