import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import {
  WorkspaceSnapshotSchema,
  WorkspaceFileListSchema,
  WorkspaceFileContentSchema,
} from "../schema";
import { buildWorkspaceSnapshot } from "../workspaceSnapshot";
import type { AgentThursdayAgent } from "../server";

/**
 *  — `/api/workspace*` routes extracted from `server.ts`.
 *
 * Each handler is the verbatim body of the original `server.ts`
 * branch, lifted into its own function. Behavior preserved:
 *   - Same `Promise.all` ordering and destructure.
 *   - Same `WorkspaceSnapshotSchema.parse(...)` boundary validation.
 *   - Same `workspaceFileError` mapping (private to this module —
 *     2 callers, both moved here).
 *
 * DI signature: the composition root in `server.ts` resolves the
 * canonical-active stub (and the registry stub when needed) and
 * passes them in. Keeps `getCanonicalActiveAgentThursdayAgentStub` /
 * `DEMO_INSTANCE` out of the route module's import graph and
 * preserves the rule that `server.ts` only exports DO classes +
 * the default fetch handler ( v2 runtime fix).
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts`. Handlers
 * never re-check.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

// map workspace file errors to HTTP shapes the web client knows.
// Pattern-match by message because errors thrown inside @callable() DO methods
// lose their JS class identity when serialized across the RPC boundary; the
// stable contract is the `path:*` / `file:*` message prefixes set in
// src/workspaceFiles.ts.
function workspaceFileError(e: unknown): Response {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("path:null-byte"))   return json({ code: "path.null-byte" }, 400);
  if (msg.includes("path:backslash"))   return json({ code: "path.backslash" }, 400);
  if (msg.includes("path:absolute"))    return json({ code: "path.absolute" }, 400);
  if (msg.includes("path:traversal"))   return json({ code: "path.traversal" }, 400);
  if (msg.includes("path:hidden"))      return json({ code: "path.hidden" }, 403);
  if (msg.includes("file:not-found"))   return json({ code: "file.not-found" }, 404);
  if (msg.includes("file:is-dir"))      return json({ code: "file.is-dir" }, 400);
  if (msg.includes("file:binary"))      return json({ code: "file.binary" }, 415);
  return json({ code: "internal", message: msg }, 500);
}

export async function handleApiWorkspace(
  stub: AgentThursdayAgentStub,
  registry: AgentThursdayAgentStub,
): Promise<Response> {
  //  — route the message-bearing fields of the workspace
  // snapshot through the active context DO so `new context` /
  // `reset` visibly clears or switches the dialog after refresh.
  //
  //  — when the request lacks `X-AgentThursday-Context-Id`,
  // resolve the canonical active context via the registry pointer
  // instead of falling back to DEMO_INSTANCE. This is what makes
  // a fresh-cache browser / Discord / cron request follow the
  // current single active session rather than the bootstrap DO.
  // Whatever DO ends up routed, the response also carries
  // `activeContextId` so the client can reconcile its local cache
  // and switch surfaces if the canonical pointer has moved.
  //
  // Per-context: cliSession, debugTrace, eventLog (drives
  // summaryStream), agentthursdayState (waitingForHuman / pendingHelpRequest
  // → replyNeed), loopReview.summary, approvalPolicy.interventions,
  // pendingToolApproval, deliverableGate, pendingMutations
  // (kanban mutations are recorded on the DO that produced them).
  // Registry/global concerns (model profile gateway, intelligence
  // signal cache) live elsewhere and are not part of this snapshot.
  const [agentthursdayState, cliSession, loopReview, approvalPolicy, pendingToolApproval, debugTrace, deliverableGate, pendingMutations, eventLog, lastResetAt, canonicalActive, dialogTurns, taskSubmittedEvents, taskReplyFinalizedEvents] = await Promise.all([
    stub.getStatus(),
    stub.getCliSession(),
    stub.getDeveloperLoopReview(),
    stub.getApprovalPolicy(),
    stub.getPendingToolApproval(),
    stub.getDebugTrace(),
    stub.getDeliverableGate(),
    stub.getPendingKanbanMutations(),
    stub.getEventLog(),
    //  — separate query because getEventLog caps at 20 rows.
    stub.getLastResetAt(),
    //  — canonical active pointer for client reconcile.
    registry.getActiveContextId(),
    //  — turn-aware dialog history. Each entry pairs
    // a user message's text with the assistant text that
    // followed it (or null if tool-only). `buildWorkspaceSnapshot`
    // matches each `task.submitted` event to a turn by
    // `userText`, so old assistants from prior rounds can never
    // be misattributed to a newer user (the 153z4 v1 bug).
    //  — bumped from 30 → 60 turns so desktop dialog
    // can show a long enough history to align with the 60-row
    // taskSubmittedEvents window below.
    stub.getDialogTurns(60),
    //  — independent `task.submitted` window (60 newest)
    // so the desktop summaryStream isn't capped at ~4 turns when
    // event_log is dominated by agent.woken / tool.* / channel
    // ack noise. Mobile collapses client-side regardless of length.
    stub.getRecentTaskSubmittedEvents(60),
    //  — independent `task.reply.finalized` window (60
    // newest) so `summaryStream` can prefer the warning-bearing
    // user-visible reply over the SDK message log's raw text.
    stub.getRecentFinalizedReplyEvents(60),
  ]);
  const snapshot = buildWorkspaceSnapshot({
    agentthursdayState,
    cliSession,
    loopReview,
    approvalPolicy,
    pendingToolApproval,
    debugTrace,
    deliverableGate,
    pendingMutations,
    eventLog,
    lastResetAt,
    activeContextId: canonicalActive.contextId,
    dialogTurns,
    taskSubmittedEvents,
    taskReplyFinalizedEvents,
  });
  // Validate at the boundary so legacy field drift is caught early.
  return json(WorkspaceSnapshotSchema.parse(snapshot));
}

export async function handleApiWorkspaceFiles(
  stub: AgentThursdayAgentStub,
  searchParams: URLSearchParams,
): Promise<Response> {
  //  — route through canonical active context so the
  // workspace file listing reflects the same DO that the agent's
  // own write/list/read tools mutate. Previously hardcoded to
  // DEMO_INSTANCE: the agent wrote files into its active context
  // DO while operators inspecting via this endpoint listed an
  // unrelated registry/bootstrap DO and saw zero files
  // (the 156l miss that surfaced when operator &  couldn't find
  // hermes-vs-agentthursday-comparison.md).
  try {
    const list = await stub.listWorkspaceFiles(searchParams.get("path"));
    return json(WorkspaceFileListSchema.parse(list));
  } catch (e) {
    return workspaceFileError(e);
  }
}

export async function handleApiWorkspaceFile(
  stub: AgentThursdayAgentStub,
  searchParams: URLSearchParams,
): Promise<Response> {
  //  — same fix as /api/workspace/files: read from the
  // canonical active DO so the file content matches what the
  // agent actually wrote.
  try {
    const content = await stub.readWorkspaceFileText(searchParams.get("path"));
    return json(WorkspaceFileContentSchema.parse(content));
  } catch (e) {
    return workspaceFileError(e);
  }
}
