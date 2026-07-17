import { useState } from "react";
import { resetContext } from "../api/contextActions";
import type { ContextResetResult } from "../../shared/schema";
import { SummaryLine } from "./contextPieces";
import { getDebugReadonlyNotice } from "../debugSurfaceMode";

type ResetStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string }
  | { kind: "running" }
  | { kind: "done"; result: ContextResetResult }
  | { kind: "error"; message: string };

const DEFAULT_RESET_REASON = "manual-ui-reset";

/**
 * confirmation-gated reset action. The destructive
 * nature of reset is shown explicitly: the confirmation copy lists what
 * is cleared (transient model-visible messages, token counters) and
 * what is preserved (durable memory, checkpoints, workspace, event_log,
 * task metadata, model profile). After success we dispatch the same
 * `agentthursday:context:compacted` event the legacy compact path uses so the
 * inspect surface and pressure rail re-fetch.
 *
 * an earlier revision (2026-05-21) — extracted from ContextPanel.tsx; behavior
 * unchanged (same API call, same event, same result UI).
 */
export function ResetAction({ totalMessageCount, actionsEnabled }: { totalMessageCount: number; actionsEnabled: boolean }) {
  const [stage, setStage] = useState<ResetStage>({ kind: "idle" });
  const resettable = totalMessageCount > 0;

  function open() {
    if (!actionsEnabled) {
      setStage({ kind: "error", message: getDebugReadonlyNotice() });
      return;
    }
    setStage({ kind: "confirming", reason: DEFAULT_RESET_REASON });
  }
  function cancel() {
    setStage({ kind: "idle" });
  }
  async function confirm() {
    if (stage.kind !== "confirming") return;
    if (!actionsEnabled) {
      setStage({ kind: "error", message: getDebugReadonlyNotice() });
      return;
    }
    const reason = stage.reason.trim().length > 0 ? stage.reason.trim() : DEFAULT_RESET_REASON;
    setStage({ kind: "running" });
    const res = await resetContext({ reason });
    if (res.ok && res.data) {
      setStage({ kind: "done", result: res.data });
      window.dispatchEvent(new Event("agentthursday:context:compacted"));
    } else {
      const message = (res.data as unknown as { error?: string })?.error
        ?? res.error
        ?? `HTTP ${res.status}`;
      setStage({ kind: "error", message });
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] text-slate-300">
        <span className="font-semibold">Reset transient context</span>
        <span className="text-[10px] text-rose-400/80 italic">
          destructive · audit-logged · durable state preserved
        </span>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Clears the Think SDK message history and resets task/session token counters.{" "}
        Durable memory, checkpoints, workspace artifacts, event_log, current task metadata,{" "}
        and the active model profile are NOT touched.
      </p>

      {stage.kind === "idle" && (
        <button
          type="button"
          onClick={open}
          disabled={!resettable}
          aria-disabled={!actionsEnabled || undefined}
          data-destructive="reset-context"
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${
            !resettable
              ? "cursor-not-allowed border-slate-700 bg-slate-900/80 text-slate-500"
              : actionsEnabled
                ? "border-rose-700/70 bg-rose-950/40 text-rose-200 hover:bg-rose-900/40"
                : "border-slate-700 bg-slate-900/80 text-slate-500 cursor-not-allowed"
          }`}
          title={!resettable ? "Context already empty" : actionsEnabled ? "Confirm before resetting transient context" : getDebugReadonlyNotice()}
        >
          Reset transient context
        </button>
      )}

      {stage.kind === "confirming" && (
        <ResetConfirm
          totalMessageCount={totalMessageCount}
          reason={stage.reason}
          onChange={(next) => setStage({ kind: "confirming", reason: next })}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}

      {stage.kind === "running" && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-[10px] text-slate-400">
          Resetting…
        </div>
      )}

      {stage.kind === "done" && (
        <ResetResultView result={stage.result} onDismiss={() => setStage({ kind: "idle" })} />
      )}

      {stage.kind === "error" && (
        <div className="mt-2 rounded border border-rose-700 bg-rose-950/40 px-2 py-1.5 text-[10px] text-rose-300">
          <div className="font-semibold">Reset failed</div>
          <div className="mt-0.5">{stage.message}</div>
          <button
            type="button"
            onClick={() => setStage({ kind: "idle" })}
            className="mt-1 text-[10px] text-rose-400 hover:text-rose-200"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function ResetConfirm({
  totalMessageCount,
  reason,
  onChange,
  onConfirm,
  onCancel,
}: {
  totalMessageCount: number;
  reason: string;
  onChange: (next: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 rounded border border-rose-700/70 bg-rose-950/30 p-3 space-y-2 text-[11px] text-rose-100">
      <div className="font-semibold">Confirm reset</div>
      <ul className="list-disc pl-4 text-[10px] text-rose-200/80 space-y-0.5">
        <li>
          Will clear all {totalMessageCount} transient message(s) the model currently sees.
        </li>
        <li>
          Resets session and current-task token counters to zero.
        </li>
        <li>
          Audit event <span className="font-mono">context.reset</span> is recorded
          with before/after counts and the reason below.
        </li>
        <li>
          Durable memory, checkpoints, workspace files, event_log, current task
          metadata, and model profile are preserved.
        </li>
      </ul>
      <label className="block">
        <span className="text-[10px] text-rose-200/80">Reason (capped 200 chars)</span>
        <input
          type="text"
          value={reason}
          maxLength={200}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. dogfood rescue after long debugging chat"
          className="mt-0.5 w-full rounded bg-slate-950/70 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-rose-500"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded border border-rose-700/70 bg-rose-900/40 px-2 py-1 text-[10px] text-rose-100 hover:bg-rose-900/60"
        >
          Confirm reset
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResetResultView({ result, onDismiss }: { result: ContextResetResult; onDismiss: () => void }) {
  return (
    <div className="mt-2 rounded border border-emerald-700/60 bg-emerald-950/30 p-3 space-y-1.5 text-[11px] text-emerald-100">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Reset complete</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-emerald-300/80 hover:text-emerald-100"
        >
          dismiss
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <SummaryLine label="before" value={`${result.beforeMessageCount} msgs`} />
        <SummaryLine label="after" value={`${result.afterMessageCount} msgs`} />
        <SummaryLine
          label="reduction"
          value={`-${Math.max(0, result.beforeMessageCount - result.afterMessageCount)}`}
        />
        <SummaryLine label="reason" value={result.reason ?? "(none)"} mono />
        <SummaryLine
          label="durable state"
          value={result.preservedDurableState ? "preserved ✓" : "NOT preserved ⚠"}
        />
        <SummaryLine label="timestamp" value={new Date(result.timestamp).toISOString()} mono />
      </div>
    </div>
  );
}
