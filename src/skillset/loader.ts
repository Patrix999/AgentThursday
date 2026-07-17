/**
 * minimum static skillset loader.
 *
 * Reads embedded manifests, runs 175 V1/V3/V4/V5 invariants and the
 * SOUL token budget guard from ADR 2026-05-07 IM-3 + Flag 1, and
 * returns a `LoaderState` that mirrors ADR 179 IM-2 cache shape.
 *
 * V2 (tool_id ∈ 176 contract registry) is delegated to 183. * accepts an optional `knownToolIds` set; tool_ids outside that set
 * trigger `v2_missing_tool_contract` errors but do not crash the
 * loader. When `knownToolIds` is omitted the V2 check is skipped
 * entirely (skeleton mode).
 *
 * The loader is pure: no DO state, no inspect surface side-effects.
 * Server.ts wraps it in `/api/inspect/skillset` for read-only
 * surfacing.
 */

import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "./manifests";
import type {
  CacheEntry,
  LoadError,
  LoaderState,
  SkillCapabilityClass,
  SkillsetManifest,
  Tier,
} from "./types";

const SCHEMA_VERSION = "0.1.0";
const PER_SKILLSET_TOKEN_CAP = 1000;
const TOTAL_SKILLSET_TOKEN_CAP = 3000;

export interface LoadOptions {
  knownToolIds?: ReadonlySet<string>;
}

/**
 * Approximate token estimate. We can't ship a real tokenizer in a
 * Worker (size + cold-start cost), and the cap is conservative
 * (1000 / 3000) so a heuristic is acceptable for . fabric
 * may upgrade to a Worker-friendly tokenizer.
 *
 * Heuristic: ~4 characters per token, with separate accounting for
 * CJK (≈ 2 chars/token) versus latin (≈ 4 chars/token). Numbers and
 * punctuation count as latin.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs + extensions, plus Hiragana/Katakana.
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2ebef)
    ) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.ceil(cjkChars / 2 + otherChars / 4);
}

export function estimateSkillsetSoulTokens(manifest: SkillsetManifest): number {
  // Mirrors ADR 179 IM-3 SOUL injection template: purpose +
  // description + workflow_patterns names/when + reasoning_protocol
  // principles/anti_patterns. skill prompt_segment is ignored here
  // because IM-5 is on-demand; loader's job is the skillset-level
  // guarantee.
  const parts: string[] = [];
  parts.push(`Purpose: ${manifest.purpose}`);
  parts.push(`Description: ${manifest.description}`);
  for (const wp of manifest.workflow_patterns) {
    parts.push(`Workflow ${wp.name}: ${wp.when ?? ""}`);
  }
  for (const p of manifest.reasoning_protocol.principles) {
    parts.push(p);
  }
  for (const a of manifest.reasoning_protocol.anti_patterns ?? []) {
    parts.push(a);
  }
  return estimateTokens(parts.join("\n"));
}

function hashYaml(text: string): string {
  // Cheap deterministic hash; not cryptographic, only meant to
  // change when the embedded manifest text changes. Worker-safe.
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return `djb2:${(h >>> 0).toString(16)}`;
}

function checkV1ToolsSubset(manifest: SkillsetManifest): LoadError[] {
  const declared = new Set(manifest.tools);
  const errors: LoadError[] = [];
  for (const skill of manifest.skills) {
    for (const toolId of skill.tools) {
      if (!declared.has(toolId)) {
        errors.push({
          code: "v1_tools_subset",
          message: `skill '${skill.id}' references tool_id '${toolId}' not in manifest.tools`,
        });
      }
    }
  }
  return errors;
}

function checkV3TierCap(manifest: SkillsetManifest): LoadError[] {
  const cap = manifest.policy.default_tier_cap;
  const errors: LoadError[] = [];
  for (const skill of manifest.skills) {
    if (skill.tier > cap) {
      errors.push({
        code: "v3_tier_cap",
        message: `skill '${skill.id}' tier ${skill.tier} exceeds policy.default_tier_cap ${cap}`,
      });
    }
  }
  return errors;
}

function checkV4DependencyCycle(
  manifest: SkillsetManifest,
  allManifests: ReadonlyMap<string, SkillsetManifest>,
): LoadError[] {
  const errors: LoadError[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const m = allManifests.get(id);
    for (const dep of m?.dependencies ?? []) {
      if (dfs(dep)) return true;
    }
    stack.delete(id);
    return false;
  };
  if (dfs(manifest.id)) {
    errors.push({
      code: "v4_dependency_cycle",
      message: `dependency cycle detected starting at '${manifest.id}'`,
    });
  }
  return errors;
}

function checkV2KnownToolIds(
  manifest: SkillsetManifest,
  knownToolIds: ReadonlySet<string>,
): LoadError[] {
  const errors: LoadError[] = [];
  for (const toolId of manifest.tools) {
    if (!knownToolIds.has(toolId)) {
      errors.push({
        code: "v2_missing_tool_contract",
        message: `tool_id '${toolId}' missing from 176 contract registry`,
      });
    }
  }
  return errors;
}

export function loadSkillsets(
  embedded: ReadonlyArray<EmbeddedManifest> = EMBEDDED_MANIFESTS,
  options: LoadOptions = {},
): LoaderState {
  const allManifests = new Map<string, SkillsetManifest>();
  for (const e of embedded) {
    allManifests.set(e.id, e.manifest);
  }

  // V5: id uniqueness. Detected by counting duplicates among the
  // embedded list keys.
  const idCounts = new Map<string, number>();
  for (const e of embedded) {
    idCounts.set(e.id, (idCounts.get(e.id) ?? 0) + 1);
  }

  const entries: Record<string, CacheEntry> = {};
  let totalSoulTokens = 0;
  const loadedAt = new Date().toISOString();

  // Sort by load_priority desc so token budget is allocated to
  // highest-priority skillsets first; equal priority falls back to
  // insertion order.
  const sorted = [...embedded].sort((a, b) => {
    const pa = a.manifest.policy.load_priority ?? 0;
    const pb = b.manifest.policy.load_priority ?? 0;
    return pb - pa;
  });

  for (const e of sorted) {
    const errors: LoadError[] = [];

    // V5
    if ((idCounts.get(e.id) ?? 0) > 1) {
      errors.push({
        code: "v5_id_conflict",
        message: `manifest id '${e.id}' is not unique among embedded manifests`,
      });
    }

    // V1, V3, V4
    errors.push(...checkV1ToolsSubset(e.manifest));
    errors.push(...checkV3TierCap(e.manifest));
    errors.push(...checkV4DependencyCycle(e.manifest, allManifests));

    // V2 (optional)
    if (options.knownToolIds) {
      errors.push(...checkV2KnownToolIds(e.manifest, options.knownToolIds));
    }

    // Per-skillset SOUL token cap (IM-3)
    const skillsetTokens = estimateSkillsetSoulTokens(e.manifest);
    if (skillsetTokens > PER_SKILLSET_TOKEN_CAP) {
      errors.push({
        code: "soul_token_overflow",
        message: `skillset '${e.id}' SOUL injection ${skillsetTokens} tokens exceeds per-skillset cap ${PER_SKILLSET_TOKEN_CAP}`,
      });
    }

    // Total SOUL token cap (Flag 1) — only counted toward total when
    // skillset would actually load.
    const willLoad = errors.length === 0;
    if (willLoad && totalSoulTokens + skillsetTokens > TOTAL_SKILLSET_TOKEN_CAP) {
      errors.push({
        code: "soul_token_overflow",
        message: `loading skillset '${e.id}' would push total SOUL injection from ${totalSoulTokens} to ${
          totalSoulTokens + skillsetTokens
        } tokens, exceeding total cap ${TOTAL_SKILLSET_TOKEN_CAP}`,
      });
    }

    const finalLoaded = errors.length === 0;
    if (finalLoaded) totalSoulTokens += skillsetTokens;

    entries[e.id] = {
      manifest: e.manifest,
      source_yaml: e.source_yaml,
      source_sha: hashYaml(e.source_yaml),
      loaded_at: loadedAt,
      status: finalLoaded ? "loaded" : "load_rejected",
      validation_errors: errors,
      soul_token_estimate: skillsetTokens,
    };
  }

  return {
    schema_version: SCHEMA_VERSION,
    loaded_at: loadedAt,
    total_soul_token_estimate: totalSoulTokens,
    total_soul_token_cap: TOTAL_SKILLSET_TOKEN_CAP,
    per_skillset_token_cap: PER_SKILLSET_TOKEN_CAP,
    entries,
  };
}

/**
 * Stage 2 (skillsets-as-data, 2026-06-17) — assemble the effective manifest set
 * from the code-embedded baseline ∪ DB-sourced manifests (system-seeded embedded
 * rows + user custom), deduped to ONE manifest per id (passing duplicate ids to
 * `loadSkillsets` would trip `v5_id_conflict` and drop the skillset entirely).
 *
 * Per-id usability fallback: the DB version of an EMBEDDED id is preferred ONLY
 * if it actually loads clean (loader status `"loaded"`); a DB row that is
 * malformed / unknown-tool / over-cap reverts to the code manifest for THAT id —
 * so an embedded skillset can never be lost even if a seed or edit is bad
 * (status-keyed, not parse-keyed). Non-embedded custom skillsets carry no code
 * fallback (correct: a broken custom one stays rejected). Used by BOTH the
 * per-agent getTools snapshot and `loadMergedManifests` so the two never drift.
 */
export function assembleEffectiveManifests(
  embeddedCode: ReadonlyArray<EmbeddedManifest>,
  dbManifests: ReadonlyArray<EmbeddedManifest>,
  options?: LoadOptions,
): EmbeddedManifest[] {
  const codeById = new Map(embeddedCode.map((m) => [m.id, m] as const));
  const byId = new Map<string, EmbeddedManifest>();
  for (const m of embeddedCode) byId.set(m.id, m); // code baseline (floor)
  for (const m of dbManifests) byId.set(m.id, m); // DB wins: system overrides code, user custom added
  // Usability check: load the DB-preferred candidate; any EMBEDDED id that did
  // not load clean reverts to its code manifest (the DB system row was bad).
  const state = loadSkillsets(Array.from(byId.values()), options);
  for (const [id, code] of codeById) {
    const entry = state.entries[id];
    if ((!entry || entry.status !== "loaded") && byId.get(id) !== code) {
      byId.set(id, code);
    }
  }
  return Array.from(byId.values());
}

/**
 * Read-only inspect view: trims the heaviest fields (full manifest
 * objects, raw yaml) so /api/inspect/skillset returns a small
 * payload suitable for the web UI.
 */
export function summarizeLoaderState(state: LoaderState): {
  schema_version: string;
  loaded_at: string;
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
  entries: Array<{
    id: string;
    version: string;
    status: "loaded" | "load_rejected";
    source_sha: string;
    soul_token_estimate: number;
    validation_errors: Array<{ code: string; message: string }>;
    skill_count: number;
    tier_distribution: Record<Tier, number>;
  }>;
} {
  const entries = Object.values(state.entries).map(entry => {
    const dist: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const skill of entry.manifest.skills) {
      dist[skill.tier] += 1;
    }
    return {
      id: entry.manifest.id,
      version: entry.manifest.version,
      status: entry.status,
      source_sha: entry.source_sha,
      soul_token_estimate: entry.soul_token_estimate,
      validation_errors: entry.validation_errors.map(e => ({ code: e.code, message: e.message })),
      skill_count: entry.manifest.skills.length,
      tier_distribution: dist,
    };
  });
  return {
    schema_version: state.schema_version,
    loaded_at: state.loaded_at,
    total_soul_token_estimate: state.total_soul_token_estimate,
    total_soul_token_cap: state.total_soul_token_cap,
    per_skillset_token_cap: state.per_skillset_token_cap,
    entries,
  };
}

/**
 * an earlier revision generic per-skill inspect detail.
 *
 * Walks every loaded manifest and projects each skill into a
 * provider-neutral shape: id, name, tier, tools, capability_class
 * (defaults to literal `"unspecified"` when the manifest does not
 * declare one), prompt_segment_present (boolean — never the raw
 * content), and pass-through source_ref / evidence_requirements
 * when present. No manifest id is hard-coded; rejected manifests
 * are included with their status so verifiers see why a skillset
 * was dropped without losing visibility into its skill ids.
 */
export type SkillCapabilityClassOrUnspecified = SkillCapabilityClass | "unspecified";

export interface SkillDetailRow {
  id: string;
  name: string;
  tier: Tier;
  tools: string[];
  capability_class: SkillCapabilityClassOrUnspecified;
  prompt_segment_present: boolean;
  source_ref?: unknown;
  evidence_requirements?: unknown;
}

export interface SkillsetDetailEntry {
  skillset_id: string;
  skillset_version: string;
  status: "loaded" | "load_rejected";
  skills: SkillDetailRow[];
}

export interface LoaderDetailSummary {
  schema_version: string;
  loaded_at: string;
  entries: SkillsetDetailEntry[];
}

export function summarizeLoaderDetail(state: LoaderState): LoaderDetailSummary {
  const entries: SkillsetDetailEntry[] = Object.values(state.entries).map(entry => {
    const skills: SkillDetailRow[] = entry.manifest.skills.map(skill => {
      const row: SkillDetailRow = {
        id: skill.id,
        name: skill.name,
        tier: skill.tier,
        tools: [...skill.tools],
        capability_class: skill.capability_class ?? "unspecified",
        prompt_segment_present:
          typeof skill.prompt_segment === "string" && skill.prompt_segment.length > 0,
      };
      if (skill.source_ref !== undefined) row.source_ref = skill.source_ref;
      if (skill.evidence_requirements !== undefined) {
        row.evidence_requirements = skill.evidence_requirements;
      }
      return row;
    });
    return {
      skillset_id: entry.manifest.id,
      skillset_version: entry.manifest.version,
      status: entry.status,
      skills,
    };
  });
  return {
    schema_version: state.schema_version,
    loaded_at: state.loaded_at,
    entries,
  };
}

/**
 * generic env-binding-aware capability class downgrade.
 *
 * Mutates `detail` in place: for each skill whose `source_ref` declares
 * a non-empty `env_binding` string, look the binding up via
 * `envLookup`. If the lookup returns no value (undefined, empty string),
 * downgrade `capability_class` to `"callable_tool_no_secret"`. Skills
 * whose `source_ref` doesn't declare an `env_binding` are untouched.
 *
 * Provider-neutral: no fyi.md / discord / any provider id appears
 * here. The shape of `source_ref` is the only contract.
 */
export function downgradeCapabilityClassByEnvBinding(
  detail: LoaderDetailSummary,
  envLookup: (binding: string) => string | undefined,
): void {
  for (const entry of detail.entries) {
    for (const skill of entry.skills) {
      const ref = skill.source_ref;
      if (!ref || typeof ref !== "object") continue;
      const binding = (ref as { env_binding?: unknown }).env_binding;
      if (typeof binding !== "string" || binding.length === 0) continue;
      const value = envLookup(binding);
      if (typeof value !== "string" || value.length === 0) {
        skill.capability_class = "callable_tool_no_secret";
      }
    }
  }
}
