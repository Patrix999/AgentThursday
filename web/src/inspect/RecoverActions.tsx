import { useState } from "react";
import { clearStaleState, forceContinue } from "../api/inspectActions";

/**
 *  §B-7 — recovery actions for the debug surface.
 * Only "real" endpoints that exist on the worker today are wired:
 *   - Clear stale state → POST /cli/clear-stale-state
 *   - Force continue    → POST /cli/continue (debug-flavored label)
 * Higher-level intervene flows (step-into / breakpoint) are out of scope (§Non-Goals).
 */
export function RecoverActions() {
  const [busy, setBusy] = useState<"clear" | "continue" | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function run(which: "clear" | "continue") {
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
          disabled={busy !== null}
          onClick={() => void run("clear")}
          className="px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "clear" ? "…" : "Clear stale state"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => void run("continue")}
          className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "continue" ? "…" : "Force continue"}
        </button>
      </div>
      {result && (
        <div className={result.kind === "ok" ? "text-emerald-300" : "text-rose-400"}>
          {result.msg}
        </div>
      )}
    </div>
  );
}
