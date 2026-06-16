import type {
  AgentThursdayState,
  CliSession,
  DeveloperLoopReview,
  ApprovalPolicy,
  DeliverableConvergence,
} from "./types";
import type {
  WorkspaceSnapshot,
  SessionView,
  TaskView,
  MessageView,
  ApprovalView,
  ArtifactView,
  InspectEntry,
} from "./schema";

/**
 *  — pure snapshot builder extracted from `src/server.ts`.
 *
 * Identity-shaped local types. These mirror the local types in
 * `src/server.ts` so the moved function can be invoked with the
 * exact same input it had before extraction (TS structural typing
 * makes the cross-module shapes compatible). They live here as
 * locals rather than as a separate types module because
 * `buildWorkspaceSnapshot` is the only outside-of-server.ts
 * consumer; duplicating four-field rows beats adding a third file
 * just to hold them.
 */
type EventLogRow = { event_type: string; payload: string; created_at: number; trace_id: string | null };

type DebugTraceShape = {
  lastAssistantSummary: string;
  recentToolEvents: { type: string; summary: string; at: number }[];
  pendingApprovalReason: string | null;
  lastActionResult: { actionType: string; outcome: string; summary: string } | null;
  lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null;
};

type PendingMutationRow = { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; created_at: number };

//  — patterns that must NEVER appear in `summaryStream`
// item text. The first matches the truncation suffix produced by
// `getLastAssistantText(maxLen)`. The second matches the developer
// -loop preview line embedded by `getDeveloperLoopReview()`. Both
// indicate the text came from a synthesized loop view rather than a
// real user / assistant turn.
const DIALOG_PREVIEW_SUFFIX_RE = /\(\+\d+ chars?\)/;
const DIALOG_LOOP_LAST_MSG_RE = /(^|\n)\[last msg\]\s/;

export function buildWorkspaceSnapshot(input: {
  agentthursdayState: AgentThursdayState;
  cliSession: CliSession;
  loopReview: DeveloperLoopReview;
  approvalPolicy: ApprovalPolicy;
  pendingToolApproval: { toolCallId: string; toolName: string } | null;
  debugTrace: DebugTraceShape;
  deliverableGate: DeliverableConvergence;
  pendingMutations: PendingMutationRow[];
  eventLog: EventLogRow[];
  //  — latest `context.reset` boundary. 0 means "no reset has
  // happened on this DO". The route handler queries `getLastResetAt()`
  // separately because `getEventLog` is capped at 20 rows.
  lastResetAt: number;
  //  — canonical active context id (registry pointer). The
  // route handler queries `getActiveContextId()` on the registry DO
  // and passes the value through. Carries identity only.
  activeContextId: string;
  //  — historical user-anchored dialog turns from the
  // message log, ordered oldest → newest, capped to last 30. Each
  // entry pairs a user message's aggregated text with the assistant
  // text that followed it (or null if tool-only). The route handler
  // calls `getDialogTurns()`; this builder matches each
  // `task.submitted` event to a turn by `userText` so pairing is
  // robust to event_log's 20-row cap (153z4 v1 used index-based
  // pairing and misaligned in production).
  dialogTurns: { userText: string; assistantText: string | null }[];
  //  — independent `task.submitted` event window (60 newest
  // by default), used in place of `eventLog.filter(... 'task.submitted')`
  // so older user turns aren't evicted from the 20-row eventLog cap.
  // Optional for backwards compatibility; falls back to eventLog
  // filter when omitted.
  taskSubmittedEvents?: EventLogRow[];
  //  — newest-first `task.reply.finalized` events. Each one
  // carries the bounded user-visible reply (post truthfulness gate /
  // supplier marker / 156g1 ack / 120 pause append) so the Web
  // `summaryStream` can render the same warning-bearing text Discord
  // and CLI receive. Optional for back-compat with older callers.
  taskReplyFinalizedEvents?: EventLogRow[];
}): WorkspaceSnapshot {
  const { agentthursdayState, cliSession, loopReview, approvalPolicy, pendingToolApproval, debugTrace, deliverableGate, pendingMutations, eventLog, lastResetAt, activeContextId, dialogTurns, taskSubmittedEvents, taskReplyFinalizedEvents } = input;
  const eventLogCount = eventLog.length;
  const now = Date.now();

  const session: SessionView = {
    sessionId: cliSession.sessionId,
    instanceName: cliSession.instanceName,
    agentState: agentthursdayState.status,
    loopStage: cliSession.loopStage,
    autoContinue: cliSession.autoContinue,
  };

  const currentTask: TaskView | null =
    cliSession.taskId && cliSession.taskTitle && cliSession.taskLifecycle
      ? {
          taskId: cliSession.taskId,
          title: cliSession.taskTitle,
          lifecycle: cliSession.taskLifecycle,
          loopStage: cliSession.loopStage,
          readyForNextRound: cliSession.readyForNextRound,
          ladderTier: debugTrace.lastLadderTier?.tier ?? null,
          ladderReason: debugTrace.lastLadderTier?.reason ?? null,
        }
      : null;

  // summaryStream: only human-readable text. Never include raw event_payload
  // or tool call JSON — those are inspect-layer responsibilities ().
  // v2.5+: include user task submissions derived from `task.submitted`
  // events so the user's own input shows up in the dialog flow and
  // completed task history is preserved across rounds.
  //
  //  — reset-aware filtering. Reset preserves durable
  // event_log / currentTaskObject / lastActionResult per /150,
  // so without filtering pre-reset task text + synthetic loop summary
  // would re-appear in the dialog. We anchor every summaryStream item
  // to a real timestamp and drop those at-or-before `lastResetAt`.
  // When `lastResetAt === 0` (no reset ever) the legacy `at = now`
  // fallback for synthetic items is preserved.
  const summaryStream: MessageView[] = [];

  // 1+2)  — turn-aware pairing of user task events
  //      against message-log dialog turns.
  //
  //      Why turn-aware (not index): `userTaskEvents` comes from
  //      `event_log` which is capped at 20 rows by `getEventLog()`,
  //      so old `task.submitted` events can fall out of the window
  //      while the message log retains every dialog turn. 153z4 v1
  //      paired index-by-index and the verifier reproduced an
  //      AGT-misalignment: latest user got an OLD assistant from a
  //      prior round (or no AGT at all) because the indexes drifted.
  //
  //      How: each user event's payload carries both the clean
  //      `display` (= `payload.task` after ) and the
  //      original `taskPrompt` (only set when display !== task,
  //      i.e. channel-origin messages where `display` was stripped
  //      of metadata). The message log stored the FULL prompt as
  //      the user text in saveMessages. So we match
  //      `dialogTurns[j].userText` against `prompt` (full) — that
  //      handles channel-origin. CLI-origin messages have
  //      display === task → `prompt` falls back to display →
  //      `dialogTurns[j].userText === display` matches identically.
  //      A `consumed[]` mask prevents one turn from being matched
  //      to two events.
  //
  //      Tool-only mid-stream rounds (agent ran a tool but didn't
  //      synthesize text) match a turn whose `assistantText` is
  //      null; we emit the YOU but skip the AGT for that round.
  //
  //      AGT timestamps are synthetic — assistant messages don't
  //      carry a `createdAt` in the Think SDK shape — but anchored
  //      to the matched user event's `created_at + 1` so sort time
  //      naturally interleaves them as YOU → AGT → YOU → AGT.
  //
  //      149e3 (clean YOU display), 149e3a (multi-text-part
  //      aggregation), 153z2 defensive filter, 156d (no SUM),
  //      149c reset boundary — all preserved.
  //  — prefer the independent `task.submitted` window when
  // the route passed it (60 newest), so the dialog isn't capped by
  // the 20-row `eventLog`. Fall back to filtering `eventLog` when
  // the field is omitted (older callers / tests). post-reset filter
  // and sort apply equally to either source.
  const taskSubmittedSource: EventLogRow[] = taskSubmittedEvents
    ?? eventLog.filter((r) => r.event_type === "task.submitted");
  const userTaskEvents = taskSubmittedSource
    .filter((r) => r.event_type === "task.submitted" && r.created_at > lastResetAt)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-60);
  //  — index `task.reply.finalized` events by `taskId` so the
  // pairing loop below can prefer the warning-bearing user-visible
  // reply over the SDK message log's raw assistant text. Keep the
  // newest finalized event per task (multiple submits per task should
  // not happen, but the resolved event is whichever came latest).
  const finalReplySource: EventLogRow[] = taskReplyFinalizedEvents
    ?? eventLog.filter((r) => r.event_type === "task.reply.finalized");
  const finalReplyByTaskId = new Map<string, string>();
  for (const r of finalReplySource) {
    if (r.event_type !== "task.reply.finalized") continue;
    if (r.created_at <= lastResetAt) continue;
    try {
      const p = JSON.parse(r.payload) as { taskId?: unknown; replyText?: unknown };
      if (typeof p.taskId !== "string") continue;
      if (typeof p.replyText !== "string") continue;
      const existing = finalReplyByTaskId.get(p.taskId);
      // Newest wins; events are newest-first in `finalReplySource`.
      if (existing === undefined) finalReplyByTaskId.set(p.taskId, p.replyText);
    } catch { /* skip malformed payload */ }
  }
  const consumed: boolean[] = new Array(dialogTurns.length).fill(false);
  let lastEventHadAgt = false;
  for (let i = 0; i < userTaskEvents.length; i++) {
    const row = userTaskEvents[i];
    let display: string | null = null;
    let prompt: string | null = null;
    let taskId: string | null = null;
    //  — `subagentTaskText` is the verbatim text `saveMessages`
    // persisted for this turn (display + task-context / manager-context
    // blocks). It is only emitted by `task.submitted` when it diverges
    // from both `display` and `task`, so it falls back to null on plain
    // turns.
    let subagentTaskText: string | null = null;
    try {
      const p = JSON.parse(row.payload) as {
        task?: unknown;
        taskId?: unknown;
        taskPrompt?: unknown;
        subagentTaskText?: unknown;
      };
      if (typeof p.task === "string") display = p.task;
      if (typeof p.taskPrompt === "string") prompt = p.taskPrompt;
      if (typeof p.taskId === "string") taskId = p.taskId;
      if (typeof p.subagentTaskText === "string") subagentTaskText = p.subagentTaskText;
    } catch { /* skip malformed */ }
    if (display === null) continue;
    let matchKey = prompt ?? display;
    summaryStream.push({
      id: `user-${taskId ?? row.created_at}`,
      kind: "user",
      text: display,
      at: row.created_at,
    });
    let matchIdx = -1;
    for (let j = 0; j < dialogTurns.length; j++) {
      if (consumed[j]) continue;
      if (dialogTurns[j].userText === matchKey) {
        matchIdx = j;
        break;
      }
    }
    //  — when prompt/display matchKey misses (e.g. manager turns
    // where `saveMessages` prepended `<task-context>` / `<manager-context>`
    // blocks to the raw caller string), fall back to the verbatim persisted
    // text from `subagentTaskText`. Keeps the happy-path matching identical
    // and only triggers when the primary key already failed.
    if (matchIdx === -1 && subagentTaskText !== null && subagentTaskText !== matchKey) {
      matchKey = subagentTaskText;
      for (let j = 0; j < dialogTurns.length; j++) {
        if (consumed[j]) continue;
        if (dialogTurns[j].userText === matchKey) {
          matchIdx = j;
          break;
        }
      }
    }
    const isLastEvent = i === userTaskEvents.length - 1;
    if (matchIdx >= 0) {
      consumed[matchIdx] = true;
      //  — prefer the finalized user-visible reply (which
      // includes truthfulness gate / supplier degradation prepends
      // and the 156g1 ack / 120 pause append) over the SDK message
      // log's raw assistant text. The two are otherwise identical
      // when no warning fired, so this is safe even on quiet rounds.
      // Falls back to the dialogTurns text when no finalized event
      // exists (older rounds before the event was logged, or
      // tool-only turns where finalize was skipped).
      const finalReply = (taskId !== null) ? finalReplyByTaskId.get(taskId) : undefined;
      const rawAt = dialogTurns[matchIdx].assistantText;
      const at = finalReply ?? rawAt;
      if (at !== null && at !== undefined) {
        summaryStream.push({
          id: `assistant-${taskId ?? row.created_at}-${matchIdx}`,
          kind: "assistant",
          text: at,
          // +1 ms keeps AGT immediately after its YOU at sort time.
          at: row.created_at + 1,
        });
        if (isLastEvent) lastEventHadAgt = true;
      }
    }
  }

  // Synthetic anchor — used by both the assistant fallback (2b
  // below) and the interventions block (3). Anchored to the latest
  // of currentTaskObject.updatedAt / lastActionResult.recordedAt.
  // If neither exists AND no reset has happened, fall back to `now`
  // (legacy behavior for fresh DOs). Once reset is in the log,
  // synthetic items only re-emerge after real post-reset activity
  // bumps an anchor.
  const taskAnchor = agentthursdayState.currentTaskObject?.updatedAt ?? 0;
  const actionAnchor = agentthursdayState.lastActionResult?.recordedAt ?? 0;
  const syntheticAnchor = Math.max(taskAnchor, actionAnchor);
  const allowSyntheticFallback = lastResetAt === 0 && syntheticAnchor === 0;
  const syntheticAt = syntheticAnchor > 0
    ? syntheticAnchor
    : allowSyntheticFallback
      ? now
      : null;

  // 2b — fallback for "latest user round has no assistant text yet".
  //      Fires only when the most recent `task.submitted` event
  //      didn't get a non-null `assistantText` from `dialogTurns`
  //      (either no matching turn at all, or the turn was
  //      tool-only). Surfaces `lastActionResult.summary` so the
  //      dialog shows something for the trailing user turn instead
  //      of a blank gap.
  //
  //       had a 2a→2b chain; 153z4a drops the redundant
  //      pre-2a single-AGT push because the turn-aware loop above
  //      already emits the latest assistant from message log when
  //      one exists.
  if (!lastEventHadAgt && userTaskEvents.length > 0) {
    const lar = agentthursdayState.lastActionResult;
    if (lar && lar.summary && lar.recordedAt > lastResetAt) {
      summaryStream.push({
        id: `assistant-action-${lar.recordedAt}`,
        kind: "assistant",
        text: lar.summary,
        at: lar.recordedAt,
      });
    }
  }

  // 2c — REMOVED in .
  //
  // Background: 153z added `loopReview.summary` as a final AGT
  // fallback so flows with no real assistant text would still show
  // an agent line. Production then surfaced the developer-loop
  // preview line `[last msg] …(+N chars)` from
  // `getDeveloperLoopReview()` because that string is embedded
  // inside `loopReview.summary`. operator reviewed and rejected loop
  // previews appearing as AGT body. The dialog should reflect real
  // user / assistant turns, not loop status.
  //
  // Removing 2c means: when `lastAssistantSummary` is empty
  // (assistant produced no readable text yet) and `lastActionResult`
  // is empty/stale, no AGT line is rendered. That's the correct UX
  // — synthetic loop summary text never looks like a real agent
  // reply, and the empty case is what the dialog should show in
  // such states. The intervention block (3) below still surfaces
  // active blockers as `kind:"system"` rows.
  //
  // The defensive filter below provides belt-and-suspenders against
  // any other path that might try to emit a `[last msg]` preview or
  // `…(+N chars)` suffix into `summaryStream`.
  void loopReview;

  // 3) Active interventions only.
  //
  //  — filter `review-gate-blocked` out of the dialog SYS
  // rows. It's a loop-internal "no reviewer-acceptable action recorded
  // yet" signal that's true on every fresh DO and on every round
  // until an action result lands; the user can't act on it directly
  // (they can only submit a task / approve / answer needsHuman, all
  // of which are surfaced by the OTHER intervention kinds when
  // applicable). The raw `approvalPolicy.interventions` array is
  // unchanged — `/cli/status`, `/cli/result`, the inspect / debug
  // surfaces continue to see every kind for diagnostics. Only the
  // user-visible main dialog `summaryStream` skips this one row.
  if (syntheticAt !== null && syntheticAt > lastResetAt) {
    for (const intervention of approvalPolicy.interventions) {
      if (!intervention.active) continue;
      if (intervention.kind === "review-gate-blocked") continue;
      summaryStream.push({
        id: `system-${intervention.kind}`,
        kind: "system",
        text: `[${intervention.kind}] ${intervention.reason}`,
        at: syntheticAt,
      });
    }
  }
  //  — defensive sanitizer. No `summaryStream` item may
  // carry a developer-loop preview line (`[last msg] …`) or a
  // server-side truncation suffix (`…(+N chars)`). Both leaked into
  // production after 's 2c fallback rendered
  // `loopReview.summary` as AGT. We've removed 2c above, but keep
  // this filter as a hard invariant so any future emitter that
  // accidentally embeds a loop preview gets dropped instead of
  // surfaced. Drop, never partially clean — partially-cleaned text
  // would change semantics; an empty dialog is the safer failure.
  for (let idx = summaryStream.length - 1; idx >= 0; idx--) {
    const text = summaryStream[idx].text;
    if (
      DIALOG_PREVIEW_SUFFIX_RE.test(text)
      || DIALOG_LOOP_LAST_MSG_RE.test(text)
    ) {
      summaryStream.splice(idx, 1);
    }
  }

  // Final order: chronological by `at`, oldest at top → newest at bottom.
  summaryStream.sort((a, b) => a.at - b.at);

  let pendingApproval: ApprovalView | null = null;
  if (pendingToolApproval) {
    pendingApproval = {
      id: `tool-${pendingToolApproval.toolCallId}`,
      kind: "tool",
      reason: debugTrace.pendingApprovalReason ?? "Tool call requires human approval",
      toolName: pendingToolApproval.toolName,
      toolCallId: pendingToolApproval.toolCallId,
      createdAt: now,
    };
  } else if (pendingMutations.length > 0) {
    const m = pendingMutations[0];
    pendingApproval = {
      id: `mutation-${m.id}`,
      kind: "mutation",
      reason: `Kanban mutation requires confirmation: ${m.mutation_type}`,
      diffSnippet: `${m.description}\n${m.diff_hint}`.slice(0, 600),
      cardRef: m.card_ref || null,
      mutationId: m.id,
      createdAt: m.created_at,
    };
  }

  let replyNeed: WorkspaceSnapshot["replyNeed"] = null;
  if (agentthursdayState.waitingForHuman && agentthursdayState.pendingHelpRequest) {
    const hr = agentthursdayState.pendingHelpRequest;
    replyNeed = {
      question: `${hr.whyBlocked}\n\nNeeded: ${hr.neededFromHuman}`,
      sinceAt: agentthursdayState.updatedAt,
    };
  }

  let latestResult: ArtifactView | null = null;
  if (deliverableGate.deliverable.readyForReview && deliverableGate.deliverable.resultSummary) {
    latestResult = {
      id: `deliverable-${deliverableGate.deliverable.taskId ?? "current"}`,
      kind: "deliverable",
      title: deliverableGate.deliverable.taskTitle ?? "Deliverable",
      textSummary: deliverableGate.deliverable.resultSummary,
      createdAt: deliverableGate.deliverable.producedAt ?? now,
    };
  } else if (agentthursdayState.lastActionResult) {
    const ar = agentthursdayState.lastActionResult;
    latestResult = {
      id: `actionResult-${ar.recordedAt}`,
      kind: "actionResult",
      title: `${ar.actionType} → ${ar.outcome}`,
      textSummary: ar.summary,
      createdAt: ar.recordedAt,
    };
  }

  const inspectEntry: InspectEntry = {
    hasLadder: !!debugTrace.lastLadderTier,
    hasTrace: eventLogCount > 0,
    hasToolEvents: debugTrace.recentToolEvents.length > 0,
  };

  return { session, currentTask, summaryStream, pendingApproval, replyNeed, latestResult, inspectEntry, activeContextId };
}
