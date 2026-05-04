import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSharedContextInspect } from "./ContextInspectProvider";
import { classifyContextPressure } from "./contextPressure";
import {
  compactContext,
  fetchCompactions,
  resetContext,
  newContext,
  switchContext,
  fetchActiveContext,
  fetchContextHistory,
} from "../api/contextActions";
import type {
  ActiveContext,
  CompactContextResult,
  ContextHistoryEntry,
  ContextResetResult,
  NewContextResult,
  StoredCompactionView,
} from "../../shared/schema";
import {
  PressurePill,
  recommendationToneClasses,
  SummaryRow,
  TokenBlock,
  TurnPreview,
  type SanitizedMessage,
} from "./contextPieces";
import { SmartCompactPlan } from "./SmartCompactPlan";

/**
 * Context Inspect Web Tab.
 *
 * Deep-view complement to 's always-visible left rail. Lives
 * inside the Inspect drawer's tab strip; consumes 's
 * `inspectContext` data via the same `useContextInspect` hook (the
 * panel only mounts when the tab is active, so polling is implicitly
 * lazy via React lifecycle — no explicit `enabled` flag needed).
 *
 * Sections (per  UX requirements):
 *   1. Context summary / pressure
 *   2. Token availability
 *   3. Visible messages / turns
 *   4. Future actions placeholder — disabled compact + read-only CLI
 *      reference for reset; no mutation in this card.
 *
 * Red lines:
 *   - no actual compact mutation
 *   - no in-UI reset button (CLI reference only; reset stays manual
 *     until  / a dedicated confirmation flow lands)
 *   - no system/SOUL/reasoning content displayed
 *   - tool input/output never rendered (not even server's truncated
 *     preview); only `toolName` surfaces
 */
export function ContextPanel() {
  const { data, loading, error } = useSharedContextInspect();
  const pressure = useMemo(() => classifyContextPressure(data), [data]);

  const protectedSystemCount = data?.byRole.system ?? 0;

  return (
    <section className="m-4 space-y-4 text-xs text-slate-200">
      <SectionHeader title="Context summary" right={data && pressure.level !== "empty" ? <PressurePill pressure={pressure} /> : null} />

      {error && (
        <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-rose-300">
          inspect fetch error: {error}
        </div>
      )}

      {!data && loading && <div className="text-slate-500">Loading…</div>}
      {!data && !loading && !error && <EmptyState />}
      {data && data.totalMessageCount === 0 && (
        <>
          <EmptyState />
          <SectionHeader title="Future actions" />
          <FutureActions totalMessageCount={0} />
        </>
      )}

      {data && data.totalMessageCount > 0 && (
        <>
          <div className="rounded border border-slate-800 bg-slate-900/60 p-3 space-y-2">
            <div className="text-[11px] text-slate-300">
              <span className="text-slate-500">why: </span>
              {pressure.reason}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <SummaryRow label="messages" value={String(data.totalMessageCount)} />
              <SummaryRow label="visible" value={String(data.visibleMessages.length)} />
              <SummaryRow label="user" value={String(data.byRole.user)} />
              <SummaryRow label="assistant" value={String(data.byRole.assistant)} />
              {protectedSystemCount > 0 && (
                <SummaryRow label="system" value={String(protectedSystemCount)} muted />
              )}
              <SummaryRow
                label="truncated"
                value={data.truncated ? "yes" : "no"}
                muted={!data.truncated}
              />
              <SummaryRow
                label="visible start"
                value={String(data.visibleStartIndex)}
                muted
              />
            </div>
            {pressure.recommendation && (pressure.level === "growing" || pressure.level === "high") && (
              <div className={`rounded px-2 py-1.5 text-[11px] ${recommendationToneClasses(pressure.level)}`}>
                {pressure.recommendation}
              </div>
            )}
          </div>

          <SectionHeader title="Token availability" />
          <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
            <TokenBlock label="session" stats={data.tokenSession} />
            <TokenBlock label="task" stats={data.tokenTask} />
            <p className="mt-2 text-[10px] text-slate-600">
              Counts come from the runtime per step; "unavailable" means the runtime did not report a value for this scope this round, not zero usage.
            </p>
          </div>

          <SectionHeader
            title={`Visible messages (${data.visibleMessages.length} of ${data.totalMessageCount})`}
            right={
              data.truncated ? (
                <span className="text-[10px] text-amber-400">older context still informs the model</span>
              ) : null
            }
          />
          <MessageList messages={data.visibleMessages} />

          <SectionHeader title="Future actions" />
          <FutureActions totalMessageCount={data.totalMessageCount} />
          <SectionHeader title="Compaction history" />
          <CompactionHistory />
        </>
      )}
    </section>
  );
}

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{title}</h3>
      {right}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-slate-500">
      No context yet.
    </div>
  );
}

function MessageList({ messages }: { messages: SanitizedMessage[] }) {
  if (messages.length === 0) {
    return <div className="text-slate-500">empty</div>;
  }
  // Newest at top — diagnosis-first ordering, opposite of the rail's
  // top-down chronological strip. Reviewers usually want "what just
  // happened" before "how did we get here".
  const reversed = [...messages].reverse();
  return (
    <div className="space-y-1.5">
      {reversed.map((m, idx) => (
        <TurnPreview key={`${m.id}-${idx}`} message={m} />
      ))}
    </div>
  );
}

function FutureActions({ totalMessageCount }: { totalMessageCount: number }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-3 space-y-4">
      <ContextIdentity />
      <ResetAction totalMessageCount={totalMessageCount} />
      <NewContextAction totalMessageCount={totalMessageCount} />
      <CompactAction totalMessageCount={totalMessageCount} />
      <SmartCompactPlan />
    </div>
  );
}

/**
 * v3 context identity summary. Renders the active
 * contextId + creation reason at the top of FutureActions so the
 * operator can see which logical context they are operating on.
 * Refreshes on `agent-thursday:context:compacted` (the same event the legacy
 * compact and  reset paths dispatch) and on the new
 * `agent-thursday:context:switched` event dispatched by `<NewContextAction>`.
 */
function ContextIdentity() {
  const [active, setActive] = useState<ActiveContext | null>(null);
  const [history, setHistory] = useState<ContextHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [a, h] = await Promise.all([fetchActiveContext(), fetchContextHistory()]);
        if (!mounted) return;
        if (a) setActive(a);
        if (h) setHistory(h.contexts);
      } catch (e) {
        if (mounted) setError(String(e));
      }
    }
    void load();
    function onRefresh() {
      void load();
    }
    window.addEventListener("agent-thursday:context:compacted", onRefresh);
    window.addEventListener("agent-thursday:context:switched", onRefresh);
    return () => {
      mounted = false;
      window.removeEventListener("agent-thursday:context:compacted", onRefresh);
      window.removeEventListener("agent-thursday:context:switched", onRefresh);
    };
  }, []);

  async function onSwitch(contextId: string) {
    if (switching) return;
    setSwitching(contextId);
    setSwitchError(null);
    const res = await switchContext({ contextId, reason: "manual-ui-switch" });
    if (res.ok && res.data) {
      setSwitching(null);
      // The client helper already wrote the new contextId to
      // localStorage; subsequent fetches will carry the header. Fire
      // the same refresh events the new-context flow uses so inspect /
      // pressure rail / compactions all re-fetch against the newly
      // active DO.
      window.dispatchEvent(new Event("agent-thursday:context:compacted"));
      window.dispatchEvent(new Event("agent-thursday:context:switched"));
    } else {
      const message = (res.data as unknown as { error?: string })?.error
        ?? res.error
        ?? `HTTP ${res.status}`;
      setSwitching(null);
      setSwitchError(message);
    }
  }

  if (error) {
    return (
      <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-[10px] text-rose-300">
        context identity error: {error}
      </div>
    );
  }
  if (!active) {
    return <div className="text-[10px] text-slate-500">loading context identity…</div>;
  }

  const closedCount = history.filter((c) => !c.isActive).length;

  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-1 text-[10px] text-slate-300">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-400">Active context</span>
        <span className="font-mono text-sky-300">{shortContextId(active.contextId)}</span>
        <span className="ml-auto text-slate-500">
          {closedCount > 0 ? `+${closedCount} closed` : "first context"}
        </span>
      </div>
      <div className="text-[10px] text-slate-500">
        opened: {new Date(active.createdAt).toISOString()}
        {active.reason ? <> · reason: <span className="text-slate-400">{active.reason}</span></> : null}
      </div>
      {switchError && (
        <div className="rounded border border-rose-700 bg-rose-950/40 px-2 py-1 text-rose-300">
          switch failed: {switchError}
        </div>
      )}
      {history.length > 1 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
            history ({history.length}) · click to switch
          </summary>
          <ul className="mt-1 space-y-0.5">
            {history.map((c) => (
              <li key={c.contextId} className="flex items-center gap-2 truncate">
                <button
                  type="button"
                  onClick={() => onSwitch(c.contextId)}
                  disabled={c.isActive || switching !== null}
                  className={`flex flex-1 items-center gap-2 truncate rounded px-1 py-0.5 text-left ${
                    c.isActive
                      ? "cursor-default bg-sky-950/40 text-sky-300"
                      : switching === c.contextId
                        ? "cursor-progress text-slate-500"
                        : "text-slate-300 hover:bg-slate-800"
                  }`}
                  title={c.isActive ? "Currently active" : `Switch to ${c.contextId}`}
                >
                  <span className="font-mono text-slate-400">{shortContextId(c.contextId)}</span>
                  <span className={c.isActive ? "text-sky-300" : switching === c.contextId ? "text-amber-300" : "text-slate-500"}>
                    {c.isActive ? "active" : switching === c.contextId ? "switching…" : "closed"}
                  </span>
                  <span className="ml-auto text-slate-500">
                    {c.messageCountAtEnd !== null ? `${c.messageCountAtEnd} msgs` : ""}
                  </span>
                  <span className="text-slate-500 truncate">{c.reason ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function shortContextId(id: string): string {
  // contextIds are emitted as `ctx_<uuid>`; strip the prefix and keep
  // the first 8 hex chars for display.
  const stripped = id.startsWith("ctx_") ? id.slice(4) : id;
  return stripped.length > 12 ? `${stripped.slice(0, 8)}…` : stripped;
}

type NewContextStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string }
  | { kind: "running" }
  | { kind: "done"; result: NewContextResult }
  | { kind: "error"; message: string };

const DEFAULT_NEW_CONTEXT_REASON = "manual-ui-new";

/**
 * v3 confirmation-gated `new context` action. UI copy
 * deliberately distinguishes this from `<ResetAction>`: reset KEEPS the
 * same context identity and only clears messages; new opens a fresh
 * `contextId` and audit-links the previous one. v1 still clears
 * messages in the same DO (per  spec; full multi-DO routing is
 * deferred to ) — the confirmation copy and result view say so
 * explicitly via `rawMessagesPreservedInOldContext: false` so the
 * operator does not mistake this for a true multi-context switch yet.
 */
function NewContextAction({ totalMessageCount }: { totalMessageCount: number }) {
  const [stage, setStage] = useState<NewContextStage>({ kind: "idle" });

  function open() {
    setStage({ kind: "confirming", reason: DEFAULT_NEW_CONTEXT_REASON });
  }
  function cancel() {
    setStage({ kind: "idle" });
  }
  async function confirm() {
    if (stage.kind !== "confirming") return;
    const reason = stage.reason.trim().length > 0 ? stage.reason.trim() : DEFAULT_NEW_CONTEXT_REASON;
    setStage({ kind: "running" });
    const res = await newContext({ reason });
    if (res.ok && res.data) {
      setStage({ kind: "done", result: res.data });
      window.dispatchEvent(new Event("agent-thursday:context:compacted"));
      window.dispatchEvent(new Event("agent-thursday:context:switched"));
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
          v3 — fresh contextId · v1 fallback (clears in same DO)
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
          className="mt-2 rounded border border-violet-700/70 bg-violet-950/40 px-2 py-1 text-[10px] text-violet-200 hover:bg-violet-900/40"
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

type ResetStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string }
  | { kind: "running" }
  | { kind: "done"; result: ContextResetResult }
  | { kind: "error"; message: string };

const DEFAULT_RESET_REASON = "manual-ui-reset";

/**
 * v3 confirmation-gated reset action. The destructive
 * nature of reset is shown explicitly: the confirmation copy lists what
 * is cleared (transient model-visible messages, token counters) and
 * what is preserved (durable memory, checkpoints, workspace, event_log,
 * task metadata, model profile). After success we dispatch the same
 * `agent-thursday:context:compacted` event the legacy compact path uses so the
 * inspect surface and pressure rail re-fetch.
 */
function ResetAction({ totalMessageCount }: { totalMessageCount: number }) {
  const [stage, setStage] = useState<ResetStage>({ kind: "idle" });
  const resettable = totalMessageCount > 0;

  function open() {
    setStage({ kind: "confirming", reason: DEFAULT_RESET_REASON });
  }
  function cancel() {
    setStage({ kind: "idle" });
  }
  async function confirm() {
    if (stage.kind !== "confirming") return;
    const reason = stage.reason.trim().length > 0 ? stage.reason.trim() : DEFAULT_RESET_REASON;
    setStage({ kind: "running" });
    const res = await resetContext({ reason });
    if (res.ok && res.data) {
      setStage({ kind: "done", result: res.data });
      window.dispatchEvent(new Event("agent-thursday:context:compacted"));
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
          v3 — destructive · audit-logged · durable state preserved
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
          data-destructive="reset-context"
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${
            resettable
              ? "border-rose-700/70 bg-rose-950/40 text-rose-200 hover:bg-rose-900/40"
              : "cursor-not-allowed border-slate-700 bg-slate-900/80 text-slate-500"
          }`}
          title={resettable ? "Confirm before resetting transient context" : "Context already empty"}
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

type CompactStage =
  | { kind: "idle" }
  | { kind: "confirming"; reason: string; lastN: number }
  | { kind: "running" }
  | { kind: "done"; result: CompactContextResult }
  | { kind: "error"; message: string };

function CompactAction({ totalMessageCount }: { totalMessageCount: number }) {
  const defaultLastN = Math.max(0, totalMessageCount - 5);
  const compactable = defaultLastN >= 2;
  const [stage, setStage] = useState<CompactStage>({ kind: "idle" });

  function open() {
    setStage({ kind: "confirming", reason: "", lastN: defaultLastN });
  }
  function cancel() {
    setStage({ kind: "idle" });
  }
  async function confirm() {
    if (stage.kind !== "confirming") return;
    const { reason, lastN } = stage;
    setStage({ kind: "running" });
    const res = await compactContext({
      reason: reason.trim().length > 0 ? reason.trim() : undefined,
      lastN,
    });
    if (res.ok && res.data) {
      setStage({ kind: "done", result: res.data });
      window.dispatchEvent(new Event("agent-thursday:context:compacted"));
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
        <span className="text-[10px] text-amber-400/80 italic"> v1 — explicit, audit-logged</span>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Folds the oldest <span className="font-mono">lastN</span> messages into a deterministic summary overlay via the SDK's <span className="font-mono">addCompaction</span>. The model sees the summary in place of the original messages on next turn; the underlying message tree is preserved. Durable state (memory, checkpoints, workspace, event log) is untouched.
      </p>

      {stage.kind === "idle" && (
        <button
          type="button"
          onClick={open}
          disabled={!compactable}
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${
            compactable
              ? "border-amber-700/70 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40"
              : "cursor-not-allowed border-slate-700 bg-slate-900/80 text-slate-500"
          }`}
          title={compactable ? "Open compaction confirmation" : `Need at least 7 messages (have ${totalMessageCount})`}
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

function SummaryLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-emerald-300/70">{label}</span>
      <span className={mono ? "font-mono truncate" : "truncate"}>{value}</span>
    </div>
  );
}

function CompactionHistory() {
  const [items, setItems] = useState<StoredCompactionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetchCompactions();
        if (!active) return;
        if (res === null) return; // 401 path
        setItems(res.compactions);
      } catch (e) {
        if (active) setError(String(e));
      }
    }
    void load();
    function onCompacted() {
      void load();
    }
    window.addEventListener("agent-thursday:context:compacted", onCompacted);
    return () => {
      active = false;
      window.removeEventListener("agent-thursday:context:compacted", onCompacted);
    };
  }, []);

  if (error) {
    return (
      <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-[10px] text-rose-300">
        compactions fetch error: {error}
      </div>
    );
  }
  if (items === null) {
    return <div className="text-[10px] text-slate-500">loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-3 py-3 text-[10px] text-slate-500 text-center">
        No compactions yet.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {items.map((c) => (
        <CompactionRow key={c.id} compaction={c} />
      ))}
    </div>
  );
}

function CompactionRow({ compaction }: { compaction: StoredCompactionView }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 text-[10px] text-slate-300">
      <div className="flex items-center gap-2">
        <span className="font-mono text-slate-400 truncate">{compaction.id.slice(0, 12)}…</span>
        <span className="text-slate-500">{compaction.createdAt}</span>
        <span className="ml-auto text-slate-500">{compaction.summaryLength} chars</span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">summary</summary>
        <pre className="mt-1 rounded bg-slate-950/70 px-2 py-1.5 text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {compaction.summaryPreview}
        </pre>
      </details>
    </div>
  );
}
