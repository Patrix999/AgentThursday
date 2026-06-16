import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveEffectiveSkillset } from "./agentSkillsetRuntime";
import type { CacheEntry, LoaderState, SkillsetManifest } from "../skillset/types";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";
import { loadSkillsets } from "../skillset/loader";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";
import {
  describeDynamicToolBindings,
} from "../skillset/agentDynamicTools";
import { z } from "zod";

// ───────────────────────────────────────────────────────────────────
// Fixture builders. The resolver is pure and only needs `LoaderState`
// entries (status + id) + manifest map + disabled map, so we don't
// have to spin up the loader for the directed cases. The last
// section uses the real loader against EMBEDDED_MANIFESTS as an
// integration check.
// ───────────────────────────────────────────────────────────────────

function fakeManifest(
  id: string,
  dependencies: string[] = [],
): SkillsetManifest {
  return {
    id,
    name: id,
    description: "",
    version: "0.0.1",
    purpose: "",
    dependencies,
    tools: [],
    skills: [],
    workflow_patterns: [],
    reasoning_protocol: { principles: [] },
    evidence_protocol: {},
    safety_policy: { policy_version: "0.0.1" },
    observability: {},
    policy: { surface_modes: ["enable"], default_tier_cap: 3 },
  };
}

function fakeEntry(
  manifest: SkillsetManifest,
  status: "loaded" | "load_rejected" = "loaded",
): CacheEntry {
  return {
    manifest,
    source_yaml: "",
    source_sha: "djb2:0",
    loaded_at: "2026-05-23T00:00:00.000Z",
    status,
    validation_errors: [],
    soul_token_estimate: 0,
  };
}

function fakeState(entries: Record<string, CacheEntry>): LoaderState {
  return {
    schema_version: "0.1.0",
    loaded_at: "2026-05-23T00:00:00.000Z",
    total_soul_token_estimate: 0,
    total_soul_token_cap: 3000,
    per_skillset_token_cap: 1000,
    entries,
  };
}

describe("agentSkillsetRuntime — resolveEffectiveSkillset", () => {
  it("empty_selection when profileSkillset is null / undefined / empty string", () => {
    const args = {
      state: fakeState({}),
      manifestsById: new Map<string, SkillsetManifest>(),
      disabledMap: new Map<string, unknown>(),
    };
    for (const sel of [null, undefined, ""] as const) {
      const r = resolveEffectiveSkillset({ ...args, profileSkillset: sel });
      assert.equal(r.status, "empty_selection");
      assert.deepEqual(r.effectiveIds, []);
      assert.equal(r.reason, "no_selection");
    }
  });

  it("unknown_skillset when selection is not in manifestsById", () => {
    const m = fakeManifest("real");
    const r = resolveEffectiveSkillset({
      profileSkillset: "does-not-exist",
      state: fakeState({ real: fakeEntry(m) }),
      manifestsById: new Map([["real", m]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "unknown_skillset");
    assert.deepEqual(r.effectiveIds, []);
    assert.equal(r.reason, "not_in_manifest_registry");
  });

  it("rejected_skillset when selection has loader entry status=load_rejected", () => {
    const m = fakeManifest("flaky");
    const r = resolveEffectiveSkillset({
      profileSkillset: "flaky",
      state: fakeState({ flaky: fakeEntry(m, "load_rejected") }),
      manifestsById: new Map([["flaky", m]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "rejected_skillset");
    assert.deepEqual(r.effectiveIds, []);
    assert.equal(r.reason, "load_rejected");
  });

  it("rejected_skillset when selection has no loader entry at all", () => {
    const m = fakeManifest("missing-in-loader");
    const r = resolveEffectiveSkillset({
      profileSkillset: "missing-in-loader",
      // entries map is empty — the manifest exists in the registry
      // but the loader never produced an entry for it.
      state: fakeState({}),
      manifestsById: new Map([["missing-in-loader", m]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "rejected_skillset");
    assert.deepEqual(r.effectiveIds, []);
    assert.equal(r.reason, "load_rejected");
  });

  it("disabled_skillset wins over a loaded selection — operator disable hides tools", () => {
    const m = fakeManifest("sw");
    const r = resolveEffectiveSkillset({
      profileSkillset: "sw",
      state: fakeState({ sw: fakeEntry(m) }),
      manifestsById: new Map([["sw", m]]),
      disabledMap: new Map<string, unknown>([["sw", { disabled_at: "x", reason: null }]]),
    });
    assert.equal(r.status, "disabled_skillset");
    assert.deepEqual(r.effectiveIds, []);
    assert.equal(r.reason, "operator_disabled");
  });

  it("ok when selection is loaded and has no deps — effectiveIds is just [selected]", () => {
    const m = fakeManifest("solo");
    const r = resolveEffectiveSkillset({
      profileSkillset: "solo",
      state: fakeState({ solo: fakeEntry(m) }),
      manifestsById: new Map([["solo", m]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.effectiveIds, ["solo"]);
    assert.equal(r.reason, null);
  });

  it("ok closure includes loaded deps; sorted; unknown / not-loaded deps silently dropped", () => {
    const parent = fakeManifest("parent", ["dep-loaded", "dep-unknown", "dep-rejected"]);
    const depLoaded = fakeManifest("dep-loaded");
    const depRejected = fakeManifest("dep-rejected");
    const r = resolveEffectiveSkillset({
      profileSkillset: "parent",
      state: fakeState({
        parent: fakeEntry(parent),
        "dep-loaded": fakeEntry(depLoaded),
        "dep-rejected": fakeEntry(depRejected, "load_rejected"),
        // dep-unknown is intentionally absent from both state and manifests.
      }),
      manifestsById: new Map([
        ["parent", parent],
        ["dep-loaded", depLoaded],
        ["dep-rejected", depRejected],
      ]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    // Sorted: dep-loaded, parent.
    assert.deepEqual(r.effectiveIds, ["dep-loaded", "parent"]);
    assert.equal(r.reason, null);
  });

  it("ok drops a disabled dep silently (still status=ok), but a disabled SELECTION yields disabled_skillset", () => {
    const parent = fakeManifest("parent", ["dep"]);
    const dep = fakeManifest("dep");
    const r = resolveEffectiveSkillset({
      profileSkillset: "parent",
      state: fakeState({ parent: fakeEntry(parent), dep: fakeEntry(dep) }),
      manifestsById: new Map([["parent", parent], ["dep", dep]]),
      disabledMap: new Map<string, unknown>([["dep", {}]]),
    });
    assert.equal(r.status, "ok");
    // dep is silently dropped — only the parent survives.
    assert.deepEqual(r.effectiveIds, ["parent"]);
    assert.equal(r.reason, null);
  });

  it("transitive dependency closure walks multiple levels", () => {
    const a = fakeManifest("a", ["b"]);
    const b = fakeManifest("b", ["c"]);
    const c = fakeManifest("c");
    const r = resolveEffectiveSkillset({
      profileSkillset: "a",
      state: fakeState({ a: fakeEntry(a), b: fakeEntry(b), c: fakeEntry(c) }),
      manifestsById: new Map([["a", a], ["b", b], ["c", c]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.effectiveIds, ["a", "b", "c"]);
  });

  it("cyclic deps terminate (DFS visited guard) and produce the loaded closure", () => {
    const a = fakeManifest("a", ["b"]);
    const b = fakeManifest("b", ["a"]); // cycle
    const r = resolveEffectiveSkillset({
      profileSkillset: "a",
      state: fakeState({ a: fakeEntry(a), b: fakeEntry(b) }),
      manifestsById: new Map([["a", a], ["b", b]]),
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.effectiveIds, ["a", "b"]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: real EMBEDDED_MANIFESTS + real loader. This is the
  // "smoke" check that the resolver agrees with the deployed manifest
  // set. We use software-dev (declares deps observability +
  // communication, neither of which is in EMBEDDED_MANIFESTS today)
  // to exercise the "silently drop unknown deps" path against real
  // data.
  // ─────────────────────────────────────────────────────────────────

  it("integration: software-dev resolves with deps dropped because they are not embedded", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const manifestsById = new Map(EMBEDDED_MANIFESTS.map(m => [m.id, m.manifest] as const));
    const r = resolveEffectiveSkillset({
      profileSkillset: "software-dev",
      state,
      manifestsById,
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    // software-dev itself must be present.
    assert.ok(r.effectiveIds.includes("software-dev"));
    // observability / communication are declared as deps but are not
    // in EMBEDDED_MANIFESTS — they must be silently dropped, not
    // included in effectiveIds.
    assert.ok(!r.effectiveIds.includes("observability"));
    assert.ok(!r.effectiveIds.includes("communication"));
    // Sorted invariant.
    assert.deepEqual(r.effectiveIds, [...r.effectiveIds].sort());
  });

  it("integration: qa-reviewer-basic resolves with itself only (no deps)", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const manifestsById = new Map(EMBEDDED_MANIFESTS.map(m => [m.id, m.manifest] as const));
    const r = resolveEffectiveSkillset({
      profileSkillset: "qa-reviewer-basic",
      state,
      manifestsById,
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.effectiveIds, ["qa-reviewer-basic"]);
  });

  it("integration: unknown profile.skillset against real manifest set → unknown_skillset", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const manifestsById = new Map(EMBEDDED_MANIFESTS.map(m => [m.id, m.manifest] as const));
    const r = resolveEffectiveSkillset({
      profileSkillset: "definitely-not-a-real-skillset",
      state,
      manifestsById,
      disabledMap: new Map(),
    });
    assert.equal(r.status, "unknown_skillset");
    assert.deepEqual(r.effectiveIds, []);
  });
});

// ───────────────────────────────────────────────────────────────────
//  §Required 6 — boundary tests at the dynamic-tool mapper.
//
// The resolver tests above prove the closure math. These prove that
// the closure is actually consulted where it matters: at
// `describeDynamicToolBindings`, which is the proof-surface mirror of
// the agent-facing `buildDynamicSkillTools` mapper. Anything visible
// here is callable by the agent; anything filtered out here is not.
// We use the real loader + real adapter registry so we are testing the
// shipped wiring, not a stub.
// ───────────────────────────────────────────────────────────────────

describe("agentSkillsetRuntime — describeDynamicToolBindings allowedSkillsetIds gate", () => {
  // envLookup that satisfies every env_binding probe — keeps
  // capability_class at `callable_tool_ready` so we are exercising the
  // skillset-id gate, not the secret-missing downgrade.
  const envLookup = () => "set";

  // Tool ids whose contracts already ship `implemented=true, surface=
  // fetch_path` in `contractRegistry.ts` (verified by directly probing
  // `summarizeLoaderDetail` against real EMBEDDED_MANIFESTS). Each of
  // these needs a handler entry for `describeDynamicToolBindings` to
  // emit a binding for it — but we can't `import "../skillset/adapters"`
  // here because `adminSmoke.ts` transitively pulls in
  // `cloudflare:workers` via `partyserver`, which is not available
  // outside the wrangler runtime. The injection hook
  // (`handlersByToolId`) exists precisely for tests like this.
  const STUB_BINDABLE_TOOL_IDS = new Set<string>([
    "artifact.write",
    "artifact.read",
    "artifact.list",
    "localdoc.convert_text",
    "skillset.runtime_summary",
    "admin.smoke",
    "patch.validate",
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubHandler: any = {
    canonicalToolId: "<stub>",
    inputSchema: z.object({}).passthrough(),
    execute: async () => ({ status: "ok" }),
  };
  const handlersByToolId = (toolId: string) =>
    STUB_BINDABLE_TOOL_IDS.has(toolId) ? stubHandler : undefined;

  it("legacy: undefined allowedSkillsetIds exposes every loaded skillset's tools", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const all = describeDynamicToolBindings({
      state,
      env: {},
      envLookup,
      handlersByToolId,
    });
    const toolIds = new Set(all.map(b => b.tool_id));
    assert.ok(toolIds.has("artifact.write"));
    assert.ok(toolIds.has("artifact.read"));
    assert.ok(toolIds.has("artifact.list"));
    assert.ok(toolIds.has("localdoc.convert_text"));
    assert.ok(toolIds.has("skillset.runtime_summary"));
    assert.ok(toolIds.has("admin.smoke"));
    const skillsetIds = new Set(all.map(b => b.skillset_id));
    assert.ok(skillsetIds.size > 1, `expected >1 skillset_id, got ${skillsetIds.size}`);
  });

  it("§Required 6 first bullet: allowedSkillsetIds narrows to the named set only", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const narrow = describeDynamicToolBindings({
      state,
      env: {},
      envLookup,
      handlersByToolId,
      allowedSkillsetIds: new Set(["artifact-delivery"]),
    });
    // Every binding is from `artifact-delivery`.
    for (const b of narrow) {
      assert.equal(b.skillset_id, "artifact-delivery");
    }
    const toolIds = new Set(narrow.map(b => b.tool_id));
    assert.ok(toolIds.has("artifact.write"));
    assert.ok(toolIds.has("artifact.read"));
    assert.ok(toolIds.has("artifact.list"));
    // Tools owned by other loaded skillsets must be absent.
    assert.ok(!toolIds.has("localdoc.convert_text"));
    assert.ok(!toolIds.has("skillset.runtime_summary"));
    assert.ok(!toolIds.has("admin.smoke"));
  });

  it("§Required 6 third bullet: allowedSkillsetIds=∅ exposes zero tools (no-callable-surface state)", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const empty = describeDynamicToolBindings({
      state,
      env: {},
      envLookup,
      handlersByToolId,
      allowedSkillsetIds: new Set<string>(),
    });
    assert.deepEqual(empty, []);
  });

  it("allowedSkillsetIds that names an unloaded id yields zero bindings (no accidental cross-skillset leak)", () => {
    const state = loadSkillsets(EMBEDDED_MANIFESTS, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const r = describeDynamicToolBindings({
      state,
      env: {},
      envLookup,
      handlersByToolId,
      allowedSkillsetIds: new Set(["definitely-not-a-real-skillset"]),
    });
    assert.deepEqual(r, []);
  });
});
