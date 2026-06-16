/**
 *  — subagent summary aggregation pure-helper tests.
 *
 * Three layers:
 *   1. UTF-8 byte cap for `reply_excerpt` (multi-byte char must not
 *      slip past a JS `.length` cap —  memo).
 *   2. `buildSubagentSummary` shape: passes through all fields,
 *      defaults `artifact_refs` to [], applies the byte cap.
 *   3. `filterSubagentSummariesForReader` permission boundary +
 *      parent_task_id / source_agent_id filters + limit clamp.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildSubagentSummary,
  capByUtf8Bytes,
  DEFAULT_SUMMARIES_LIMIT,
  filterSubagentSummariesForReader,
  MAX_REPLY_EXCERPT_BYTES,
  MAX_SUMMARIES_LIMIT,
  SUBAGENT_SUMMARY_EVENT_NAME,
  type SubagentSummary,
  type SubagentSummaryRow,
} from "./subagentSummaryOps";

const baseSummary: Omit<SubagentSummary, "source_agent_id" | "parent_task_id" | "task_id"> = {
  agent_id: "agent-subagent-x",
  artifact_refs: [],
  reply_excerpt: "done",
  completed_at: "2026-05-25T00:00:00.000Z",
};

function row(summary: SubagentSummary, ts = "2026-05-25T00:00:00.000Z"): SubagentSummaryRow {
  return { parent_task_id: summary.parent_task_id, payload: summary, recorded_at: ts };
}

describe("capByUtf8Bytes", () => {
  it("returns the input unchanged when under the cap", () => {
    assert.equal(capByUtf8Bytes("hello", 100), "hello");
  });

  it("caps multi-byte content by UTF-8 bytes, not JS length", () => {
    // '界' = 3 UTF-8 bytes per char. 700 chars = 2100 bytes.
    const input = "界".repeat(700);
    const out = capByUtf8Bytes(input, 500);
    const bytes = new TextEncoder().encode(out).byteLength;
    assert.ok(bytes <= 500, `expected <= 500 bytes, got ${bytes}`);
    // 500 bytes / 3 bytes per char = 166 chars (165 full + 2 spare bytes).
    assert.ok(out.length <= 166);
  });
});

describe("buildSubagentSummary", () => {
  it("applies the 500-byte cap on reply_excerpt with multi-byte content", () => {
    const summary = buildSubagentSummary({
      task_id: "task-1",
      agent_id: "agent-sub-1",
      parent_task_id: "task-parent-1",
      source_agent_id: "agent-mgr-1",
      reply_text: "界".repeat(700),
      completed_at: "2026-05-25T00:00:00.000Z",
    });
    const bytes = new TextEncoder().encode(summary.reply_excerpt).byteLength;
    assert.ok(
      bytes <= MAX_REPLY_EXCERPT_BYTES,
      `expected <= ${MAX_REPLY_EXCERPT_BYTES} bytes, got ${bytes}`,
    );
    assert.equal(summary.task_id, "task-1");
    assert.equal(summary.parent_task_id, "task-parent-1");
    assert.equal(summary.source_agent_id, "agent-mgr-1");
    assert.deepEqual(summary.artifact_refs, []);
  });

  it("preserves artifact_refs when provided", () => {
    const summary = buildSubagentSummary({
      task_id: "task-2",
      agent_id: "agent-sub-1",
      parent_task_id: "task-parent-1",
      source_agent_id: "agent-mgr-1",
      reply_text: "ok",
      completed_at: "2026-05-25T00:00:00.000Z",
      artifact_refs: [
        {
          agent_id: "agent-sub-1",
          task_id: "task-2",
          artifact_id: "art-1",
          kind: "summary",
        },
      ],
    });
    assert.equal(summary.artifact_refs.length, 1);
    assert.equal(summary.artifact_refs[0]!.artifact_id, "art-1");
  });

  it("preserves the event name constant", () => {
    assert.equal(SUBAGENT_SUMMARY_EVENT_NAME, "manager.subagent.summary");
  });
});

describe("filterSubagentSummariesForReader — permission boundary", () => {
  const own: SubagentSummary = {
    ...baseSummary,
    task_id: "task-own-1",
    parent_task_id: "task-parent-A",
    source_agent_id: "agent-mgr-A",
  };
  const other: SubagentSummary = {
    ...baseSummary,
    task_id: "task-other-1",
    parent_task_id: "task-parent-B",
    source_agent_id: "agent-mgr-B",
  };

  it("returns own work only when caller is manager A", () => {
    const out = filterSubagentSummariesForReader([row(own), row(other)], "agent-mgr-A");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.task_id, "task-own-1");
  });

  it("returns empty list for a manager that issued nothing", () => {
    const out = filterSubagentSummariesForReader([row(own), row(other)], "agent-mgr-C");
    assert.deepEqual(out, []);
  });

  it("returns empty list (not error) for cross-manager parent_task_id query", () => {
    // Manager B asks for Manager A's parent_task_id.
    const out = filterSubagentSummariesForReader([row(own)], "agent-mgr-B", {
      parent_task_id: "task-parent-A",
    });
    assert.deepEqual(out, []);
  });
});

describe("filterSubagentSummariesForReader — filters and limit", () => {
  const summaries: SubagentSummary[] = Array.from({ length: 60 }, (_, i) => ({
    ...baseSummary,
    task_id: `task-${i}`,
    parent_task_id: i < 30 ? "task-parent-X" : "task-parent-Y",
    source_agent_id: "agent-mgr-A",
  }));

  it("clamps limit to MAX_SUMMARIES_LIMIT even if caller requests more", () => {
    const out = filterSubagentSummariesForReader(
      summaries.map((s) => row(s)),
      "agent-mgr-A",
      { limit: 999 },
    );
    assert.equal(out.length, MAX_SUMMARIES_LIMIT);
  });

  it("uses DEFAULT_SUMMARIES_LIMIT when limit omitted", () => {
    const out = filterSubagentSummariesForReader(
      summaries.map((s) => row(s)),
      "agent-mgr-A",
    );
    assert.equal(out.length, DEFAULT_SUMMARIES_LIMIT);
  });

  it("filters by parent_task_id", () => {
    const out = filterSubagentSummariesForReader(
      summaries.map((s) => row(s)),
      "agent-mgr-A",
      { parent_task_id: "task-parent-Y", limit: 50 },
    );
    assert.equal(out.length, 30);
    for (const s of out) assert.equal(s.parent_task_id, "task-parent-Y");
  });

  it("filters by source_agent_id (after permission boundary)", () => {
    const mixed: SubagentSummary[] = [
      { ...baseSummary, task_id: "t1", parent_task_id: "p1", source_agent_id: "agent-mgr-A" },
      { ...baseSummary, task_id: "t2", parent_task_id: "p1", source_agent_id: "agent-mgr-A" },
      { ...baseSummary, task_id: "t3", parent_task_id: "p1", source_agent_id: "agent-mgr-B" },
    ];
    const out = filterSubagentSummariesForReader(
      mixed.map((s) => row(s)),
      "agent-mgr-A",
      { source_agent_id: "agent-mgr-A" },
    );
    assert.equal(out.length, 2);
    for (const s of out) assert.equal(s.source_agent_id, "agent-mgr-A");
  });

  it("preserves input ordering (caller is responsible for sorting)", () => {
    const a: SubagentSummary = {
      ...baseSummary,
      task_id: "task-a",
      parent_task_id: "p1",
      source_agent_id: "agent-mgr-A",
    };
    const b: SubagentSummary = {
      ...baseSummary,
      task_id: "task-b",
      parent_task_id: "p1",
      source_agent_id: "agent-mgr-A",
    };
    const out = filterSubagentSummariesForReader([row(b), row(a)], "agent-mgr-A");
    assert.deepEqual(out.map((s) => s.task_id), ["task-b", "task-a"]);
  });
});
