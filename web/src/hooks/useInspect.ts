import { useEffect, useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type State = {
  data: InspectSnapshot | null;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
};

/**
 * Polls `/api/inspect` only when `enabled` is true. Drawer passes `open` so
 * closed drawers don't waste cycles (Card 81 acceptance: "drawer 关闭后
 * useInspect 停止 polling"). 5s interval — slower than workspace, since
 * inspect data changes less critically.
 *
 * On 401 mirrors `useWorkspace`: clearSecret + dispatch `agent-thursday:unauthorized`
 * so SecretGate re-prompts.
 */
export function useInspect(enabled: boolean, intervalMs = 5000): State {
  const [state, setState] = useState<State>({
    data: null,
    loading: false,
    error: null,
    lastRefreshedAt: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/inspect", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as InspectSnapshot;
        if (active) {
          setState({ data: json, loading: false, error: null, lastRefreshedAt: Date.now() });
        }
      } catch (e) {
        if (active) {
          setState((s) => ({ ...s, loading: false, error: String(e) }));
        }
      }
    }

    setState((s) => ({ ...s, loading: true }));
    void poll();
    const timer = window.setInterval(poll, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return state;
}
