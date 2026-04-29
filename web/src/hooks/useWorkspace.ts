import { useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type WorkspaceState = {
  data: WorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
};

/**
 * Polls `/api/workspace` every 3s. Card 76 contract.
 * On 401, clears the stored secret and dispatches `agent-thursday:unauthorized` so
 * `SecretGate` re-prompts. Other errors stay inline.
 */
export function useWorkspace(intervalMs = 3000): WorkspaceState {
  const [state, setState] = useState<WorkspaceState>({
    data: null,
    loading: true,
    error: null,
    lastRefreshedAt: null,
  });

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/workspace", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as WorkspaceSnapshot;
        if (active) {
          setState({ data: json, loading: false, error: null, lastRefreshedAt: Date.now() });
        }
      } catch (e) {
        if (active) {
          setState((s) => ({ ...s, loading: false, error: String(e) }));
        }
      }
    }

    void poll();
    const timer = window.setInterval(poll, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}
