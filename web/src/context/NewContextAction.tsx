import { useState } from "react";
import { newContext } from "../api/contextActions";
import type { NewContextResult } from "../../shared/schema";
import { SummaryLine } from "./contextPieces";
import { getDebugReadonlyNotice } from "../debugSurfaceMode";

type NewContextStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string }
  | { kind: "running" }
  | { kind: "done"; result: NewContextResult }
  | { kind: "error"; message: string };

const DEFAULT_NEW_CONTEXT_REASON = "manual-ui-new";

/**
 *   — confirmation-gated `new context` action. UI copy
 * deliberately distinguishes this from `<ResetAction>`: reset KEEPS the
 * same context identity and only clears messages; new opens a fresh
 * `contextId` and audit-links the previous one. v1 still clears
 * messages in the same DO (per  spec; full multi-DO routing is
 * deferred to ) — the confirmation copy and result view say so
 * explicitly via `rawMessagesPreservedInOldContext: false` so the
 * operator does not mistake this for a true multi-context switch yet.
 *
 *  (2026-05-21) — extracted from ContextPanel.tsx; behavior
 * unchanged (same API call, same events, same result UI).
 */
export function NewContextAction({ totalMessageCount, actionsEnabled }: { totalMessageCount: number; actionsEnabled: boolean }) {
  const [stage, setStage] = useState<NewContextStage>({ kind: "idle" });

  function open() {
    if (!actionsEnabled) {
      setStage({ kind: "error", message: getDebugReadonlyNotice() });
      return;
    }
    setStage({ kind: "confirming", reason: DEFAULT_NEW_CONTEXT_REASON });
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
    const reason = stage.reason.trim().length > 0 ? stage.reason.trim() : DEFAULT_NEW_CONTEXT_REASON;
    setStage({ kind: "running" });
    const res = await newContext({ reason });
    if (res.ok && res.data) {
      setStage({ kind: "done", result: res.data });
      window.dispatchEvent(new Event("agentthursday:context:compacted"));
      window.dispatchEvent(new Event("agentthursday:context:switched"));
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
        <span className="font-semibold">New context (audit-linked)</span>
        <span className="text-[10px] text-violet-400/80 italic">
           — fresh contextId · v1 fallback (clears in same DO)
        </span>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Closes the active <span className="font-mono">contextId</span> and opens a fresh one,
        recording the boundary in <span className="font-mono">context_history</span> with a{" "}
        <span className="font-mono">context.new</span> audit row that links{" "}
        <span className="font-mono">previousContextId → newContextId</span>. v1 still clears
        transient messages (reset-style) in the same Durable Object — true multi-DO context
        switching is deferred to . Durable memory, checkpoints, workspace artifacts,
        and event_log are preserved.
      </p>

      {stage.kind === "idle" && (
        <button
          type="button"
          onClick={open}
          data-destructive="new-context"
          aria-disabled={!actionsEnabled || undefined}
          title={actionsEnabled ? "Open new-context confirmation" : getDebugReadonlyNotice()}
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${actionsEnabled ? "border-violet-700/70 bg-violet-950/40 text-violet-200 hover:bg-violet-900/40" : "border-slate-700 bg-slate-900/80 text-slate-500 cursor-not-allowed"}`}
        >
          New context
        </button>
      )}

      {stage.kind === "confirming" && (
        <NewContextConfirm
          totalMessageCount={totalMessageCount}
          reason={stage.reason}
          onChange={(next) => setStage({ kind: "confirming", reason: next })}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}

      {stage.kind === "running" && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-[10px] text-slate-400">
          Opening new context…
        </div>
      )}

      {stage.kind === "done" && (
        <NewContextResultView result={stage.result} onDismiss={() => setStage({ kind: "idle" })} />
      )}

      {stage.kind === "error" && (
        <div className="mt-2 rounded border border-rose-700 bg-rose-950/40 px-2 py-1.5 text-[10px] text-rose-300">
          <div className="font-semibold">New context failed</div>
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

function NewContextConfirm({
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
    <div className="mt-2 rounded border border-violet-700/70 bg-violet-950/30 p-3 space-y-2 text-[11px] text-violet-100">
      <div className="font-semibold">Confirm new context</div>
      <ul className="list-disc pl-4 text-[10px] text-violet-200/80 space-y-0.5">
        <li>
          Closes the current contextId and opens a fresh one. The boundary +{" "}
          {totalMessageCount} message count are written to{" "}
          <span className="font-mono">context_history</span>.
        </li>
        <li>
          Audit event <span className="font-mono">context.new</span> links{" "}
          <span className="font-mono">previousContextId → newContextId</span> with the reason
          below.
        </li>
        <li>
          <span className="font-semibold text-amber-200">v1 fallback:</span> raw transcripts of
          the old context are NOT preserved — they are cleared in the same Durable Object.
          Only the audit trail and per-context event_log entries survive.  (deferred)
          will add per-context DO routing for true multi-context switching.
        </li>
        <li>
          Durable memory, checkpoints, workspace artifacts, event_log, current task metadata,
          and model profile are preserved.
        </li>
      </ul>
      <label className="block">
        <span className="text-[10px] text-violet-200/80">Reason (capped 200 chars)</span>
        <input
          type="text"
          value={reason}
          maxLength={200}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. switching from  work to M8 planning"
          className="mt-0.5 w-full rounded bg-slate-950/70 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded border border-violet-700/70 bg-violet-900/40 px-2 py-1 text-[10px] text-violet-100 hover:bg-violet-900/60"
        >
          Confirm new context
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

function NewContextResultView({
  result,
  onDismiss,
}: {
  result: NewContextResult;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-2 rounded border border-emerald-700/60 bg-emerald-950/30 p-3 space-y-1.5 text-[11px] text-emerald-100">
      <div className="flex items-center justify-between">
        <span className="font-semibold">New context opened</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-emerald-300/80 hover:text-emerald-100"
        >
          dismiss
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <SummaryLine label="previous" value={shortContextId(result.previousContextId)} mono />
        <SummaryLine label="new" value={shortContextId(result.newContextId)} mono />
        <SummaryLine label="before" value={`${result.beforeMessageCount} msgs`} />
        <SummaryLine label="after" value={`${result.afterMessageCount} msgs`} />
        <SummaryLine label="reason" value={result.reason ?? "(none)"} mono />
        <SummaryLine
          label="durable state"
          value={result.preservedDurableState ? "preserved ✓" : "NOT preserved ⚠"}
        />
        <SummaryLine
          label="raw old transcripts"
          value={result.rawMessagesPreservedInOldContext ? "preserved" : "cleared (v1 fallback)"}
        />
        <SummaryLine label="timestamp" value={new Date(result.timestamp).toISOString()} mono />
      </div>
      <div className="text-[10px] text-amber-200/80">
        Note: {result.v1FallbackNote}
      </div>
    </div>
  );
}

function shortContextId(id: string): string {
  // contextIds are emitted as `ctx_<uuid>`; strip the prefix and keep
  // the first 8 hex chars for display.
  const stripped = id.startsWith("ctx_") ? id.slice(4) : id;
  return stripped.length > 12 ? `${stripped.slice(0, 8)}…` : stripped;
}
