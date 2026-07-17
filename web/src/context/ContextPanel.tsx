import { useMemo, type ReactNode } from "react";
import { useSharedContextInspect } from "./ContextInspectProvider";
import { classifyContextPressure } from "./contextPressure";
import {
  PressurePill,
  recommendationToneClasses,
  SummaryRow,
  TokenBlock,
  TurnPreview,
  type SanitizedMessage,
} from "./contextPieces";
import { SmartCompactPlan } from "./SmartCompactPlan";
import { isDebugActionEnabled } from "../debugSurfaceMode";
import { useDebugSurfaceMode } from "../hooks/useDebugSurfaceMode";
import { CompactionHistory } from "./CompactionHistory";
import { ContextIdentity } from "./ContextIdentity";
import { NewContextAction } from "./NewContextAction";
import { ResetAction } from "./ResetAction";
import { CompactAction } from "./CompactAction";

/**
 * Context Inspect Web Tab.
 *
 * Deep-view complement to an earlier revision's always-visible left rail. Lives
 * inside the Inspect drawer's tab strip; consumes an earlier revision's
 * `inspectContext` data via the same `useContextInspect` hook (the
 * panel only mounts when the tab is active, so polling is implicitly
 * lazy via React lifecycle — no explicit `enabled` flag needed).
 *
 * Sections (per an earlier revision UX requirements):
 *   1. Context summary / pressure
 *   2. Token availability
 *   3. Visible messages / turns
 *   4. Future actions placeholder — disabled compact + read-only CLI
 *      reference for reset; no mutation in this card.
 *
 * Red lines:
 *   - no actual compact mutation
 *   - no in-UI reset button (CLI reference only; reset stays manual
 *     until an earlier revision / a dedicated confirmation flow lands)
 *   - no system/SOUL/reasoning content displayed
 *   - tool input/output never rendered (not even server's truncated
 *     preview); only `toolName` surfaces
 *
 * an earlier revision (2026-05-21) — split workflow components out into
 * `CompactionHistory`, `ContextIdentity`, `NewContextAction`,
 * `ResetAction`, `CompactAction`. This file stays as the composition
 * root with the four local layout helpers (`SectionHeader`,
 * `EmptyState`, `MessageList`, `FutureActions`).
 */
export function ContextPanel() {
  const { data, loading, error } = useSharedContextInspect();
  const pressure = useMemo(() => classifyContextPressure(data), [data]);

  const protectedSystemCount = data?.byRole.system ?? 0;
  const debugSurfaceMode = useDebugSurfaceMode();
  const contextActionsEnabled = debugSurfaceMode === null ? false : isDebugActionEnabled(debugSurfaceMode);

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
          <FutureActions totalMessageCount={0} actionsEnabled={contextActionsEnabled} />
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
          <FutureActions totalMessageCount={data.totalMessageCount} actionsEnabled={contextActionsEnabled} />
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

function FutureActions({ totalMessageCount, actionsEnabled }: { totalMessageCount: number; actionsEnabled: boolean }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-3 space-y-4">
      <ContextIdentity actionsEnabled={actionsEnabled} />
      <ResetAction totalMessageCount={totalMessageCount} actionsEnabled={actionsEnabled} />
      <NewContextAction totalMessageCount={totalMessageCount} actionsEnabled={actionsEnabled} />
      <CompactAction totalMessageCount={totalMessageCount} actionsEnabled={actionsEnabled} />
      <SmartCompactPlan actionsEnabled={actionsEnabled} />
    </div>
  );
}
