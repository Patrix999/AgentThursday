/**
 * M8.9 inspect/debug views extraction.
 *
 * Four read-only inspect/debug/usage view helpers moved verbatim from
 * `AgentThursdayAgent` (`src/server.ts:2239-2547`). No SQL strings, table
 * names, column names, LIMIT caps, payload preview boundary
 * (`substr(payload, 1, 4000)`), parse strategies, dedupe keys, or
 * sort priorities changed — only the location of the calls moved.
 * `server.ts` keeps `@callable()` `getDebugTrace` / `getInspectSnapshot`
 * / `getUsageStats` (plus the private `getDegradationDiagnostics`) as
 * thin delegates so the RPC surface is unchanged.
 *
 * Out of scope:
 *   - `getMemoryLayers()` — already a thin delegate to
 *     `getMemoryLayersFree` via `memoryOps` .
 *
 * The host is narrow on purpose. SQL is the only DO-level capability
 * exposed; the other surfaces (`getSafeState`, `getPendingToolApproval`,
 * `getLastAssistantTextFull`, message count, session/task token
 * snapshots, last-step input tokens + model info) are read-only
 * projections that the agent supplies at call time via
 * `_inspectViewsHost()`.
 *
 * Composition note: `getInspectSnapshotView` internally calls
 * `getDebugTraceView` and `getDegradationDiagnosticsView` on the same
 * host — matching the original `this.getDebugTrace()` / `this.getDegradationDiagnostics()`
 * nested calls.
 *
 * See:
 *   - `src/agent/statusViews.ts` (precedent — an earlier revision)
 *   - `src/agent/memoryOps.ts`  (precedent — an earlier revision)
 */

import type { EventLogRow } from "./agentConstants";
import type { AgentThursdayState } from "../types";
import type {
  InspectSnapshot,
  LadderTierEntry,
  TraceEvent,
  ToolEvent,
  DegradationDiagnostics,
  TaskDegradationSummaryView,
  SupplierSignalSummaryView,
  TruthfulnessViolationView,
  ActionUiIntent,
} from "../schema";
import { buildActionUiIntents, type ActionUiIntentSourceRow } from "../actionUiIntents";

export type InspectViewsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface InspectViewsHost {
  sql: InspectViewsSqlTag;
  getSafeState(): AgentThursdayState;
  getPendingToolApproval(): { toolCallId: string; toolName: string } | null;
  getLastAssistantTextFull(): string;
  getMessagesCount(): number;
  sessionTok: { hasData: boolean; in: number; out: number; total: number };
  taskTok: { taskId: string | null; in: number; out: number; total: number };
  lastStepInputTokens: number | null;
  lastStepModel: { provider: string; modelId: string } | null;
}

export interface DebugTraceView {
  lastAssistantSummary: string;
  recentToolEvents: { type: string; summary: string; at: number }[];
  pendingApprovalReason: string | null;
  lastActionResult: { actionType: string; outcome: string; summary: string } | null;
  lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null;
}

export interface UsageStatsView {
  checkpoints: number;
  notes: number;
  appliedMutations: number;
  eventCount: number;
  taskCheckpoints: number;
  taskNotes: number;
  taskAppliedMutations: number;
  tokenSession: { in: number; out: number; total: number } | null;
  tokenTask: { in: number; out: number; total: number } | null;
  lastStepInputTokens: number | null;
  msgCount: number;
  modelInfo: { provider: string; modelId: string } | null;
  modelProfile: { provider: string; model: string };
}

export function getDebugTraceView(host: InspectViewsHost): DebugTraceView {
  const s = host.getSafeState();
  const lar = s.lastActionResult;

  // SQL-side payload preview keeps debug callables
  // bounded even when individual tool events have huge inputs/outputs.
  const rawEvents = host.sql<{ event_type: string; payload: string; created_at: number }>`
      SELECT event_type, substr(payload, 1, 4000) AS payload, created_at FROM event_log
      WHERE event_type LIKE 'tool.%'
      ORDER BY created_at DESC LIMIT 20
    `;
  const recentToolEvents = rawEvents.map(e => {
    let summary = e.event_type;
    try {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const snippets = Object.entries(p).map(([k, v]) => {
        const raw = String(v);
        const cap = 500;
        const val = raw.length > cap ? `${raw.slice(0, cap)}…(+${raw.length - cap})` : raw;
        return `${k}:${val}`;
      }).join(" ");
      if (snippets) summary = `${e.event_type} — ${snippets}`;
    } catch { /* ignore */ }
    return { type: e.event_type, summary, at: e.created_at };
  });

  const pta = host.getPendingToolApproval();
  const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;
  const pendingMutCount = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const pendingApprovalReason = pta
    ? `tool-approval: ${pta.toolName}`
    : s.waitingForHuman
    ? "waiting-for-human"
    : pendingMutCount > 0
    ? `${pendingMutCount} mutation(s) pending confirm`
    : null;

  const ladderRows = host.sql<{ event_type: string; payload: string; created_at: number }>`
      SELECT event_type, payload, created_at FROM event_log
      WHERE event_type IN ('tool.execute', 'tool.sandbox_exec')
      ORDER BY created_at DESC LIMIT 1
    `;
  let lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null = null;
  if (ladderRows.length > 0) {
    const ev = ladderRows[0];
    try {
      const p = JSON.parse(ev.payload) as { tier?: number; reason?: string };
      lastLadderTier = { tier: p.tier ?? 1, toolName: ev.event_type.replace("tool.", ""), reason: p.reason ?? "", at: ev.created_at };
    } catch { /* ignore */ }
  }

  return {
    // workspace dialog AGT line must show the full
    // assistant reply, never the `…(+N chars)` preview suffix that
    // `getLastAssistantText(maxLen)` appends.
    lastAssistantSummary: host.getLastAssistantTextFull(),
    recentToolEvents,
    pendingApprovalReason,
    lastActionResult: lar ? { actionType: lar.actionType, outcome: lar.outcome, summary: lar.summary } : null,
    lastLadderTier,
  };
}

// index recent degradation events into a compact view
// for the inspect panel. Read-only: queries existing event_log rows
// emitted by an earlier revision, parses payload as JSON, and tolerates
// shape drift via fail-soft per-row try/catch. Cap recentSummaries to
// keep the inspect response payload bounded.
export function getDegradationDiagnosticsView(host: InspectViewsHost): DegradationDiagnostics {
  const SUMMARY_CAP = 10;

  const summaryRows = host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'degradation.summary'
      ORDER BY created_at DESC LIMIT ${SUMMARY_CAP}
    `;
  const recentSummaries: TaskDegradationSummaryView[] = [];
  for (const r of summaryRows) {
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      if (typeof p?.taskId !== "string") continue;
      if (typeof p?.state !== "string") continue;
      recentSummaries.push({ ...(p as unknown as TaskDegradationSummaryView), eventAt: r.created_at });
    } catch { /* skip malformed row */ }
  }
  const latestSummary: TaskDegradationSummaryView | null = recentSummaries[0] ?? null;

  const latestTaskId = latestSummary?.taskId ?? null;

  const supplierRows = host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'supplier.signal.summary'
      ORDER BY created_at DESC LIMIT 50
    `;
  let latestSupplierSignal: SupplierSignalSummaryView | null = null;
  if (latestTaskId) {
    for (const r of supplierRows) {
      try {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        if (p?.taskId !== latestTaskId) continue;
        latestSupplierSignal = { ...(p as unknown as SupplierSignalSummaryView), eventAt: r.created_at };
        break;
      } catch { /* skip */ }
    }
  }

  const truthfulnessRows = host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'tool.truthfulness.violation'
      ORDER BY created_at DESC LIMIT 50
    `;
  let latestTruthfulnessViolation: TruthfulnessViolationView | null = null;
  if (latestTaskId) {
    for (const r of truthfulnessRows) {
      try {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        if (p?.taskId !== latestTaskId) continue;
        latestTruthfulnessViolation = { ...(p as unknown as TruthfulnessViolationView), eventAt: r.created_at };
        break;
      } catch { /* skip */ }
    }
  }

  return { latestSummary, latestSupplierSignal, latestTruthfulnessViolation, recentSummaries };
}

export function getInspectSnapshotView(host: InspectViewsHost): InspectSnapshot {
  // real producer for /api/inspect.
  // No new storage; pulls from event_log + DO state. an earlier revision schema is canonical.

  // ladder: history of tier-bearing tool events, newest first
  const ladderRows = host.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type IN ('tool.execute', 'tool.sandbox_exec')
      ORDER BY created_at DESC LIMIT 50
    `;
  const ladder: LadderTierEntry[] = ladderRows.map(r => {
    let tier = 1;
    let reason = "";
    try {
      const p = JSON.parse(r.payload) as { tier?: number; reason?: string };
      tier = p.tier ?? 1;
      reason = p.reason ?? "";
    } catch { /* ignore parse failures */ }
    return {
      tier,
      toolName: r.event_type.replace(/^tool\./, ""),
      reason,
      at: r.created_at,
    };
  });

  // trace: full event log (capped) newest-first; payloads parsed when valid JSON.
  // SQL-side preview (substr) bounds memory for /api/inspect
  // even when individual events log very large payloads (big tool outputs,
  // pasted content, etc).
  const traceRows = host.sql<EventLogRow>`
      SELECT event_type, substr(payload, 1, 4000) AS payload, created_at, trace_id FROM event_log
      ORDER BY created_at DESC LIMIT 200
    `;
  const trace: TraceEvent[] = traceRows.map(r => {
    let payload: unknown = r.payload;
    try { payload = JSON.parse(r.payload); } catch { /* keep raw string */ }
    return {
      id: `${r.event_type}-${r.created_at}`,
      type: r.event_type,
      payload,
      at: r.created_at,
      traceId: r.trace_id,
    };
  });

  // toolEvents: kind="call" because the worker only logs tool entries today.
  // independent SQL query (LIKE 'tool.%'); SQL-side
  // preview to keep tool tab bounded.
  const toolEventRows = host.sql<EventLogRow>`
      SELECT event_type, substr(payload, 1, 4000) AS payload, created_at, trace_id FROM event_log
      WHERE event_type LIKE 'tool.%'
      ORDER BY created_at DESC LIMIT 100
    `;
  const toolEvents: ToolEvent[] = toolEventRows.map(r => {
    let payload: unknown = r.payload;
    try { payload = JSON.parse(r.payload); } catch { /* keep raw */ }
    return {
      id: `${r.event_type}-${r.created_at}`,
      kind: "call" as const,
      toolName: r.event_type.replace(/^tool\./, ""),
      payload,
      at: r.created_at,
    };
  });

  // debugRaw: the existing debugTrace dump preserved for deep-dive debugging
  const debugRaw = getDebugTraceView(host);

  // index latest degradation events into a compact view
  // for the inspect panel.
  const degradationDiagnostics = getDegradationDiagnosticsView(host);

  // derive Action UI Intents.
  //
  // an earlier revision: feed intents from a richer pool than `traceRows` alone.
  // Merge traceRows + toolEventRows + actionAuxRows; dedupe by
  // (event_type, created_at, trace_id); sort with action-relevant rows
  // ahead of others so buildActionUiIntents fills its budget with
  // feed-worthy entries first.
  //
  // Wrapped in try/catch so a malformed row never breaks /api/inspect.
  const actionAuxRows = host.sql<EventLogRow>`
      SELECT event_type, substr(payload, 1, 4000) AS payload, created_at, trace_id FROM event_log
      WHERE event_type IN ('degradation.summary', 'loop.pause.needs_human', 'loop.pause.awaiting_resume')
      ORDER BY created_at DESC LIMIT 50
    `;
  const isActionRelevant = (et: string): boolean =>
    et.startsWith("tool.")
    || et === "degradation.summary"
    || et === "loop.pause.needs_human"
    || et === "loop.pause.awaiting_resume";
  const intentSeen = new Set<string>();
  const intentDeduped: EventLogRow[] = [];
  for (const row of [...traceRows, ...toolEventRows, ...actionAuxRows]) {
    const key = `${row.event_type}|${row.created_at}|${row.trace_id ?? ""}`;
    if (intentSeen.has(key)) continue;
    intentSeen.add(key);
    intentDeduped.push(row);
  }
  intentDeduped.sort((a, b) => {
    const ar = isActionRelevant(a.event_type) ? 0 : 1;
    const br = isActionRelevant(b.event_type) ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.created_at - a.created_at;
  });
  let actionUiIntents: ActionUiIntent[] | undefined;
  try {
    const sourceRows: ActionUiIntentSourceRow[] = intentDeduped.map(r => ({
      event_type: r.event_type,
      payload: r.payload,
      created_at: r.created_at,
      trace_id: r.trace_id,
    }));
    actionUiIntents = buildActionUiIntents(sourceRows);
  } catch { /* fail-soft: omit field rather than break inspect */ }

  return { ladder, trace, toolEvents, debugRaw, degradationDiagnostics, actionUiIntents };
}

export function getUsageStatsView(host: InspectViewsHost): UsageStatsView {
  const s = host.getSafeState();
  const checkpoints = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints`)[0]?.n ?? 0);
  const notes = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes`)[0]?.n ?? 0);
  const appliedMutations = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied'`)[0]?.n ?? 0);
  const eventCount = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM event_log`)[0]?.n ?? 0);
  const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;
  const taskCheckpoints = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const taskNotes = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const taskAppliedMutations = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const msgCount = host.getMessagesCount();
  const mp = s.modelProfile;
  return {
    checkpoints, notes, appliedMutations, eventCount,
    taskCheckpoints, taskNotes, taskAppliedMutations,
    tokenSession: host.sessionTok.hasData ? { in: host.sessionTok.in, out: host.sessionTok.out, total: host.sessionTok.total } : null,
    tokenTask: (host.taskTok.taskId !== null && (host.taskTok.in > 0 || host.taskTok.out > 0)) ? { in: host.taskTok.in, out: host.taskTok.out, total: host.taskTok.total } : null,
    lastStepInputTokens: host.lastStepInputTokens,
    msgCount,
    modelInfo: host.lastStepModel,
    modelProfile: { provider: mp.provider, model: mp.model },
  };
}
