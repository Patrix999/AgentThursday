import { useEffect, useState } from "react";
import type { MemorySnapshot } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type State = {
  data: MemorySnapshot | null;
  loading: boolean;
  error: string | null;
};

/**
 * poll `/api/memory` every 10s. Slower than workspace because
 * memory changes are rare. On 401 mirrors `useWorkspace`: clearSecret +
 * dispatch `agent-thursday:unauthorized` so SecretGate re-prompts.
 */
export function useMemorySnapshot(intervalMs = 10_000): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/memory", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MemorySnapshot;
        if (active) setState({ data, loading: false, error: null });
      } catch (e) {
        if (active) setState((s) => ({ ...s, loading: false, error: String(e) }));
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
