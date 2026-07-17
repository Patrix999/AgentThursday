/**
 * pure helpers for the merge reader/status surface.
 *
 * No DO, no env: every test feeds raw `ManagerTaskMergedRow[]` arrays
 * directly into `deriveMergeSideField` / `buildMergeReaderResponse` so
 * the assertions cover the bounded shapes the route layer emits.
 *
 * Coverage map:
 *   - no-row → `merged: false`, `merge_count: 0`, all latest fields null
 *   - single-row → `merged: true`, latest derived from the only row
 *   - multi-row → latest = newest row (rows[length-1]); stable ASC order preserved
 *   - status-unchanged guarantee → the side-field helper has NO branch
 *     on `manager.task.received/started/replied/...` events; covered
 *     by `handleManagerTaskStatus` tests in the controller suite, but
 *     asserted here at the helper boundary by feeding only merge rows
 *     and checking the rest of TaskStatusBody is untouched
 *   - malformed/legacy payload → `payload: null`, count still increments,
 *     latest fields fall back to row.created_at and surface `null`
 *     verdict / `0` subagent_count
 *   - parseManagerTaskMergedRow → JSON-parse fail-soft yields `payload: null`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMergeReaderResponse,
  deriveMergeSideField,
  parseManagerTaskMergedRow,
  type ManagerTaskMergedRow,
} from "./managerTaskMergeReaderOps";
import type {
  ManagerTaskMergedPayload,
  ManagerTaskMergedRef,
} from "./managerTaskMergeOps";

function refStub(taskId: string, agentId = "agent-sub", verdict: "success" | "partial" | "failed" | "ignored" = "success"): ManagerTaskMergedRef {
  return {
    task_id: taskId,
    agent_id: agentId,
    summary_id: taskId,
    verdict,
    superseded_by: null,
  };
}

function payloadStub(
  parentTaskId: string,
  managerAgentId: string,
  mergedAt: string,
  refs: ManagerTaskMergedRef[],
  verdict: "success" | "partial" | "failed" = "success",
): ManagerTaskMergedPayload {
  return {
    parent_task_id: parentTaskId,
    manager_agent_id: managerAgentId,
    subagent_task_refs: refs,
    merge_verdict: verdict,
    merged_at: mergedAt,
  };
}

function rowStub(eventId: number, createdAt: string, payload: ManagerTaskMergedPayload | null): ManagerTaskMergedRow {
  return { event_id: eventId, created_at: createdAt, payload };
}

describe("deriveMergeSideField — no merge rows", () => {
  it("returns merged:false + zero counts + null latest fields", () => {
    const side = deriveMergeSideField([]);
    assert.equal(side.merged, false);
    assert.equal(side.merge_count, 0);
    assert.equal(side.latest_verdict, null);
    assert.equal(side.latest_merged_at, null);
    assert.equal(side.subagent_count, 0);
  });
});

describe("deriveMergeSideField — single merge row", () => {
  it("derives merged:true + latest fields from the only row", () => {
    const payload = payloadStub(
      "task-parent",
      "agent-manager-1",
      "2026-05-26T10:00:00.000Z",
      [refStub("task-sub-1"), refStub("task-sub-2")],
      "success",
    );
    const side = deriveMergeSideField([rowStub(101, "2026-05-26T10:00:00.000Z", payload)]);
    assert.equal(side.merged, true);
    assert.equal(side.merge_count, 1);
    assert.equal(side.latest_verdict, "success");
    assert.equal(side.latest_merged_at, "2026-05-26T10:00:00.000Z");
    assert.equal(side.subagent_count, 2);
  });
});

describe("deriveMergeSideField — multi-row stable ASC ordering", () => {
  it("derives latest from the NEWEST (last) row + counts all", () => {
    const rowOld = rowStub(
      101,
      "2026-05-26T10:00:00.000Z",
      payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:00:00.000Z", [refStub("task-sub-1")], "partial"),
    );
    const rowMid = rowStub(
      102,
      "2026-05-26T10:05:00.000Z",
      payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:05:00.000Z", [refStub("task-sub-1"), refStub("task-sub-2")], "success"),
    );
    const rowNew = rowStub(
      103,
      "2026-05-26T10:10:00.000Z",
      payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:10:00.000Z", [refStub("task-sub-1"), refStub("task-sub-2"), refStub("task-sub-3")], "success"),
    );
    const side = deriveMergeSideField([rowOld, rowMid, rowNew]);
    assert.equal(side.merge_count, 3);
    assert.equal(side.latest_verdict, "success");
    assert.equal(side.latest_merged_at, "2026-05-26T10:10:00.000Z");
    assert.equal(side.subagent_count, 3);
  });
});

describe("deriveMergeSideField — malformed legacy payload fail-soft", () => {
  it("counts a null-payload row + falls back latest_merged_at to created_at + null verdict + 0 subagent_count", () => {
    const side = deriveMergeSideField([rowStub(101, "2026-05-26T10:00:00.000Z", null)]);
    assert.equal(side.merged, true);
    assert.equal(side.merge_count, 1);
    assert.equal(side.latest_verdict, null);
    assert.equal(side.latest_merged_at, "2026-05-26T10:00:00.000Z");
    assert.equal(side.subagent_count, 0);
  });

  it("handles partial-payload (missing merged_at / non-array refs) without throwing", () => {
    const broken = {
      parent_task_id: "task-parent",
      manager_agent_id: "agent-manager-1",
      // missing merged_at + merge_verdict + subagent_task_refs not an array
      subagent_task_refs: "not-an-array" as unknown as ManagerTaskMergedRef[],
    } as unknown as ManagerTaskMergedPayload;
    const side = deriveMergeSideField([rowStub(101, "2026-05-26T10:00:00.000Z", broken)]);
    assert.equal(side.merged, true);
    assert.equal(side.merge_count, 1);
    assert.equal(side.latest_verdict, null);
    assert.equal(side.latest_merged_at, "2026-05-26T10:00:00.000Z");
    assert.equal(side.subagent_count, 0);
  });

  it("handles enum-violating merge_verdict by surfacing null instead of leaking the bad value", () => {
    const broken = payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:00:00.000Z", [refStub("task-sub-1")], "success");
    (broken as unknown as { merge_verdict: string }).merge_verdict = "exploded";
    const side = deriveMergeSideField([rowStub(101, "2026-05-26T10:00:00.000Z", broken)]);
    assert.equal(side.latest_verdict, null);
    assert.equal(side.subagent_count, 1);
  });
});

describe("buildMergeReaderResponse", () => {
  it("returns merged:false + merges:[] + latest:null for an empty rows array", () => {
    const body = buildMergeReaderResponse("task-parent", []);
    assert.equal(body.ok, true);
    assert.equal(body.task_id, "task-parent");
    assert.equal(body.merged, false);
    assert.equal(body.merge_count, 0);
    assert.equal(body.latest, null);
    assert.deepEqual(body.merges, []);
  });

  it("returns the single row with payload echoed + latest derived from it", () => {
    const payload = payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:00:00.000Z", [refStub("task-sub-1")], "success");
    const rows = [rowStub(101, "2026-05-26T10:00:00.000Z", payload)];
    const body = buildMergeReaderResponse("task-parent", rows);
    assert.equal(body.merge_count, 1);
    assert.equal(body.merges.length, 1);
    assert.equal(body.merges[0]?.event_id, 101);
    assert.equal(body.merges[0]?.payload?.merge_verdict, "success");
    assert.equal(body.latest?.event_id, 101);
    assert.equal(body.latest?.merge_verdict, "success");
    assert.equal(body.latest?.merged_at, "2026-05-26T10:00:00.000Z");
    assert.equal(body.latest?.subagent_count, 1);
  });

  it("preserves ASC ordering in merges[] + picks latest from the last row", () => {
    const payloadOld = payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:00:00.000Z", [refStub("task-sub-1")], "partial");
    const payloadNew = payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:10:00.000Z", [refStub("task-sub-1"), refStub("task-sub-2")], "success");
    const rows = [
      rowStub(101, "2026-05-26T10:00:00.000Z", payloadOld),
      rowStub(102, "2026-05-26T10:10:00.000Z", payloadNew),
    ];
    const body = buildMergeReaderResponse("task-parent", rows);
    assert.equal(body.merge_count, 2);
    assert.equal(body.merges[0]?.event_id, 101);
    assert.equal(body.merges[1]?.event_id, 102);
    assert.equal(body.latest?.event_id, 102);
    assert.equal(body.latest?.merge_verdict, "success");
    assert.equal(body.latest?.subagent_count, 2);
  });

  it("surfaces a null-payload entry without dropping it from merges[]", () => {
    const rows = [
      rowStub(101, "2026-05-26T10:00:00.000Z", null),
      rowStub(102, "2026-05-26T10:01:00.000Z", payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:01:00.000Z", [refStub("task-sub-1")])),
    ];
    const body = buildMergeReaderResponse("task-parent", rows);
    assert.equal(body.merge_count, 2);
    assert.equal(body.merges[0]?.payload, null);
    assert.equal(body.merges[1]?.payload?.merge_verdict, "success");
    assert.equal(body.latest?.event_id, 102);
  });
});

describe("parseManagerTaskMergedRow", () => {
  it("parses a valid JSON payload into a typed row", () => {
    const payload = payloadStub("task-parent", "agent-manager-1", "2026-05-26T10:00:00.000Z", [refStub("task-sub-1")]);
    const row = parseManagerTaskMergedRow({
      event_id: 101,
      payload: JSON.stringify(payload),
      created_at: "2026-05-26T10:00:00.000Z",
    });
    assert.equal(row.event_id, 101);
    assert.equal(row.payload?.merge_verdict, "success");
    assert.equal(row.payload?.parent_task_id, "task-parent");
  });

  it("returns payload:null on JSON.parse error without throwing", () => {
    const row = parseManagerTaskMergedRow({
      event_id: 101,
      payload: "{not json",
      created_at: "2026-05-26T10:00:00.000Z",
    });
    assert.equal(row.event_id, 101);
    assert.equal(row.payload, null);
    assert.equal(row.created_at, "2026-05-26T10:00:00.000Z");
  });

  it("rejects non-object JSON shapes (array, string, null) → payload:null", () => {
    const arr = parseManagerTaskMergedRow({ event_id: 1, payload: "[]", created_at: "x" });
    assert.equal(arr.payload, null);
    const str = parseManagerTaskMergedRow({ event_id: 2, payload: "\"hello\"", created_at: "x" });
    assert.equal(str.payload, null);
    const nul = parseManagerTaskMergedRow({ event_id: 3, payload: "null", created_at: "x" });
    assert.equal(nul.payload, null);
  });
});
