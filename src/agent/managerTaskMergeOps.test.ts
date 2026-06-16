/**
 *  — `manager.task.merged` emitter pure-helper tests.
 *
 * Covers the audit-grade merge emitter contract:
 *   1. Happy path: valid refs → record + payload echo.
 *   2. Status derivation unchanged: `received → started → merged →
 *      replied` still derives `replied` ( invariant).
 *   3. Permission negative: cross-manager refs → permission_denied.
 *   4. Bad-ref negatives: nonexistent summary_id → summary_not_found;
 *      task_id/agent_id mismatch → ref_mismatch.
 *   5. Zero-ref legality (ADR §4.2): empty refs still emit a payload
 *      with `subagent_count = 0`.
 *   6. Field validation: invalid verdict / empty parent_task_id /
 *      non-array refs / missing per-ref fields.
 *   7. `manager_agent_id` forging guard: helper always derives from
 *      callingAgentId, never trusts input.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  emitManagerTaskMerged,
  MANAGER_TASK_MERGED_EVENT_NAME,
  type ManagerTaskMergeInput,
  type ManagerTaskMergeRegistrySurface,
  type ManagerTaskMergedPayload,
} from "./managerTaskMergeOps";
import type {
  SubagentSummary,
  SubagentSummaryRow,
} from "./subagentSummaryOps";
import {
  deriveManagerTaskStatus,
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";

const MANAGER_ID = "agent-mgr-1";
const OTHER_MANAGER_ID = "agent-mgr-2";
const SUBAGENT_ID = "agent-sub-1";
const PARENT_TASK_ID = "task-parent-1";
const SUBAGENT_TASK_ID = "task-sub-1";

function buildSummaryRow(opts: {
  parent_task_id?: string;
  source_agent_id?: string;
  agent_id?: string;
  task_id?: string;
}): SubagentSummaryRow {
  const payload: SubagentSummary = {
    task_id: opts.task_id ?? SUBAGENT_TASK_ID,
    agent_id: opts.agent_id ?? SUBAGENT_ID,
    parent_task_id: opts.parent_task_id ?? PARENT_TASK_ID,
    source_agent_id: opts.source_agent_id ?? MANAGER_ID,
    artifact_refs: [],
    reply_excerpt: "subagent done",
    completed_at: "2026-05-26T00:00:00.000Z",
  };
  return {
    parent_task_id: payload.parent_task_id,
    payload,
    recorded_at: "2026-05-26T00:00:00.000Z",
  };
}

interface CapturedWrite {
  parentTaskId: string;
  payload: ManagerTaskMergedPayload;
}

function buildRegistry(rows: SubagentSummaryRow[]): {
  registry: ManagerTaskMergeRegistrySurface;
  writes: CapturedWrite[];
} {
  const writes: CapturedWrite[] = [];
  const registry: ManagerTaskMergeRegistrySurface = {
    readSubagentSummaries: async () => rows,
    recordManagerTaskMerged: (parentTaskId, payload) => {
      writes.push({ parentTaskId, payload });
    },
  };
  return { registry, writes };
}

const happyInput: ManagerTaskMergeInput = {
  parent_task_id: PARENT_TASK_ID,
  subagent_task_refs: [
    {
      task_id: SUBAGENT_TASK_ID,
      agent_id: SUBAGENT_ID,
      summary_id: SUBAGENT_TASK_ID, // v1: summary_id == subagent task_id
      verdict: "success",
    },
  ],
  merge_verdict: "success",
  merged_at: "2026-05-26T12:00:00.000Z",
};

describe("emitManagerTaskMerged — happy path", () => {
  it("records manager.task.merged with the validated payload", async () => {
    const { registry, writes } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(registry, happyInput, MANAGER_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.task_id, PARENT_TASK_ID);
      assert.equal(result.parent_task_id, PARENT_TASK_ID);
      assert.equal(result.merge_verdict, "success");
      assert.equal(result.subagent_count, 1);
      assert.equal(result.merged_at, "2026-05-26T12:00:00.000Z");
      assert.equal(result.payload.manager_agent_id, MANAGER_ID);
      assert.equal(result.payload.subagent_task_refs.length, 1);
      assert.equal(result.payload.subagent_task_refs[0]?.superseded_by, null);
    }
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.parentTaskId, PARENT_TASK_ID);
    assert.equal(writes[0]?.payload.merge_verdict, "success");
  });

  it("auto-fills merged_at via the supplied now() when omitted", async () => {
    const fixedNow = new Date("2026-05-26T13:30:00.000Z");
    const { registry } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        parent_task_id: PARENT_TASK_ID,
        subagent_task_refs: happyInput.subagent_task_refs,
        merge_verdict: "success",
      },
      MANAGER_ID,
      () => fixedNow,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.merged_at, fixedNow.toISOString());
      assert.equal(result.payload.merged_at, fixedNow.toISOString());
    }
  });

  it("derives manager_agent_id from callingAgentId, never from input", async () => {
    const { registry, writes } = buildRegistry([buildSummaryRow({})]);
    const inputWithForge = {
      ...happyInput,
      // @ts-expect-error — guard: input has no manager_agent_id field
      manager_agent_id: OTHER_MANAGER_ID,
    };
    const result = await emitManagerTaskMerged(
      registry,
      inputWithForge as ManagerTaskMergeInput,
      MANAGER_ID,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.manager_agent_id, MANAGER_ID);
    }
    assert.equal(writes[0]?.payload.manager_agent_id, MANAGER_ID);
  });
});

describe("manager.task.merged +  status derivation", () => {
  it("does not alter terminal status when interleaved with received/started/replied", () => {
    const events: ManagerTaskEventRow[] = [
      {
        type: MANAGER_TASK_EVENT_NAMES.received,
        ts: "2026-05-26T12:00:00.000Z",
      },
      {
        type: MANAGER_TASK_EVENT_NAMES.started,
        ts: "2026-05-26T12:00:01.000Z",
      },
      {
        type: MANAGER_TASK_EVENT_NAMES.merged,
        ts: "2026-05-26T12:00:02.000Z",
      },
      {
        type: MANAGER_TASK_EVENT_NAMES.replied,
        ts: "2026-05-26T12:00:03.000Z",
        payload: { reply: "done", envelope_id: "env-1" },
      },
    ];
    const derived = deriveManagerTaskStatus(events, new Date("2026-05-26T12:00:04.000Z"));
    assert.equal(derived.status, "replied");
    assert.equal(derived.completed_at, "2026-05-26T12:00:03.000Z");
    assert.equal(derived.reply, "done");
  });

  it("does not promote merged alone into a terminal status", () => {
    const events: ManagerTaskEventRow[] = [
      {
        type: MANAGER_TASK_EVENT_NAMES.received,
        ts: "2026-05-26T12:00:00.000Z",
      },
      {
        type: MANAGER_TASK_EVENT_NAMES.started,
        ts: "2026-05-26T12:00:01.000Z",
      },
      {
        type: MANAGER_TASK_EVENT_NAMES.merged,
        ts: "2026-05-26T12:00:02.000Z",
      },
    ];
    const derived = deriveManagerTaskStatus(events, new Date("2026-05-26T12:00:03.000Z"));
    assert.equal(derived.status, "in_progress");
    assert.equal(derived.completed_at, null);
  });
});

describe("emitManagerTaskMerged — permission and ref negatives", () => {
  it("rejects cross-manager refs with permission_denied", async () => {
    const { registry, writes } = buildRegistry([
      buildSummaryRow({ source_agent_id: OTHER_MANAGER_ID }),
    ]);
    const result = await emitManagerTaskMerged(registry, happyInput, MANAGER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "permission_denied");
    }
    assert.equal(writes.length, 0);
  });

  it("returns summary_not_found when no row exists for parent_task_id+summary_id", async () => {
    const { registry, writes } = buildRegistry([]);
    const result = await emitManagerTaskMerged(registry, happyInput, MANAGER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "summary_not_found");
    }
    assert.equal(writes.length, 0);
  });

  it("returns ref_mismatch when ref.task_id does not match summary.task_id", async () => {
    const { registry, writes } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        subagent_task_refs: [
          {
            task_id: "task-sub-wrong",
            agent_id: SUBAGENT_ID,
            summary_id: SUBAGENT_TASK_ID,
            verdict: "success",
          },
        ],
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ref_mismatch");
    }
    assert.equal(writes.length, 0);
  });

  it("returns ref_mismatch when ref.agent_id does not match summary.agent_id", async () => {
    const { registry, writes } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        subagent_task_refs: [
          {
            task_id: SUBAGENT_TASK_ID,
            agent_id: "agent-sub-wrong",
            summary_id: SUBAGENT_TASK_ID,
            verdict: "success",
          },
        ],
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ref_mismatch");
    }
    assert.equal(writes.length, 0);
  });
});

describe("emitManagerTaskMerged — zero-ref legality", () => {
  it("permits zero-ref merges (audit-only signal)", async () => {
    const { registry, writes } = buildRegistry([]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        parent_task_id: PARENT_TASK_ID,
        subagent_task_refs: [],
        merge_verdict: "partial",
        note: "no subagent work merged this turn",
      },
      MANAGER_ID,
      () => new Date("2026-05-26T14:00:00.000Z"),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.subagent_count, 0);
      assert.equal(result.payload.subagent_task_refs.length, 0);
      assert.equal(result.payload.note, "no subagent work merged this turn");
      assert.equal(result.merge_verdict, "partial");
    }
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.payload.subagent_task_refs.length, 0);
  });

  it("permits zero-ref merge with verdict=failed", async () => {
    const { registry, writes } = buildRegistry([]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        parent_task_id: PARENT_TASK_ID,
        subagent_task_refs: [],
        merge_verdict: "failed",
        note: "all subagents failed; no summaries to merge",
      },
      MANAGER_ID,
      () => new Date("2026-05-26T14:00:00.000Z"),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.merge_verdict, "failed");
    assert.equal(writes.length, 1);
  });

  //  — zero-ref + success is a hard validation failure.
  // Pre-376 this was silently accepted, papering over a broken
  // summary-aggregation chain (the operator saw "success" with no
  // subagent rows attached). Audit-only zero-ref merges remain legal
  // under partial / failed.
  it("rejects zero-ref merge with verdict=success ()", async () => {
    const { registry, writes } = buildRegistry([]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        parent_task_id: PARENT_TASK_ID,
        subagent_task_refs: [],
        merge_verdict: "success",
      },
      MANAGER_ID,
      () => new Date("2026-05-26T14:00:00.000Z"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "validation_failed");
      assert.match(result.error.message, /zero-ref merge cannot be success/);
      assert.match(result.error.message, /partial or merge_verdict=failed/);
    }
    // No row written when validation fails.
    assert.equal(writes.length, 0);
  });
});

describe("emitManagerTaskMerged — field validation", () => {
  it("rejects empty callingAgentId", async () => {
    const { registry } = buildRegistry([]);
    const result = await emitManagerTaskMerged(registry, happyInput, "");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects empty parent_task_id", async () => {
    const { registry } = buildRegistry([]);
    const result = await emitManagerTaskMerged(
      registry,
      { ...happyInput, parent_task_id: "" },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects non-array subagent_task_refs", async () => {
    const { registry } = buildRegistry([]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        // @ts-expect-error — runtime validation guard
        subagent_task_refs: "not-an-array",
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects invalid merge_verdict", async () => {
    const { registry } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        // @ts-expect-error — runtime validation guard
        merge_verdict: "approved",
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects invalid per-ref verdict", async () => {
    const { registry } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        subagent_task_refs: [
          {
            task_id: SUBAGENT_TASK_ID,
            agent_id: SUBAGENT_ID,
            summary_id: SUBAGENT_TASK_ID,
            // @ts-expect-error — runtime validation guard
            verdict: "approved",
          },
        ],
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects empty per-ref summary_id", async () => {
    const { registry } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      {
        ...happyInput,
        subagent_task_refs: [
          {
            task_id: SUBAGENT_TASK_ID,
            agent_id: SUBAGENT_ID,
            summary_id: "",
            verdict: "success",
          },
        ],
      },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });

  it("rejects an empty-string note (not undefined)", async () => {
    const { registry } = buildRegistry([buildSummaryRow({})]);
    const result = await emitManagerTaskMerged(
      registry,
      { ...happyInput, note: "" },
      MANAGER_ID,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "validation_failed");
  });
});

describe("MANAGER_TASK_MERGED_EVENT_NAME contract", () => {
  it("is the exact wire name 'manager.task.merged' (verifier grep target)", () => {
    assert.equal(MANAGER_TASK_MERGED_EVENT_NAME, "manager.task.merged");
  });

  it("matches MANAGER_TASK_EVENT_NAMES.merged so derivation + emitter stay in lockstep", () => {
    assert.equal(MANAGER_TASK_MERGED_EVENT_NAME, MANAGER_TASK_EVENT_NAMES.merged);
  });
});
