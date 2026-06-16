/**
 *  — TaskContext schema + render helper + preflight wiring tests.
 *
 * Two layers:
 *   1. Pure schema (`TaskContextSchema`) — ADR §5.1 required fields,
 *      length limits, nested ArtifactRefSchema, accept/reject cases.
 *   2. `renderTaskContextBlock` — produces a `<task-context>` block
 *      with pretty-printed JSON (preserving order).
 *   3. Preflight integration via `handleAsyncManagerMessage` —
 *      invalid task_context rejects BEFORE `manager.task.received`
 *      lands (Req §2); valid task_context propagates verbatim into
 *      the received-event payload.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  ArtifactRefSchema,
  TaskContextSchema,
  renderTaskContextBlock,
  renderTaskContextBlockPreview,
  type TaskContext,
} from "./taskContext";
import {
  handleAsyncManagerMessage,
  type AsyncMessageRegistryStub,
} from "./managerAsyncTaskController";
import { MANAGER_TASK_EVENT_NAMES } from "./managerTaskStatus";

const FIXED_TASK_ID = "task-fixture-361";
const FIXED_NOW = new Date("2026-05-25T13:00:00.000Z");

interface Recorded {
  type: string;
  payload: unknown;
  taskId: string;
}

function makeRegistry(
  opts: { targetExists?: boolean } = {},
): AsyncMessageRegistryStub & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    async readAgentProfile(id) {
      return opts.targetExists === true ? { id } : null;
    },
    async recordManagerTaskEvent(type, payload, taskId) {
      recorded.push({ type, payload, taskId });
    },
  };
}

const validContext: TaskContext = {
  id: "ctx-1",
  title: "Implement ",
  objective: "Thread task_context through manager dispatch",
  source_agent_id: "manager-1",
  expected_outputs: ["test doc", "completion report"],
};

describe("TaskContextSchema — accept", () => {
  it("accepts the minimum required object", () => {
    const r = TaskContextSchema.safeParse({
      id: "x",
      title: "t",
      objective: "o",
      source_agent_id: "m",
    });
    assert.equal(r.success, true);
  });

  it("accepts the full optional set including nested artifact_refs", () => {
    const full: TaskContext = {
      ...validContext,
      house_rules: ["no force push"],
      parent_task_id: "parent-1",
      card_id: "361",
      artifact_refs: [
        {
          agent_id: "agent-x",
          task_id: "task-x",
          artifact_id: "art-x",
          kind: "summary",
          digest: "sha256:abc",
        },
      ],
      non_goals: ["do not modify  path"],
      verification_hint: "verify via inspect events",
    };
    const r = TaskContextSchema.safeParse(full);
    assert.equal(r.success, true);
  });
});

describe("TaskContextSchema — reject", () => {
  it("rejects missing id / title / objective / source_agent_id", () => {
    for (const drop of ["id", "title", "objective", "source_agent_id"] as const) {
      const bad = { ...validContext } as Record<string, unknown>;
      delete bad[drop];
      const r = TaskContextSchema.safeParse(bad);
      assert.equal(r.success, false, `expected reject when '${drop}' is missing`);
    }
  });

  it("rejects title > 100 chars", () => {
    const r = TaskContextSchema.safeParse({
      ...validContext,
      title: "x".repeat(101),
    });
    assert.equal(r.success, false);
  });

  it("rejects objective > 500 chars (Req §2 negative smoke parity)", () => {
    const r = TaskContextSchema.safeParse({
      ...validContext,
      objective: "x".repeat(501),
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "objective");
      assert.ok(issue, "expected a field-level issue on 'objective'");
    }
  });

  it("rejects verification_hint > 500 chars", () => {
    const r = TaskContextSchema.safeParse({
      ...validContext,
      verification_hint: "x".repeat(501),
    });
    assert.equal(r.success, false);
  });

  it("ArtifactRefSchema rejects an unknown 'kind'", () => {
    const r = ArtifactRefSchema.safeParse({
      agent_id: "a",
      task_id: "t",
      artifact_id: "x",
      kind: "screenshot",
    });
    assert.equal(r.success, false);
  });
});

describe("renderTaskContextBlock", () => {
  it("wraps pretty-printed JSON in <task-context> tags", () => {
    const out = renderTaskContextBlock(validContext);
    assert.ok(out.startsWith("<task-context>\n"));
    assert.ok(out.endsWith("\n</task-context>"));
    const inner = out.slice("<task-context>\n".length, -"\n</task-context>".length);
    // Pretty-printed JSON (2-space indent): the inner body must have a newline.
    assert.ok(inner.includes("\n"));
    const reparsed = JSON.parse(inner);
    assert.deepEqual(reparsed, validContext);
  });
});

describe("renderTaskContextBlockPreview — ", () => {
  it("returns the full block unchanged when under the byte cap", () => {
    const out = renderTaskContextBlockPreview(validContext, 2000);
    const full = renderTaskContextBlock(validContext);
    assert.equal(out, full);
    assert.ok(out.includes("<task-context>"));
    assert.ok(out.includes("</task-context>"));
  });

  it("truncates oversized context but retains BOTH opening and closing tags", () => {
    const big: TaskContext = {
      ...validContext,
      expected_outputs: Array.from({ length: 20 }, (_, i) =>
        `output-${i}-${"x".repeat(200)}`,
      ),
      non_goals: Array.from({ length: 20 }, (_, i) =>
        `non-goal-${i}-${"y".repeat(200)}`,
      ),
    };
    const out = renderTaskContextBlockPreview(big, 2000);
    const bytes = new TextEncoder().encode(out).byteLength;
    assert.ok(
      bytes <= 2000,
      `expected preview <= 2000 bytes, got ${bytes}`,
    );
    assert.ok(
      out.includes("<task-context>"),
      "truncated preview must retain opening <task-context> tag",
    );
    assert.ok(
      out.includes("</task-context>"),
      "truncated preview must retain closing </task-context> tag",
    );
    assert.ok(out.length < renderTaskContextBlock(big).length, "expected truncation");
  });

  it("caps by UTF-8 bytes, not JS string length, for multi-byte chars", () => {
    // 700 × '界' = 2100 UTF-8 bytes but only 700 string chars.
    // A naive `.length` cap of 2000 would let this through; a proper
    // byte cap must truncate.
    const multibyte: TaskContext = {
      ...validContext,
      objective: "界".repeat(700),
    };
    const out = renderTaskContextBlockPreview(multibyte, 2000);
    const bytes = new TextEncoder().encode(out).byteLength;
    assert.ok(
      bytes <= 2000,
      `expected preview <= 2000 bytes for multi-byte content, got ${bytes}`,
    );
    assert.ok(out.includes("<task-context>"));
    assert.ok(out.includes("</task-context>"));
  });
});

describe("preflight wiring — handleAsyncManagerMessage", () => {
  it("rejects invalid task_context with invalid_input BEFORE recording received", async () => {
    const reg = makeRegistry({ targetExists: true });
    const outcome = await handleAsyncManagerMessage(
      reg,
      {
        agent_id: "agent-1",
        text: "hello",
        task_context: {
          ...validContext,
          objective: "x".repeat(501),
        } as TaskContext,
      },
      {
        mintTaskId: () => FIXED_TASK_ID,
        now: () => FIXED_NOW,
        spawnBackground: () => () => {
          throw new Error("spawn must not run on rejected preflight");
        },
      },
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.equal(outcome.httpStatus, 400);
      assert.equal(outcome.body.error.code, "invalid_input");
      assert.ok(
        outcome.body.error.message.startsWith("task_context."),
        `expected field-prefixed message, got ${outcome.body.error.message}`,
      );
    }
    assert.deepEqual(reg.recorded, [], "manager.task.received must NOT be recorded on invalid task_context");
  });

  it("records valid task_context in the received-event payload", async () => {
    const reg = makeRegistry({ targetExists: true });
    let spawnCount = 0;
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-1", text: "hello", task_context: validContext },
      {
        mintTaskId: () => FIXED_TASK_ID,
        now: () => FIXED_NOW,
        spawnBackground: () => () => {
          spawnCount += 1;
        },
      },
    );
    assert.equal(outcome.kind, "accepted");
    assert.equal(reg.recorded.length, 1);
    const ev = reg.recorded[0];
    assert.equal(ev.type, MANAGER_TASK_EVENT_NAMES.received);
    const payload = ev.payload as Record<string, unknown>;
    assert.deepEqual(payload.task_context, validContext);
    if (outcome.kind === "accepted") {
      outcome.spawn();
      assert.equal(spawnCount, 1);
    }
  });

  it("omits task_context from the received-event payload when absent", async () => {
    const reg = makeRegistry({ targetExists: true });
    const outcome = await handleAsyncManagerMessage(
      reg,
      { agent_id: "agent-1", text: "hello" },
      {
        mintTaskId: () => FIXED_TASK_ID,
        now: () => FIXED_NOW,
        spawnBackground: () => () => {},
      },
    );
    assert.equal(outcome.kind, "accepted");
    assert.equal(reg.recorded.length, 1);
    const payload = reg.recorded[0].payload as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, "task_context"),
      false,
    );
  });
});
