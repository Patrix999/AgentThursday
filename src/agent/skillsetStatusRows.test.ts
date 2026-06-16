import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { buildSkillsetRows } from "./skillsetStatusRows";

const SOFTWARE_DEV = {
  id: "software-dev",
  name: "Software development",
  description: "Primary engineering loop",
};

const QA = {
  id: "qa-reviewer-basic",
  name: "QA reviewer basic",
  description: "Read-only review loop",
};

describe("buildSkillsetRows", () => {
  it("status=loaded when runtime lists id under `loaded`", () => {
    const rows = buildSkillsetRows({
      options: [SOFTWARE_DEV],
      runtime: {
        skillset_ids: { loaded: ["software-dev"], disabled: [], rejected: [] },
        disabled: [],
      },
      detail: { entries: [] },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "loaded");
    assert.equal(rows[0].selectable, true);
    assert.equal(rows[0].disabledReason, null);
  });

  it("status=disabled when runtime lists id under `disabled`, surfaces reason", () => {
    const rows = buildSkillsetRows({
      options: [QA],
      runtime: {
        skillset_ids: { loaded: [], disabled: ["qa-reviewer-basic"], rejected: [] },
        disabled: [{ skillset_id: "qa-reviewer-basic", reason: "operator hold" }],
      },
      detail: { entries: [] },
    });
    assert.equal(rows[0].status, "disabled");
    assert.equal(rows[0].disabledReason, "operator hold");
  });

  it("status=rejected when runtime lists id under `rejected`", () => {
    const rows = buildSkillsetRows({
      options: [],
      runtime: {
        skillset_ids: { loaded: [], disabled: [], rejected: ["broken-skillset"] },
        disabled: [],
      },
      detail: { entries: [] },
    });
    assert.equal(rows[0].id, "broken-skillset");
    assert.equal(rows[0].status, "rejected");
    assert.equal(rows[0].selectable, false);
  });

  it("status=unknown when id is in options but runtime+detail are silent", () => {
    const rows = buildSkillsetRows({
      options: [{ id: "ghost", name: "Ghost", description: "" }],
      runtime: {
        skillset_ids: { loaded: [], disabled: [], rejected: [] },
        disabled: [],
      },
      detail: { entries: [] },
    });
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].selectable, true);
  });

  it("falls back to loader detail when runtime is null", () => {
    const rows = buildSkillsetRows({
      options: [SOFTWARE_DEV],
      runtime: null,
      detail: {
        entries: [
          {
            skillset_id: "software-dev",
            skillset_version: "0.4.0",
            status: "loaded",
            skills: [{ tools: ["a", "b"] }, { tools: ["c"] }],
          },
        ],
      },
    });
    assert.equal(rows[0].status, "loaded");
    assert.equal(rows[0].version, "0.4.0");
    assert.equal(rows[0].skillCount, 2);
    assert.equal(rows[0].toolCount, 3);
  });

  it("loader detail `load_rejected` → status=rejected when runtime silent", () => {
    const rows = buildSkillsetRows({
      options: [],
      runtime: null,
      detail: {
        entries: [
          {
            skillset_id: "broken",
            status: "load_rejected",
            skills: [],
          },
        ],
      },
    });
    assert.equal(rows[0].status, "rejected");
  });

  it("merges ids that appear in only one of options / runtime / detail", () => {
    const rows = buildSkillsetRows({
      options: [SOFTWARE_DEV],
      runtime: {
        skillset_ids: {
          loaded: ["software-dev"],
          disabled: ["qa-reviewer-basic"],
          rejected: ["broken"],
        },
        disabled: [{ skillset_id: "qa-reviewer-basic", reason: null }],
      },
      detail: {
        entries: [
          { skillset_id: "research-stub", status: "loaded", skills: [{ tools: [] }] },
        ],
      },
    });
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ["broken", "qa-reviewer-basic", "research-stub", "software-dev"]);
    const research = rows.find(r => r.id === "research-stub")!;
    assert.equal(research.status, "loaded");
    assert.equal(research.selectable, false);
    assert.equal(research.skillCount, 1);
  });

  it("rows are sorted by id for stable rendering", () => {
    const rows = buildSkillsetRows({
      options: [
        { id: "zzz-last", name: "Z", description: "" },
        { id: "aaa-first", name: "A", description: "" },
        { id: "mmm-mid", name: "M", description: "" },
      ],
      runtime: null,
      detail: { entries: [] },
    });
    assert.deepEqual(rows.map(r => r.id), ["aaa-first", "mmm-mid", "zzz-last"]);
  });

  it("disabled state wins over a stale loaded listing", () => {
    // Hypothetical: an id appears in BOTH `loaded` and `disabled`. The
    // runtime snapshot in production partitions them, but the helper
    // shouldn't depend on that invariant — disabled has stronger
    // operator semantics so it wins.
    const rows = buildSkillsetRows({
      options: [QA],
      runtime: {
        skillset_ids: {
          loaded: ["qa-reviewer-basic"],
          disabled: ["qa-reviewer-basic"],
          rejected: [],
        },
        disabled: [{ skillset_id: "qa-reviewer-basic", reason: "paused" }],
      },
      detail: { entries: [] },
    });
    assert.equal(rows[0].status, "disabled");
    assert.equal(rows[0].disabledReason, "paused");
  });
});
