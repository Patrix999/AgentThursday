import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { validateCustomSkillset } from "./customSkillsetValidation";

/**
 * custom skillset validation unit tests.
 *
 * The validator is the boundary that keeps manager-authored manifests
 * from shadowing embedded ids and from referencing tool_ids that the
 * loader will reject downstream. Pure function, no DO.
 */

const KNOWN_TOOL_IDS = new Set(["alpha.test", "beta.test"]);

function baseManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "ops.test",
    name: "Ops Test",
    description: "test manifest",
    version: "0.1.0",
    purpose: "test purpose",
    tools: ["alpha.test"],
    skills: [
      {
        id: "ops.test.do",
        name: "Do thing",
        tier: 2,
        tools: ["alpha.test"],
      },
    ],
    ...overrides,
  };
}

describe("validateCustomSkillset — manifest shape", () => {
  it("rejects missing manifest", () => {
    const r = validateCustomSkillset({ manifest: undefined as unknown });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "manifest_required");
  });

  it("rejects non-object manifest", () => {
    const r = validateCustomSkillset({ manifest: "string" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "manifest_invalid_shape");
  });

  it("rejects missing required field", () => {
    const m = baseManifest();
    delete m.purpose;
    const r = validateCustomSkillset({ manifest: m }, { knownToolIds: KNOWN_TOOL_IDS });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "manifest_invalid_shape");
      if ("field" in r.error) assert.equal(r.error.field, "purpose");
    }
  });

  it("rejects skill with non-integer tier", () => {
    const m = baseManifest({
      skills: [{ id: "s.x", name: "S", tier: 6, tools: ["alpha.test"] }],
    });
    const r = validateCustomSkillset({ manifest: m }, { knownToolIds: KNOWN_TOOL_IDS });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "manifest_invalid_shape");
  });
});

describe("validateCustomSkillset — id rules", () => {
  it("rejects body.id ↔ manifest.id mismatch", () => {
    const r = validateCustomSkillset(
      { id: "other.id", manifest: baseManifest() },
      { knownToolIds: KNOWN_TOOL_IDS },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "id_mismatch");
  });

  it("rejects URL expectedId ↔ manifest.id mismatch (PATCH path)", () => {
    const r = validateCustomSkillset(
      { manifest: baseManifest() },
      { knownToolIds: KNOWN_TOOL_IDS, expectedId: "url.different" },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "id_mismatch");
  });

  it("accepts body.id matching manifest.id", () => {
    const r = validateCustomSkillset(
      { id: "ops.test", manifest: baseManifest() },
      { knownToolIds: KNOWN_TOOL_IDS },
    );
    assert.equal(r.ok, true);
  });
});

describe("validateCustomSkillset — embedded readonly", () => {
  it("rejects an embedded skillset id (uses real EMBEDDED_MANIFESTS)", () => {
    // 'manager' is the embedded id an earlier revision ships.
    const m = baseManifest({ id: "manager" });
    const r = validateCustomSkillset({ manifest: m }, { knownToolIds: KNOWN_TOOL_IDS });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "embedded_skillset_readonly");
      if ("id" in r.error) assert.equal(r.error.id, "manager");
    }
  });
});

describe("validateCustomSkillset — tool registry", () => {
  it("rejects manifest tool_id not in registry", () => {
    const m = baseManifest({ tools: ["unknown.tool"] });
    const r = validateCustomSkillset({ manifest: m }, { knownToolIds: KNOWN_TOOL_IDS });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "unknown_tool_id");
      if ("tool_id" in r.error) assert.equal(r.error.tool_id, "unknown.tool");
    }
  });

  it("rejects skill.tools[] entry not in registry", () => {
    const m = baseManifest({
      tools: ["alpha.test"],
      skills: [{ id: "s", name: "S", tier: 1, tools: ["never.exists"] }],
    });
    const r = validateCustomSkillset({ manifest: m }, { knownToolIds: KNOWN_TOOL_IDS });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "unknown_tool_id");
      if ("tool_id" in r.error) assert.equal(r.error.tool_id, "never.exists");
    }
  });

  it("returns canonicalized output on success", () => {
    const r = validateCustomSkillset(
      { manifest: baseManifest() },
      { knownToolIds: KNOWN_TOOL_IDS },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.id, "ops.test");
      assert.equal(r.value.manifest.policy.default_tier_cap, 3);
      assert.deepEqual(r.value.manifest.tools, ["alpha.test"]);
      assert.equal(r.value.manifest.skills.length, 1);
      assert.equal(r.value.manifest.skills[0].tier, 2);
    }
  });
});
