/**
 * pure descriptor contract tests: validator (reject malformed
 * / cyclic / over-cap descriptors), executor-owned id derivation, and
 * topological phase ordering.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  validateWorkflowDescriptor,
  orderPhasesByDependency,
  deriveExecutorRunId,
  deriveExecutorPhaseId,
  deriveExecutorAgentNodeId,
} from "./workflowDescriptor";

const twoPhase = {
  descriptor_id: "d1",
  name: "smoke",
  caps: { max_agents: 5, max_concurrency: 1 },
  phases: [
    { phase_id: "p1", name: "first", agents: [{ agent_id: "a", prompt: "do x" }] },
    {
      phase_id: "p2",
      name: "second",
      depends_on_phase_ids: ["p1"],
      agents: [{ agent_id: "b", prompt: "do y" }],
    },
  ],
};

describe("validateWorkflowDescriptor", () => {
  it("accepts a valid 2-phase descriptor with deps, returns order", () => {
    const r = validateWorkflowDescriptor(twoPhase);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.order, ["p1", "p2"]);
    assert.equal(r.total_agents, 2);
  });

  it("rejects empty phases", () => {
    const r = validateWorkflowDescriptor({ descriptor_id: "d", name: "n", phases: [] });
    assert.equal(r.ok, false);
  });

  it("rejects a phase with no agents", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      phases: [{ phase_id: "p1", name: "x", agents: [] }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects duplicate phase_ids", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      phases: [
        { phase_id: "p1", name: "a", agents: [{ agent_id: "x", prompt: "p" }] },
        { phase_id: "p1", name: "b", agents: [{ agent_id: "y", prompt: "p" }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("duplicate phase_id")));
  });

  it("rejects a dependency on a non-existent phase", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      phases: [
        { phase_id: "p1", name: "a", depends_on_phase_ids: ["nope"], agents: [{ agent_id: "x", prompt: "p" }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("unknown phase 'nope'")));
  });

  it("rejects a self-dependency", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      phases: [
        { phase_id: "p1", name: "a", depends_on_phase_ids: ["p1"], agents: [{ agent_id: "x", prompt: "p" }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("depends on itself")));
  });

  it("rejects total agents exceeding caps.max_agents (validation, not enforcement)", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      caps: { max_agents: 1 },
      phases: [
        { phase_id: "p1", name: "a", agents: [{ agent_id: "x", prompt: "p" }, { agent_id: "y", prompt: "p" }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("exceeds caps.max_agents")));
  });

  it("rejects a dependency cycle", () => {
    const r = validateWorkflowDescriptor({
      descriptor_id: "d",
      name: "n",
      phases: [
        { phase_id: "p1", name: "a", depends_on_phase_ids: ["p2"], agents: [{ agent_id: "x", prompt: "p" }] },
        { phase_id: "p2", name: "b", depends_on_phase_ids: ["p1"], agents: [{ agent_id: "y", prompt: "p" }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("cycle")));
  });
});

describe("orderPhasesByDependency", () => {
  it("orders a linear chain", () => {
    const r = orderPhasesByDependency([
      { phase_id: "c", depends_on_phase_ids: ["b"] },
      { phase_id: "b", depends_on_phase_ids: ["a"] },
      { phase_id: "a" },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.order, ["a", "b", "c"]);
  });

  it("preserves descriptor order for independent phases", () => {
    const r = orderPhasesByDependency([
      { phase_id: "x" },
      { phase_id: "y" },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.order, ["x", "y"]);
  });

  it("errors on a cycle", () => {
    const r = orderPhasesByDependency([
      { phase_id: "a", depends_on_phase_ids: ["b"] },
      { phase_id: "b", depends_on_phase_ids: ["a"] },
    ]);
    assert.equal(r.ok, false);
  });
});

describe("executor id derivation", () => {
  it("derives executor-owned ids distinct from an earlier revision (wfr-exec- prefix)", () => {
    const runId = deriveExecutorRunId("abc123");
    assert.equal(runId, "wfr-exec-abc123");
    assert.ok(!runId.startsWith("wfr-task-")); // not the 384 ad-hoc derivation
    const phaseId = deriveExecutorPhaseId(runId, "p1");
    assert.equal(phaseId, "wfr-exec-abc123-p-p1");
    assert.equal(deriveExecutorAgentNodeId(phaseId, 0), "wfr-exec-abc123-p-p1-a-0");
  });
});
