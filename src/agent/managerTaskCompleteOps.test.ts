/**
 *  — `manager.task.completed` emitter pure-helper tests.
 *
 * Covers the completion-report emitter contract:
 *   1. Happy path: success + prior merge → record + payload echo.
 *   2. Verdict gating: success without merge → validation_failed;
 *      partial / failed without merge → accepted (precondition only
 *      applies to success).
 *   3. allow_without_merge bypass: true + non-empty reason → accepted;
 *      true + missing reason → validation_failed.
 *   4. `manager_agent_id` forging guard: helper always derives from
 *      callingAgentId, never trusts input.
 *   5. Summary byte cap: empty rejected; >2 KB UTF-8 rejected (CJK is
 *      counted correctly via TextEncoder, not string.length).
 *   6. Shape validation: invalid verdict / missing parent_task_id /
 *      malformed evidence / malformed card_ref.
 *   7. Multi-complete: multiple writes per parent are allowed and the
 *      registry is called once per emit.
 *   8. Status derivation: `manager.task.completed` is a no-op even
 *      after a `failed` terminal (unlike `merged` per ).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  emitManagerTaskCompleted,
  MANAGER_TASK_COMPLETED_EVENT_NAME,
  SUMMARY_BYTE_MAX,
  type ManagerTaskCompleteInput,
  type ManagerTaskCompleteRegistrySurface,
  type ManagerTaskCompletedPayload,
} from "./managerTaskCompleteOps";
import {
  deriveManagerTaskStatus,
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";

const MANAGER_ID = "agent-mgr-1";
const PARENT_TASK_ID = "task-parent-1";
const NOW = () => new Date("2026-05-27T10:00:00.000Z");

interface CapturedWrite {
  parentTaskId: string;
  payload: ManagerTaskCompletedPayload;
}

function buildRegistry(opts: {
  mergedRows?: Array<{ event_id: number; created_at: string; payload: unknown }>;
} = {}): {
  registry: ManagerTaskCompleteRegistrySurface;
  writes: CapturedWrite[];
  mergedProbeCalls: string[];
} {
  const writes: CapturedWrite[] = [];
  const mergedProbeCalls: string[] = [];
  const registry: ManagerTaskCompleteRegistrySurface = {
    readManagerTaskMergedEvents: async (parentTaskId: string) => {
      mergedProbeCalls.push(parentTaskId);
      return opts.mergedRows ?? [];
    },
    recordManagerTaskCompleted: (parentTaskId, payload) => {
      writes.push({ parentTaskId, payload });
    },
  };
  return { registry, writes, mergedProbeCalls };
}

const happyInput: ManagerTaskCompleteInput = {
  parent_task_id: PARENT_TASK_ID,
  completion_verdict: "success",
  summary: " dogfood verified: subagent reply landed, summary aggregated, merge audit emitted.",
  evidence: {
    merge_event_id: 6830,
    subagent_task_ids: ["task-sub-1"],
    envelope_id: "env-abc",
  },
  next_step: "operator to flip kanban to .done.verified",
  card_ref: { card_id: "377", path: "" },
};

describe("emitManagerTaskCompleted — happy path", () => {
  it("records success completion when prior merge exists", async () => {
    const { registry, writes, mergedProbeCalls } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      happyInput,
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.parent_task_id, PARENT_TASK_ID);
    assert.equal(result.completion_verdict, "success");
    assert.equal(result.completed_at, "2026-05-27T10:00:00.000Z");
    assert.equal(result.payload.manager_agent_id, MANAGER_ID);
    assert.equal(result.payload.summary, happyInput.summary);
    assert.deepEqual(result.payload.evidence, happyInput.evidence);
    assert.deepEqual(result.payload.card_ref, happyInput.card_ref);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].parentTaskId, PARENT_TASK_ID);
    assert.deepEqual(mergedProbeCalls, [PARENT_TASK_ID]);
  });

  it("auto-fills completed_at when omitted", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      happyInput,
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.completed_at, "2026-05-27T10:00:00.000Z");
  });

  it("respects caller-supplied completed_at when provided", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, completed_at: "2026-05-27T08:00:00.000Z" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.completed_at, "2026-05-27T08:00:00.000Z");
  });
});

describe("emitManagerTaskCompleted — verdict gating", () => {
  it("rejects success without prior merge with validation_failed (message names allow_without_merge)", async () => {
    const { registry, writes } = buildRegistry({ mergedRows: [] });
    const result = await emitManagerTaskCompleted(
      registry,
      happyInput,
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /allow_without_merge/);
    assert.equal(writes.length, 0);
  });

  it("accepts partial verdict without prior merge (no probe)", async () => {
    const { registry, writes, mergedProbeCalls } = buildRegistry({
      mergedRows: [],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, completion_verdict: "partial" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
    // partial verdict skips the merge precondition probe entirely.
    assert.deepEqual(mergedProbeCalls, []);
  });

  it("accepts failed verdict without prior merge (no probe)", async () => {
    const { registry, writes, mergedProbeCalls } = buildRegistry({
      mergedRows: [],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, completion_verdict: "failed" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(mergedProbeCalls, []);
  });
});

describe("emitManagerTaskCompleted — allow_without_merge bypass", () => {
  it("accepts success without merge when allow_without_merge=true + reason", async () => {
    const { registry, writes, mergedProbeCalls } = buildRegistry({
      mergedRows: [],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      {
        ...happyInput,
        allow_without_merge: true,
        allow_without_merge_reason: "advisory task, no subagent fanout",
      },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.allow_without_merge, true);
    assert.equal(
      result.payload.allow_without_merge_reason,
      "advisory task, no subagent fanout",
    );
    assert.equal(writes.length, 1);
    // Override path also skips the probe — we never need to read
    // merged rows when the caller is explicitly waiving it.
    assert.deepEqual(mergedProbeCalls, []);
  });

  it("rejects allow_without_merge=true without reason", async () => {
    const { registry, writes } = buildRegistry({ mergedRows: [] });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, allow_without_merge: true },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /allow_without_merge_reason/);
    assert.equal(writes.length, 0);
  });

  it("rejects allow_without_merge=true with empty reason", async () => {
    const { registry, writes } = buildRegistry({ mergedRows: [] });
    const result = await emitManagerTaskCompleted(
      registry,
      {
        ...happyInput,
        allow_without_merge: true,
        allow_without_merge_reason: "",
      },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.equal(writes.length, 0);
  });
});

describe("emitManagerTaskCompleted — identity / forging guard", () => {
  it("derives manager_agent_id from callingAgentId, ignoring any input-side attempt", async () => {
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    // Even if some caller tries to inject manager_agent_id at the
    // wire layer (the schema strips it but defense-in-depth), the
    // helper never reads it from input — manager_agent_id is set
    // from callingAgentId.
    const result = await emitManagerTaskCompleted(
      registry,
      happyInput,
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.manager_agent_id, MANAGER_ID);
    assert.equal(writes[0].payload.manager_agent_id, MANAGER_ID);
  });

  it("rejects empty callingAgentId", async () => {
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(registry, happyInput, "", NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /calling agent_id/);
    assert.equal(writes.length, 0);
  });
});

describe("emitManagerTaskCompleted — summary byte cap", () => {
  it("rejects empty summary", async () => {
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, summary: "" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /non-empty/);
    assert.equal(writes.length, 0);
  });

  it("counts CJK bytes correctly (TextEncoder, not string.length)", async () => {
    // '界' is 3 UTF-8 bytes. 700 copies = 2100 bytes > 2000 cap, but
    // string.length = 700. If the helper used string.length the test
    // would falsely PASS. This proves  lesson is honored.
    const cjkOver = "界".repeat(700);
    assert.equal(cjkOver.length, 700);
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, summary: cjkOver },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /UTF-8 bytes/);
    assert.equal(writes.length, 0);
  });

  it("accepts ASCII summary at exactly the byte cap", async () => {
    const atCap = "a".repeat(SUMMARY_BYTE_MAX);
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, summary: atCap },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
  });

  it("rejects ASCII summary one byte over the cap", async () => {
    const overCap = "a".repeat(SUMMARY_BYTE_MAX + 1);
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, summary: overCap },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.equal(writes.length, 0);
  });
});

describe("emitManagerTaskCompleted — shape validation", () => {
  it("rejects empty parent_task_id", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      { ...happyInput, parent_task_id: "" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
  });

  it("rejects unknown completion_verdict", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      // @ts-expect-error testing runtime guard
      { ...happyInput, completion_verdict: "bogus" },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /completion_verdict/);
  });

  it("rejects malformed evidence.merge_event_id (negative)", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      {
        ...happyInput,
        evidence: { merge_event_id: -5 },
      },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /merge_event_id/);
  });

  it("rejects evidence.subagent_task_ids with empty string entry", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      {
        ...happyInput,
        evidence: { subagent_task_ids: ["task-1", ""] },
      },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /subagent_task_ids\[1\]/);
  });

  it("rejects card_ref without card_id", async () => {
    const { registry } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const result = await emitManagerTaskCompleted(
      registry,
      // @ts-expect-error testing runtime guard
      { ...happyInput, card_ref: { path: "" } },
      MANAGER_ID,
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "validation_failed");
    assert.match(result.error.message, /card_ref\.card_id/);
  });
});

describe("emitManagerTaskCompleted — multi-complete", () => {
  it("allows multiple writes per parent_task_id", async () => {
    const { registry, writes } = buildRegistry({
      mergedRows: [
        { event_id: 1, created_at: "2026-05-27T09:00:00.000Z", payload: {} },
      ],
    });
    const first = await emitManagerTaskCompleted(
      registry,
      happyInput,
      MANAGER_ID,
      NOW,
    );
    const second = await emitManagerTaskCompleted(
      registry,
      {
        ...happyInput,
        summary: "Correction: subagent reply final byte was UTF-8 cut, re-verified now.",
      },
      MANAGER_ID,
      NOW,
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].parentTaskId, PARENT_TASK_ID);
    assert.equal(writes[1].parentTaskId, PARENT_TASK_ID);
  });
});

describe(" — manager.task.completed is no-op for status derivation", () => {
  it("does NOT flip terminal_conflict even after failed terminal", () => {
    const events: ManagerTaskEventRow[] = [
      { type: MANAGER_TASK_EVENT_NAMES.received, ts: "2026-05-27T09:00:00.000Z" },
      { type: MANAGER_TASK_EVENT_NAMES.started, ts: "2026-05-27T09:01:00.000Z" },
      { type: MANAGER_TASK_EVENT_NAMES.failed, ts: "2026-05-27T09:02:00.000Z", payload: { reason: "boom", message: "boom" } },
      // : a completion landing after a failed terminal must
      // NOT count as a conflict (unlike `merged`, which DOES flip
      // terminal_conflict per ). Operators can see the
      // disagreement via the additive completion side field on the
      // status endpoint; the lifecycle terminal status stays `failed`.
      { type: MANAGER_TASK_EVENT_NAMES.completed, ts: "2026-05-27T09:03:00.000Z" },
    ];
    const derived = deriveManagerTaskStatus(
      events,
      new Date("2026-05-27T10:00:00.000Z"),
    );
    assert.equal(derived.status, "failed");
    assert.equal(derived.terminal_conflict.has_conflict, false);
  });

  it("does NOT flip terminal_conflict after replied terminal", () => {
    const events: ManagerTaskEventRow[] = [
      { type: MANAGER_TASK_EVENT_NAMES.received, ts: "2026-05-27T09:00:00.000Z" },
      { type: MANAGER_TASK_EVENT_NAMES.started, ts: "2026-05-27T09:01:00.000Z" },
      { type: MANAGER_TASK_EVENT_NAMES.replied, ts: "2026-05-27T09:02:00.000Z", payload: { reply: "ok", envelope_id: "env-1" } },
      { type: MANAGER_TASK_EVENT_NAMES.merged, ts: "2026-05-27T09:03:00.000Z" },
      { type: MANAGER_TASK_EVENT_NAMES.completed, ts: "2026-05-27T09:04:00.000Z" },
    ];
    const derived = deriveManagerTaskStatus(
      events,
      new Date("2026-05-27T10:00:00.000Z"),
    );
    assert.equal(derived.status, "replied");
    assert.equal(derived.terminal_conflict.has_conflict, false);
  });
});

describe(" — event-name lock-in", () => {
  it("exposes MANAGER_TASK_COMPLETED_EVENT_NAME as exact string", () => {
    assert.equal(MANAGER_TASK_COMPLETED_EVENT_NAME, "manager.task.completed");
  });
});
