/**
 * Stage 2 (skillsets-as-data) — the two load-bearing safety invariants:
 *   1. Seed round-trip is identity: a manifest stored as JSON and read back is
 *      byte-equal to the code manifest. A lossy round-trip would mean a seeded
 *      system skillset resolves DIFFERENT tools than code → abort the migration.
 *   2. `assembleEffectiveManifests` per-id usability fallback: a clean DB row
 *      wins; a BROKEN DB row (unknown tool, fails loader validation) reverts to
 *      the code manifest for that id — so an embedded skillset can never be lost
 *      even if a seed/edit is bad. Deduped one-per-id (no v5_id_conflict).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "./manifests";
import { assembleEffectiveManifests, loadSkillsets } from "./loader";
import { STUB_KNOWN_TOOL_IDS } from "./contractRegistry";

const OPTS = { knownToolIds: STUB_KNOWN_TOOL_IDS };

describe("Stage 2 — seed round-trip is identity (lossy ⇒ abort)", () => {
  it("JSON.stringify → parse reproduces every embedded manifest byte-for-byte", () => {
    for (const m of EMBEDDED_MANIFESTS) {
      const roundTripped = JSON.parse(JSON.stringify(m.manifest));
      assert.deepEqual(roundTripped, m.manifest, `round-trip lossy for ${m.id}`);
    }
  });
});

describe("Stage 2 — assembleEffectiveManifests", () => {
  it("empty DB ⇒ exactly the embedded set, all loaded (no duplicates / conflicts)", () => {
    const set = assembleEffectiveManifests(EMBEDDED_MANIFESTS, [], OPTS);
    assert.equal(set.length, EMBEDDED_MANIFESTS.length);
    const state = loadSkillsets(set, OPTS);
    for (const m of EMBEDDED_MANIFESTS) {
      assert.equal(state.entries[m.id]?.status, "loaded", `${m.id} should load`);
    }
  });

  it("clean DB system row (= seeded copy) wins, deduped one-per-id, still loads", () => {
    const dbCopies: EmbeddedManifest[] = EMBEDDED_MANIFESTS.map((m) => ({
      id: m.id,
      source_yaml: m.source_yaml,
      manifest: JSON.parse(JSON.stringify(m.manifest)), // round-tripped DB copy
    }));
    const set = assembleEffectiveManifests(EMBEDDED_MANIFESTS, dbCopies, OPTS);
    // one entry per id — passing duplicates would trip v5_id_conflict
    assert.equal(new Set(set.map((m) => m.id)).size, set.length);
    assert.equal(set.length, EMBEDDED_MANIFESTS.length);
    const state = loadSkillsets(set, OPTS);
    for (const m of EMBEDDED_MANIFESTS) assert.equal(state.entries[m.id]?.status, "loaded");
  });

  it("BROKEN DB system row reverts to the code manifest for THAT id (status-keyed, not parse-keyed)", () => {
    const victim = EMBEDDED_MANIFESTS[0];
    const broken: EmbeddedManifest = {
      id: victim.id,
      source_yaml: "",
      // valid JSON, but references a tool id that is NOT in the registry → the
      // loader rejects it. JSON.parse would "succeed"; only the load status catches it.
      manifest: {
        ...victim.manifest,
        tools: ["definitely.not.a.real.tool.id"],
        skills: victim.manifest.skills.map((s) => ({ ...s, tools: ["definitely.not.a.real.tool.id"] })),
      },
    };
    const set = assembleEffectiveManifests(EMBEDDED_MANIFESTS, [broken], OPTS);
    const chosen = set.find((m) => m.id === victim.id);
    // reverted to the CODE manifest (tools intact), not the broken DB row
    assert.deepEqual(chosen?.manifest.tools, victim.manifest.tools);
    const state = loadSkillsets(set, OPTS);
    assert.equal(state.entries[victim.id]?.status, "loaded", "victim must still load via code fallback");
  });

  it("user custom (non-embedded id) is appended alongside embedded", () => {
    // Clone a real embedded manifest (complete shape) under a non-embedded id.
    const cloned = JSON.parse(JSON.stringify(EMBEDDED_MANIFESTS[0].manifest));
    cloned.id = "user-custom-x";
    const custom: EmbeddedManifest = { id: "user-custom-x", source_yaml: "", manifest: cloned };
    const set = assembleEffectiveManifests(EMBEDDED_MANIFESTS, [custom], OPTS);
    assert.ok(set.some((m) => m.id === "user-custom-x"));
    assert.equal(set.length, EMBEDDED_MANIFESTS.length + 1);
  });
});
