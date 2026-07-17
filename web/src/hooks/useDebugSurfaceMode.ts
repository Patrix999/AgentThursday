/**
 * React hook around `fetchDebugSurfaceMode()`.
 *
 * Subscribes a component to the resolved mode. Returns `null` while
 * the first fetch is in flight so the caller can render nothing
 * inspect-related until the mode is known — preventing a flash of
 * Inspect UI on `disable` deployments.
 *
 * The fetch is memoised globally, so multiple hook callers share a
 * single round-trip.
 */
import { useEffect, useState } from "react";
import { fetchDebugSurfaceMode, type DebugSurfaceMode } from "../debugSurfaceMode";

export function useDebugSurfaceMode(): DebugSurfaceMode | null {
  const [mode, setMode] = useState<DebugSurfaceMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchDebugSurfaceMode()
      .then((m) => { if (!cancelled) setMode(m); })
      .catch(() => { if (!cancelled) setMode("enable"); });
    return () => { cancelled = true; };
  }, []);
  return mode;
}
