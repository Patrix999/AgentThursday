import { useState } from "react";
import { compactContext } from "../api/contextActions";
import type { CompactContextResult } from "../../shared/schema";
import { SummaryLine } from "./contextPieces";
import { getDebugReadonlyNotice } from "../debugSurfaceMode";

type CompactStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string; lastN: number }
  | { kind: "running" }
  | { kind: "done"; result: CompactContextResult }
  | { kind: "error"; message: string };

/**
 * M7.7 v1 — selective compaction action. Folds the oldest `lastN`
 * messages into a deterministic summary overlay via the SDK's
 * `addCompaction`. Audit events `context.compact.requested` +
 * `context.compact.completed` are logged.
 *
 * an earlier revision (2026-05-21) — extracted from ContextPanel.tsx; behavior
 * unchanged (same API call, same event, same confirmation copy).
 */
export function CompactAction({ totalMessageCount, actionsEnabled }: { totalMessageCount: number; actionsEnabled: boolean }) {
  const defaultLastN = Math.max(0, totalMessageCount - 5);
  const compactable = defaultLastN >= 2;
  const [stage, setStage] = useState<CompactStage>({ kind: "idle" });

  function open() {
    if (!actionsEnabled) {
      setStage({ kind: "error", message: getDebugReadonlyNotice() });
      return;
    }
    setStage({ kind: "confirming", reason: "", lastN: defaultLastN });
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
    const { reason, lastN } = stage;
    setStage({ kind: "running" });
    const res = await compactContext({
      reason: reason.trim().length > 0 ? reason.trim() : undefined,
      lastN,
    });
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
        <span className="font-semibold">Compact (selective range)</span>
        <span className="text-[10px] text-amber-400/80 italic">M7.7 v1 — explicit, audit-logged</span>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Folds the oldest <span className="font-mono">lastN</span> messages into a deterministic summary overlay via the SDK's <span className="font-mono">addCompaction</span>. The model sees the summary in place of the original messages on next turn; the underlying message tree is preserved. Durable state (memory, checkpoints, workspace, event log) is untouched.
      </p>

      {stage.kind === "idle" && (
        <button
          type="button"
          onClick={open}
          disabled={!compactable}
          aria-disabled={!actionsEnabled || undefined}
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${
            !compactable
              ? "cursor-not-allowed border-slate-700 bg-slate-900/80 text-slate-500"
              : actionsEnabled
                ? "border-amber-700/70 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40"
                : "border-slate-700 bg-slate-900/80 text-slate-500 cursor-not-allowed"
          }`}
          title={!compactable ? `Need at least 7 messages (have ${totalMessageCount})` : actionsEnabled ? "Open compaction confirmation" : getDebugReadonlyNotice()}
        >
          Compact this range
        </button>
      )}

      {stage.kind === "confirming" && (
        <CompactConfirm
          totalMessageCount={totalMessageCount}
          reason={stage.reason}
          lastN={stage.lastN}
          onChange={(next) => setStage({ kind: "confirming", ...next })}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}

      {stage.kind === "running" && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-[10px] text-slate-400">
          Compacting…
        </div>
      )}

      {stage.kind === "done" && (
        <CompactResultView result={stage.result} onDismiss={() => setStage({ kind: "idle" })} />
      )}

      {stage.kind === "error" && (
        <div className="mt-2 rounded border border-rose-700 bg-rose-950/40 px-2 py-1.5 text-[10px] text-rose-300">
          <div className="font-semibold">Compact failed</div>
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

function CompactConfirm({
  totalMessageCount,
  reason,
  lastN,
  onChange,
  onConfirm,
  onCancel,
}: {
  totalMessageCount: number;
  reason: string;
  lastN: number;
  onChange: (next: { reason: string; lastN: number }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const max = Math.max(2, totalMessageCount - 1);
  const min = 2;
  return (
    <div className="mt-2 rounded border border-amber-700/70 bg-amber-950/30 p-3 space-y-2 text-[11px] text-amber-100">
      <div className="font-semibold">Confirm compaction</div>
      <p className="text-[10px] text-amber-200/80">
        Will replace messages [0..{lastN - 1}] with a deterministic summary overlay. Audit events <span className="font-mono">context.compact.requested</span> + <span className="font-mono">context.compact.completed</span> are logged. Reset/rollback is not yet exposed.
      </p>
      <label className="block">
        <span className="text-[10px] text-amber-200/80">Reason (optional, capped 200 chars)</span>
        <input
          type="text"
          value={reason}
          maxLength={200}
          onChange={(e) => onChange({ reason: e.target.value, lastN })}
          placeholder="e.g. context pressure high after long debugging chat"
          className="mt-0.5 w-full rounded bg-slate-950/70 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500"
        />
      </label>
      <label className="block">
        <span className="text-[10px] text-amber-200/80">
          lastN — how many oldest messages to compact ({min}..{max}, total {totalMessageCount})
        </span>
        <input
          type="number"
          value={lastN}
          min={min}
          max={max}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange({ reason, lastN: Math.max(min, Math.min(max, Math.floor(n))) });
          }}
          className="mt-0.5 w-24 rounded bg-slate-950/70 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-amber-500"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-900/60"
        >
          Confirm compact
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

function CompactResultView({ result, onDismiss }: { result: CompactContextResult; onDismiss: () => void }) {
  return (
    <div className="mt-2 rounded border border-emerald-700/60 bg-emerald-950/30 p-3 space-y-1.5 text-[11px] text-emerald-100">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Compact complete</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-emerald-300/80 hover:text-emerald-100"
        >
          dismiss
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <SummaryLine label="range" value={`[${result.fromIndex}..${result.toIndex}]`} />
        <SummaryLine label="compacted" value={`${result.compactedRangeSize} msgs`} />
        <SummaryLine label="before" value={`${result.beforeMessageCount} msgs`} />
        <SummaryLine label="after" value={`${result.afterMessageCount} msgs`} />
        <SummaryLine
          label="model-visible after"
          value={result.modelVisibleAfter !== null ? `${result.modelVisibleAfter} msgs` : "n/a"}
        />
        <SummaryLine label="compaction id" value={result.compaction.id} mono />
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-emerald-300/80 hover:text-emerald-100">
          summary preview ({result.compaction.summaryLength} chars{result.summaryTruncated ? " · truncated" : ""})
        </summary>
        <pre className="mt-1 rounded bg-slate-950/70 px-2 py-1.5 text-[10px] text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {result.compaction.summaryPreview}
        </pre>
      </details>
    </div>
  );
}
