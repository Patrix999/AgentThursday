import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildSubagentInsightPayload,
  filterInsightsByOwner,
  insightsToCandidates,
  MAX_INSIGHTS_PER_PUSH,
  MAX_INGEST_CANDIDATES,
  type SubagentInsightPayload,
} from "./subagentInsightOps";

const mk = (owner: string, insights: Array<{ type: string; content: string; confidence: number }>, src = "agent-sub"): SubagentInsightPayload => ({
  parent_task_id: "task-parent",
  source_agent_id: src,
  owner_user_id: owner,
  insights,
  completed_at: "2026-07-01T00:00:00.000Z",
});

describe("buildSubagentInsightPayload", () => {
  it("caps insights to MAX_INSIGHTS_PER_PUSH", () => {
    const many = Array.from({ length: MAX_INSIGHTS_PER_PUSH + 5 }, (_, i) => ({ type: "fact", content: `c${i}`, confidence: 0.9 }));
    const p = buildSubagentInsightPayload({ parent_task_id: "t", source_agent_id: "a", owner_user_id: "u", insights: many, completed_at: "x" });
    assert.equal(p.insights.length, MAX_INSIGHTS_PER_PUSH);
  });
});

describe("filterInsightsByOwner — fail-closed (an earlier revision d)", () => {
  const payloads = [mk("user-alice", [{ type: "fact", content: "a", confidence: 0.9 }]), mk("user-bob", [{ type: "fact", content: "b", confidence: 0.9 }])];
  it("keeps only same-owner payloads", () => {
    const r = filterInsightsByOwner(payloads, "user-alice");
    assert.equal(r.length, 1);
    assert.equal(r[0].owner_user_id, "user-alice");
  });
  it("a different-owner subagent insight never crosses (cross-owner not promoted)", () => {
    assert.deepEqual(filterInsightsByOwner(payloads, "user-carol"), []);
  });
  it("empty / missing parent owner → drops everything (fail-closed, never fail-open)", () => {
    assert.deepEqual(filterInsightsByOwner(payloads, ""), []);
  });
});

describe("insightsToCandidates — provenance + bounds", () => {
  it("tags source=subagent:<id> and maps type", () => {
    const cands = insightsToCandidates([mk("u", [
      { type: "instruction", content: "always X", confidence: 0.9 },
      { type: "fact", content: "Y is true", confidence: 0.85 },
    ], "agent-42")]);
    assert.equal(cands.length, 2);
    assert.equal(cands[0].source, "subagent:agent-42");
    assert.equal(cands[0].type, "instruction");
    assert.equal(cands[1].type, "fact");
    assert.equal(cands[1].content, "Y is true");
  });
  it("skips blank content", () => {
    assert.equal(insightsToCandidates([mk("u", [{ type: "fact", content: "   ", confidence: 0.9 }])]).length, 0);
  });
  it("bounds total candidates to MAX_INGEST_CANDIDATES", () => {
    const big = mk("u", Array.from({ length: MAX_INGEST_CANDIDATES + 10 }, (_, i) => ({ type: "fact", content: `c${i}`, confidence: 0.9 })));
    assert.equal(insightsToCandidates([big]).length, MAX_INGEST_CANDIDATES);
  });
});
