import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextInspectResult } from "../../shared/schema";
import { fetchContextInspect } from "../api/contextActions";

type State = {
  data: ContextInspectResult | null;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
  /** Force an immediate poll outside the regular cadence. */
  refresh: () => Promise<void>;
};

/**
 * polls `/cli/context/inspect` for the left context
 * indicator rail. 12s interval — slower than workspace () and inspect
 * () since context only changes when a turn completes. `lastN` is
 * fixed at 60 so the rail can show enough segments to be visually
 * meaningful while still bounded by 's 200-cap.
 *
 * exposes `refresh()` so the compact action can trigger an
 * immediate re-poll instead of waiting up to 12s for the interval to
 * tick. Without this the rail/panel show pre-compact state for up to
 * 12s after a successful compact, which is confusing.
 */
export function useContextInspect(enabled: boolean, intervalMs = 12_000, lastN = 60): State {
  const [data, setData] = useState<ContextInspectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const activeRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const json = await fetchContextInspect(lastN);
      if (!activeRef.current) return;
      if (json === null) return; // 401 path; auth gate already kicked in.
      setData(json);
      setLoading(false);
      setError(null);
      setLastRefreshedAt(Date.now());
    } catch (e) {
      if (activeRef.current) {
        setLoading(false);
        setError(String(e));
      }
    }
  }, [lastN]);

  useEffect(() => {
    if (!enabled) return;
    activeRef.current = true;
    setLoading(true);
    void poll();
    const timer = window.setInterval(() => { void poll(); }, intervalMs);
    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, poll]);

  return { data, loading, error, lastRefreshedAt, refresh: poll };
}
