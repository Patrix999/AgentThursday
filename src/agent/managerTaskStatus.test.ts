/**
 * pure status-derivation tests.
 *
 * Targets `managerTaskStatus.ts` directly. The helper has no DO/env
 * dependencies; we only assert the derivation logic against synthetic
 * event rows.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveManagerTaskStatus,
  MANAGER_TASK_EVENT_NAMES,
  MANAGER_TASK_TIMEOUT_MS,
  MANAGER_TASK_HARD_TIMEOUT_MS,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";

function row(
  type: string,
  ts: string,
  payload?: Record<string, unknown>,
): ManagerTaskEventRow {
  return payload !== undefined ? { type, ts, payload } : { type, ts };
}

describe("deriveManagerTaskStatus", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");

  it("returns unknown when events array is empty", () => {
    const r = deriveManagerTaskStatus([], now);
    assert.equal(r.status, "unknown");
    assert.equal(r.accepted_at, null);
    assert.equal(r.started_at, null);
    assert.equal(r.completed_at, null);
    assert.equal(r.reply, null);
    assert.equal(r.envelope_id, null);
    assert.equal(r.submit_task_id, null);
    assert.equal(r.error, null);
  });

  it("returns received when only received event is present", () => {
    const r = deriveManagerTaskStatus(
      [row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z")],
      now,
    );
    assert.equal(r.status, "received");
    assert.equal(r.accepted_at, "2026-05-25T11:59:00.000Z");
    assert.equal(r.started_at, null);
  });

  it("returns in_progress when received + started without terminal", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "in_progress");
    assert.equal(r.accepted_at, "2026-05-25T11:59:00.000Z");
    assert.equal(r.started_at, "2026-05-25T11:59:30.000Z");
    assert.equal(r.completed_at, null);
  });

  it("returns replied when replied event is present and surfaces reply + envelope_id + submit_task_id", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-25T11:59:45.000Z", {
          reply: "hello",
          envelope_id: "env-abc",
          submit_task_id: "task-inner-7a4696bb",
          reply_length: 5,
        }),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.completed_at, "2026-05-25T11:59:45.000Z");
    assert.equal(r.reply, "hello");
    assert.equal(r.envelope_id, "env-abc");
    assert.equal(r.submit_task_id, "task-inner-7a4696bb");
    assert.equal(r.error, null);
  });

  it("returns failed when failed event is present and surfaces error fields", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-25T11:59:40.000Z", {
          reason: "internal",
          message: "boom",
          failure_class: "internal",
        }),
      ],
      now,
    );
    assert.equal(r.status, "failed");
    assert.equal(r.completed_at, "2026-05-25T11:59:40.000Z");
    assert.deepEqual(r.error, {
      reason: "internal",
      message: "boom",
      failure_class: "internal",
    });
    assert.equal(r.reply, null);
  });

  it("returns waiting when latest non-terminal event after started is waiting", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.waiting, "2026-05-25T11:59:35.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "waiting");
  });

  // layered timeout. The soft threshold no longer flips the
  // primary status to terminal `timed_out`; it raises a `stale_warning`
  // while keeping `in_progress`. Only the HARD ceiling is terminal.
  it("fresh started run (< soft window): in_progress, no stale warning", () => {
    const started = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, started),
        row(MANAGER_TASK_EVENT_NAMES.started, started),
      ],
      now,
    );
    assert.equal(r.status, "in_progress");
    assert.equal(r.stale_warning.stale, false);
  });

  it("past SOFT but under HARD: stays in_progress with stale_warning ", () => {
    const started = new Date(
      now.getTime() - MANAGER_TASK_TIMEOUT_MS - 60 * 1000,
    ).toISOString();
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, started),
        row(MANAGER_TASK_EVENT_NAMES.started, started),
      ],
      now,
    );
    // Primary status is NOT terminal — a long legitimate gate may still
    // be running (an earlier revision observed ~21 min).
    assert.equal(r.status, "in_progress");
    assert.equal(r.stale_warning.stale, true);
    assert.ok((r.stale_warning.elapsed_ms ?? 0) > MANAGER_TASK_TIMEOUT_MS);
  });

  it("past HARD ceiling: terminal timed_out with stale_warning ", () => {
    const started = new Date(
      now.getTime() - MANAGER_TASK_HARD_TIMEOUT_MS - 1000,
    ).toISOString();
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, started),
        row(MANAGER_TASK_EVENT_NAMES.started, started),
      ],
      now,
    );
    assert.equal(r.status, "timed_out");
    assert.equal(r.stale_warning.stale, true);
  });

  it("terminal replied is never marked stale regardless of age", () => {
    const old = new Date(now.getTime() - MANAGER_TASK_HARD_TIMEOUT_MS - 1000).toISOString();
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, old),
        row(MANAGER_TASK_EVENT_NAMES.started, old),
        row(MANAGER_TASK_EVENT_NAMES.replied, old, { reply: "done" }),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.stale_warning.stale, false);
  });

  it("ignores unrelated event types but still derives from manager.task.* events", () => {
    const r = deriveManagerTaskStatus(
      [
        row("manager.agent.created", "2026-05-25T11:58:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "in_progress");
  });

  it("replied wins over a prior waiting event", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.waiting, "2026-05-25T11:59:35.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-25T11:59:40.000Z", {
          reply: "done",
          envelope_id: "env-xyz",
        }),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.reply, "done");
    assert.equal(r.envelope_id, "env-xyz");
  });

  it("missing payload on replied yields null reply + envelope_id + submit_task_id, still status:replied", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-25T11:59:45.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.reply, null);
    assert.equal(r.envelope_id, null);
    assert.equal(r.submit_task_id, null);
  });

  it("non-terminal states leave submit_task_id null", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "in_progress");
    assert.equal(r.submit_task_id, null);
  });

  it("failed terminal leaves submit_task_id null", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-25T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-25T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-25T11:59:40.000Z", {
          reason: "internal",
          message: "boom",
        }),
      ],
      now,
    );
    assert.equal(r.status, "failed");
    assert.equal(r.submit_task_id, null);
  });
});

// terminal_conflict evidence surface tests. The `status`
// enum is NOT extended; it still reflects the FIRST terminal. The
// new field exposes later contradicting events so operators don't
// only see a single side of the truth.
describe("deriveManagerTaskStatus — an earlier revision terminal_conflict", () => {
  const now = new Date("2026-05-27T12:00:00.000Z");

  it("no terminal events → terminal_conflict has_conflict=false", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-27T11:59:30.000Z"),
      ],
      now,
    );
    assert.equal(r.terminal_conflict.has_conflict, false);
    assert.equal(r.terminal_conflict.terminal_status, undefined);
    assert.equal(r.terminal_conflict.later_events, undefined);
  });

  it("single replied terminal → no conflict", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-27T11:59:40.000Z", {
          reply: "hi",
          envelope_id: "env-1",
        }),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.terminal_conflict.has_conflict, false);
  });

  it("single failed terminal → no conflict", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-27T11:59:40.000Z", {
          reason: "internal",
          message: "boom",
        }),
      ],
      now,
    );
    assert.equal(r.status, "failed");
    assert.equal(r.terminal_conflict.has_conflict, false);
  });

  it("replied followed by merged → NOT conflict (an earlier revision audit pattern)", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-27T11:59:40.000Z", {
          reply: "ok",
          envelope_id: "env-x",
        }),
        row(MANAGER_TASK_EVENT_NAMES.merged, "2026-05-27T11:59:50.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    assert.equal(r.reply, "ok");
    assert.equal(r.envelope_id, "env-x");
    // Replied + merged is the by-design audit-grade pattern; NOT a
    // conflict. an earlier revision §4.5 explicitly permits this co-existence.
    assert.equal(r.terminal_conflict.has_conflict, false);
  });

  it("failed followed by merged → CONFLICT (primary an earlier revision case)", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-27T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-27T11:59:40.000Z", {
          reason: "internal",
          message: "Durable Object's isolate exceeded its memory limit",
        }),
        row(MANAGER_TASK_EVENT_NAMES.merged, "2026-05-27T12:00:30.000Z"),
      ],
      now,
    );
    // First terminal's truth is preserved on the primary status.
    assert.equal(r.status, "failed");
    assert.equal(r.completed_at, "2026-05-27T11:59:40.000Z");
    assert.deepEqual(r.error, {
      reason: "internal",
      message: "Durable Object's isolate exceeded its memory limit",
    });
    // Conflict evidence surfaced additively.
    assert.equal(r.terminal_conflict.has_conflict, true);
    assert.equal(r.terminal_conflict.terminal_status, "failed");
    assert.deepEqual(r.terminal_conflict.later_events, ["manager.task.merged"]);
    assert.match(
      r.terminal_conflict.message ?? "",
      /terminal failed.*manager\.task\.merged/,
    );
  });

  it("failed followed by replied → CONFLICT", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-27T11:59:40.000Z", {
          reason: "internal",
          message: "boom",
        }),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-27T12:00:00.000Z", {
          reply: "delayed reply",
        }),
      ],
      now,
    );
    // First terminal wins on the status enum.
    assert.equal(r.status, "failed");
    // First terminal's error preserved; the later replied does NOT
    // overwrite reply/envelope_id (operator reads the first truth).
    assert.equal(r.reply, null);
    assert.equal(r.terminal_conflict.has_conflict, true);
    assert.equal(r.terminal_conflict.terminal_status, "failed");
    assert.deepEqual(r.terminal_conflict.later_events, [
      "manager.task.replied",
    ]);
  });

  it("replied followed by failed → CONFLICT", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-27T11:59:40.000Z", {
          reply: "ok",
          envelope_id: "env-z",
        }),
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-27T11:59:50.000Z", {
          reason: "internal",
          message: "after-the-fact crash",
        }),
      ],
      now,
    );
    assert.equal(r.status, "replied");
    // First terminal payload preserved; failed payload does NOT
    // overwrite reply/envelope_id.
    assert.equal(r.reply, "ok");
    assert.equal(r.envelope_id, "env-z");
    assert.equal(r.error, null);
    assert.equal(r.terminal_conflict.has_conflict, true);
    assert.equal(r.terminal_conflict.terminal_status, "replied");
    assert.deepEqual(r.terminal_conflict.later_events, [
      "manager.task.failed",
    ]);
  });

  it("failed followed by both merged and replied → both later_events captured", () => {
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.failed, "2026-05-27T11:59:40.000Z", {
          reason: "internal",
          message: "first",
        }),
        row(MANAGER_TASK_EVENT_NAMES.merged, "2026-05-27T11:59:50.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.replied, "2026-05-27T12:00:00.000Z", {
          reply: "delayed",
        }),
      ],
      now,
    );
    assert.equal(r.status, "failed");
    assert.equal(r.terminal_conflict.has_conflict, true);
    assert.equal(r.terminal_conflict.terminal_status, "failed");
    assert.deepEqual(r.terminal_conflict.later_events, [
      "manager.task.merged",
      "manager.task.replied",
    ]);
  });

  it("merged event BEFORE any terminal is ignored (no terminal_conflict)", () => {
    // Defensive — `merged` should never land before a terminal in
    // production, but the helper must not flag this as conflict
    // because there is no first-terminal anchor to contradict.
    const r = deriveManagerTaskStatus(
      [
        row(MANAGER_TASK_EVENT_NAMES.received, "2026-05-27T11:59:00.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.merged, "2026-05-27T11:59:30.000Z"),
        row(MANAGER_TASK_EVENT_NAMES.started, "2026-05-27T11:59:35.000Z"),
      ],
      now,
    );
    assert.equal(r.status, "in_progress");
    assert.equal(r.terminal_conflict.has_conflict, false);
  });
});
