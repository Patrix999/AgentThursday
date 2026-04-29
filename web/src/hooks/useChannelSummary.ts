import { useEffect, useState } from "react";
import type { ChannelCompactSummary } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type State = {
  data: ChannelCompactSummary | null;
  loading: boolean;
  error: string | null;
};

/**
 * M7.3 Card 89 — compact summary for the user-layer ChannelSummaryPanel.
 * 10s polling because change rate is low and we don't want to compete with
 * `useWorkspace`'s 3s polling for the same network slot.
 */
export function useChannelSummary(intervalMs = 10_000): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/channel/summary", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ChannelCompactSummary;
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
