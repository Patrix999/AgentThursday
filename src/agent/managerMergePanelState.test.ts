/**
 *  — tests for the pure merge panel state derivation.
 *
 * Covers the panel acceptance criteria (idle / loading / error /
 * not_found / no_merge / merged + malformed-latest + truncation).
 * No DO, no fetch — feeds raw `MergePanelInput` straight into
 * `deriveMergePanelState` and asserts the discriminated state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REFS,
  deriveMergePanelState,
  type MergePanelInput,
} from "./managerMergePanelState";
import type {
  MergeReaderEntry,
  MergeReaderResponse,
} from "./managerTaskMergeReaderOps";
import type {
  ManagerTaskMergedPayload,
  ManagerTaskMergedRef,
} from "./managerTaskMergeOps";

function refStub(
  taskId: string,
  agentId = "agent-sub",
  verdict: "success" | "partial" | "failed" | "ignored" = "success",
): ManagerTaskMergedRef {
  return {
    task_id: taskId,
    agent_id: agentId,
    summary_id: taskId,
    verdict,
    superseded_by: null,
  };
}

function payloadStub(
  refs: ManagerTaskMergedRef[],
  verdict: "success" | "partial" | "failed" = "success",
  mergedAt = "2026-05-26T10:00:00.000Z",
): ManagerTaskMergedPayload {
  return {
    parent_task_id: "task-parent",
    manager_agent_id: "agent-manager-1",
    subagent_task_refs: refs,
    merge_verdict: verdict,
    merged_at: mergedAt,
  };
}

function entryStub(
  eventId: number,
  createdAt: string,
  payload: ManagerTaskMergedPayload | null,
): MergeReaderEntry {
  return { event_id: eventId, created_at: createdAt, payload };
}

function readerStub(entries: MergeReaderEntry[]): MergeReaderResponse {
  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  return {
    ok: true,
    task_id: "task-parent",
    merged: entries.length > 0,
    merge_count: entries.length,
    latest: last !== null && last !== undefined
      ? {
          event_id: last.event_id,
          created_at: last.created_at,
          merge_verdict: last.payload?.merge_verdict ?? null,
          merged_at: last.payload?.merged_at ?? last.created_at,
          subagent_count: Array.isArray(last.payload?.subagent_task_refs)
            ? last.payload!.subagent_task_refs.length
            : 0,
        }
      : null,
    merges: entries,
  };
}

function input(overrides: Partial<MergePanelInput> = {}): MergePanelInput {
  return {
    taskId: "task-parent",
    loading: false,
    fetchError: null,
    reader: null,
    ...overrides,
  };
}

describe("deriveMergePanelState — idle", () => {
  it("returns idle when taskId is null", () => {
    const state = deriveMergePanelState(input({ taskId: null }));
    assert.equal(state.kind, "idle");
  });

  it("returns idle when taskId is empty string", () => {
    const state = deriveMergePanelState(input({ taskId: "" }));
    assert.equal(state.kind, "idle");
  });
});

describe("deriveMergePanelState — loading", () => {
  it("returns loading when fetch is in flight, even with stale reader present", () => {
    const reader = readerStub([entryStub(101, "2026-05-26T10:00:00.000Z", payloadStub([refStub("task-sub-1")]))]);
    const state = deriveMergePanelState(input({ loading: true, reader }));
    assert.equal(state.kind, "loading");
    if (state.kind === "loading") assert.equal(state.taskId, "task-parent");
  });
});

describe("deriveMergePanelState — error", () => {
  it("returns error when fetchError is set", () => {
    const state = deriveMergePanelState(input({ fetchError: "HTTP 500" }));
    assert.equal(state.kind, "error");
    if (state.kind === "error") {
      assert.equal(state.taskId, "task-parent");
      assert.equal(state.message, "HTTP 500");
    }
  });
});

describe("deriveMergePanelState — not_found", () => {
  it("returns not_found when reader is null and no fetch flags are set", () => {
    const state = deriveMergePanelState(input({ reader: null }));
    assert.equal(state.kind, "not_found");
  });
});

describe("deriveMergePanelState — no_merge", () => {
  it("returns no_merge when reader.merged is false", () => {
    const reader = readerStub([]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "no_merge");
  });
});

describe("deriveMergePanelState — merged single row", () => {
  it("returns merged state with refs + counts derived from latest", () => {
    const payload = payloadStub([refStub("task-sub-1"), refStub("task-sub-2", "agent-sub-b", "partial")], "success");
    const reader = readerStub([entryStub(101, "2026-05-26T10:00:00.000Z", payload)]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.mergeCount, 1);
      assert.equal(state.subagentCount, 2);
      assert.equal(state.latestVerdict, "success");
      assert.equal(state.latestMergedAt, "2026-05-26T10:00:00.000Z");
      assert.equal(state.refs.length, 2);
      assert.equal(state.refs[0]?.task_id, "task-sub-1");
      assert.equal(state.refs[1]?.verdict, "partial");
      assert.equal(state.malformedLatest, false);
      assert.equal(state.truncated, false);
    }
  });
});

describe("deriveMergePanelState — merged multi-row picks latest", () => {
  it("derives latest from the newest entry (last in ASC array)", () => {
    const reader = readerStub([
      entryStub(101, "2026-05-26T10:00:00.000Z", payloadStub([refStub("task-sub-1")], "partial", "2026-05-26T10:00:00.000Z")),
      entryStub(102, "2026-05-26T10:10:00.000Z", payloadStub([refStub("task-sub-1"), refStub("task-sub-2"), refStub("task-sub-3")], "success", "2026-05-26T10:10:00.000Z")),
    ]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.mergeCount, 2);
      assert.equal(state.subagentCount, 3);
      assert.equal(state.latestVerdict, "success");
      assert.equal(state.latestMergedAt, "2026-05-26T10:10:00.000Z");
      assert.equal(state.refs.length, 3);
    }
  });
});

describe("deriveMergePanelState — malformed latest payload", () => {
  it("surfaces merged state with malformedLatest:true and empty refs[]", () => {
    const reader: MergeReaderResponse = {
      ok: true,
      task_id: "task-parent",
      merged: true,
      merge_count: 1,
      latest: {
        event_id: 101,
        created_at: "2026-05-26T10:00:00.000Z",
        merge_verdict: null,
        merged_at: "2026-05-26T10:00:00.000Z",
        subagent_count: 0,
      },
      merges: [entryStub(101, "2026-05-26T10:00:00.000Z", null)],
    };
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.mergeCount, 1);
      assert.equal(state.subagentCount, 0);
      assert.equal(state.latestVerdict, null);
      assert.equal(state.refs.length, 0);
      assert.equal(state.malformedLatest, true);
      assert.equal(state.truncated, false);
    }
  });

  it("does not crash when latest payload has a non-array subagent_task_refs", () => {
    const broken = {
      parent_task_id: "task-parent",
      manager_agent_id: "agent-manager-1",
      subagent_task_refs: "not-an-array" as unknown as ManagerTaskMergedRef[],
      merge_verdict: "success" as const,
      merged_at: "2026-05-26T10:00:00.000Z",
    };
    const reader = readerStub([entryStub(101, "2026-05-26T10:00:00.000Z", broken as unknown as ManagerTaskMergedPayload)]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.refs.length, 0);
      assert.equal(state.truncated, false);
    }
  });
});

describe("deriveMergePanelState — ref truncation", () => {
  it("caps refs[] at MAX_REFS and flags truncated:true", () => {
    const refs: ManagerTaskMergedRef[] = [];
    for (let i = 0; i < MAX_REFS + 5; i++) {
      refs.push(refStub(`task-sub-${i}`));
    }
    const reader = readerStub([entryStub(101, "2026-05-26T10:00:00.000Z", payloadStub(refs))]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.refs.length, MAX_REFS);
      assert.equal(state.truncated, true);
      // subagent_count reflects the LATEST.subagent_count from the
      // server (full count), not the truncated visible list.
      assert.equal(state.subagentCount, MAX_REFS + 5);
    }
  });

  it("does not flag truncated when refs <= MAX_REFS", () => {
    const refs: ManagerTaskMergedRef[] = [];
    for (let i = 0; i < MAX_REFS; i++) refs.push(refStub(`task-sub-${i}`));
    const reader = readerStub([entryStub(101, "2026-05-26T10:00:00.000Z", payloadStub(refs))]);
    const state = deriveMergePanelState(input({ reader }));
    assert.equal(state.kind, "merged");
    if (state.kind === "merged") {
      assert.equal(state.refs.length, MAX_REFS);
      assert.equal(state.truncated, false);
    }
  });
});
