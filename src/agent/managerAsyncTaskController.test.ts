/**
 * async manager message controller tests.
 *
 * Targets `managerAsyncTaskController.ts` directly. The route layer
 * (`managerRoutes.ts`) cannot be imported under `node --import tsx
 * --test` because its `managerOps` import pulls partyserver →
 * cloudflare:workers. The controller is pure and accepts injected
 * registry stubs + spawn/clock factories, mirroring the
 * `managerSkillsetContentFanout` pattern from an earlier revision.
 *
 * Covers spec §"Focused tests":
 *   - async POST returns `received` without awaiting reply
 *   - invalid input does NOT record `manager.task.received`
 *   - missing agent / target_not_found does NOT record nor spawn
 *   - GET status derives over `received/in_progress/replied/failed/unknown`
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  handleAsyncManagerMessage,
  handleManagerTaskStatus,
  handleSyncManagerMessage,
  type AsyncMessageRegistryStub,
  type ReadManagerTaskEventsSurface,
  type SyncInlineResult,
} from "./managerAsyncTaskController";
import {
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";

interface RecordedEvent {
  type: string;
  payload: unknown;
  taskId: string;
}

function makeRegistryStub(
  opts: { targetExists?: boolean; recordThrows?: Error } = {},
): AsyncMessageRegistryStub & { recorded: RecordedEvent[] } {
  const recorded: RecordedEvent[] = [];
  return {
    recorded,
    async readAgentProfile(id) {
      return opts.targetExists === true ? { id } : null;
    },
    async recordManagerTaskEvent(type, payload, taskId) {
      if (opts.recordThrows !== undefined) throw opts.recordThrows;
      recorded.push({ type, payload, taskId });
    },
  };
}

const fixedNow = new Date("2026-05-25T12:00:00.000Z");
const fixedTaskId = "task-fixture-1";

function spawnSpy(): { calls: string[]; deps: { spawnBackground: (id: string) => () => void } } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      spawnBackground: (managerTaskId) => () => {
        calls.push(managerTaskId);
      },
    },
  };
}

describe("handleAsyncManagerMessage", () => {
  it("returns 200 + status:received + accepted_at for valid input on a known target", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "hello" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "accepted");
    if (outcome.kind !== "accepted") return;
    assert.equal(outcome.httpStatus, 200);
    assert.equal(outcome.body.ok, true);
    assert.equal(outcome.body.task_id, fixedTaskId);
    assert.equal(outcome.body.trace_id, fixedTaskId);
    assert.equal(outcome.body.status, "received");
    assert.equal(outcome.body.accepted_at, "2026-05-25T12:00:00.000Z");
    // received event must be recorded BEFORE we fire spawn
    assert.equal(reg.recorded.length, 1);
    assert.equal(reg.recorded[0].type, MANAGER_TASK_EVENT_NAMES.received);
    assert.equal(reg.recorded[0].taskId, fixedTaskId);
    // spawn thunk is returned but not yet executed
    assert.equal(spy.calls.length, 0);
    outcome.spawn();
    assert.deepEqual(spy.calls, [fixedTaskId]);
  });

  it("rejects empty text with 400 invalid_input and does NOT record manager.task.received", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 400);
    assert.equal(outcome.body.error.code, "invalid_input");
    assert.equal(reg.recorded.length, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("rejects empty agent_id with 400 invalid_input and does NOT record manager.task.received", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "", text: "hello" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 400);
    assert.equal(outcome.body.error.code, "invalid_input");
    assert.equal(reg.recorded.length, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("returns 404 agent_not_found for display-name-shaped target and does NOT record received nor spawn background", async () => {
    const reg = makeRegistryStub({ targetExists: false });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-missing", text: "hello" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 404);
    assert.equal(outcome.body.error.code, "agent_not_found");
    assert.equal(reg.recorded.length, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("returns 404 target_not_found for canonical missing agent_id and does NOT record received nor spawn background", async () => {
    const reg = makeRegistryStub({ targetExists: false });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-00000000-0000-4000-8000-000000000000", text: "hello" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 404);
    assert.equal(outcome.body.error.code, "target_not_found");
    assert.equal(reg.recorded.length, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("surfaces conversation_id + source in the received event payload", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const spy = spawnSpy();
    await handleAsyncManagerMessage(
      reg,
      {
        agent_id: "agent-known",
        text: "hello",
        conversation_id: "conv-1",
        source: "ai-tester",
      },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(reg.recorded.length, 1);
    const payload = reg.recorded[0].payload as Record<string, unknown>;
    assert.equal(payload.conversation_id, "conv-1");
    assert.equal(payload.source, "ai-tester");
    assert.equal(payload.agent_id, "agent-known");
    assert.equal(payload.accepted_at, "2026-05-25T12:00:00.000Z");
  });

  it("returns 500 if recordManagerTaskEvent throws synchronously and does NOT spawn background", async () => {
    const reg = makeRegistryStub({
      targetExists: true,
      recordThrows: new Error("event_log offline"),
    });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "hello" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 500);
    assert.equal(outcome.body.error.code, "internal");
    assert.equal(spy.calls.length, 0);
  });
});

describe("handleSyncManagerMessage", () => {
  it("emits received BEFORE invoking runInline (preflight precedes dispatch)", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const inlineOrder: string[] = [];
    const wrappedRecord = reg.recordManagerTaskEvent.bind(reg);
    reg.recordManagerTaskEvent = async (type, payload, taskId) => {
      inlineOrder.push(`record:${type}`);
      await wrappedRecord(type, payload, taskId);
    };
    const outcome = await handleSyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "hello" },
      { mintTaskId: () => fixedTaskId, now: () => fixedNow },
      async (taskId) => {
        inlineOrder.push(`run:${taskId}`);
        return {
          ok: true,
          status: "replied",
          agent_id: "agent-known",
          task_id: "submit-1",
          reply: "ok",
          loop_triggered: true,
        };
      },
    );
    assert.equal(outcome.kind, "inline_completed");
    if (outcome.kind !== "inline_completed") return;
    assert.equal(outcome.managerTaskId, fixedTaskId);
    assert.equal(outcome.acceptedAt, "2026-05-25T12:00:00.000Z");
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.reply, "ok");
    // received must be recorded BEFORE runInline fires
    assert.deepEqual(inlineOrder, [
      `record:${MANAGER_TASK_EVENT_NAMES.received}`,
      `run:${fixedTaskId}`,
    ]);
  });

  it("rejects empty text with 400 invalid_input WITHOUT calling runInline or recording received", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    let inlineCalls = 0;
    const outcome = await handleSyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "" },
      { mintTaskId: () => fixedTaskId, now: () => fixedNow },
      async () => {
        inlineCalls += 1;
        return { ok: false };
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 400);
    assert.equal(outcome.body.error.code, "invalid_input");
    assert.equal(reg.recorded.length, 0);
    assert.equal(inlineCalls, 0);
  });

  it("rejects agent_not_found with 404 WITHOUT calling runInline or recording received for display-name-shaped target", async () => {
    const reg = makeRegistryStub({ targetExists: false });
    let inlineCalls = 0;
    const outcome = await handleSyncManagerMessage(
      reg,
      { agent_id: "agent-missing", text: "hello" },
      { mintTaskId: () => fixedTaskId, now: () => fixedNow },
      async () => {
        inlineCalls += 1;
        return { ok: false };
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 404);
    assert.equal(outcome.body.error.code, "agent_not_found");
    assert.equal(reg.recorded.length, 0);
    assert.equal(inlineCalls, 0);
  });

  it("rejects target_not_found with 404 WITHOUT calling runInline or recording received for canonical missing agent_id", async () => {
    const reg = makeRegistryStub({ targetExists: false });
    let inlineCalls = 0;
    const outcome = await handleSyncManagerMessage(
      reg,
      { agent_id: "agent-00000000-0000-4000-8000-000000000000", text: "hello" },
      { mintTaskId: () => fixedTaskId, now: () => fixedNow },
      async () => {
        inlineCalls += 1;
        return { ok: false };
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 404);
    assert.equal(outcome.body.error.code, "target_not_found");
    assert.equal(reg.recorded.length, 0);
    assert.equal(inlineCalls, 0);
  });

  it("passes through a failure result from runInline as inline_completed (route maps status)", async () => {
    const reg = makeRegistryStub({ targetExists: true });
    const failure: SyncInlineResult = {
      ok: false,
      status: "failed",
      agent_id: "agent-known",
      error: { code: "agent_loop_timeout", message: "loop > 90s" },
    };
    const outcome = await handleSyncManagerMessage(
      reg,
      { agent_id: "agent-known", text: "hello" },
      { mintTaskId: () => fixedTaskId, now: () => fixedNow },
      async () => failure,
    );
    assert.equal(outcome.kind, "inline_completed");
    if (outcome.kind !== "inline_completed") return;
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.error?.code, "agent_loop_timeout");
    // received was still recorded — verifier polling
    // GET /api/manager/tasks/:task_id must see the bracket event
    // even on dispatch failure.
    assert.equal(reg.recorded.length, 1);
    assert.equal(reg.recorded[0].type, MANAGER_TASK_EVENT_NAMES.received);
  });
});

function readerStub(events: ManagerTaskEventRow[]): ReadManagerTaskEventsSurface {
  return {
    async readManagerTaskEvents() {
      return events;
    },
    // stub the new merged-events surface as empty so the
    // pre-372 status tests continue to assert `status` derivation
    // without the side field colliding. an earlier revision's own tests live
    // in `managerTaskMergeReaderOps.test.ts` and the dedicated
    // status-with-merge tests below.
    async readManagerTaskMergedEvents() {
      return [];
    },
    // stub the completion-events surface as empty so
    // pre-378 status tests continue to assert `status` derivation
    // without the side field colliding. an earlier revision's own reader tests
    // live in `managerTaskCompleteReaderOps.test.ts`.
    async readManagerTaskCompletedEvents() {
      return [];
    },
  };
}

describe("handleManagerTaskStatus", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");

  it("returns status:unknown + events:[] + agent_id:null for an unknown task_id", async () => {
    const body = await handleManagerTaskStatus(readerStub([]), "task-bogus", now);
    assert.equal(body.status, "unknown");
    assert.deepEqual(body.events, []);
    assert.equal(body.agent_id, null);
    assert.equal(body.ok, true);
    assert.equal(body.task_id, "task-bogus");
  });

  it("derives status:received and surfaces agent_id from the received event payload", async () => {
    const body = await handleManagerTaskStatus(
      readerStub([
        {
          type: MANAGER_TASK_EVENT_NAMES.received,
          ts: "2026-05-25T11:59:00.000Z",
          payload: { agent_id: "agent-known", task_id: "task-1" },
        },
      ]),
      "task-1",
      now,
    );
    assert.equal(body.status, "received");
    assert.equal(body.agent_id, "agent-known");
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].type, MANAGER_TASK_EVENT_NAMES.received);
  });

  it("derives status:in_progress when received + started events present", async () => {
    const body = await handleManagerTaskStatus(
      readerStub([
        {
          type: MANAGER_TASK_EVENT_NAMES.received,
          ts: "2026-05-25T11:59:00.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.started,
          ts: "2026-05-25T11:59:30.000Z",
          payload: { agent_id: "agent-known" },
        },
      ]),
      "task-1",
      now,
    );
    assert.equal(body.status, "in_progress");
    assert.equal(body.started_at, "2026-05-25T11:59:30.000Z");
  });

  it("derives status:replied + surfaces reply + envelope_id + submit_task_id", async () => {
    const body = await handleManagerTaskStatus(
      readerStub([
        {
          type: MANAGER_TASK_EVENT_NAMES.received,
          ts: "2026-05-25T11:59:00.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.started,
          ts: "2026-05-25T11:59:30.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.replied,
          ts: "2026-05-25T11:59:45.000Z",
          payload: {
            agent_id: "agent-known",
            reply: "ok",
            envelope_id: "env-xyz",
            submit_task_id: "task-inner-9",
          },
        },
      ]),
      "task-1",
      now,
    );
    assert.equal(body.status, "replied");
    assert.equal(body.reply, "ok");
    assert.equal(body.envelope_id, "env-xyz");
    assert.equal(body.submit_task_id, "task-inner-9");
    assert.equal(body.events.length, 3);
    // events[] stays lightweight {type, ts}; no payload leakage.
    for (const ev of body.events) {
      assert.deepEqual(Object.keys(ev).sort(), ["ts", "type"]);
    }
  });

  it("submit_task_id is null for unknown and non-terminal tasks", async () => {
    const unknown = await handleManagerTaskStatus(readerStub([]), "task-bogus", now);
    assert.equal(unknown.submit_task_id, null);

    const inProgress = await handleManagerTaskStatus(
      readerStub([
        {
          type: MANAGER_TASK_EVENT_NAMES.received,
          ts: "2026-05-25T11:59:00.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.started,
          ts: "2026-05-25T11:59:30.000Z",
          payload: { agent_id: "agent-known" },
        },
      ]),
      "task-1",
      now,
    );
    assert.equal(inProgress.status, "in_progress");
    assert.equal(inProgress.submit_task_id, null);
  });

  it("derives status:failed + surfaces error + agent_id", async () => {
    const body = await handleManagerTaskStatus(
      readerStub([
        {
          type: MANAGER_TASK_EVENT_NAMES.received,
          ts: "2026-05-25T11:59:00.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.started,
          ts: "2026-05-25T11:59:30.000Z",
          payload: { agent_id: "agent-known" },
        },
        {
          type: MANAGER_TASK_EVENT_NAMES.failed,
          ts: "2026-05-25T11:59:40.000Z",
          payload: {
            agent_id: "agent-known",
            reason: "internal",
            message: "boom",
            failure_class: "internal",
          },
        },
      ]),
      "task-1",
      now,
    );
    assert.equal(body.status, "failed");
    assert.equal(body.agent_id, "agent-known");
    assert.deepEqual(body.error, {
      reason: "internal",
      message: "boom",
      failure_class: "internal",
    });
  });
});

// merge side field on the status endpoint.
//
// Asserts:
//   - default no-merge side field surfaces `merged: false` + zero counts
//     for unknown / in-progress / replied tasks
//   - presence of `manager.task.merged` rows does NOT change the
//     derived `status` (still `replied` / `in_progress` / `unknown`)
//   - the multi-row latest derives from the newest merge row
//   - malformed merge payload is fail-soft (no throw + null verdict)
describe("handleManagerTaskStatus — an earlier revision merge side field", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");

  function readerStubWithMerges(
    events: ManagerTaskEventRow[],
    mergedRows: ReadonlyArray<{ event_id: number; created_at: string; payload: unknown }>,
  ): ReadManagerTaskEventsSurface {
    return {
      async readManagerTaskEvents() {
        return events;
      },
      async readManagerTaskMergedEvents() {
        return mergedRows.map((r) => ({
          event_id: r.event_id,
          created_at: r.created_at,
          payload: r.payload as never,
        }));
      },
      async readManagerTaskCompletedEvents() {
        return [];
      },
    };
  }

  it("no merge rows → merge side field reports merged:false + zero counts", async () => {
    const body = await handleManagerTaskStatus(readerStubWithMerges([], []), "task-bogus", now);
    assert.equal(body.status, "unknown");
    assert.deepEqual(body.merge, {
      merged: false,
      merge_count: 0,
      latest_verdict: null,
      latest_merged_at: null,
      subagent_count: 0,
    });
  });

  it("merge present on a replied task does NOT change derived status", async () => {
    const body = await handleManagerTaskStatus(
      readerStubWithMerges(
        [
          {
            type: MANAGER_TASK_EVENT_NAMES.received,
            ts: "2026-05-25T11:59:00.000Z",
            payload: { agent_id: "agent-known" },
          },
          {
            type: MANAGER_TASK_EVENT_NAMES.started,
            ts: "2026-05-25T11:59:30.000Z",
            payload: { agent_id: "agent-known" },
          },
          {
            type: MANAGER_TASK_EVENT_NAMES.replied,
            ts: "2026-05-25T11:59:50.000Z",
            payload: {
              agent_id: "agent-known",
              reply: "ok",
              envelope_id: "env-xyz",
              submit_task_id: "task-inner-9",
            },
          },
        ],
        [
          {
            event_id: 201,
            created_at: "2026-05-25T11:59:55.000Z",
            payload: {
              parent_task_id: "task-1",
              manager_agent_id: "agent-known",
              merge_verdict: "success",
              merged_at: "2026-05-25T11:59:55.000Z",
              subagent_task_refs: [
                {
                  task_id: "task-sub-1",
                  agent_id: "agent-sub",
                  summary_id: "task-sub-1",
                  verdict: "success",
                  superseded_by: null,
                },
              ],
            },
          },
        ],
      ),
      "task-1",
      now,
    );
    assert.equal(body.status, "replied");
    assert.equal(body.merge.merged, true);
    assert.equal(body.merge.merge_count, 1);
    assert.equal(body.merge.latest_verdict, "success");
    assert.equal(body.merge.latest_merged_at, "2026-05-25T11:59:55.000Z");
    assert.equal(body.merge.subagent_count, 1);
  });

  it("merge present on an in-progress task does NOT flip status to terminal", async () => {
    const body = await handleManagerTaskStatus(
      readerStubWithMerges(
        [
          {
            type: MANAGER_TASK_EVENT_NAMES.received,
            ts: "2026-05-25T11:59:00.000Z",
            payload: { agent_id: "agent-known" },
          },
          {
            type: MANAGER_TASK_EVENT_NAMES.started,
            ts: "2026-05-25T11:59:30.000Z",
            payload: { agent_id: "agent-known" },
          },
        ],
        [
          {
            event_id: 201,
            created_at: "2026-05-25T11:59:45.000Z",
            payload: {
              parent_task_id: "task-1",
              manager_agent_id: "agent-known",
              merge_verdict: "partial",
              merged_at: "2026-05-25T11:59:45.000Z",
              subagent_task_refs: [],
            },
          },
        ],
      ),
      "task-1",
      now,
    );
    assert.equal(body.status, "in_progress");
    assert.equal(body.merge.merged, true);
    assert.equal(body.merge.latest_verdict, "partial");
  });

  it("multi-row latest derives from the newest merge row", async () => {
    const body = await handleManagerTaskStatus(
      readerStubWithMerges(
        [
          {
            type: MANAGER_TASK_EVENT_NAMES.received,
            ts: "2026-05-25T11:59:00.000Z",
            payload: { agent_id: "agent-known" },
          },
        ],
        [
          {
            event_id: 201,
            created_at: "2026-05-25T11:59:30.000Z",
            payload: {
              parent_task_id: "task-1",
              manager_agent_id: "agent-known",
              merge_verdict: "partial",
              merged_at: "2026-05-25T11:59:30.000Z",
              subagent_task_refs: [
                { task_id: "task-sub-1", agent_id: "agent-sub", summary_id: "task-sub-1", verdict: "success", superseded_by: null },
              ],
            },
          },
          {
            event_id: 202,
            created_at: "2026-05-25T11:59:45.000Z",
            payload: {
              parent_task_id: "task-1",
              manager_agent_id: "agent-known",
              merge_verdict: "success",
              merged_at: "2026-05-25T11:59:45.000Z",
              subagent_task_refs: [
                { task_id: "task-sub-1", agent_id: "agent-sub", summary_id: "task-sub-1", verdict: "success", superseded_by: null },
                { task_id: "task-sub-2", agent_id: "agent-sub", summary_id: "task-sub-2", verdict: "success", superseded_by: null },
              ],
            },
          },
        ],
      ),
      "task-1",
      now,
    );
    assert.equal(body.merge.merge_count, 2);
    assert.equal(body.merge.latest_verdict, "success");
    assert.equal(body.merge.latest_merged_at, "2026-05-25T11:59:45.000Z");
    assert.equal(body.merge.subagent_count, 2);
  });

  it("malformed merge payload (null) is fail-soft + status unchanged", async () => {
    const body = await handleManagerTaskStatus(
      readerStubWithMerges(
        [
          {
            type: MANAGER_TASK_EVENT_NAMES.received,
            ts: "2026-05-25T11:59:00.000Z",
            payload: { agent_id: "agent-known" },
          },
        ],
        [
          {
            event_id: 201,
            created_at: "2026-05-25T11:59:30.000Z",
            payload: null,
          },
        ],
      ),
      "task-1",
      now,
    );
    assert.equal(body.status, "received");
    assert.equal(body.merge.merged, true);
    assert.equal(body.merge.merge_count, 1);
    assert.equal(body.merge.latest_verdict, null);
    assert.equal(body.merge.latest_merged_at, "2026-05-25T11:59:30.000Z");
    assert.equal(body.merge.subagent_count, 0);
  });
});

// ── manager message dispatch ownership (leak assertions) ───────
function makeOwnerScopedRegistry(
  owners: Record<string, string>,
): AsyncMessageRegistryStub & { recorded: RecordedEvent[] } {
  const recorded: RecordedEvent[] = [];
  return {
    recorded,
    async readAgentProfile(id, identity) {
      const owner = owners[id];
      if (owner === undefined) return null;
      if (!identity || identity.kind === "admin") return { id };
      return identity.userId === owner ? { id } : null;
    },
    async recordManagerTaskEvent(type, payload, taskId) {
      recorded.push({ type, payload, taskId });
    },
  };
}

describe("manager message dispatch ownership", () => {
  const BOB_AGENT = "agent-11111111-1111-1111-1111-111111111111";

  it("cross-tenant message is rejected (404, no received event, no spawn)", async () => {
    const reg = makeOwnerScopedRegistry({ [BOB_AGENT]: "user-bob" });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: BOB_AGENT, text: "hi" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
        identity: { kind: "user", userId: "user-alice" },
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.httpStatus, 404);
    assert.equal(outcome.body.error.code, "target_not_found");
    assert.equal(reg.recorded.length, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("owner can message their own agent (accepted)", async () => {
    const reg = makeOwnerScopedRegistry({ [BOB_AGENT]: "user-bob" });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: BOB_AGENT, text: "hi" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
        identity: { kind: "user", userId: "user-bob" },
      },
    );
    assert.equal(outcome.kind, "accepted");
  });

  it("admin can message any tenant's agent (accepted)", async () => {
    const reg = makeOwnerScopedRegistry({ [BOB_AGENT]: "user-bob" });
    const spy = spawnSpy();
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: BOB_AGENT, text: "hi" },
      {
        mintTaskId: () => fixedTaskId,
        now: () => fixedNow,
        spawnBackground: spy.deps.spawnBackground,
        identity: { kind: "admin" },
      },
    );
    assert.equal(outcome.kind, "accepted");
  });
});
