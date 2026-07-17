/**
 * pure reader/status-side-field tests for
 * `manager.task.completed`. Mirrors an earlier revision's reader test pattern.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveCompletionSideField,
  parseManagerTaskCompletedRow,
  type ManagerTaskCompletedRow,
} from "./managerTaskCompleteReaderOps";
import type { ManagerTaskCompletedPayload } from "./managerTaskCompleteOps";

const PARENT = "task-parent-1";
const MANAGER = "agent-mgr-1";

function row(
  opts: {
    event_id?: number;
    created_at?: string;
    payload?: Partial<ManagerTaskCompletedPayload> | null;
  } = {},
): ManagerTaskCompletedRow {
  const base: ManagerTaskCompletedPayload = {
    parent_task_id: PARENT,
    manager_agent_id: MANAGER,
    completion_verdict: "success",
    summary: "ok",
    completed_at: opts.created_at ?? "2026-05-27T10:00:00.000Z",
  };
  return {
    event_id: opts.event_id ?? 1,
    created_at: opts.created_at ?? "2026-05-27T10:00:00.000Z",
    payload:
      opts.payload === null
        ? null
        : opts.payload === undefined
        ? base
        : { ...base, ...opts.payload },
  };
}

describe("deriveCompletionSideField", () => {
  it("returns placeholder shape for empty rows", () => {
    const out = deriveCompletionSideField([]);
    assert.deepEqual(out, {
      completed: false,
      completion_count: 0,
      latest_verdict: null,
      latest_completed_at: null,
      latest_summary: null,
    });
  });

  it("derives completed=true + latest from a single row", () => {
    const out = deriveCompletionSideField([
      row({
        payload: {
          completion_verdict: "success",
          summary: "task done",
          completed_at: "2026-05-27T09:30:00.000Z",
        },
      }),
    ]);
    assert.equal(out.completed, true);
    assert.equal(out.completion_count, 1);
    assert.equal(out.latest_verdict, "success");
    assert.equal(out.latest_completed_at, "2026-05-27T09:30:00.000Z");
    assert.equal(out.latest_summary, "task done");
  });

  it("picks the last row (ASC ordered) as latest", () => {
    const out = deriveCompletionSideField([
      row({
        event_id: 1,
        created_at: "2026-05-27T09:00:00.000Z",
        payload: {
          completion_verdict: "partial",
          summary: "first try",
          completed_at: "2026-05-27T09:00:00.000Z",
        },
      }),
      row({
        event_id: 2,
        created_at: "2026-05-27T10:00:00.000Z",
        payload: {
          completion_verdict: "success",
          summary: "second try",
          completed_at: "2026-05-27T10:00:00.000Z",
        },
      }),
    ]);
    assert.equal(out.completion_count, 2);
    assert.equal(out.latest_verdict, "success");
    assert.equal(out.latest_summary, "second try");
    assert.equal(out.latest_completed_at, "2026-05-27T10:00:00.000Z");
  });

  it("counts a null-payload row toward completion_count and falls back to row created_at", () => {
    const out = deriveCompletionSideField([
      row({
        event_id: 1,
        created_at: "2026-05-27T09:00:00.000Z",
        payload: null,
      }),
    ]);
    assert.equal(out.completed, true);
    assert.equal(out.completion_count, 1);
    // Fail-soft: null payload yields null verdict + null summary,
    // but the row's created_at provides the timestamp so the UI can
    // still render the "an event happened" anchor.
    assert.equal(out.latest_verdict, null);
    assert.equal(out.latest_completed_at, "2026-05-27T09:00:00.000Z");
    assert.equal(out.latest_summary, null);
  });

  it("treats malformed verdict as null (fail-soft)", () => {
    const out = deriveCompletionSideField([
      row({
        payload: {
          // @ts-expect-error simulating legacy / garbled payload
          completion_verdict: "WAT",
          summary: "legacy row",
        },
      }),
    ]);
    assert.equal(out.latest_verdict, null);
    assert.equal(out.latest_summary, "legacy row");
  });
});

describe("parseManagerTaskCompletedRow", () => {
  it("parses valid JSON payload", () => {
    const parsed = parseManagerTaskCompletedRow({
      event_id: 5,
      payload: JSON.stringify({
        parent_task_id: PARENT,
        manager_agent_id: MANAGER,
        completion_verdict: "success",
        summary: "ok",
        completed_at: "2026-05-27T10:00:00.000Z",
      }),
      created_at: "2026-05-27T10:00:00.000Z",
    });
    assert.equal(parsed.event_id, 5);
    assert.equal(parsed.payload?.completion_verdict, "success");
  });

  it("fails soft on invalid JSON (returns null payload, keeps row)", () => {
    const parsed = parseManagerTaskCompletedRow({
      event_id: 6,
      payload: "{not json",
      created_at: "2026-05-27T10:00:00.000Z",
    });
    assert.equal(parsed.event_id, 6);
    assert.equal(parsed.payload, null);
  });

  it("rejects JSON arrays (returns null payload)", () => {
    const parsed = parseManagerTaskCompletedRow({
      event_id: 7,
      payload: "[1,2,3]",
      created_at: "2026-05-27T10:00:00.000Z",
    });
    assert.equal(parsed.payload, null);
  });
});
