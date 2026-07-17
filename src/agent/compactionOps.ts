/**
 * M8.9 Step 6 compactionOps pure/read surfaces extraction.
 * M8.9 Step 6 compactionOps apply surfaces extraction.
 *
 * Compaction-related helpers pulled verbatim from `AgentThursdayAgent`
 * (`src/server.ts`). No call shapes, return shapes, event names,
 * error messages, or guard semantics changed — only the location of
 * the calls moved.
 *
 * Host shapes:
 *   - `CompactionReadHost` : `getMessages` / `getCompactions`
 *     / `logEvent`.
 *   - `CompactionWriteHost extends CompactionReadHost` 
 *     adds:
 *       - `addCompaction(summary, fromMessageId, toMessageId)` —
 *         wraps `session.addCompaction(...)` and returns the stored
 *         record.
 *       - `getHistoryLengthSafe()` — wraps the
 *         `session.getHistory().length` try/catch → `null` fallback
 *         that `compactContext` reports as `modelVisibleAfter`.
 *
 * Per Step 5 preflight §6: reset/new/switch/hygiene mutations remain
 * on `AgentThursdayAgent` . SQL schema / storage shape / env
 * bindings unchanged. The semantic advisor client provider still
 * returns `null` — no model client wired in this card.
 */

import type { UIMessage } from "ai";

import {
  buildCompactPlan,
  buildCompactSummary,
  buildContextSnapshot,
  classifyContextAnchors as runAnchorClassifier,
  isHardPreserveAnchor,
  type CompactPlanResultView,
  type ContextAnchorClassification,
  type ContextSnapshotViewModel,
} from "../contextLifecycle";
import type {
  CompactContextResult,
  CompactionsList,
  CompactPlanApplyResult,
  CompactPlanInput,
  CompactPlanResult,
  ContextAnchorsResult,
} from "../schema";
import {
  runSemanticSummaryAdvisor,
  type SemanticAdvisorClient,
  type SemanticSummaryAdvisorRequest,
  type SemanticSummaryAdvisorResult,
  type SemanticSummarySourceTurn,
} from "../semanticSummaryAdvisor";
import { collectFreshPreservedPoints, storedCompactionView } from "./contextHelpers";

type StoredCompaction = {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
};

export interface CompactionReadHost {
  getMessages: () => UIMessage[];
  // Raw access; may throw. Free functions preserve the original
  // try/catch fallback semantics verbatim.
  getCompactions: () => StoredCompaction[];
  logEvent: (type: string, payload: unknown) => void;
}

export interface CompactionWriteHost extends CompactionReadHost {
  // Wraps `session.addCompaction(...)`. May throw — callers catch and
  // route the failure into the audit event family verbatim.
  addCompaction: (
    summary: string,
    fromMessageId: string,
    toMessageId: string,
  ) => StoredCompaction;
  // Wraps `session.getHistory().length` with the same try/catch →
  // `null` fallback that `compactContext` previously inlined.
  getHistoryLengthSafe: () => number | null;
}

export function listCompactionsFree(host: CompactionReadHost): CompactionsList {
  let stored: StoredCompaction[] = [];
  try {
    stored = host.getCompactions();
  } catch {
    stored = [];
  }
  return { compactions: stored.map(storedCompactionView) };
}

export function inspectContextSnapshotFree(
  host: CompactionReadHost,
  input?: { lastN?: number },
): ContextSnapshotViewModel {
  const lastN = typeof input?.lastN === "number" ? input.lastN : 20;
  const messages = host.getMessages();
  let stored: StoredCompaction[] = [];
  try {
    stored = host.getCompactions();
  } catch {
    stored = [];
  }
  return buildContextSnapshot(messages, stored, lastN);
}

export function classifyContextAnchorsFree(
  host: CompactionReadHost,
  input?: { lastN?: number; firstK?: number },
): ContextAnchorsResult {
  const lastN = Math.max(1, Math.min(200, Math.floor(input?.lastN ?? 50)));
  const firstK = Math.max(0, Math.min(50, Math.floor(input?.firstK ?? 4)));
  const snapshot = inspectContextSnapshotFree(host, { lastN });
  const anchors = runAnchorClassifier(snapshot, { firstK });
  return {
    snapshot: {
      totalMessageCount: snapshot.totalMessageCount,
      visibleStartIndex: snapshot.visibleStartIndex,
      sanitizedAt: snapshot.sanitizedAt,
    },
    options: { firstK, lastN },
    anchors,
    anchorCount: anchors.reduce((acc, a) => acc + (a.isAnchor ? 1 : 0), 0),
    classifiedAt: Date.now(),
  };
}

export function compactPlanFree(
  host: CompactionReadHost,
  input?: CompactPlanInput,
): CompactPlanResult {
  const strategy = normalizeCompactPlanStrategyFree(input);
  const plan = buildFreshCompactPlanFree(host, strategy);
  host.logEvent("context.compact.plan_proposed", {
    planId: plan.planId,
    strategy: plan.strategy,
    rangeCount: plan.ranges.length,
    preservedCount: plan.preserved.length,
    rejectedCount: plan.rejected.length,
    beforeMessages: plan.pressure.beforeMessages,
    estimatedAfterMessages: plan.pressure.estimatedAfterMessages,
    estimatedReduction: plan.pressure.estimatedReduction,
  });
  return plan;
}

export function normalizeCompactPlanStrategyFree(
  input?: CompactPlanInput,
): CompactPlanResultView["strategy"] {
  const lastN = Math.max(1, Math.min(200, Math.floor(input?.lastN ?? 200)));
  const firstK = Math.max(0, Math.min(50, Math.floor(input?.firstK ?? 4)));
  const keepRecent = Math.max(0, Math.min(50, Math.floor(input?.keepRecent ?? 8)));
  const minRangeMessages = Math.max(1, Math.min(50, Math.floor(input?.minRangeMessages ?? 3)));
  const pressureThreshold = Math.max(0, Math.min(500, Math.floor(input?.pressureThreshold ?? 20)));
  return { lastN, firstK, keepRecent, minRangeMessages, pressureThreshold };
}

export function buildFreshCompactPlanFree(
  host: CompactionReadHost,
  strategy: CompactPlanResultView["strategy"],
): CompactPlanResultView {
  const snapshot = inspectContextSnapshotFree(host, { lastN: strategy.lastN });
  const anchors = runAnchorClassifier(snapshot, { firstK: strategy.firstK });
  return buildCompactPlan(snapshot, anchors, strategy);
}

export function preflightCompactRangeFree(
  range: CompactPlanResult["ranges"][number],
  snapshot: ContextSnapshotViewModel,
  anchors: readonly ContextAnchorClassification[],
  strategy: CompactPlanResultView["strategy"],
): { reason: string; detail: string } | null {
  const fromIdx = snapshot.messages.findIndex((m) => m.id === range.fromMessageId);
  const toIdx = snapshot.messages.findIndex((m) => m.id === range.toMessageId);
  if (fromIdx < 0 || toIdx < 0) {
    return {
      reason: "range_endpoint_missing",
      detail: `fromFound=${fromIdx >= 0} toFound=${toIdx >= 0} fromId=${range.fromMessageId} toId=${range.toMessageId}`,
    };
  }
  if (toIdx < fromIdx) {
    return {
      reason: "range_inverted",
      detail: `fromIdx=${fromIdx} toIdx=${toIdx}`,
    };
  }
  const slice = snapshot.messages.slice(fromIdx, toIdx + 1);
  if (slice.length < strategy.minRangeMessages) {
    return {
      reason: "range_too_small",
      detail: `count=${slice.length} minRangeMessages=${strategy.minRangeMessages}`,
    };
  }
  for (const m of slice) {
    if (m.isSyntheticCompaction) {
      return {
        reason: "range_contains_synthetic",
        detail: `messageId=${m.id} index=${m.index}`,
      };
    }
  }
  if (slice[0].isSyntheticCompaction || slice[slice.length - 1].isSyntheticCompaction) {
    return {
      reason: "endpoint_is_synthetic",
      detail: `from=${range.fromMessageId} to=${range.toMessageId}`,
    };
  }
  // only HARD-tier anchors (explicit / first-k / long
  // user briefing) block compaction. Medium anchors flow through and
  // are lifted into the summary at apply time.
  const hardAnchorIds = new Set<string>();
  for (const a of anchors) {
    if (isHardPreserveAnchor(a)) hardAnchorIds.add(a.id);
  }
  for (const m of slice) {
    if (hardAnchorIds.has(m.id)) {
      return {
        reason: "range_contains_hard_anchor",
        detail: `anchorId=${m.id} index=${m.index}`,
      };
    }
  }
  for (const cr of snapshot.compactedRanges) {
    if (cr.isResolvableInCurrentView) continue;
    if (
      (cr.fromIndex !== null && cr.fromIndex >= fromIdx + snapshot.visibleStartIndex && cr.fromIndex <= toIdx + snapshot.visibleStartIndex) ||
      (cr.toIndex !== null && cr.toIndex >= fromIdx + snapshot.visibleStartIndex && cr.toIndex <= toIdx + snapshot.visibleStartIndex)
    ) {
      return {
        reason: "range_overlaps_unresolved_compaction",
        detail: `compactionId=${cr.id}`,
      };
    }
  }
  return null;
}

export function planRangeOverlapsAcceptedFree(
  range: CompactPlanResult["ranges"][number],
  accepted: readonly { rangeId: string }[],
  allRanges: readonly CompactPlanResult["ranges"][number][],
  seenInPlan: ReadonlySet<string>,
): boolean {
  for (const other of allRanges) {
    if (other.rangeId === range.rangeId) continue;
    if (!seenInPlan.has(other.rangeId)) continue;
    const overlap = !(other.toIndex < range.fromIndex || other.fromIndex > range.toIndex);
    if (overlap) return true;
  }
  void accepted;
  return false;
}

export function safeGetCompactionsFree(host: CompactionReadHost): StoredCompaction[] {
  try {
    return host.getCompactions();
  } catch {
    return [];
  }
}

export function countSyntheticInVisibleFree(host: CompactionReadHost): number {
  const messages = host.getMessages();
  let n = 0;
  for (const m of messages) {
    if (typeof m.id === "string" && /^compaction[_-]/.test(m.id)) n++;
  }
  return n;
}

// semantic advisor client provider. Returns null in this
// scaffold so the orchestrator always falls back to the deterministic
// summary; a future card can override this to wire a model client
// (e.g. Workers AI / Anthropic SDK) without touching applyCompactPlan.
export function getSemanticAdvisorClientFree(): SemanticAdvisorClient | null {
  return null;
}

// sanitized source slice handed to the advisor. Reuses the
// an earlier revision snapshot which already strips system/SOUL/reasoning/tool
// payloads down to text + tool *names*. The advisor sees the same
// surface a human reading the inspect tab would see — never raw
// payloads. System and synthetic-compaction messages are skipped.
export function buildAdvisorSanitizedSourceFree(
  snapshot: ContextSnapshotViewModel,
  fromMessageId: string,
  toMessageId: string,
): SemanticSummarySourceTurn[] {
  const fromIdx = snapshot.messages.findIndex((m) => m.id === fromMessageId);
  const toIdx = snapshot.messages.findIndex((m) => m.id === toMessageId);
  if (fromIdx < 0 || toIdx < 0 || toIdx < fromIdx) return [];
  const out: SemanticSummarySourceTurn[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const m = snapshot.messages[i];
    if (m.role === "system" || m.isSyntheticCompaction) continue;
    let text = "";
    const toolNames: string[] = [];
    for (const p of m.parts) {
      if (p.type === "text") {
        if (text.length === 0) text = p.text;
      } else if (p.type === "tool" && p.toolName && !toolNames.includes(p.toolName)) {
        toolNames.push(p.toolName);
      }
    }
    if (text.length === 0 && toolNames.length === 0) continue;
    out.push({
      id: m.id,
      index: m.index,
      role: m.role === "user" ? "user" : "assistant",
      text,
      toolNames,
    });
  }
  return out;
}

// `compactContext` mutation surface. Behavior-preserving
// move of `AgentThursdayAgent.compactContext` (`src/server.ts` pre-285 lines
// ~5244–5346). Event names, payload shapes, error text, and the
// `session.getHistory().length` → null fallback all match the
// pre-move body byte-for-byte.
export function compactContextFree(
  host: CompactionWriteHost,
  input?: { reason?: string | null; lastN?: number; keepRecent?: number },
): CompactContextResult {
  const reason = (typeof input?.reason === "string" && input.reason.trim().length > 0)
    ? input.reason.trim().slice(0, 200)
    : null;
  const keepRecent = typeof input?.keepRecent === "number"
    ? Math.max(0, Math.min(20, Math.floor(input.keepRecent)))
    : 5;
  const messages = host.getMessages();
  const total = messages.length;
  const defaultLastN = Math.max(0, total - keepRecent);
  const lastN = typeof input?.lastN === "number"
    ? Math.max(0, Math.min(total, Math.floor(input.lastN)))
    : defaultLastN;

  host.logEvent("context.compact.requested", {
    reason,
    lastN,
    keepRecent,
    totalMessageCount: total,
  });

  if (lastN < 2) {
    const failPayload = { reason, lastN, totalMessageCount: total, error: "lastN_too_small" };
    host.logEvent("context.compact.failed", failPayload);
    throw new Error(`compactContext: refused — lastN=${lastN} (need at least 2 messages to compact)`);
  }
  if (lastN > total - 1) {
    const failPayload = { reason, lastN, totalMessageCount: total, error: "would_compact_entire_log" };
    host.logEvent("context.compact.failed", failPayload);
    throw new Error(`compactContext: refused — would compact entire log (lastN=${lastN}, total=${total}); use resetContext instead`);
  }

  const fromIndex = 0;
  const toIndex = lastN - 1;
  const fromMsg = messages[fromIndex];
  const toMsg = messages[toIndex];
  if (!fromMsg?.id || !toMsg?.id) {
    host.logEvent("context.compact.failed", { reason, lastN, error: "missing_message_id" });
    throw new Error("compactContext: refused — message slice is missing stable IDs");
  }

  const summary = buildCompactSummary({ messages, fromIndex, toIndex });

  let stored: StoredCompaction;
  try {
    stored = host.addCompaction(summary.text, fromMsg.id, toMsg.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    host.logEvent("context.compact.failed", {
      reason,
      lastN,
      fromMessageId: fromMsg.id,
      toMessageId: toMsg.id,
      error: msg.slice(0, 400),
    });
    throw e;
  }

  const beforeMessageCount = total;
  const afterMessageCount = host.getMessages().length;
  const modelVisibleAfter = host.getHistoryLengthSafe();
  const timestamp = Date.now();

  host.logEvent("context.compact.completed", {
    reason,
    lastN,
    fromIndex,
    toIndex,
    fromMessageId: fromMsg.id,
    toMessageId: toMsg.id,
    compactionId: stored.id,
    compactedRangeSize: summary.rangeSize,
    summaryLength: summary.text.length,
    summaryTruncated: summary.truncated,
    beforeMessageCount,
    afterMessageCount,
    modelVisibleAfter,
    preservedDurableState: true,
  });

  return {
    ok: true,
    reason,
    fromIndex,
    toIndex,
    fromMessageId: fromMsg.id,
    toMessageId: toMsg.id,
    compactedRangeSize: summary.rangeSize,
    beforeMessageCount,
    afterMessageCount,
    modelVisibleAfter,
    compaction: storedCompactionView(stored),
    summaryTruncated: summary.truncated,
    preservedDurableState: true,
    timestamp,
  };
}

// `applyCompactPlan` mutation surface. Behavior-preserving
// move of `AgentThursdayAgent.applyCompactPlan` (`src/server.ts` pre-285
// lines ~5390–5588). Event names/payloads, rejection reasons, the
// strict-greater dead-record detector (`compactionsDelta >
// syntheticsDelta`), the `.slice(0, 400)` error-detail cap, the
// push-then-mutate `applied.semanticAdvisor` assignment, and the
// null-advisor fallback all match the pre-move body byte-for-byte.
export async function applyCompactPlanFree(
  host: CompactionWriteHost,
  input: {
    plan: CompactPlanResult;
    semanticAdvisor?: boolean;
    semanticAdvisorTrigger?: "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";
  },
): Promise<CompactPlanApplyResult> {
  if (!input?.plan || typeof input.plan.planId !== "string") {
    throw new Error("applyCompactPlan: missing plan in input");
  }
  const plan = input.plan;
  const advisorRequested = input.semanticAdvisor === true;
  const advisorClient: SemanticAdvisorClient | null = advisorRequested
    ? getSemanticAdvisorClientFree()
    : null;
  const beforeCount = host.getMessages().length;
  const appliedRanges: CompactPlanApplyResult["appliedRanges"] = [];
  const rejectedRanges: CompactPlanApplyResult["rejectedRanges"] = [];
  const seenInPlan = new Set<string>();
  let deadRecordDetected = false;

  for (const range of plan.ranges) {
    // Disallow duplicate / overlapping ranges within the same plan.
    if (planRangeOverlapsAcceptedFree(range, appliedRanges, plan.ranges, seenInPlan)) {
      const rejection = {
        rangeId: range.rangeId,
        reason: "overlapping_in_plan",
        detail: `range ${range.fromMessageId}..${range.toMessageId} overlaps another range in the same plan`,
      };
      rejectedRanges.push(rejection);
      host.logEvent("context.compact.plan_rejected", { planId: plan.planId, ...rejection });
      continue;
    }
    seenInPlan.add(range.rangeId);

    // Fresh pre-flight on every step — an earlier revision spike showed prior
    // compactions can swallow message IDs. We use the same lastN
    // strategy the plan was built with so the validation window
    // matches the planner's view.
    const freshSnapshot = inspectContextSnapshotFree(host, { lastN: plan.strategy.lastN });
    const freshAnchors = runAnchorClassifier(freshSnapshot, { firstK: plan.strategy.firstK });

    const validation = preflightCompactRangeFree(range, freshSnapshot, freshAnchors, plan.strategy);
    if (validation) {
      rejectedRanges.push({ rangeId: range.rangeId, ...validation });
      host.logEvent("context.compact.plan_rejected", {
        planId: plan.planId,
        rangeId: range.rangeId,
        ...validation,
      });
      continue;
    }

    // Build deterministic style summary using the underlying
    // raw `getMessages()` (sanitization is applied inside
    // buildCompactSummary). The summary text never includes tool
    // payloads or reasoning.
    const rawMessages = host.getMessages();
    const fromIdx = rawMessages.findIndex((m) => m.id === range.fromMessageId);
    const toIdx = rawMessages.findIndex((m) => m.id === range.toMessageId);
    if (fromIdx < 0 || toIdx < 0 || toIdx < fromIdx) {
      const rejection = {
        rangeId: range.rangeId,
        reason: "range_not_resolvable_in_raw",
        detail: `from=${range.fromMessageId} to=${range.toMessageId} fromIdx=${fromIdx} toIdx=${toIdx}`,
      };
      rejectedRanges.push(rejection);
      host.logEvent("context.compact.plan_rejected", { planId: plan.planId, ...rejection });
      continue;
    }
    // recompute medium-tier preserved points from the
    // FRESH snapshot+anchors (not the original plan) so the summary
    // reflects what is actually being compacted right now. The
    // `range.summaryPreservedAnchors` from the plan is informational
    // only; staleness is corrected here.
    const preservedPoints = collectFreshPreservedPoints(
      freshSnapshot,
      freshAnchors,
      range.fromMessageId,
      range.toMessageId,
    );
    const summary = buildCompactSummary({
      messages: rawMessages,
      fromIndex: fromIdx,
      toIndex: toIdx,
      preservedPoints,
    });

    // optional semantic advisor. The orchestrator is
    // fallback-safe: a null client (current default), timeout, error,
    // or validator failure all route to the deterministic summary
    // text without blocking compaction. The audit row is emitted
    // either way when the operator asked for it.
    let advisorResult: SemanticSummaryAdvisorResult | null = null;
    let summaryTextForCompaction = summary.text;
    if (advisorRequested) {
      const advisorReq: SemanticSummaryAdvisorRequest = {
        fromMessageId: range.fromMessageId,
        toMessageId: range.toMessageId,
        sourceCompactionId: null,
        deterministicSummary: summary.text,
        preservedPoints,
        sanitizedSource: buildAdvisorSanitizedSourceFree(freshSnapshot, range.fromMessageId, range.toMessageId),
        trigger: input.semanticAdvisorTrigger,
      };
      advisorResult = await runSemanticSummaryAdvisor(advisorReq, advisorClient);
      if (advisorResult.ok && advisorResult.enrichedSummary) {
        summaryTextForCompaction = advisorResult.enrichedSummary;
      }
    }

    const compactionsBefore = safeGetCompactionsFree(host).length;
    const syntheticsBefore = countSyntheticInVisibleFree(host);

    let stored: StoredCompaction;
    try {
      stored = host.addCompaction(summaryTextForCompaction, range.fromMessageId, range.toMessageId);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      const rejection = {
        rangeId: range.rangeId,
        reason: "add_compaction_threw",
        detail,
      };
      rejectedRanges.push(rejection);
      host.logEvent("context.compact.plan_rejected", { planId: plan.planId, ...rejection });
      continue;
    }

    const compactionsAfter = safeGetCompactionsFree(host).length;
    const syntheticsAfter = countSyntheticInVisibleFree(host);
    const compactionsDelta = compactionsAfter - compactionsBefore;
    const syntheticsDelta = syntheticsAfter - syntheticsBefore;
    if (compactionsDelta > syntheticsDelta) {
      deadRecordDetected = true;
      host.logEvent("context.compact.dead_record_detected", {
        planId: plan.planId,
        rangeId: range.rangeId,
        compactionId: stored.id,
        compactionsDelta,
        syntheticsDelta,
      });
    }

    const afterCount = host.getMessages().length;
    const applied: CompactPlanApplyResult["appliedRanges"][number] = {
      rangeId: range.rangeId,
      compactionId: stored.id,
      fromMessageId: range.fromMessageId,
      toMessageId: range.toMessageId,
      beforeCount,
      afterCount,
    };
    if (advisorResult) {
      const auditWithCompaction = {
        ...advisorResult.audit,
        sourceCompactionId: stored.id,
      };
      applied.semanticAdvisor = {
        ok: advisorResult.ok,
        audit: auditWithCompaction,
      };
      host.logEvent("context.compact.semantic_advisor_invoked", {
        planId: plan.planId,
        rangeId: range.rangeId,
        ok: advisorResult.ok,
        ...auditWithCompaction,
      });
    }
    appliedRanges.push(applied);
    host.logEvent("context.compact.plan_applied", {
      planId: plan.planId,
      rangeId: range.rangeId,
      compactionId: stored.id,
      fromMessageId: range.fromMessageId,
      toMessageId: range.toMessageId,
      messageCount: range.messageCount,
      summaryLength: summary.text.length,
      summaryTruncated: summary.truncated,
      beforeCount,
      afterCount,
    });
  }

  const finalAfterCount = host.getMessages().length;
  return {
    ok: rejectedRanges.length === 0,
    planId: plan.planId,
    appliedRanges,
    rejectedRanges,
    beforeCount,
    afterCount: finalAfterCount,
    deadRecordDetected,
    timestamp: Date.now(),
  };
}
