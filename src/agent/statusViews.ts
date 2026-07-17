/**
 * M8.9 status/event views extraction.
 *
 * Six read-only status/event view helpers moved verbatim from
 * `AgentThursdayAgent` (`src/server.ts:2191-2316`). No SQL strings, table
 * names, column names, LIMIT caps, payload preview boundary
 * (`substr(payload, 1, 4000)`), or Chinese reason strings changed —
 * only the location of the calls moved. `server.ts` keeps the
 * `@callable()` `getLoopContract` / `getEventLog` /
 * `getRecentTaskSubmittedEvents` / `getRecentFinalizedReplyEvents` /
 * `getLastResetAt` / `getLastTrace` methods as thin delegates so the
 * RPC surface is unchanged.
 *
 * Out of scope (stays inline as one-line delegates on `AgentThursdayAgent`):
 *   - `getStatus()`             → `this.getSafeState()`
 *   - `getCurrentTaskObject()`  → `this.getSafeState().currentTaskObject`
 * Both touch private SDK state (`getSafeState()`) and are already
 * one-line — moving them would only add a host hop.
 *
 * `buildLoopContractView` is the only state-input helper (no SQL).
 * It takes a typed `AgentThursdayState` plus an optional `now?: number` for
 * deterministic smoke testing. `now` is consulted at most once —
 * the same value is reused for both `roundId` fallback and
 * `updatedAt` so the two timestamps stay coherent within a single
 * call.
 *
 * See:
 *   - `src/agent/memoryOps.ts` (precedent for `XOpsSqlTag` + narrow host)
 */

import type { EventLogRow } from "./agentConstants";
import type { LoopContract, AgentThursdayState } from "../types";

export type StatusViewsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface StatusViewsHost {
  sql: StatusViewsSqlTag;
}

export function buildLoopContractView(state: AgentThursdayState, now?: number): LoopContract {
  const s = state;
  const lar = s.lastActionResult;
  const ts = now ?? Date.now();

  const planner = {
    taskId: s.currentTaskObject?.id ?? null,
    taskTitle: s.currentTaskObject?.title ?? s.currentTask,
    nextStep: s.committedAction?.title ?? null,
    rationale: s.committedAction?.reason ?? null,
    readyForExecutor: s.committedAction !== null,
  };

  const executor = {
    actionType: lar?.actionType ?? null,
    outcome: lar?.outcome ?? null,
    artifactSummary: lar ? `${lar.actionType} → ${lar.outcome}: ${lar.summary.slice(0, 100)}` : null,
    executedAt: lar?.recordedAt ?? null,
  };

  const canContinue = !s.waitingForHuman && !(s.currentObstacle?.blocked);
  const accepted = lar?.outcome === "success" && canContinue;
  let reason: string;
  if (!lar) {
    reason = "尚未执行任何 action，等待 executor 完成第一次执行。";
  } else if (lar.outcome === "blocked") {
    reason = `执行失败: ${lar.summary}`;
  } else if (s.waitingForHuman) {
    reason = "Agent 等待人类响应，无法继续。";
  } else if (s.currentObstacle?.blocked) {
    reason = `存在未解除阻塞: ${s.currentObstacle.reason}`;
  } else {
    reason = `${lar.actionType} 执行成功，可以继续。`;
  }
  const reviewer = { accepted, canContinue, reason };

  return {
    roundId: s.currentTaskObject?.id ?? `round-${ts.toString(36)}`,
    planner,
    executor,
    reviewer,
    updatedAt: ts,
  };
}

export function getEventLogView(host: StatusViewsHost): EventLogRow[] {
  return host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log ORDER BY created_at DESC LIMIT 20
    `;
}

// independent query for `task.submitted` events so the
// workspace summary stream can show more than 4 dialog turns. The
// 20-row `getEventLog()` cap was dropping older `task.submitted`
// rows when they were buried behind agent.woken / tool.* noise.
// 60 keeps the desktop dialog readable (~30 user/assistant pairs)
// without ballooning the snapshot payload.
export function getRecentTaskSubmittedEventsView(
  host: StatusViewsHost,
  limit: number = 60,
): EventLogRow[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  return host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'task.submitted'
      ORDER BY created_at DESC LIMIT ${cap}
    `;
}

// fetch recent `task.reply.finalized` events for
// `buildWorkspaceSnapshot`'s pairing loop. Stays consistent with
// `getRecentTaskSubmittedEvents` (independent SQL query, 60-row
// newest-first window) so the user/assistant pairing has equal
// depth on both sides.
export function getRecentFinalizedReplyEventsView(
  host: StatusViewsHost,
  limit: number = 60,
): EventLogRow[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  return host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'task.reply.finalized'
      ORDER BY created_at DESC LIMIT ${cap}
    `;
}

/**
 * return the timestamp of the latest `context.reset` event,
 * or 0 if reset has never been recorded on this DO. Used by
 * `buildWorkspaceSnapshot` to filter `summaryStream` to post-reset
 * activity. Does NOT delete event_log; the boundary is informational.
 *
 * Has its own MAX() query because `getEventLog` caps at 20 rows; a
 * recent reset followed by 20+ events would otherwise be invisible to
 * the snapshot builder.
 */
export function getLastResetAtView(host: StatusViewsHost): number {
  const row = host.sql<{ at: number | null }>`
      SELECT MAX(created_at) AS at FROM event_log WHERE event_type = 'context.reset'
    `[0];
  const at = row?.at ?? null;
  return typeof at === "number" ? at : 0;
}

export function getLastTraceView(
  host: StatusViewsHost,
): { traceId: string; events: EventLogRow[] } | null {
  // bounded read.
  // Previously this returned every row matching `trace_id`, with full
  // `payload`. A long-running trace can accumulate hundreds of events
  // with large tool payloads, which on the DO isolate has shown up as
  // memory-limit resets during status/debug fetches.
  // Cap rows + SQL-side payload preview keeps this debug-only callable
  // safe even when a trace is enormous.
  const rows = host.sql<{ trace_id: string }>`
      SELECT DISTINCT trace_id FROM event_log
      WHERE trace_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `;
  if (rows.length === 0) return null;
  const traceId = rows[0].trace_id;
  const events = host.sql<EventLogRow>`
      SELECT event_type, substr(payload, 1, 4000) AS payload, created_at, trace_id FROM event_log
      WHERE trace_id = ${traceId}
      ORDER BY created_at ASC
      LIMIT 200
    `;
  return { traceId, events };
}
