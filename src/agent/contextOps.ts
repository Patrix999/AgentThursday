/**
 *  —  Step 6 contextOps pointer/history extraction.
 *
 * Six active-pointer / context-history helpers pulled verbatim from
 * `AgentThursdayAgent` (`src/server.ts` lines ~4672–4783). No SQL strings,
 * table names, column names, return shapes, or callable payloads
 * changed; only the location of the calls moved.
 *
 * Host shape is intentionally narrow — only `sql` is needed. None of
 * these six helpers emits events or reads `env`. `DEMO_INSTANCE` is
 * referenced as a literal initial-bootstrap contextId inside
 * `ensureActiveContextFree`; this is a constant reference, NOT a
 * self-RPC branch (per Step 5 preflight §5: self-RPC branching stays
 * at composition root in `resetContext` / `newContext` /
 * `runContextHygiene`, which are out of this card's scope).
 *
 * Wrapper retention: every helper retains its `AgentThursdayAgent` delegate
 * in `src/server.ts` (private or `@callable`). `ensureActiveContext`
 * alone has ~9 internal call sites; removing the wrapper would break
 * the byte-equivalent surface contract required by the preflight.
 */

import type { UIMessage } from "ai";

import { DEMO_INSTANCE } from "../demoConstants";
import {
  buildArchiveChunks,
  buildContextInspect,
  type ContextInspectViewModel,
} from "../contextLifecycle";
import type {
  ActiveContext,
  ArchiveChunkInput,
  ArchiveChunksInput,
  ArchiveFlushResult,
  ArchiveTrigger,
  CompactPlanApplyResult,
  CompactPlanInput,
  CompactPlanResult,
  ContextHistoryList,
  ContextInspectResult,
  ContextResetResult,
  CurrentModelResolution,
  DrainForArchiveResult,
  HygieneDecision,
  HygieneRiskCondition,
  HygieneRunInput,
  HygieneRunResult,
  HygieneTrigger,
  NewContextResult,
  SwitchContextResult,
} from "../schema";
import {
  DEFAULT_CONTEXT_PROFILE,
  type ModelContextProfile,
  pickModelContextProfile,
} from "../contextWindowRegistry";
import type { AgentThursdayState } from "../types";
import {
  ESTIMATED_OTHER_OVERHEAD_TOKENS,
  ESTIMATED_TOOLS_OVERHEAD_TOKENS,
} from "./agentConstants";
import {
  estimateDialogTokensFromMessages,
  newContextId,
} from "./contextHelpers";
import { SOUL } from "./soulPrompt";

export type ContextOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface ContextPointerHost {
  sql: ContextOpsSqlTag;
}

// ──  — read-side Host ───────────────────────────────────────
// Adds the four agent-instance accessors the resolver / budget /
// inspect surfaces consume beyond the pointer Host. `getLastStepModel`
// returns the in-memory `_lastStepModel` field (shape preserved); the
// persisted observation comes via `getAgentThursdayState().lastObservedModel`.
export interface ContextReadHost extends ContextPointerHost {
  getAgentThursdayState: () => AgentThursdayState;
  getLastStepModel: () => { provider: string; modelId: string } | null;
  getMessages: () => UIMessage[];
  getSessionTokens: () => { in: number; out: number; total: number; hasData: boolean };
  getTaskTokens: () => { taskId: string | null; in: number; out: number; total: number };
  logEvent: (type: string, payload: unknown) => void;
}

// ──  — write-side Host ──────────────────────────────────────
// Adds env/namespace-free capability methods composed at the server
// composition root. `archiveChunksRemote` / `drainForArchiveRemote`
// encapsulate the cross-DO RPC the helper functions never see
// directly (per preflight §69 self-RPC stays at the root). Compaction
// capabilities mirror the existing `compactPlan` / `applyCompactPlan`
// callable contract.
export interface ContextWriteHost extends ContextReadHost {
  isRegistry: (contextId: string) => boolean;
  resetTurnState: () => void;
  clearMessages: () => void;
  resetSessionTokens: () => void;
  resetTaskTokens: () => void;
  writeArchiveFlushLocal: (input: {
    contextId: string;
    trigger: ArchiveTrigger | string;
    chunks: readonly ArchiveChunkInput[];
    reason: string | null;
  }) => ArchiveFlushResult;
  archiveChunksRemote: (contextId: string, input: ArchiveChunksInput) => Promise<ArchiveFlushResult>;
  drainForArchiveRemote: (contextId: string) => Promise<DrainForArchiveResult>;
  compactPlan: (input?: CompactPlanInput) => CompactPlanResult;
  applyCompactPlan: (input: { plan: CompactPlanResult }) => Promise<CompactPlanApplyResult>;
  getPendingToolApproval: () => unknown;
  getSafeState: () => AgentThursdayState;
}

export function getActiveContextRowFromHistoryFree(
  host: ContextPointerHost,
): { context_id: string; reason: string | null; created_at: number } | null {
  // Returns the row that currently has `ended_at IS NULL`. Used
  // during bootstrap migration when context_active is empty; once
  // populated, getActivePointer() is the canonical accessor.
  const rows = host.sql<{ context_id: string; reason: string | null; created_at: number | bigint }>`
    SELECT context_id, reason, created_at FROM context_history WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    context_id: row.context_id,
    reason: row.reason,
    created_at: Number(row.created_at),
  };
}

export function getActivePointerFree(
  host: ContextPointerHost,
): { active_context_id: string; activated_at: number } | null {
  const rows = host.sql<{ active_context_id: string; activated_at: number | bigint }>`
    SELECT active_context_id, activated_at FROM context_active WHERE id = 1 LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { active_context_id: row.active_context_id, activated_at: Number(row.activated_at) };
}

export function writeActivePointerFree(
  host: ContextPointerHost,
  contextId: string,
  activatedAt: number,
): void {
  host.sql`
    INSERT OR REPLACE INTO context_active (id, active_context_id, activated_at)
    VALUES (1, ${contextId}, ${activatedAt})
  `;
}

export function ensureActiveContextFree(
  host: ContextPointerHost,
): { context_id: string; reason: string | null; created_at: number } {
  // First check the active pointer; this is the canonical accessor
  // post-v2 and avoids the "ended_at IS NULL" assumption that
  // breaks once we allow switching back to closed contexts.
  const pointer = getActivePointerFree(host);
  if (pointer) {
    const rows = host.sql<{ context_id: string; reason: string | null; created_at: number | bigint }>`
      SELECT context_id, reason, created_at FROM context_history WHERE context_id = ${pointer.active_context_id} LIMIT 1
    `;
    if (rows[0]) {
      return {
        context_id: rows[0].context_id,
        reason: rows[0].reason,
        created_at: Number(rows[0].created_at),
      };
    }
  }
  // Pointer missing or stale → migrate from v1 semantics.
  const v1Active = getActiveContextRowFromHistoryFree(host);
  const now = Date.now();
  if (v1Active) {
    // v1 bootstrap row exists — adopt it as the active context and
    // populate the pointer so future calls take the fast path.
    writeActivePointerFree(host, v1Active.context_id, now);
    return v1Active;
  }
  // Truly fresh DO → bootstrap. v2 uses DEMO_INSTANCE as the
  // bootstrap contextId so header-less requests route to the same DO
  // that owns this row.
  const contextId = DEMO_INSTANCE;
  const reason = "initial-bootstrap";
  host.sql`
    INSERT INTO context_history (context_id, reason, created_at, ended_at, message_count_at_end)
    VALUES (${contextId}, ${reason}, ${now}, NULL, NULL)
  `;
  writeActivePointerFree(host, contextId, now);
  return { context_id: contextId, reason, created_at: now };
}

export function getActiveContextIdFree(host: ContextPointerHost): ActiveContext {
  const row = ensureActiveContextFree(host);
  return {
    contextId: row.context_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function listContextHistoryFree(host: ContextPointerHost): ContextHistoryList {
  ensureActiveContextFree(host);
  // After v2 the "isActive" status on a row should reflect the
  // pointer, not just `ended_at IS NULL` (since switching back to a
  // closed context updates the pointer without re-opening the row).
  const pointer = getActivePointerFree(host);
  const activeId = pointer?.active_context_id ?? null;
  const rows = host.sql<{
    context_id: string;
    reason: string | null;
    created_at: number | bigint;
    ended_at: number | bigint | null;
    message_count_at_end: number | bigint | null;
  }>`
    SELECT context_id, reason, created_at, ended_at, message_count_at_end
    FROM context_history
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return {
    contexts: rows.map((r) => ({
      contextId: r.context_id,
      reason: r.reason,
      createdAt: Number(r.created_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      messageCountAtEnd: r.message_count_at_end === null ? null : Number(r.message_count_at_end),
      isActive: activeId !== null && r.context_id === activeId,
    })),
  };
}

// ──  — model resolution / budget / inspect ───────────────────
// Verbatim ports of the   resolver,  budget, and
//  inspect surfaces from `AgentThursdayAgent`. Selection invariants
// (configured vs lastObserved, conservative budget on mismatch,
// placeholder gating, awareness preferring observed) preserved.
export function resolveCurrentModelProfileFree(host: ContextReadHost): CurrentModelResolution {
  const agentthursdayState = host.getAgentThursdayState();
  const configuredRaw = agentthursdayState.modelProfile;
  const configured = configuredRaw && configuredRaw.model
    ? { provider: configuredRaw.provider ?? null, modelId: configuredRaw.model }
    : null;

  // Persisted observation () survives hibernate; in-memory
  // cache wins when present (cheaper) but they should match within
  // the same isolate.
  const stepObsRaw = host.getLastStepModel();
  const stepObs = stepObsRaw
    ? { provider: stepObsRaw.provider ?? null, modelId: stepObsRaw.modelId }
    : null;
  const persistedObs = agentthursdayState.lastObservedModel
    ? { provider: agentthursdayState.lastObservedModel.provider ?? null, modelId: agentthursdayState.lastObservedModel.model }
    : null;
  const lastObserved = stepObs ?? persistedObs;

  // v1 effective: observed ?? configured. Future routing policy
  // hooks here without changing consumer call sites.
  const effective = lastObserved ?? configured;

  // budgetModel — conservative on configured/observed mismatch, but
  // ONLY when `configured` represents a real user-intended model.
  // : the default `stub-concise` / `stub-verbose` placeholders
  // (and any model id that doesn't resolve to a real registry entry)
  // must NOT trigger the conservative smaller-window path — otherwise
  // an observed Kimi 256K gets clipped back to the stub's DEFAULT 128K
  // every time a real inference lands. The check is registry-based
  // (resolves to DEFAULT) plus an explicit stub-provider gate so future
  // unmapped real models get logged as observed instead of mistreated
  // as a fake "user wants smaller window" intent.
  const configuredIsPlaceholder = (() => {
    if (!configured) return true;
    if (
      configuredRaw?.provider === "deterministic"
      && (configuredRaw?.model === "stub-concise" || configuredRaw?.model === "stub-verbose")
    ) {
      return true;
    }
    const cfgProf = pickModelContextProfile(configured.modelId);
    return cfgProf === DEFAULT_CONTEXT_PROFILE;
  })();

  let budgetModel: CurrentModelResolution["budgetModel"] = null;
  if (
    lastObserved
    && configured
    && !configuredIsPlaceholder
    && lastObserved.modelId !== configured.modelId
  ) {
    const obsProf = pickModelContextProfile(lastObserved.modelId);
    const cfgProf = pickModelContextProfile(configured.modelId);
    if (cfgProf.modelMaxTokens > 0 && cfgProf.modelMaxTokens < obsProf.modelMaxTokens) {
      budgetModel = { ...configured, source: "conservative" };
    } else {
      budgetModel = { ...lastObserved, source: "observed" };
    }
  } else if (lastObserved) {
    budgetModel = { ...lastObserved, source: "observed" };
  } else if (configured && !configuredIsPlaceholder) {
    budgetModel = { ...configured, source: "configured" };
  } else if (configured) {
    budgetModel = { ...configured, source: "fallback" };
  } else {
    budgetModel = null;
  }

  let awarenessModel: CurrentModelResolution["awarenessModel"] = null;
  if (lastObserved) {
    awarenessModel = { ...lastObserved, source: "observed" };
  } else if (configured) {
    awarenessModel = { ...configured, source: "configured" };
  } else {
    awarenessModel = null;
  }

  return { configured, lastObserved, effective, budgetModel, awarenessModel };
}

export function computeContextBudgetFree(
  host: ContextReadHost,
  taskTok: number | null,
  sessionTok: number | null,
  dialogTokenFallback: number | null,
): ContextInspectResult["contextBudget"] {
  const resolution = resolveCurrentModelProfileFree(host);
  const modelId = resolution.budgetModel?.modelId ?? "";
  const profile: ModelContextProfile = pickModelContextProfile(modelId);
  const modelMaxTokens = profile.modelMaxTokens;
  const softCompactAt = Math.round(modelMaxTokens * profile.thresholds.softCompactRatio);
  const autoCompactAt = Math.round(modelMaxTokens * profile.thresholds.hardCompactRatio);
  const dangerAt = Math.round(modelMaxTokens * profile.thresholds.dangerRatio);
  const soulTok = Math.ceil(SOUL.length / 4);
  const toolsTok = ESTIMATED_TOOLS_OVERHEAD_TOKENS;
  const otherTok = ESTIMATED_OTHER_OVERHEAD_TOKENS;
  const systemOverheadTokens = soulTok + toolsTok + otherTok;
  const runtimeDialogTokens = taskTok !== null ? taskTok : sessionTok;
  const visibleDialogTokens =
    runtimeDialogTokens !== null
      ? runtimeDialogTokens
      : (dialogTokenFallback !== null && dialogTokenFallback > 0)
      ? dialogTokenFallback
      : null;
  const usedTokens = visibleDialogTokens !== null
    ? visibleDialogTokens + systemOverheadTokens
    : systemOverheadTokens;
  const source: "estimated" | "provider" | "unavailable" = "estimated";
  return {
    modelMaxTokens,
    autoCompactAt,
    dangerAt,
    softCompactAt,
    usedTokens,
    visibleDialogTokens,
    systemOverheadTokens,
    systemOverheadBreakdown: {
      soul: soulTok,
      tools: toolsTok,
      other: otherTok,
    },
    source,
  };
}

export function inspectContextFree(
  host: ContextReadHost,
  input?: { lastN?: number },
): ContextInspectResult {
  const lastN = typeof input?.lastN === "number" ? input.lastN : 20;
  const messages = host.getMessages();
  const view: ContextInspectViewModel = buildContextInspect(messages, lastN);
  const sessionTok = host.getSessionTokens();
  const taskTok = host.getTaskTokens();
  const tokenSession = sessionTok.hasData
    ? { in: sessionTok.in, out: sessionTok.out, total: sessionTok.total }
    : null;
  const tokenTask = (taskTok.taskId !== null && (taskTok.in > 0 || taskTok.out > 0))
    ? { in: taskTok.in, out: taskTok.out, total: taskTok.total }
    : null;
  const dialogFallback = estimateDialogTokensFromMessages(messages);
  const contextBudget = computeContextBudgetFree(
    host,
    tokenTask?.total ?? null,
    tokenSession?.total ?? null,
    dialogFallback,
  );
  const currentModelResolution = resolveCurrentModelProfileFree(host);
  return { ...view, tokenSession, tokenTask, contextBudget, currentModelResolution };
}

// ──  — lifecycle: resetContext / newContext / switchContext ──
// Verbatim ports preserving:
//   - resetContext archive-before-clear + abort-on-failure semantics,
//     `archive.flush.failed` payload `{contextId, trigger, reason,
//     error, beforeMessageCount, blockedReset: true}`, and the
//     multi-line abort error text.
//   - newContext archive-before-close non-blocking path,
//     `conversation_archive_flushes` audit row insertion on failure,
//     `archive.flush.failed` payload `{flushId, contextId, trigger,
//     error, reason}`, and the v1FallbackNote string.
//   - switchContext input validation, no-op event branch, and
//     `writeActivePointer` on real switch.
//   - lifecycle ordering: archive flush → resetTurnState() →
//     clearMessages() → token resets.
export async function resetContextFree(
  host: ContextWriteHost,
  input?: { reason?: string | null; routedContextId?: string },
): Promise<ContextResetResult> {
  const reason = (typeof input?.reason === "string" && input.reason.trim().length > 0)
    ? input.reason.trim().slice(0, 200)
    : null;
  const routedContextId = (typeof input?.routedContextId === "string" && input.routedContextId.length > 0)
    ? input.routedContextId
    : null;
  const beforeMessageCount = host.getMessages().length;

  if (beforeMessageCount > 0) {
    const messages = host.getMessages();
    const chunks = buildArchiveChunks(messages);
    const isRegistryReset = routedContextId === DEMO_INSTANCE;
    let contextIdGuess: string;
    if (routedContextId !== null) {
      contextIdGuess = routedContextId;
    } else {
      try {
        contextIdGuess = ensureActiveContextFree(host).context_id;
      } catch {
        contextIdGuess = "unknown";
      }
    }
    try {
      let flush: ArchiveFlushResult;
      if (isRegistryReset) {
        flush = host.writeArchiveFlushLocal({
          contextId: contextIdGuess,
          trigger: "context.reset",
          chunks,
          reason,
        });
      } else {
        flush = await host.archiveChunksRemote(DEMO_INSTANCE, {
          contextId: contextIdGuess,
          trigger: "context.reset",
          chunks,
          reason,
        });
      }
      if (flush.status !== "ok" && flush.status !== "skipped") {
        throw new Error(
          `resetContext: archive flush returned status=${flush.status} error=${flush.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      host.logEvent("archive.flush.failed", {
        contextId: contextIdGuess,
        trigger: "context.reset",
        reason,
        error: detail,
        beforeMessageCount,
        blockedReset: true,
      });
      throw new Error(
        `resetContext: aborted because archive flush failed (${detail}). No messages were cleared. ` +
        `The conversation_archive_flushes audit row records the failure; you may retry once the archive write path is available.`,
      );
    }
  }

  host.resetTurnState();
  host.clearMessages();
  host.resetSessionTokens();
  host.resetTaskTokens();
  const afterMessageCount = host.getMessages().length;
  const timestamp = Date.now();
  host.logEvent("context.reset", {
    reason,
    beforeMessageCount,
    afterMessageCount,
    preservedDurableState: true,
    archivedBeforeClear: beforeMessageCount > 0,
  });
  return {
    ok: true,
    beforeMessageCount,
    afterMessageCount,
    reason,
    preservedDurableState: true,
    timestamp,
  };
}

export async function newContextFree(
  host: ContextWriteHost,
  input?: { reason?: string | null },
): Promise<NewContextResult> {
  const reason = (typeof input?.reason === "string" && input.reason.trim().length > 0)
    ? input.reason.trim().slice(0, 200)
    : null;
  const previous = ensureActiveContextFree(host);
  const timestamp = Date.now();

  let beforeMessageCount = 0;
  let archiveFlushId: string | null = null;
  let archiveStatus: string = "skipped";
  try {
    let drained: DrainForArchiveResult;
    if (host.isRegistry(previous.context_id)) {
      const messages = host.getMessages();
      drained = {
        contextId: previous.context_id,
        snapshotAt: Date.now(),
        chunks: buildArchiveChunks(messages),
        totalMessageCount: messages.length,
      };
    } else {
      drained = await host.drainForArchiveRemote(previous.context_id);
    }
    beforeMessageCount = drained.totalMessageCount;
    const flush = host.writeArchiveFlushLocal({
      contextId: previous.context_id,
      trigger: "context.new",
      chunks: drained.chunks,
      reason,
    });
    archiveFlushId = flush.flushId;
    archiveStatus = flush.status;
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    const fallbackFlushId = newContextId().replace(/^ctx_/, "flush_");
    host.sql`
      INSERT INTO conversation_archive_flushes (flush_id, context_id, trigger, chunk_count, message_count, status, reason, error, created_at)
      VALUES (${fallbackFlushId}, ${previous.context_id}, ${"context.new"}, ${0}, ${0}, ${"failed"}, ${reason}, ${detail}, ${timestamp})
    `;
    archiveFlushId = fallbackFlushId;
    archiveStatus = "failed";
    host.logEvent("archive.flush.failed", {
      flushId: fallbackFlushId,
      contextId: previous.context_id,
      trigger: "context.new",
      error: detail,
      reason,
    });
  }

  host.sql`
    UPDATE context_history
    SET ended_at = ${timestamp}, message_count_at_end = ${beforeMessageCount}
    WHERE context_id = ${previous.context_id} AND ended_at IS NULL
  `;

  const newId = newContextId();
  host.sql`
    INSERT INTO context_history (context_id, reason, created_at, ended_at, message_count_at_end)
    VALUES (${newId}, ${reason}, ${timestamp}, NULL, NULL)
  `;
  writeActivePointerFree(host, newId, timestamp);

  const afterMessageCount = host.getMessages().length;

  const note = `v2 per-context DO routing active. Old context's raw transcripts remain in its own DO and are now also archived to conversation_archive (flushId=${archiveFlushId ?? "none"}, status=${archiveStatus}).`;
  host.logEvent("context.new", {
    previousContextId: previous.context_id,
    newContextId: newId,
    reason,
    beforeMessageCount,
    afterMessageCount,
    preservedDurableState: true,
    rawMessagesPreservedInOldContext: true,
    archiveFlushId,
    archiveStatus,
    v1FallbackNote: note,
  });

  return {
    ok: true,
    previousContextId: previous.context_id,
    newContextId: newId,
    reason,
    beforeMessageCount,
    afterMessageCount,
    preservedDurableState: true,
    rawMessagesPreservedInOldContext: true,
    v1FallbackNote: note,
    timestamp,
  };
}

export function switchContextFree(
  host: ContextWriteHost,
  input: { contextId: string; reason?: string | null },
): SwitchContextResult {
  if (typeof input?.contextId !== "string" || input.contextId.trim().length === 0) {
    throw new Error("switchContext: missing contextId");
  }
  const target = input.contextId.trim();
  const reason = (typeof input?.reason === "string" && input.reason.trim().length > 0)
    ? input.reason.trim().slice(0, 200)
    : null;

  const existsRows = host.sql<{ context_id: string }>`
    SELECT context_id FROM context_history WHERE context_id = ${target} LIMIT 1
  `;
  if (existsRows.length === 0) {
    throw new Error(`switchContext: contextId not found in history: ${target}`);
  }

  const before = ensureActiveContextFree(host);
  const activatedAt = Date.now();

  if (before.context_id === target) {
    host.logEvent("context.switch", {
      previousContextId: before.context_id,
      newContextId: target,
      reason,
      noop: true,
    });
    return {
      ok: true,
      previousContextId: before.context_id,
      newContextId: target,
      reason,
      activatedAt,
    };
  }

  writeActivePointerFree(host, target, activatedAt);
  host.logEvent("context.switch", {
    previousContextId: before.context_id,
    newContextId: target,
    reason,
    noop: false,
  });

  return {
    ok: true,
    previousContextId: before.context_id,
    newContextId: target,
    reason,
    activatedAt,
  };
}

// ──  — runContextHygiene ─────────────────────────────────────
// Verbatim port preserving:
//   - manual-check trigger guard + error string
//   - risk condition push order
//     (below_pressure_threshold → auto_apply_disabled →
//      pending_tool_approval → waiting_for_human →
//      current_obstacle_blocked → no_compactable_ranges)
//   - registry / non-registry archive branch with `manual` trigger and
//     `hygiene-precompact:${runId}` reason
//   - decision/reason composition + .slice caps (240 / 200)
//   - SQL INSERT into context_hygiene_runs and `context.hygiene.run`
//     event payload field order
export async function runContextHygieneFree(
  host: ContextWriteHost,
  input?: HygieneRunInput,
): Promise<HygieneRunResult> {
  const trigger: HygieneTrigger = (input?.trigger ?? "manual-check") as HygieneTrigger;
  if (trigger !== "manual-check") {
    throw new Error(
      `runContextHygiene v1: only trigger="manual-check" is allowed; received "${trigger}". ` +
      `Scheduled triggers require explicit operator config (out of scope for  v1).`,
    );
  }
  const pressureThreshold = Math.max(1, Math.min(500, Math.floor(input?.pressureThreshold ?? 50)));
  const autoApply = input?.autoApply !== false;
  const runId = newContextId().replace(/^ctx_/, "hyg_");
  const createdAt = Date.now();

  const messages = host.getMessages();
  const beforeMessageCount = messages.length;
  const pressureMessageCount = beforeMessageCount;

  const riskConditions: HygieneRiskCondition[] = [];

  if (pressureMessageCount < pressureThreshold) {
    riskConditions.push("below_pressure_threshold");
  }
  if (!autoApply) {
    riskConditions.push("auto_apply_disabled");
  }
  try {
    const pending = host.getPendingToolApproval();
    if (pending && (pending as { toolCallId?: unknown }).toolCallId) {
      riskConditions.push("pending_tool_approval");
    }
  } catch {
    // Treat as no pending approval; hygiene continues.
  }
  try {
    const safe = host.getSafeState();
    if (safe.waitingForHuman) riskConditions.push("waiting_for_human");
    if (safe.currentObstacle?.blocked) riskConditions.push("current_obstacle_blocked");
  } catch {
    // Defensive: missing getter shouldn't kill hygiene.
  }

  let decision: HygieneDecision = "skipped";
  let reason: string | null = null;
  let archiveFlushId: string | null = null;
  let appliedCompactPlanId: string | null = null;
  let proposedRanges: HygieneRunResult["proposedRanges"] = [];
  let afterMessageCount: number | null = beforeMessageCount;

  const belowThreshold = pressureMessageCount < pressureThreshold;
  if (belowThreshold) {
    decision = "skipped";
    reason = `pressure (${pressureMessageCount}) < threshold (${pressureThreshold})`;
  } else {
    const plan = host.compactPlan({
      lastN: 200,
      firstK: 4,
      keepRecent: 8,
      minRangeMessages: 3,
      pressureThreshold: pressureThreshold,
    });
    proposedRanges = plan.ranges.map((r) => ({
      rangeId: r.rangeId,
      fromMessageId: r.fromMessageId,
      toMessageId: r.toMessageId,
      fromIndex: r.fromIndex,
      toIndex: r.toIndex,
      messageCount: r.messageCount,
      estimatedReduction: r.estimatedReduction,
    }));

    if (proposedRanges.length === 0) {
      riskConditions.push("no_compactable_ranges");
      decision = "skipped";
      reason = `compactPlan produced no ranges (${plan.rejected.map((r) => r.reason).join(", ") || "no_runs"})`;
    } else if (riskConditions.length > 0) {
      decision = "proposed";
      reason = `risk gates fired: ${riskConditions.join(", ")}`;
    } else {
      let contextIdGuess: string;
      try {
        contextIdGuess = ensureActiveContextFree(host).context_id;
      } catch {
        contextIdGuess = "unknown";
      }
      try {
        const chunks = buildArchiveChunks(messages);
        if (host.isRegistry(contextIdGuess)) {
          const flush = host.writeArchiveFlushLocal({
            contextId: contextIdGuess,
            trigger: "manual",
            chunks,
            reason: `hygiene-precompact:${runId}`,
          });
          archiveFlushId = flush.flushId;
        } else {
          const flush = await host.archiveChunksRemote(DEMO_INSTANCE, {
            contextId: contextIdGuess,
            trigger: "manual",
            chunks,
            reason: `hygiene-precompact:${runId}`,
          });
          archiveFlushId = flush.flushId;
        }
      } catch (e) {
        decision = "failed";
        reason = `archive-before-compact failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
      }

      if (decision !== "failed") {
        try {
          const apply = await host.applyCompactPlan({ plan });
          appliedCompactPlanId = plan.planId;
          afterMessageCount = apply.afterCount;
          if (apply.ok) {
            decision = "auto-applied";
            reason = `applied=${apply.appliedRanges.length} rejected=${apply.rejectedRanges.length}`;
          } else {
            decision = "failed";
            reason = `applyCompactPlan partial: applied=${apply.appliedRanges.length} rejected=${apply.rejectedRanges.length} ` +
              apply.rejectedRanges.map((r) => `${r.rangeId}=${r.reason}`).join(", ").slice(0, 200);
          }
        } catch (e) {
          decision = "failed";
          reason = `applyCompactPlan threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
        }
      }
    }
  }

  if (afterMessageCount === null || decision === "failed") {
    afterMessageCount = host.getMessages().length;
  }

  const riskJson = JSON.stringify(riskConditions);
  host.sql`
    INSERT INTO context_hygiene_runs (
      run_id, trigger, decision, reason, pressure_message_count, pressure_threshold,
      before_message_count, after_message_count, archive_flush_id, applied_compact_plan_id,
      risk_conditions_json, created_at
    ) VALUES (
      ${runId}, ${trigger}, ${decision}, ${reason}, ${pressureMessageCount}, ${pressureThreshold},
      ${beforeMessageCount}, ${afterMessageCount}, ${archiveFlushId}, ${appliedCompactPlanId},
      ${riskJson}, ${createdAt}
    )
  `;
  host.logEvent("context.hygiene.run", {
    runId,
    trigger,
    decision,
    reason,
    pressureMessageCount,
    pressureThreshold,
    beforeMessageCount,
    afterMessageCount,
    archiveFlushId,
    appliedCompactPlanId,
    riskConditions,
    proposedRangeCount: proposedRanges.length,
  });

  return {
    ok: decision !== "failed",
    runId,
    trigger,
    decision,
    reason,
    pressureMessageCount,
    pressureThreshold,
    beforeMessageCount,
    afterMessageCount,
    archiveFlushId,
    appliedCompactPlanId,
    riskConditions,
    proposedRanges,
    createdAt,
  };
}
