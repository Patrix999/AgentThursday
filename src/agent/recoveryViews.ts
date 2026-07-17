// recovery/readiness/review projection helpers.
//
// All helpers here are read-only projections lifted from `src/server.ts`.
// Mutation surfaces (`confirmKanbanMutation`, `setModelProfile`,
// `acknowledgeHumanResponse`) intentionally remain in `server.ts` — they
// touch state/event_log and are out of scope per an earlier revision kanban.
//
// Contracts preserved byte-for-byte:
// - SQL LIMIT/ORDER unchanged (review_notes LIMIT 3, checkpoints LIMIT 5,
//   kanban_mutations LIMIT 5 DESC + WHERE pending LIMIT 10 ASC,
//   event_log LIMIT 100 DESC then filter+reverse).
// - getChannelIngressReadiness predicate order:
//   waitingForHuman → blocked → no currentTaskObject → completed/failed
//   → active busy. (Kanban-mandated; reason strings preserved verbatim.)
// - getMutationReview bounded aggregate SQL (GROUP BY + LIMIT 1 evidence
//   probe) — O(1) memory regardless of mutation count.
// - getRecoveryTimeline event filter set + last-obstacle scoping + Chinese
//   summary mapping unchanged.
// - getRecoveryReview stage precedence: waitingForHuman → blocked → safe-resume
//   → recovered → normal.
// - getOutcomeVerification 4-item ordering + Chinese summary branches.

import type {
  AgentThursdayState,
  OutcomeVerification,
  MutationReview,
  RecoveryReview,
  RecoveryTimelineItem,
} from "../types";

export type RecoveryViewsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface RecoveryViewsHost {
  sql: RecoveryViewsSqlTag;
  getSafeState(): AgentThursdayState;
}

// Named row aliases exported so external callers can import a single shape.
// Structurally identical to the inline types previously declared on the
// `@callable()` method signatures in `server.ts`.
export type ReviewNoteRow = { content: string; source: string; created_at: number };
export type CheckpointRow = { key: string; content: string; source: string; created_at: number };
export type KanbanMutationRow = {
  id: number;
  card_ref: string;
  mutation_type: string;
  description: string;
  diff_hint: string;
  status: string;
  applied_at: number | null;
  evidence: string | null;
  created_at: number;
};
export type PendingKanbanMutationRow = {
  id: number;
  card_ref: string;
  mutation_type: string;
  description: string;
  diff_hint: string;
  created_at: number;
};
export type ChannelIngressReadinessView = {
  canAccept: boolean;
  reason: string;
  currentTaskId: string | null;
  currentTaskLifecycle: string | null;
};

export function getRecentReviewNotesView(host: RecoveryViewsHost): ReviewNoteRow[] {
  return host.sql<ReviewNoteRow>`
    SELECT content, source, created_at FROM review_notes ORDER BY created_at DESC LIMIT 3
  `;
}

export function getRecentCheckpointsView(host: RecoveryViewsHost): CheckpointRow[] {
  return host.sql<CheckpointRow>`
    SELECT key, content, source, created_at FROM checkpoints ORDER BY created_at DESC LIMIT 5
  `;
}

export function getRecentKanbanMutationsView(host: RecoveryViewsHost): KanbanMutationRow[] {
  return host.sql<KanbanMutationRow>`
    SELECT id, card_ref, mutation_type, description, diff_hint, status, applied_at, evidence, created_at FROM kanban_mutations ORDER BY created_at DESC LIMIT 5
  `;
}

export function getPendingKanbanMutationsView(host: RecoveryViewsHost): PendingKanbanMutationRow[] {
  return host.sql<PendingKanbanMutationRow>`
    SELECT id, card_ref, mutation_type, description, diff_hint, created_at FROM kanban_mutations WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10
  `;
}

export function getChannelIngressReadinessView(state: AgentThursdayState): ChannelIngressReadinessView {
  const taskId = state.currentTaskObject?.id ?? null;
  const lifecycle = state.currentTaskObject?.status ?? null;
  if (state.waitingForHuman) {
    return { canAccept: false, reason: "waitingForHuman", currentTaskId: taskId, currentTaskLifecycle: lifecycle };
  }
  if (state.currentObstacle?.blocked) {
    const why = (state.currentObstacle.reason ?? "").slice(0, 120);
    return { canAccept: false, reason: `blocked: ${why}`, currentTaskId: taskId, currentTaskLifecycle: lifecycle };
  }
  if (state.currentTaskObject === null) {
    return { canAccept: true, reason: "no active task object", currentTaskId: null, currentTaskLifecycle: null };
  }
  if (lifecycle === "completed" || lifecycle === "failed") {
    return { canAccept: true, reason: `prior task ${lifecycle}`, currentTaskId: taskId, currentTaskLifecycle: lifecycle };
  }
  return {
    canAccept: false,
    reason: `active task lifecycle=${lifecycle}`,
    currentTaskId: taskId,
    currentTaskLifecycle: lifecycle,
  };
}

export function getOutcomeVerificationView(host: RecoveryViewsHost): OutcomeVerification {
  const lar = host.getSafeState().lastActionResult;
  const ckptRows = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints`;
  const noteRows = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes`;
  const mutRows = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations`;
  const ckptCount = Number(ckptRows[0]?.n ?? 0);
  const noteCount = Number(noteRows[0]?.n ?? 0);
  const mutCount = Number(mutRows[0]?.n ?? 0);

  const items: OutcomeVerification["items"] = [
    {
      actionType: "write-checkpoint",
      verified: ckptCount > 0,
      evidence: ckptCount > 0 ? `${ckptCount} checkpoint(s) in DB` : "checkpoints 表为空",
    },
    {
      actionType: "review-note",
      verified: noteCount > 0,
      evidence: noteCount > 0 ? `${noteCount} review note(s) in DB` : "review_notes 表为空",
    },
    {
      actionType: "advance-kanban-card",
      verified: mutCount > 0,
      evidence: mutCount > 0 ? `${mutCount} kanban mutation(s) in DB` : "kanban_mutations 表为空",
    },
    {
      actionType: "last-action",
      verified: lar?.outcome === "success",
      evidence: lar ? `lastActionResult: ${lar.actionType} → ${lar.outcome}` : "尚未执行任何 action",
    },
  ];

  const verified = items.every(i => i.verified);
  const effectiveProgress = (lar?.outcome === "success") && (ckptCount > 0 || noteCount > 0);
  let summary: string;
  if (!lar) {
    summary = "尚未执行 real action，请先运行 doWork 再执行 action。";
  } else if (effectiveProgress) {
    summary = `有效推进已确认：${lar.actionType} 执行成功，已有可审计 artifact。`;
  } else if (lar.outcome === "success") {
    summary = `${lar.actionType} 执行成功，但暂无持久化 artifact（可能为 stub）。`;
  } else {
    summary = `最近 action 未产出有效推进（outcome: ${lar.outcome}）。`;
  }

  return { lastActionType: lar?.actionType ?? null, lastOutcome: lar?.outcome ?? null, verified, items, effectiveProgress, summary };
}

export function getMutationReviewView(host: RecoveryViewsHost): MutationReview {
  // bounded read. GROUP BY counts + LIMIT 1 evidence probe; O(1)
  // memory regardless of how many mutations the project has accumulated.
  const countsRows = host.sql<{ status: string; n: number | bigint }>`
    SELECT status, COUNT(*) as n FROM kanban_mutations GROUP BY status
  `;
  let pendingCount = 0, appliedCount = 0, failedCount = 0, rejectedCount = 0;
  let totalRows = 0;
  for (const r of countsRows) {
    const n = Number(r.n);
    totalRows += n;
    if (r.status === "pending") pendingCount = n;
    else if (r.status === "applied") appliedCount = n;
    else if (r.status === "failed") failedCount = n;
    else if (r.status === "rejected") rejectedCount = n;
  }
  const hasEvidence = Number((host.sql<{ n: number | bigint }>`
    SELECT COUNT(*) as n FROM kanban_mutations
    WHERE status = 'applied' AND evidence IS NOT NULL AND evidence != ''
    LIMIT 1
  `)[0]?.n ?? 0) > 0;
  const effectiveProgress = appliedCount > 0 && hasEvidence;
  const readyForNextMilestone = effectiveProgress;

  let stage: MutationReview["stage"];
  let summary: string;
  if (totalRows === 0) {
    stage = "no-mutation";
    summary = "尚未产生任何 kanban mutation。先运行 doWork（stub-verbose）再执行 advance-kanban-card。";
  } else if (appliedCount === 0) {
    stage = "pending-only";
    summary = `${pendingCount} 条 pending mutation，尚未 apply。local executor 尚未确认任何修改。`;
  } else if (!effectiveProgress) {
    stage = "partial-applied";
    summary = `${appliedCount} 条已 apply，但无有效 evidence。confirm 时请提供 evidence。`;
  } else {
    stage = "mutation-verified";
    summary = `planner/executor 闭环成立：${appliedCount} applied（有 evidence），${failedCount} failed，${rejectedCount} rejected。mutation 已确认推动项目对象。`;
  }

  return { stage, pendingCount, appliedCount, failedCount, rejectedCount, hasEvidence, effectiveProgress, readyForNextMilestone, summary };
}

export function getRecoveryTimelineView(host: RecoveryViewsHost): RecoveryTimelineItem[] {
  const RECOVERY_EVENTS = new Set([
    "obstacle.detected", "escalation.requested", "waiting.entered",
    "response.received", "response.acknowledged", "resume.triggered",
    "mode.changed", "response.used_in_resume", "action.failure.bridged",
  ]);

  const rows = host.sql<{ event_type: string; payload: string; created_at: number }>`
    SELECT event_type, payload, created_at FROM event_log
    ORDER BY created_at DESC LIMIT 100
  `;

  // Filter to recovery events and restore ASC order
  const recovery = rows.filter(r => RECOVERY_EVENTS.has(r.event_type)).reverse();

  // Scope to most recent recovery chain (from last obstacle.detected onward)
  const lastBlockIdx = recovery.map(r => r.event_type).lastIndexOf("obstacle.detected");
  const chain = lastBlockIdx >= 0 ? recovery.slice(lastBlockIdx) : recovery;

  return chain.map(row => {
    const p = JSON.parse(row.payload) as Record<string, string>;
    let summary: string;
    switch (row.event_type) {
      case "obstacle.detected":      summary = `阻塞: ${p.reason ?? ""}`; break;
      case "escalation.requested":   summary = `求助: ${p.whyBlocked ?? ""}`; break;
      case "waiting.entered":        summary = `进入等待: ${p.reason ?? ""}`; break;
      case "response.received":      summary = `收到响应 (${p.fromHuman}): ${p.contentSnippet ?? ""}`; break;
      case "response.acknowledged":  summary = `响应已确认: ${p.fromHuman}`; break;
      case "resume.triggered":       summary = `恢复触发: ${p.trigger ?? ""}`; break;
      case "mode.changed":           summary = `模式切换: ${p.from} → ${p.to}`; break;
      case "response.used_in_resume":  summary = `响应已用于恢复 (${p.fromHuman})`; break;
      case "action.failure.bridged":   summary = `执行失败已桥接回恢复链: ${p.actionType} — ${p.reason ?? ""}`; break;
      default:                       summary = row.event_type;
    }
    return { at: row.created_at, event: row.event_type, summary };
  });
}

export function getRecoveryReviewView(state: AgentThursdayState): RecoveryReview {
  const { waitingForHuman, currentObstacle, runtimeMode, recoveryPolicy, resumeTrigger } = state;
  let stage: RecoveryReview["stage"];
  let summary: string;
  if (waitingForHuman) {
    stage = "waiting";
    summary = "Agent 正在等待人类响应，请通过 Send Human Response 提供输入后继续。";
  } else if (currentObstacle?.blocked) {
    stage = "blocked";
    summary = `Agent 遇到阻塞: ${currentObstacle.reason}`;
  } else if (recoveryPolicy.policyMode === "safe-resume") {
    stage = "safe-resume";
    summary = `Agent 处于安全恢复模式，将单步谨慎推进。恢复触发: ${resumeTrigger ?? "—"}`;
  } else if (runtimeMode.mode === "recovered") {
    stage = "recovering";
    summary = "Agent 已收到人类响应，正在恢复执行。";
  } else {
    stage = "normal";
    summary = "Agent 运行正常，无恢复链路激活。";
  }
  const readyToContinue = !waitingForHuman && !(currentObstacle?.blocked);
  return { stage, readyToContinue, summary };
}
