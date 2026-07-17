/**
 * named workflow helper tests.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  validateWorkflowName,
  substituteWorkflowArgs,
  substitutePhaseResults,
  summarizeDescriptorRow,
} from "./workflowNamed";

const DESC = {
  descriptor_id: "t",
  name: "T",
  phases: [
    {
      phase_id: "plan",
      name: "Plan",
      agents: [{ agent_id: "agent-1", prompt: "Plan for {{args.topic}} please." }],
    },
    {
      phase_id: "review",
      name: "Review",
      depends_on_phase_ids: ["plan"],
      agents: [
        { agent_id: "agent-2", prompt: "Review {{args.topic}} with focus {{args.focus}}." },
      ],
    },
  ],
};

describe("validateWorkflowName", () => {
  it("accepts kebab-case", () => {
    assert.equal(validateWorkflowName("site-build-draft"), true);
  });
  it("rejects uppercase, spaces, long, empty, non-string", () => {
    assert.equal(validateWorkflowName("Site"), false);
    assert.equal(validateWorkflowName("a b"), false);
    assert.equal(validateWorkflowName("a".repeat(65)), false);
    assert.equal(validateWorkflowName(""), false);
    assert.equal(validateWorkflowName(42), false);
  });
});

describe("substituteWorkflowArgs", () => {
  it("substitutes all placeholders across phases", () => {
    const r = substituteWorkflowArgs(DESC, { topic: "proof page", focus: "facts" });
    assert.equal(r.ok, true);
    const d = r.descriptor as typeof DESC;
    assert.equal(d.phases[0].agents[0].prompt, "Plan for proof page please.");
    assert.equal(d.phases[1].agents[0].prompt, "Review proof page with focus facts.");
  });

  it("fails fast listing every missing arg", () => {
    const r = substituteWorkflowArgs(DESC, { topic: "x" });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["focus"]);
  });

  it("ignores extra args and passes through placeholder-free descriptors", () => {
    const plain = { phases: [{ agents: [{ agent_id: "a", prompt: "static" }] }] };
    const r = substituteWorkflowArgs(plain, { unused: "y" });
    assert.equal(r.ok, true);
    assert.equal(
      (r.descriptor as typeof plain).phases[0].agents[0].prompt,
      "static",
    );
  });

  it("does not mutate the input descriptor", () => {
    const r = substituteWorkflowArgs(DESC, { topic: "z", focus: "w" });
    assert.equal(r.ok, true);
    assert.match(DESC.phases[0].agents[0].prompt, /\{\{args\.topic\}\}/);
  });
});

describe("summarizeDescriptorRow", () => {
  it("counts phases and agents", () => {
    const s = summarizeDescriptorRow({
      name: "t",
      version: 3,
      descriptor_json: JSON.stringify(DESC),
      created_by_agent_id: null,
      created_at: "2026-06-10T00:00:00Z",
      updated_at: "2026-06-10T01:00:00Z",
    });
    assert.deepEqual(s, {
      name: "t",
      version: 3,
      phase_count: 2,
      agent_count: 2,
      updated_at: "2026-06-10T01:00:00Z",
    });
  });

  it("fail-soft on unparseable json", () => {
    const s = summarizeDescriptorRow({
      name: "bad",
      version: 1,
      descriptor_json: "{nope",
      created_by_agent_id: null,
      created_at: "x",
      updated_at: "y",
    });
    assert.equal(s.phase_count, 0);
    assert.equal(s.agent_count, 0);
  });
});

describe("substitutePhaseResults ", () => {
  const replies = new Map([
    ["p3-merge", ["MERGED MANUAL TEXT"]],
    ["p1", ["ch1", "ch2"]],
  ]);

  it("substitutes a known phase result", () => {
    const r = substitutePhaseResults("修订：{{p3-merge.result}} 完", replies);
    assert.equal(r.prompt, "修订：MERGED MANUAL TEXT 完");
    assert.deepEqual(r.resolved, ["p3-merge"]);
    assert.deepEqual(r.unresolved, []);
  });

  it("joins multi-agent phase replies with separators", () => {
    const r = substitutePhaseResults("{{p1.result}}", replies);
    assert.equal(r.prompt, "ch1\n\n---\n\nch2");
  });

  it("keeps unknown/forward references intact and reports them", () => {
    const r = substitutePhaseResults("need {{p9.result}}", replies);
    assert.equal(r.prompt, "need {{p9.result}}");
    assert.deepEqual(r.unresolved, ["p9"]);
  });

  it("byte-caps oversized injections with a truncation marker", () => {
    const big = new Map([["p", ["界".repeat(20000)]]]); // 60KB UTF-8
    const r = substitutePhaseResults("{{p.result}}", big);
    assert.ok(r.prompt.endsWith("…[truncated]"));
    assert.ok(new TextEncoder().encode(r.prompt).length <= 24 * 1024 + 64);
  });
});
