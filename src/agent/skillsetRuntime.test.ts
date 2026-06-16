/**
 *  — per-agent custom skillset loader sync.
 *
 * The cross-DO sync path exposes a host-level accessor
 * (`getExtraCustomManifests()`) that lets a per-agent DO mirror the
 * registry DO's custom-manifest set without copying SQL rows. This
 * suite proves the accessor flows through to:
 *   1. `buildSkillsetSnapshotNow` — extra customs end up in
 *      `state.entries` alongside embedded manifests + any local SQL
 *      customs.
 *   2. Resolution — `resolveEffectiveSkillset` over a snapshot built
 *      from extras only narrows to the named custom skillset's
 *      closure (no silent fallback to embedded).
 *   3. Negative — an `agent_profile.skillset` pointing at a custom
 *      id the host has NOT cached resolves to `unknown_skillset`,
 *      not a silent broaden.
 *   4. Dedupe — when local SQL and extras share an id, the extras
 *      win (per-agent DO mirroring the registry is authoritative).
 *
 * No DO / `cloudflare:workers` import here. We pass a synthetic
 * `SkillsetRuntimeReadHost` directly so the test runs under
 * `node --import tsx --test` like the rest of the agent suite.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildSkillsetSnapshotNow,
  type SkillsetRuntimeReadHost,
} from "./skillsetRuntime";
import { resolveEffectiveSkillset } from "./agentSkillsetRuntime";
import type { EmbeddedManifest } from "../skillset/manifests";
import type { SkillsetManifest } from "../skillset/types";

// ───────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────

function fakeManifest(
  id: string,
  opts: { tools?: string[] } = {},
): SkillsetManifest {
  return {
    id,
    name: id,
    description: "",
    version: "0.0.1",
    purpose: "",
    dependencies: [],
    tools: opts.tools ?? [],
    skills: [],
    workflow_patterns: [],
    reasoning_protocol: { principles: [] },
    evidence_protocol: {},
    safety_policy: { policy_version: "0.0.1" },
    observability: {},
    policy: { surface_modes: ["enable"], default_tier_cap: 3 },
  };
}

function fakeEmbedded(id: string, tools: string[] = []): EmbeddedManifest {
  return {
    id,
    source_yaml: `id: ${id}\n`,
    manifest: fakeManifest(id, { tools }),
  };
}

interface FakeHostOptions {
  localCustomRows?: Array<{
    id: string;
    source_yaml: string;
    manifest_json: string;
  }>;
  extras?: EmbeddedManifest[];
  /** Cause only the `custom_skillset` read to throw — exercises the
   *  fail-soft inside `readLocalCustomManifests`. `skillset_disabled`
   *  reads still succeed so the snapshot itself doesn't blow up. */
  customSqlBoom?: boolean;
}

function fakeHost(opts: FakeHostOptions = {}): SkillsetRuntimeReadHost {
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("custom_skillset")) {
      if (opts.customSqlBoom) throw new Error("simulated_custom_sql_failure");
      return opts.localCustomRows ?? [];
    }
    if (text.includes("skillset_disabled")) {
      return [];
    }
    return [];
  }) as SkillsetRuntimeReadHost["sql"];
  return {
    env: {} as Env,
    sql,
    getReloadCount: () => 0,
    getExtraCustomManifests: opts.extras ? () => opts.extras! : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────

describe("skillsetRuntime —  per-agent custom-manifest sync", () => {
  it("extras flow into state.entries with manifests attached", () => {
    // Use a tool id that's already in STUB_KNOWN_TOOL_IDS so the
    // loader accepts the custom manifest (no v2 unknown_tool_id
    // rejection).
    const custom = fakeEmbedded("custom-runtime-summary", ["inspect.self.task"]);
    const host = fakeHost({ extras: [custom] });
    const snap = buildSkillsetSnapshotNow(host);
    assert.ok(
      snap.state.entries["custom-runtime-summary"],
      "extra custom manifest must appear in state.entries",
    );
    assert.equal(
      snap.state.entries["custom-runtime-summary"].status,
      "loaded",
      "custom skillset with a known tool should be loaded by the loader",
    );
    assert.ok(
      snap.skillset_ids.loaded.includes("custom-runtime-summary"),
      "custom skillset must be in skillset_ids.loaded",
    );
  });

  it("undefined getExtraCustomManifests is the legacy embedded-only path", () => {
    const host = fakeHost(); // no extras, no local custom rows
    const snap = buildSkillsetSnapshotNow(host);
    // No custom id leaked into the snapshot.
    assert.ok(
      !snap.skillset_ids.loaded.includes("custom-runtime-summary"),
      "no custom skillset should appear when host has no extras",
    );
  });

  it("resolveEffectiveSkillset narrows to the custom skillset's closure", () => {
    const custom = fakeEmbedded("only-runtime-summary", ["inspect.self.task"]);
    const host = fakeHost({ extras: [custom] });
    const snap = buildSkillsetSnapshotNow(host);
    const manifestsById = new Map<string, SkillsetManifest>();
    for (const [id, entry] of Object.entries(snap.state.entries)) {
      if (entry?.manifest) manifestsById.set(id, entry.manifest);
    }
    const r = resolveEffectiveSkillset({
      profileSkillset: "only-runtime-summary",
      state: snap.state,
      manifestsById,
      disabledMap: new Map(),
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.effectiveIds, ["only-runtime-summary"]);
  });

  it("unknown custom id resolves to unknown_skillset (no silent fallback)", () => {
    // Host has only one cached custom; the profile points at a
    // different one that nobody created.
    const cached = fakeEmbedded("cached-custom", ["inspect.self.task"]);
    const host = fakeHost({ extras: [cached] });
    const snap = buildSkillsetSnapshotNow(host);
    const manifestsById = new Map<string, SkillsetManifest>();
    for (const [id, entry] of Object.entries(snap.state.entries)) {
      if (entry?.manifest) manifestsById.set(id, entry.manifest);
    }
    const r = resolveEffectiveSkillset({
      profileSkillset: "phantom-custom",
      state: snap.state,
      manifestsById,
      disabledMap: new Map(),
    });
    assert.equal(r.status, "unknown_skillset");
    assert.deepEqual(r.effectiveIds, []);
  });

  it("dedupe: extras win over local-SQL customs on id collision", () => {
    // Local SQL has an OLD version of the manifest with no tools.
    // Extras have the NEW version (registry authoritative) with one
    // known tool. The merged snapshot must reflect the extras
    // version — verified by the fact that the loaded skillset
    // contributes its tool id.
    const oldManifestJson = JSON.stringify(fakeManifest("dup-id", { tools: [] }));
    const newCustom = fakeEmbedded("dup-id", ["inspect.self.task"]);
    const host = fakeHost({
      localCustomRows: [
        { id: "dup-id", source_yaml: "id: dup-id\n", manifest_json: oldManifestJson },
      ],
      extras: [newCustom],
    });
    const snap = buildSkillsetSnapshotNow(host);
    const entry = snap.state.entries["dup-id"];
    assert.ok(entry, "dup-id must appear exactly once");
    assert.equal(entry.status, "loaded");
    assert.equal(
      entry.manifest.tools.length,
      1,
      "tools should come from extras (registry authoritative), not local SQL",
    );
    assert.equal(entry.manifest.tools[0], "inspect.self.task");
  });

  it("fail-soft: local custom SQL read failure still lets extras in", () => {
    // Only the local `custom_skillset` read throws — `skillset_disabled`
    // reads still succeed so the snapshot itself builds. The customs
    // path's own try/catch swallows the SQL failure and falls back to
    // the extras-only set, so the registry-mirrored custom skillset
    // still ends up in state.entries. This proves the extras accessor
    // is independent of the local SQL path.
    const custom = fakeEmbedded("fail-soft-custom", ["inspect.self.task"]);
    const host = fakeHost({ extras: [custom], customSqlBoom: true });
    const snap = buildSkillsetSnapshotNow(host);
    assert.ok(
      snap.state.entries["fail-soft-custom"],
      "extras must still appear when local custom SQL read throws",
    );
    assert.equal(snap.state.entries["fail-soft-custom"].status, "loaded");
  });
});
