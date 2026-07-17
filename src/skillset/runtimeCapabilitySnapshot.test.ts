/**
 * runtime capability snapshot derivation tests.
 *
 * Pure helper coverage: runtime state branching (loaded / disabled /
 * rejected / absent priority), count derivations, tier distribution,
 * and cap pass-through. Frontend rendering is covered by the route
 * itself; per an earlier revision §86, no DOM harness exists yet so route-level
 * tests are deferred.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveRuntimeCapabilitySnapshot,
  resolveRuntimeState,
  type RuntimeSummaryInput,
  type ToolContractInput,
  type DetailEntryInput,
} from "./runtimeCapabilitySnapshot";

const SKILLSET_A = "skillset.a";
const SKILLSET_B = "skillset.b";

function summary(over: Partial<RuntimeSummaryInput> = {}): RuntimeSummaryInput {
  return {
    skillset_ids: { loaded: [], disabled: [], rejected: [] },
    disabled: [],
    agent_tools: [],
    total_soul_token_estimate: 0,
    total_soul_token_cap: 0,
    per_skillset_token_cap: 0,
    ...over,
  };
}

function tool(over: Partial<ToolContractInput> = {}): ToolContractInput {
  return {
    tier: 1,
    approval_required: false,
    implemented: true,
    emit_events: [],
    ...over,
  };
}

function detail(skillIds: string[]): DetailEntryInput {
  return { skills: skillIds.map((id) => ({ id })) };
}

describe("resolveRuntimeState", () => {
  it("returns absent when runtime is null", () => {
    const r = resolveRuntimeState(SKILLSET_A, null);
    assert.equal(r.state, "absent");
    assert.equal(r.reason, null);
    assert.equal(r.raw, null);
  });

  it("returns absent when id is in none of the partitions", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: { loaded: [SKILLSET_B], disabled: [], rejected: [] },
    }));
    assert.equal(r.state, "absent");
  });

  it("returns loaded when id is in loaded partition", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: { loaded: [SKILLSET_A], disabled: [], rejected: [] },
    }));
    assert.equal(r.state, "loaded");
  });

  it("returns rejected when id is in rejected partition", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: { loaded: [], disabled: [], rejected: [SKILLSET_A] },
    }));
    assert.equal(r.state, "rejected");
  });

  it("returns disabled with reason when id is in disabled partition", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: { loaded: [], disabled: [SKILLSET_A], rejected: [] },
      disabled: [{ skillset_id: SKILLSET_A, reason: "operator-disabled" }],
    }));
    assert.equal(r.state, "disabled");
    assert.equal(r.reason, "operator-disabled");
  });

  it("disabled outranks rejected and loaded when id appears in multiple partitions", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: {
        loaded: [SKILLSET_A],
        disabled: [SKILLSET_A],
        rejected: [SKILLSET_A],
      },
      disabled: [{ skillset_id: SKILLSET_A, reason: null }],
    }));
    assert.equal(r.state, "disabled");
    assert.equal(r.reason, null);
  });

  it("exposes raw partition flags for downstream debug rendering", () => {
    const r = resolveRuntimeState(SKILLSET_A, summary({
      skillset_ids: { loaded: [SKILLSET_A], disabled: [], rejected: [] },
    }));
    assert.deepEqual(r.raw, {
      in_loaded: true,
      in_disabled: false,
      in_rejected: false,
      reason: null,
    });
  });
});

describe("deriveRuntimeCapabilitySnapshot", () => {
  it("returns zeroed snapshot with absent state when nothing is known", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: null,
      toolRows: [],
      runtime: null,
    });
    assert.equal(snap.state, "absent");
    assert.equal(snap.reason, null);
    assert.deepEqual(snap.counts, {
      declared_skills: 0,
      tool_contracts: 0,
      active_agent_bindings: 0,
      approval_required: 0,
      not_implemented: 0,
      no_handler: 0,
      event_emitting: 0,
    });
    assert.deepEqual(snap.tier_distribution, {});
    assert.equal(snap.caps, null);
  });

  it("counts declared skills, tool contracts, and tier distribution", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: detail(["skill.one", "skill.two", "skill.three"]),
      toolRows: [
        tool({ tier: 1 }),
        tool({ tier: 1 }),
        tool({ tier: 2 }),
        tool({ tier: 3 }),
      ],
      runtime: summary({
        skillset_ids: { loaded: [SKILLSET_A], disabled: [], rejected: [] },
      }),
    });
    assert.equal(snap.state, "loaded");
    assert.equal(snap.counts.declared_skills, 3);
    assert.equal(snap.counts.tool_contracts, 4);
    assert.deepEqual(snap.tier_distribution, { "1": 2, "2": 1, "3": 1 });
  });

  it("counts approval-required, not-implemented, and event-emitting tools", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: null,
      toolRows: [
        tool({ approval_required: true }),
        tool({ approval_required: true, implemented: false }),
        tool({ implemented: false }),
        tool({ emit_events: ["evt.a", "evt.b"] }),
        tool(),
      ],
      runtime: null,
    });
    assert.equal(snap.counts.approval_required, 2);
    assert.equal(snap.counts.not_implemented, 2);
    assert.equal(snap.counts.event_emitting, 1);
  });

  it("counts active-agent bindings and no-handler bindings scoped to this skillset", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: null,
      toolRows: [],
      runtime: summary({
        skillset_ids: { loaded: [SKILLSET_A], disabled: [], rejected: [] },
        agent_tools: [
          { skillset_id: SKILLSET_A, has_handler: true },
          { skillset_id: SKILLSET_A, has_handler: true },
          { skillset_id: SKILLSET_A, has_handler: false },
          { skillset_id: SKILLSET_B, has_handler: false },
        ],
      }),
    });
    assert.equal(snap.counts.active_agent_bindings, 3);
    assert.equal(snap.counts.no_handler, 1);
  });

  it("passes through SOUL caps when runtime is available", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: null,
      toolRows: [],
      runtime: summary({
        total_soul_token_estimate: 1500,
        total_soul_token_cap: 8000,
        per_skillset_token_cap: 2000,
      }),
    });
    assert.deepEqual(snap.caps, {
      per_skillset_token_cap: 2000,
      total_soul_token_estimate: 1500,
      total_soul_token_cap: 8000,
    });
  });

  it("propagates disabled state and reason", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: detail(["skill.one"]),
      toolRows: [tool()],
      runtime: summary({
        skillset_ids: { loaded: [], disabled: [SKILLSET_A], rejected: [] },
        disabled: [{ skillset_id: SKILLSET_A, reason: "policy-block" }],
      }),
    });
    assert.equal(snap.state, "disabled");
    assert.equal(snap.reason, "policy-block");
    // Counts continue to reflect declared contracts even when disabled
    assert.equal(snap.counts.declared_skills, 1);
    assert.equal(snap.counts.tool_contracts, 1);
  });

  it("propagates rejected state without leaking other skillsets' bindings", () => {
    const snap = deriveRuntimeCapabilitySnapshot({
      id: SKILLSET_A,
      detailEntry: null,
      toolRows: [],
      runtime: summary({
        skillset_ids: { loaded: [SKILLSET_B], disabled: [], rejected: [SKILLSET_A] },
        agent_tools: [{ skillset_id: SKILLSET_B, has_handler: true }],
      }),
    });
    assert.equal(snap.state, "rejected");
    assert.equal(snap.counts.active_agent_bindings, 0);
  });
});
