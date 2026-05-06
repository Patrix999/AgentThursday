import { useState } from "react";
import { clearStaleState, forceContinue } from "../api/inspectActions";
import { useDebugSurfaceMode } from "../hooks/useDebugSurfaceMode";
import { isDebugActionEnabled, getDebugReadonlyNotice } from "../debugSurfaceMode";

/**
 * §B-7 — recovery actions for the debug surface.
 * Only "real" endpoints that exist on the worker today are wired:
 *   - Clear stale state → POST /cli/clear-stale-state
 *   - Force continue    → POST /cli/continue (debug-flavored label)
 * Higher-level intervene flows (step-into / breakpoint) are out of scope (§Non-Goals).
 *
 * when `AGENT_THURSDAY_DEBUG_SURFACE_MODE === "readonly"` the
 * buttons still render (so the operator can see what would be
 * available) but onClick surfaces a readonly notice instead of
 * hitting the API. This is a UI gate; backend endpoints stay
 * auth-gated independently.
 */
export function RecoverActions() {
  const [busy, setBusy] = useState<"clear" | "continue" | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "err" | "readonly"; msg: string } | null>(null);
  const debugMode = useDebugSurfaceMode();
  const actionsEnabled = debugMode === null ? false : isDebugActionEnabled(debugMode);

  async function run(which: "clear" | "continue") {
    if (!actionsEnabled) {
      setResult({ kind: "readonly", msg: getDebugReadonlyNotice() });
      return;
    }
    setBusy(which);
    setResult(null);
    const res = which === "clear" ? await clearStaleState() : await forceContinue();
    if (res.ok) {
      setResult({ kind: "ok", msg: `${which} → ok` });
    } else if (res.status !== 401) {
      setResult({ kind: "err", msg: res.error ?? `HTTP ${res.status}` });
    }
    setBusy(null);
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="text-slate-500 uppercase tracking-wide">Recovery</div>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy !== null || !actionsEnabled}
          onClick={() => void run("clear")}
          aria-disabled={!actionsEnabled || undefined}
          title={!actionsEnabled && debugMode !== null ? getDebugReadonlyNotice() : undefined}
          data-testid="recover-clear-stale-state"
          className="px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "clear" ? "…" : "Clear stale state"}
        </button>
        <button
          disabled={busy !== null || !actionsEnabled}
          onClick={() => void run("continue")}
          aria-disabled={!actionsEnabled || undefined}
          title={!actionsEnabled && debugMode !== null ? getDebugReadonlyNotice() : undefined}
          data-testid="recover-force-continue"
          className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "continue" ? "…" : "Force continue"}
        </button>
      </div>
      {result && (
        <div
          className={
            result.kind === "ok" ? "text-emerald-300"
              : result.kind === "readonly" ? "text-amber-300"
              : "text-rose-400"
          }
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}
