/**
 *  — pure controller for the async / sync manager message +
 * status routes.
 *
 * Lives in its own module so the test suite can `node --import tsx
 * --test` it without importing `managerOps.ts` (which pulls
 * `getAgentByName from "agents"` → `partyserver` →
 * `cloudflare:workers`). `managerRoutes.ts` calls the same controllers
 * but injects real registry stubs + a `ctx.waitUntil`-backed spawn,
 * and (for the sync path) a `runInline` thunk that awaits
 * `runManagerTaskBackground` directly.
 *
 * Scope: validation + target-existence check + `manager.task.received`
 * emission + spawn / inline-run decision for the message route; status
 * derivation for the GET route. The actual `runManagerTaskBackground`
 * body still lives in `managerOps.ts` because it must call
 * `managerSendAgentMessage`.
 *
 * The controllers return plain `{ status, body }` envelopes rather
 * than `Response` instances so they are trivially assertable.
 *
 * Sync vs async share the same preflight (`preflightManagerMessage`)
 * so both emit `manager.task.received` BEFORE dispatch — that is the
 * spec §"sync mode 仍记录相同 bracket events" invariant.
 */
import {
  deriveManagerTaskStatus,
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";
import {
  deriveMergeSideField,
  type ManagerTaskMergedRow,
  type MergeStatusSideField,
} from "./managerTaskMergeReaderOps";
import {
  deriveCompletionSideField,
  type ManagerTaskCompletedRow,
  type CompletionStatusSideField,
} from "./managerTaskCompleteReaderOps";
import { TaskContextSchema, type TaskContext } from "./taskContext";
import { looksLikeAgentId } from "./managerAgentIdShape";

export interface AsyncMessageRegistryStub {
  readAgentProfile(id: string): Promise<{ id: string } | null>;
  recordManagerTaskEvent(
    type: string,
    payload: unknown,
    taskId: string,
  ): Promise<void> | void;
}

export interface AsyncMessageInput {
  agent_id: string;
  text: string;
  conversation_id?: string;
  source?: string;
  //  — optional structured TaskContext (ADR §5). Validated in
  // preflight BEFORE any `manager.task.received` event is recorded.
  task_context?: TaskContext;
}

export type PreflightRejected = {
  kind: "rejected";
  httpStatus: number;
  body: {
    ok: false;
    status: "failed";
    agent_id: string;
    error: { code: string; message: string };
  };
};

export type PreflightAccepted = {
  kind: "accepted";
  managerTaskId: string;
  acceptedAt: string;
};

/**
 * Shared preflight: validate → target_not_found → mint task_id → emit
 * `manager.task.received`. Both the async path (which then returns
 * 200 + spawn) and the sync path (which then awaits the inline run)
 * call this first so the `received` event is in event_log BEFORE any
 * dispatch attempt. This is the spec invariant — sync mode still
 * records bracket events.
 */
async function preflightManagerMessage(
  registry: AsyncMessageRegistryStub,
  input: AsyncMessageInput,
  deps: { mintTaskId: () => string; now: () => Date },
): Promise<PreflightRejected | PreflightAccepted> {
  if (typeof input.agent_id !== "string" || input.agent_id.length === 0) {
    return {
      kind: "rejected",
      httpStatus: 400,
      body: {
        ok: false,
        status: "failed",
        agent_id: "",
        error: { code: "invalid_input", message: "agent_id is required" },
      },
    };
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    return {
      kind: "rejected",
      httpStatus: 400,
      body: {
        ok: false,
        status: "failed",
        agent_id: input.agent_id,
        error: {
          code: "invalid_input",
          message: "text is required and must be non-empty",
        },
      },
    };
  }
  //  — validate optional task_context BEFORE recording the
  // received bracket event. Reject with field hint per Req §2.
  if (input.task_context !== undefined) {
    const parsed = TaskContextSchema.safeParse(input.task_context);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue && issue.path.length > 0 ? issue.path.join(".") : "task_context";
      const reason = issue ? issue.message : "invalid";
      return {
        kind: "rejected",
        httpStatus: 400,
        body: {
          ok: false,
          status: "failed",
          agent_id: input.agent_id,
          error: {
            code: "invalid_input",
            message: `task_context.${field}: ${reason}`,
          },
        },
      };
    }
  }
  const target = await registry.readAgentProfile(input.agent_id);
  if (target === null) {
    //  D — split missing-target on shape. Display-name-shaped
    // inputs (no `agent-<uuid>` prefix) surface as `agent_not_found`
    // so the manager LLM gets a clearer signal it skipped
    // `manager.agent_list` resolution. Correctly-shaped but missing
    // ids stay on the existing `target_not_found`.
    const code = looksLikeAgentId(input.agent_id) ? "target_not_found" : "agent_not_found";
    const message = code === "agent_not_found"
      ? `agent_id '${input.agent_id}' does not match the canonical 'agent-<uuid>' shape; pass the real agent_id, not a display name`
      : `no agent registered with agent_id: ${input.agent_id}`;
    return {
      kind: "rejected",
      httpStatus: 404,
      body: {
        ok: false,
        status: "failed",
        agent_id: input.agent_id,
        error: { code, message },
      },
    };
  }

  const managerTaskId = deps.mintTaskId();
  const acceptedAt = deps.now().toISOString();

  try {
    await registry.recordManagerTaskEvent(
      MANAGER_TASK_EVENT_NAMES.received,
      {
        task_id: managerTaskId,
        agent_id: input.agent_id,
        accepted_at: acceptedAt,
        source: input.source,
        ...(input.conversation_id !== undefined
          ? { conversation_id: input.conversation_id }
          : {}),
        //  — record full structured task_context on received
        // bracket event so inspect/event payloads expose it.
        ...(input.task_context !== undefined
          ? { task_context: input.task_context }
          : {}),
      },
      managerTaskId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      kind: "rejected",
      httpStatus: 500,
      body: {
        ok: false,
        status: "failed",
        agent_id: input.agent_id,
        error: {
          code: "internal",
          message: `failed to record task: ${message}`,
        },
      },
    };
  }

  return { kind: "accepted", managerTaskId, acceptedAt };
}

export type AsyncMessageOutcome =
  | PreflightRejected
  | {
      kind: "accepted";
      httpStatus: 200;
      body: {
        ok: true;
        task_id: string;
        status: "received";
        trace_id: string;
        accepted_at: string;
      };
      spawn: () => void;
    };

/**
 * Async-default message handler.
 *
 * After the shared preflight emits `manager.task.received`, returns
 * 200 + a `spawn` thunk for the caller to wire to `ctx.waitUntil`. We
 * do NOT call `runManagerTaskBackground` ourselves because the spawn
 * lifecycle is owned by the route layer (waitUntil vs fire-and-forget
 * in tests).
 */
export async function handleAsyncManagerMessage(
  registry: AsyncMessageRegistryStub,
  input: AsyncMessageInput,
  deps: {
    mintTaskId: () => string;
    now: () => Date;
    spawnBackground: (managerTaskId: string) => () => void;
  },
): Promise<AsyncMessageOutcome> {
  const pre = await preflightManagerMessage(registry, input, deps);
  if (pre.kind === "rejected") return pre;
  return {
    kind: "accepted",
    httpStatus: 200,
    body: {
      ok: true,
      task_id: pre.managerTaskId,
      status: "received",
      trace_id: pre.managerTaskId,
      accepted_at: pre.acceptedAt,
    },
    spawn: deps.spawnBackground(pre.managerTaskId),
  };
}

/**
 * Result shape returned by `runInline` — minimal projection of
 * `ManagerAgentMessageResult` from `managerOps.ts`. We keep this
 * loose (`Record<string, unknown>`-friendly) so the controller test
 * stays decoupled from the managerOps surface.
 */
export interface SyncInlineResult {
  ok: boolean;
  status?: string;
  agent_id?: string;
  task_id?: string;
  conversation_id?: string;
  envelope_id?: string;
  reply?: string;
  loop_triggered?: boolean;
  error?: { code: string; message: string };
}

export type SyncMessageOutcome =
  | PreflightRejected
  | {
      kind: "inline_completed";
      managerTaskId: string;
      acceptedAt: string;
      result: SyncInlineResult;
    };

/**
 * Sync (debug) message handler.
 *
 * Same preflight as async (so the `manager.task.received` bracket
 * event lands BEFORE any dispatch), then awaits `runInline` —
 * production wires this to `runManagerTaskBackground(env, input,
 * managerTaskId)` so the same `started` / `replied` / `failed`
 * bracket events fire on the inline path too. The route layer maps
 * the returned `result` to an HTTP status by inspecting
 * `result.ok` / `result.error.code` (same mapping it already uses
 * for the pre- sync path).
 */
export async function handleSyncManagerMessage(
  registry: AsyncMessageRegistryStub,
  input: AsyncMessageInput,
  deps: { mintTaskId: () => string; now: () => Date },
  runInline: (managerTaskId: string) => Promise<SyncInlineResult>,
): Promise<SyncMessageOutcome> {
  const pre = await preflightManagerMessage(registry, input, deps);
  if (pre.kind === "rejected") return pre;
  const result = await runInline(pre.managerTaskId);
  return {
    kind: "inline_completed",
    managerTaskId: pre.managerTaskId,
    acceptedAt: pre.acceptedAt,
    result,
  };
}

export interface ReadManagerTaskEventsSurface {
  readManagerTaskEvents(taskId: string): Promise<ManagerTaskEventRow[]>;
  //  — additive read surface for the `merge` side field on
  // GET /api/manager/tasks/:task_id. Empty array when no merge rows
  // exist; the derived side field then reports `merged: false`.
  readManagerTaskMergedEvents(
    parentTaskId: string,
  ): Promise<ManagerTaskMergedRow[]>;
  //  — additive read surface for the `completion` side field
  // on GET /api/manager/tasks/:task_id. Empty array when no
  // completion rows exist; the derived side field then reports
  // `completed: false`. Completion is report/archive evidence, NOT
  // a lifecycle terminal — `status` is derived independently.
  readManagerTaskCompletedEvents(
    parentTaskId: string,
  ): Promise<ManagerTaskCompletedRow[]>;
}

export interface TaskStatusBody {
  ok: true;
  task_id: string;
  agent_id: string | null;
  status: ReturnType<typeof deriveManagerTaskStatus>["status"];
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  reply: string | null;
  envelope_id: string | null;
  //  — inner per-agent task id (from the
  // `manager.task.replied` event payload); `null` for unknown /
  // non-terminal / failed manager tasks.
  submit_task_id: string | null;
  error: ReturnType<typeof deriveManagerTaskStatus>["error"];
  events: Array<{ type: string; ts: string }>;
  //  §3 — bounded merge side field. Always present (never
  // null) so frontend consumers see a stable shape; `merged: false`
  // when no `manager.task.merged` rows exist for this task_id.
  // Documented contract in ``.
  merge: MergeStatusSideField;
  //  — additive evidence. `{ has_conflict: false }` when the
  // task had at most one terminal class and no contradicting follow-up.
  // When `has_conflict: true`, includes `terminal_status` (the first
  // terminal that landed), `later_events` (types of events that
  // followed it and contradict it), and a human-readable `message`.
  terminal_conflict: ReturnType<
    typeof deriveManagerTaskStatus
  >["terminal_conflict"];
  //  — additive stale warning. `{ stale: false }` for fresh /
  // terminal tasks. `stale: true` when a started-without-terminal task
  // has passed the soft window; primary `status` stays `in_progress`
  // until the hard ceiling (then `status` becomes `timed_out` with
  // `stale: true`). Lets the UI show "still running, a while now"
  // without prematurely rendering a terminal `timed_out`.
  stale_warning: ReturnType<
    typeof deriveManagerTaskStatus
  >["stale_warning"];
  //  — additive completion side field. Always present (never
  // null) so consumers see a stable shape; `completed: false` when no
  // `manager.task.completed` rows exist. Coexists with `merge` and
  // `status`; completion is report/archive evidence, NOT a lifecycle
  // terminal — `replied` / `failed` remain the terminal classes.
  completion: CompletionStatusSideField;
}

export async function handleManagerTaskStatus(
  registry: ReadManagerTaskEventsSurface,
  taskId: string,
  now: Date,
): Promise<TaskStatusBody> {
  const [events, mergedRows, completedRows] = await Promise.all([
    registry.readManagerTaskEvents(taskId),
    registry.readManagerTaskMergedEvents(taskId),
    registry.readManagerTaskCompletedEvents(taskId),
  ]);
  const derived = deriveManagerTaskStatus(events, now);
  let agentId: string | null = null;
  for (const ev of events) {
    const p = ev.payload;
    if (p !== null && p !== undefined && typeof p.agent_id === "string") {
      agentId = p.agent_id;
      break;
    }
  }
  return {
    ok: true,
    task_id: taskId,
    agent_id: agentId,
    status: derived.status,
    accepted_at: derived.accepted_at,
    started_at: derived.started_at,
    completed_at: derived.completed_at,
    reply: derived.reply,
    envelope_id: derived.envelope_id,
    submit_task_id: derived.submit_task_id,
    error: derived.error,
    events: events.map((e) => ({ type: e.type, ts: e.ts })),
    merge: deriveMergeSideField(mergedRows),
    terminal_conflict: derived.terminal_conflict,
    stale_warning: derived.stale_warning,
    completion: deriveCompletionSideField(completedRows),
  };
}
