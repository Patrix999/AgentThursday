import { useEffect, useState } from "react";
import type { ChannelSnapshot } from "../../shared/schema";
import { authHeaders, clearSecret } from "../auth/secret";

type State = {
  data: ChannelSnapshot | null;
  loading: boolean;
  error: string | null;
};

/**
 * M7.3 Card 89 — full ChannelHub snapshot for the inspect tab.
 * `enabled=false` → no polling (mirrors `useInspect` lazy pattern from Card 81).
 * 5s interval — channel events arrive via webhook, faster polling buys little.
 */
export function useChannelSnapshot(enabled: boolean, intervalMs = 5000): State {
  const [state, setState] = useState<State>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/channel/snapshot", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agent-thursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ChannelSnapshot;
        if (active) setState({ data, loading: false, error: null });
      } catch (e) {
        if (active) setState((s) => ({ ...s, loading: false, error: String(e) }));
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
