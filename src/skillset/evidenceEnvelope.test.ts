/**
 *  — seal() gate-evidence reason coverage.
 *
 * B: a real `repo.write` / `repo.patch` in the execution ring with an
 *    empty evidence ring (no gate logs) must seal `fail` with the
 *    dedicated reason `missing_gate_evidence` — distinct from the
 *    generic `envelope missing required ring(s)` and from
 *    `missing_mutation_evidence` (never wrote).
 * C: the evidence ring is gate-logs-only; write/patch diffs are NOT
 *    promoted (addDiffEvidence is intentionally unwired), so a mutation
 *    that skips gates correctly leaves the ring "missing".
 *
 * Regression guards: the two  C `missing_mutation_evidence`
 * paths (empty execution; execution present but read-only) and the
 *  failing-gate path are unaffected by the new branch.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { EnvelopeStore, type IntentEnvelope } from "./evidenceEnvelope";
import type { GateResult } from "./gateRunner";

const INTENT: IntentEnvelope = {
  source: "human_directive",
  source_ref: "task-380a-test",
  declared_goal: "implement the unified primary nav component",
  expected_output: [],
};

function draft(store: EnvelopeStore): string {
  return store.createDraft({
    task_id: "task-380a-test",
    skillset_id: "software-dev",
    agent_id: "agent-test",
    intent: INTENT,
  }).envelope_id;
}

function addTool(store: EnvelopeStore, id: string, toolId: string): number {
  const step = store.addExecution(id, {
    tool_call: {
      tool_id: toolId,
      input_hash: "h",
      dispatched_at: new Date().toISOString(),
    },
    tool_result: {
      status: "ok",
      finished_at: new Date().toISOString(),
      duration_ms: 1,
    },
  });
  assert.ok(step, "addExecution should accept on a draft envelope");
  return step.step_index;
}

function gate(target: "typecheck" | "build", exit_code: number): GateResult {
  return {
    ok: exit_code === 0,
    target,
    tool_id: `gate.${target}`,
    command: `npm run ${target}`,
    exit_code,
    stdout: "",
    stderr: exit_code === 0 ? "" : "boom",
    duration_ms: 1,
    truncated: { stdout: false, stderr: false },
    backend: "stub",
  };
}

describe(" seal() missing_gate_evidence", () => {
  it("B: write/patch in execution + no gate evidence → missing_gate_evidence", () => {
    const store = new EnvelopeStore();
    const id = draft(store);
    addTool(store, id, "repo.prepare");
    addTool(store, id, "repo.write");
    addTool(store, id, "repo.patch");
    const sealed = store.seal(id, ["repo.prepare", "repo.write", "repo.patch"], {
      mutationToolsExpected: true,
    });
    assert.ok(sealed);
    assert.equal(sealed.self_verify?.verdict, "fail");
    assert.equal(sealed.self_verify?.verdict_reason, "missing_gate_evidence");
    // C: the diff lived in execution[], never promoted to evidence.diff.
    assert.equal(sealed.evidence.diff, undefined);
    assert.equal(sealed.self_verify?.required_envelope_check.evidence, "missing");
    // Not fabricated — the agent really dispatched what it claimed.
    assert.deepEqual(sealed.self_verify?.fabricated_tools, []);
  });

  it("regression: mutation intent + empty execution → missing_mutation_evidence", () => {
    const store = new EnvelopeStore();
    const id = draft(store);
    const sealed = store.seal(id, [], { mutationToolsExpected: true });
    assert.ok(sealed);
    assert.equal(sealed.self_verify?.verdict, "fail");
    assert.equal(sealed.self_verify?.verdict_reason, "missing_mutation_evidence");
  });

  it("regression: mutation intent + read-only execution (no write) → missing_mutation_evidence", () => {
    const store = new EnvelopeStore();
    const id = draft(store);
    addTool(store, id, "repo.read");
    const gIdx = addTool(store, id, "gate.typecheck");
    // Evidence ring present (a gate ran) so the ring-missing block is
    // skipped — the seal must still fail because no mutation tool landed.
    store.addGateEvidence(id, gate("typecheck", 0), gIdx);
    const sealed = store.seal(id, ["repo.read", "gate.typecheck"], {
      mutationToolsExpected: true,
    });
    assert.ok(sealed);
    assert.equal(sealed.self_verify?.verdict, "fail");
    assert.equal(sealed.self_verify?.verdict_reason, "missing_mutation_evidence");
  });

  it("success: write + passing gate evidence → pass (evidence ring satisfied by gate logs)", () => {
    const store = new EnvelopeStore();
    const id = draft(store);
    addTool(store, id, "repo.write");
    const gIdx = addTool(store, id, "gate.typecheck");
    store.addGateEvidence(id, gate("typecheck", 0), gIdx);
    const sealed = store.seal(id, ["repo.write", "gate.typecheck"], {
      mutationToolsExpected: true,
    });
    assert.ok(sealed);
    assert.equal(sealed.self_verify?.verdict, "pass");
    assert.equal(sealed.self_verify?.required_envelope_check.evidence, "present");
  });

  it("edge: write + FAILING gate → gate-failed reason, not missing_gate_evidence", () => {
    const store = new EnvelopeStore();
    const id = draft(store);
    addTool(store, id, "repo.write");
    const gIdx = addTool(store, id, "gate.typecheck");
    store.addGateEvidence(id, gate("typecheck", 1), gIdx);
    const sealed = store.seal(id, ["repo.write", "gate.typecheck"], {
      mutationToolsExpected: true,
    });
    assert.ok(sealed);
    assert.equal(sealed.self_verify?.verdict, "fail");
    assert.match(sealed.self_verify?.verdict_reason ?? "", /^gate failed: typecheck exit 1$/);
    assert.notEqual(sealed.self_verify?.verdict_reason, "missing_gate_evidence");
  });
});
