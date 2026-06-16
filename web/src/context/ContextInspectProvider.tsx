import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useContextInspect } from "../hooks/useContextInspect";

type State = ReturnType<typeof useContextInspect>;

const Ctx = createContext<State | null>(null);

const COMPACTED_EVENT = "agentthursday:context:compacted";
const RESET_EVENT = "agentthursday:context:reset";

/**
 * single-source provider for `inspectContext` polling.
 *
 * Both `ContextRail` (always visible on desktop) and `ContextPanel`
 * (Inspect-drawer Context tab) need the same data. Without this
 * provider they would each call `useContextInspect(true)` and run
 * separate `setInterval` loops against the same endpoint — a regression
 *  spec explicitly forbids ("Do not add another independent
 * high-frequency polling loop if existing useContextInspect or inspect
 * polling can be reused").
 *
 * Wrap any subtree that mounts a ContextRail/ContextPanel descendant
 * once. Children read via `useSharedContextInspect()`. Outside a
 * provider that hook throws — fail loud rather than silently start a
 * hidden second poll.
 */
export function ContextInspectProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const state = useContextInspect(enabled);
  //  — when a compact (or future reset-from-UI) lands, re-poll
  // immediately rather than waiting up to 12s for the interval. Both
  // events are user-triggered mutations, so a fresh fetch right after
  // is the lowest-cost way to keep the rail/panel visually consistent.
  useEffect(() => {
    function onMutated() { void state.refresh(); }
    window.addEventListener(COMPACTED_EVENT, onMutated);
    window.addEventListener(RESET_EVENT, onMutated);
    return () => {
      window.removeEventListener(COMPACTED_EVENT, onMutated);
      window.removeEventListener(RESET_EVENT, onMutated);
    };
  }, [state.refresh]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useSharedContextInspect(): State {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useSharedContextInspect must be used inside a <ContextInspectProvider>");
  }
  return ctx;
}
