/**
 * tests for `runManagerTaskBackgroundPure`.
 *
 * Targets the pure dispatch helper, NOT the DO callable. The whole
 * point of 359a is that the terminal `manager.task.replied` event is
 * now recorded INSIDE the DO `submitManagerTask` callable — which
 * cannot be unit-tested here (would need a CF DO test harness; we
 * rely on prod smoke for that, as the card spec requires).
 *
 * What we CAN assert at this layer:
 *   - worker emits `manager.task.started` BEFORE invoking the perAgent.
 *   - `target_not_found` shortcircuits BEFORE touching the perAgent
 *     and records a worker-side `manager.task.failed` (failure_class
 *     `target_not_found`).
 *   - happy path: perAgent.submitManagerTask is called with the right
 *     args, and the worker does NOT double-emit `manager.task.replied`
 *     (the DO is responsible for that).
 *   - perAgent throw with a timeout-shaped message is classified
 *     `agent_loop_timeout` (an earlier revision contract preservation).
 *   - perAgent throw with a generic message is classified `internal`.
 *
 * Pure node:test — no `agents` / `partyserver` / `cloudflare:workers`
 * import chain. Mirrors the `managerAsyncTaskController.test.ts` pattern.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  runManagerTaskBackgroundPure,
  MANAGER_TASK_EVENT_STARTED,
  MANAGER_TASK_EVENT_FAILED,
  type ManagerTaskBackgroundRegistry,
  type ManagerTaskBackgroundPerAgent,
} from "./managerTaskBackgroundPure";

type EventCall = { type: string; payload: unknown; taskId: string };
type PerAgentCall = {
  text: string;
  managerTaskId: string;
  opts?: { source?: string; conversationId?: string; displayText?: string };
};

function makeRegistry(
  profile: { id: string } | null,
): {
  stub: ManagerTaskBackgroundRegistry;
  events: EventCall[];
  profileReads: string[];
} {
  const events: EventCall[] = [];
  const profileReads: string[] = [];
  return {
    events,
    profileReads,
    stub: {
      async readAgentProfile(id: string) {
        profileReads.push(id);
        return profile;
      },
      async recordManagerTaskEvent(type, payload, taskId) {
        events.push({ type, payload, taskId });
      },
    },
  };
}

function makePerAgent(
  behavior:
    | {
        kind: "ok";
        result: {
          ok: boolean;
          taskId: string;
          loopTriggered: boolean;
          replyText: string;
          envelopeId: string | null;
        };
      }
    | { kind: "throw"; error: Error },
): { stub: ManagerTaskBackgroundPerAgent; calls: PerAgentCall[] } {
  const calls: PerAgentCall[] = [];
  return {
    calls,
    stub: {
      async submitManagerTask(text, managerTaskId, opts) {
        calls.push({ text, managerTaskId, opts });
        if (behavior.kind === "throw") throw behavior.error;
        return behavior.result;
      },
    },
  };
}

describe("runManagerTaskBackgroundPure — success path ", () => {
  it("emits started, invokes submitManagerTask, does NOT double-emit replied", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const per = makePerAgent({
      kind: "ok",
      result: {
        ok: true,
        taskId: "task-mpkn-inner",
        loopTriggered: true,
        replyText: "hello",
        envelopeId: "env-mpkn-x",
      },
    });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-X", text: "ping", source: "smoke" },
      "task-outer-1",
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "replied");
      assert.equal(result.task_id, "task-mpkn-inner");
      assert.equal(result.envelope_id, "env-mpkn-x");
      assert.equal(result.reply, "hello");
      assert.equal(result.loop_triggered, true);
    }

    // Worker emits only `started` on the success path; terminal
    // `manager.task.replied` is the DO's job inside submitManagerTask.
    const types = reg.events.map((e) => e.type);
    assert.deepEqual(types, [MANAGER_TASK_EVENT_STARTED]);

    assert.equal(per.calls.length, 1);
    assert.equal(per.calls[0].text, "ping");
    assert.equal(per.calls[0].managerTaskId, "task-outer-1");
    assert.equal(per.calls[0].opts?.source, "smoke");
  });

  it("status maps to 'accepted' when loopTriggered is false", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const per = makePerAgent({
      kind: "ok",
      result: {
        ok: true,
        taskId: "task-no-loop",
        loopTriggered: false,
        replyText: "",
        envelopeId: null,
      },
    });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-X", text: "noop" },
      "task-outer-2",
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "accepted");
      assert.equal(result.envelope_id, undefined);
      assert.equal(result.reply, undefined);
    }
  });

  it("passes conversation_id through to the perAgent opts", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const per = makePerAgent({
      kind: "ok",
      result: {
        ok: true,
        taskId: "t",
        loopTriggered: true,
        replyText: "r",
        envelopeId: "e",
      },
    });
    await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-X", text: "ping", conversation_id: "conv-7" },
      "task-3",
    );
    assert.equal(per.calls[0].opts?.conversationId, "conv-7");
  });
});

describe("runManagerTaskBackgroundPure — target_not_found", () => {
  it("emits failed worker-side and never touches perAgent", async () => {
    const reg = makeRegistry(null);
    const per = makePerAgent({
      kind: "ok",
      result: {
        ok: true,
        taskId: "t",
        loopTriggered: true,
        replyText: "r",
        envelopeId: null,
      },
    });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-missing", text: "ping" },
      "task-tnf",
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "target_not_found");
      assert.match(result.error.message, /no agent registered/);
    }
    assert.deepEqual(reg.profileReads, ["agent-missing"]);
    assert.equal(per.calls.length, 0);

    const types = reg.events.map((e) => e.type);
    assert.deepEqual(types, [MANAGER_TASK_EVENT_STARTED, MANAGER_TASK_EVENT_FAILED]);
    const failed = reg.events[1];
    const payload = failed.payload as Record<string, unknown>;
    assert.equal(payload.failure_class, "target_not_found");
    assert.equal(payload.reason, "target_not_found");
  });
});

describe("runManagerTaskBackgroundPure — perAgent throws", () => {
  it("classifies timeout-shaped error as agent_loop_timeout", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const per = makePerAgent({
      kind: "throw",
      error: new Error("DO RPC envelope timeout exceeded after 90s"),
    });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-X", text: "slow" },
      "task-timeout",
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "agent_loop_timeout");
    }

    const types = reg.events.map((e) => e.type);
    assert.deepEqual(types, [MANAGER_TASK_EVENT_STARTED, MANAGER_TASK_EVENT_FAILED]);
    const payload = reg.events[1].payload as Record<string, unknown>;
    assert.equal(payload.failure_class, "agent_loop_timeout");
    assert.equal(payload.reason, "agent_loop_timeout");
  });

  it("classifies generic throw as internal", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const per = makePerAgent({
      kind: "throw",
      error: new Error("kv store unavailable"),
    });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => per.stub,
      { agent_id: "agent-X", text: "x" },
      "task-internal",
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "internal");
    }

    const types = reg.events.map((e) => e.type);
    assert.deepEqual(types, [MANAGER_TASK_EVENT_STARTED, MANAGER_TASK_EVENT_FAILED]);
    const payload = reg.events[1].payload as Record<string, unknown>;
    assert.equal(payload.failure_class, "internal");
    assert.equal(payload.message, "kv store unavailable");
  });

  it("getPerAgent factory throw is treated like a perAgent throw (internal)", async () => {
    const reg = makeRegistry({ id: "agent-X" });
    const result = await runManagerTaskBackgroundPure(
      reg.stub,
      async () => {
        throw new Error("resolvePerAgent failed");
      },
      { agent_id: "agent-X", text: "x" },
      "task-resolve-fail",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "internal");
    }
    const types = reg.events.map((e) => e.type);
    assert.deepEqual(types, [MANAGER_TASK_EVENT_STARTED, MANAGER_TASK_EVENT_FAILED]);
  });
});

describe("runManagerTaskBackgroundPure — fail-soft logging", () => {
  it("started-event record failure does NOT prevent dispatch", async () => {
    const events: EventCall[] = [];
    let recordCallCount = 0;
    const reg: ManagerTaskBackgroundRegistry = {
      async readAgentProfile() {
        return { id: "agent-X" };
      },
      async recordManagerTaskEvent(type, payload, taskId) {
        recordCallCount += 1;
        if (type === MANAGER_TASK_EVENT_STARTED) {
          throw new Error("started write failed");
        }
        events.push({ type, payload, taskId });
      },
    };
    const per = makePerAgent({
      kind: "ok",
      result: {
        ok: true,
        taskId: "t",
        loopTriggered: true,
        replyText: "r",
        envelopeId: "e",
      },
    });
    const result = await runManagerTaskBackgroundPure(
      reg,
      async () => per.stub,
      { agent_id: "agent-X", text: "ping" },
      "task-startedfail",
    );
    assert.equal(result.ok, true);
    assert.equal(per.calls.length, 1);
    assert.ok(recordCallCount >= 1);
  });
});
