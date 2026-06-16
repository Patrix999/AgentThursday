/**
 *  — pure workflow run model tests. Proves the contract is
 * deterministic and that the `run -> phases -> agents` tree is folded
 * ONLY from structured ledger rows (never inferred): the assembler
 * takes typed rows and never touches `manager.task.*` events.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveWorkflowRunId,
  deriveDefaultPhaseId,
  deriveAgentNodeId,
  safePromptPreview,
  assembleWorkflowRunTree,
  parseCaps,
  PROMPT_PREVIEW_MAX,
  WORKFLOW_DEFAULT_PHASE_NAME,
  type WorkflowRunRow,
  type WorkflowPhaseRow,
  type WorkflowAgentRow,
} from "./workflowRunModel";

function runRow(over: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    run_id: "wfr-task-A",
    source_task_id: "task-A",
    root_agent_id: "agent-mgr",
    status: "active",
    caps: null,
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:01.000Z",
    ...over,
  };
}
function phaseRow(over: Partial<WorkflowPhaseRow> = {}): WorkflowPhaseRow {
  return {
    phase_id: "wfp-wfr-task-A-subagents",
    run_id: "wfr-task-A",
    name: WORKFLOW_DEFAULT_PHASE_NAME,
    status: "active",
    phase_order: 0,
    depends_on_phase_ids: null,
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    ...over,
  };
}
function agentRow(over: Partial<WorkflowAgentRow> = {}): WorkflowAgentRow {
  return {
    agent_node_id: "wfa-wfr-task-A-task-S1",
    run_id: "wfr-task-A",
    phase_id: "wfp-wfr-task-A-subagents",
    agent_id: "agent-s1",
    task_id: "task-S1",
    status: "dispatched",
    prompt_preview: "do the thing",
    result_summary: null,
    failure_reason: null,
    retry_state: null,
    rough_token_count: null,
    rough_cost: null,
    created_at: "2026-06-03T00:00:00.500Z",
    updated_at: "2026-06-03T00:00:00.500Z",
    ...over,
  };
}

describe("workflow id derivation (stable contract)", () => {
  it("derives deterministic, stable ids", () => {
    const runId = deriveWorkflowRunId("task-A");
    assert.equal(runId, "wfr-task-A");
    assert.equal(deriveDefaultPhaseId(runId), "wfp-wfr-task-A-subagents");
    assert.equal(deriveAgentNodeId(runId, "task-S1"), "wfa-wfr-task-A-task-S1");
    // same inputs → same ids (idempotent upsert key)
    assert.equal(deriveWorkflowRunId("task-A"), runId);
  });
});

describe("safePromptPreview", () => {
  it("collapses whitespace and bounds length", () => {
    assert.equal(safePromptPreview("  hello   world \n"), "hello world");
    const long = "x".repeat(PROMPT_PREVIEW_MAX + 50);
    const p = safePromptPreview(long)!;
    assert.equal(p.length, PROMPT_PREVIEW_MAX + 1); // capped slice + ellipsis
    assert.ok(p.endsWith("…"));
  });
  it("returns null for empty / non-string", () => {
    assert.equal(safePromptPreview(""), null);
    assert.equal(safePromptPreview("   "), null);
    assert.equal(safePromptPreview(null), null);
    assert.equal(safePromptPreview(undefined), null);
  });
});

describe("parseCaps", () => {
  it("parses caps json; null when absent/garbage", () => {
    assert.deepEqual(parseCaps('{"max_agents":5,"max_concurrency":2}'), {
      max_agents: 5,
      max_concurrency: 2,
    });
    assert.deepEqual(parseCaps('{"max_agents":5}'), { max_agents: 5, max_concurrency: null });
    assert.equal(parseCaps(null), null);
    assert.equal(parseCaps("not json"), null);
  });
});

describe("assembleWorkflowRunTree", () => {
  it("folds rows into run -> phases -> agents (one phase, one agent)", () => {
    const tree = assembleWorkflowRunTree(runRow(), [phaseRow()], [agentRow()]);
    assert.equal(tree.run_id, "wfr-task-A");
    assert.equal(tree.root_agent_id, "agent-mgr");
    assert.equal(tree.phases.length, 1);
    assert.equal(tree.phases[0].name, "subagents");
    assert.equal(tree.phases[0].agents.length, 1);
    assert.equal(tree.phases[0].agents[0].task_id, "task-S1");
    assert.equal(tree.phases[0].agents[0].status, "dispatched");
  });

  it("orders phases by phase_order and groups agents to the right phase", () => {
    const tree = assembleWorkflowRunTree(
      runRow(),
      [
        phaseRow({ phase_id: "p2", name: "second", phase_order: 1 }),
        phaseRow({ phase_id: "p1", name: "first", phase_order: 0 }),
      ],
      [
        agentRow({ agent_node_id: "a2", phase_id: "p2", task_id: "task-2", created_at: "2026-06-03T00:00:02.000Z" }),
        agentRow({ agent_node_id: "a1", phase_id: "p1", task_id: "task-1", created_at: "2026-06-03T00:00:01.000Z" }),
      ],
    );
    assert.deepEqual(tree.phases.map((p) => p.name), ["first", "second"]);
    assert.deepEqual(tree.phases[0].agents.map((a) => a.task_id), ["task-1"]);
    assert.deepEqual(tree.phases[1].agents.map((a) => a.task_id), ["task-2"]);
  });

  it("does NOT fabricate phases: no phase rows → empty phases (even with agent rows)", () => {
    const tree = assembleWorkflowRunTree(runRow(), [], [agentRow()]);
    assert.deepEqual(tree.phases, []);
  });

  it("orders agents within a phase by created_at", () => {
    const tree = assembleWorkflowRunTree(
      runRow(),
      [phaseRow()],
      [
        agentRow({ agent_node_id: "late", task_id: "task-late", created_at: "2026-06-03T00:00:09.000Z" }),
        agentRow({ agent_node_id: "early", task_id: "task-early", created_at: "2026-06-03T00:00:01.000Z" }),
      ],
    );
    assert.deepEqual(tree.phases[0].agents.map((a) => a.task_id), ["task-early", "task-late"]);
  });

  it("surfaces caps + result/failure fields", () => {
    const tree = assembleWorkflowRunTree(
      runRow({ caps: '{"max_agents":3,"max_concurrency":1}' }),
      [phaseRow()],
      [
        agentRow({ agent_node_id: "ok", task_id: "task-ok", status: "replied", result_summary: "done" }),
        agentRow({ agent_node_id: "bad", task_id: "task-bad", status: "failed", failure_reason: "boom", created_at: "2026-06-03T00:00:00.600Z" }),
      ],
    );
    assert.deepEqual(tree.caps, { max_agents: 3, max_concurrency: 1 });
    const byTask = Object.fromEntries(tree.phases[0].agents.map((a) => [a.task_id, a]));
    assert.equal(byTask["task-ok"].result_summary, "done");
    assert.equal(byTask["task-bad"].failure_reason, "boom");
  });
});
