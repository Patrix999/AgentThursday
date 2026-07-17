/**
 * manager-authored custom skillset validation.
 *
 * Sits between the HTTP/dispatch route layer and the SQLite ops in
 * `customSkillsetOps.ts`. Enforces the constraints the route can't
 * delegate to SQL: embedded-id readonly, unknown tool id rejection,
 * minimum manifest shape. Pure function — no DO, no env.
 *
 * v1 input shape: a structured manifest object (matches
 * `SkillsetManifest` from `../skillset/types`). YAML text input is
 * out of scope for v1 — an earlier revision test doc records the deferred
 * surface and the operator-facing copy.
 */
import type { SkillsetManifest, SkillDescriptor } from "../skillset/types";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";

export type CustomSkillsetValidationInput = {
  /** Required on create. PATCH supplies the URL id and may omit body.id. */
  id?: string;
  manifest: unknown;
};

export type CustomSkillsetValidationOutput = {
  id: string;
  name: string;
  description: string;
  version: string;
  manifest: SkillsetManifest;
};

export type CustomSkillsetValidationError =
  | { code: "manifest_required"; message: string }
  | { code: "manifest_invalid_shape"; message: string; field?: string }
  | { code: "missing_id"; message: string }
  | { code: "id_mismatch"; message: string }
  | { code: "embedded_skillset_readonly"; message: string; id: string }
  | { code: "unknown_tool_id"; message: string; tool_id: string };

export type CustomSkillsetValidationResult =
  | { ok: true; value: CustomSkillsetValidationOutput }
  | { ok: false; error: CustomSkillsetValidationError };

const EMBEDDED_IDS: ReadonlySet<string> = new Set(EMBEDDED_MANIFESTS.map(m => m.id));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] | null {
  const v = obj[key];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * Minimum-shape validator. an earlier revision v1 enforces the load-bearing
 * subset of `SkillsetManifest` that the loader actually inspects:
 * id, name, description, version, purpose, tools[], skills[]
 * (with tier 1-5 + tools[]), workflow_patterns[], reasoning_protocol,
 * evidence_protocol, safety_policy, observability, policy.
 *
 * Fields beyond the load-bearing subset (per-skill capability_class,
 * source_ref, evidence_requirements) pass through as-is when present.
 * The loader's V1/V3/V4/V5 + SOUL invariants run at snapshot build
 * time and surface in `skillset_runtime` as `load_rejected` rather
 * than blocking the create — same as embedded YAMLs do today.
 */
function validateManifestShape(
  raw: unknown,
): { ok: true; manifest: SkillsetManifest } | { ok: false; error: CustomSkillsetValidationError } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: "manifest_invalid_shape", message: "manifest must be an object" } };
  }
  const required: Array<keyof SkillsetManifest> = [
    "id",
    "name",
    "description",
    "version",
    "purpose",
    "tools",
    "skills",
  ];
  for (const k of required) {
    if (!(k in raw)) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `missing required field: ${k}`, field: String(k) },
      };
    }
  }
  for (const k of ["id", "name", "description", "version", "purpose"] as const) {
    const v = readString(raw, k);
    if (v === null || v.length === 0) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `field '${k}' must be a non-empty string`, field: k },
      };
    }
  }
  const toolsArr = readStringArray(raw, "tools");
  if (toolsArr === null) {
    return { ok: false, error: { code: "manifest_invalid_shape", message: "tools must be a string array", field: "tools" } };
  }
  const skillsRaw = raw.skills;
  if (!Array.isArray(skillsRaw)) {
    return { ok: false, error: { code: "manifest_invalid_shape", message: "skills must be an array", field: "skills" } };
  }
  const skills: SkillDescriptor[] = [];
  for (let i = 0; i < skillsRaw.length; i++) {
    const s = skillsRaw[i];
    if (!isPlainObject(s)) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `skills[${i}] must be an object`, field: `skills[${i}]` },
      };
    }
    const sid = readString(s, "id");
    const sname = readString(s, "name");
    const stier = s.tier;
    const stools = readStringArray(s, "tools");
    if (sid === null || sid.length === 0) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `skills[${i}].id must be a non-empty string`, field: `skills[${i}].id` },
      };
    }
    if (sname === null || sname.length === 0) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `skills[${i}].name must be a non-empty string`, field: `skills[${i}].name` },
      };
    }
    if (typeof stier !== "number" || stier < 1 || stier > 5 || !Number.isInteger(stier)) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `skills[${i}].tier must be integer 1-5`, field: `skills[${i}].tier` },
      };
    }
    if (stools === null) {
      return {
        ok: false,
        error: { code: "manifest_invalid_shape", message: `skills[${i}].tools must be a string array`, field: `skills[${i}].tools` },
      };
    }
    skills.push({
      id: sid,
      name: sname,
      description: readString(s, "description") ?? undefined,
      tier: stier as SkillDescriptor["tier"],
      tools: stools,
      prompt_segment: readString(s, "prompt_segment") ?? undefined,
      input_contract: s.input_contract,
      output_contract: s.output_contract,
      requires_approval: s.requires_approval as SkillDescriptor["requires_approval"],
      capability_class: s.capability_class as SkillDescriptor["capability_class"],
      source_ref: s.source_ref,
      evidence_requirements: s.evidence_requirements,
    });
  }

  // Optional sections — provide safe defaults the loader accepts.
  const workflowPatterns = Array.isArray(raw.workflow_patterns) ? raw.workflow_patterns : [];
  const reasoningProtocol = isPlainObject(raw.reasoning_protocol)
    ? raw.reasoning_protocol
    : { principles: [] };
  const evidenceProtocol = raw.evidence_protocol ?? {};
  const safetyPolicy = isPlainObject(raw.safety_policy)
    ? raw.safety_policy
    : { policy_version: "0.0.0" };
  const observability = raw.observability ?? {};
  const policyRaw = isPlainObject(raw.policy) ? raw.policy : {};
  const surfaceModes = Array.isArray(policyRaw.surface_modes)
    ? (policyRaw.surface_modes as ("enable" | "readonly" | "disable")[])
    : (["enable"] as ("enable" | "readonly" | "disable")[]);
  const defaultTierCap =
    typeof policyRaw.default_tier_cap === "number" &&
    Number.isInteger(policyRaw.default_tier_cap) &&
    policyRaw.default_tier_cap >= 1 &&
    policyRaw.default_tier_cap <= 5
      ? (policyRaw.default_tier_cap as 1 | 2 | 3 | 4 | 5)
      : 3;

  const manifest: SkillsetManifest = {
    id: readString(raw, "id")!,
    name: readString(raw, "name")!,
    description: readString(raw, "description")!,
    version: readString(raw, "version")!,
    purpose: readString(raw, "purpose")!,
    dependencies: readStringArray(raw, "dependencies") ?? undefined,
    tools: toolsArr,
    skills,
    workflow_patterns: workflowPatterns as SkillsetManifest["workflow_patterns"],
    reasoning_protocol: reasoningProtocol as unknown as SkillsetManifest["reasoning_protocol"],
    evidence_protocol: evidenceProtocol,
    safety_policy: safetyPolicy as unknown as SkillsetManifest["safety_policy"],
    observability,
    policy: {
      surface_modes: surfaceModes,
      default_tier_cap: defaultTierCap,
      per_tier_approval: policyRaw.per_tier_approval as SkillsetManifest["policy"]["per_tier_approval"],
      load_priority:
        typeof policyRaw.load_priority === "number" ? policyRaw.load_priority : undefined,
    },
  };
  return { ok: true, manifest };
}

export type ValidateOptions = {
  /** Optional override (tests). Defaults to `STUB_KNOWN_TOOL_IDS`. */
  knownToolIds?: ReadonlySet<string>;
  /** When set, validates that body.id matches the URL id (PATCH). */
  expectedId?: string;
};

/**
 * Validate a custom-skillset create or update body. Returns the
 * canonicalized manifest and the load-bearing top-level fields the
 * SQLite layer needs. Embedded ids are rejected here, NOT in
 * `customSkillsetOps` — the ops layer enforces PK conflict only.
 */
export function validateCustomSkillset(
  input: CustomSkillsetValidationInput,
  options: ValidateOptions = {},
): CustomSkillsetValidationResult {
  if (input.manifest === undefined || input.manifest === null) {
    return { ok: false, error: { code: "manifest_required", message: "manifest is required" } };
  }
  const shape = validateManifestShape(input.manifest);
  if (!shape.ok) return shape;
  const manifest = shape.manifest;

  // Both body.id (when present) and manifest.id must agree on a
  // single id. Body.id is optional; manifest.id is required.
  if (typeof input.id === "string" && input.id.length > 0 && input.id !== manifest.id) {
    return {
      ok: false,
      error: { code: "id_mismatch", message: `body.id '${input.id}' does not match manifest.id '${manifest.id}'` },
    };
  }
  if (typeof options.expectedId === "string" && options.expectedId.length > 0) {
    if (options.expectedId !== manifest.id) {
      return {
        ok: false,
        error: {
          code: "id_mismatch",
          message: `URL id '${options.expectedId}' does not match manifest.id '${manifest.id}'`,
        },
      };
    }
  }
  if (manifest.id.length === 0) {
    return { ok: false, error: { code: "missing_id", message: "manifest.id is required" } };
  }
  // Stage 2 — embedded/system ids are blocked on CREATE (no shadowing a baseline
  // id) but ALLOWED on UPDATE (`expectedId` set): baseline skillsets are now
  // editable system DB rows. The write authority is then owner-scoping — system
  // rows are owned by `user-system`, so only an admin (undefined write scope)
  // updates them; a scoped manager's update reads as not_found.
  const isUpdate = typeof options.expectedId === "string" && options.expectedId.length > 0;
  if (EMBEDDED_IDS.has(manifest.id) && !isUpdate) {
    return {
      ok: false,
      error: {
        code: "embedded_skillset_readonly",
        message: `cannot shadow embedded skillset id on create: ${manifest.id}`,
        id: manifest.id,
      },
    };
  }
  const knownTools = options.knownToolIds ?? STUB_KNOWN_TOOL_IDS;
  for (const t of manifest.tools) {
    if (!knownTools.has(t)) {
      return {
        ok: false,
        error: { code: "unknown_tool_id", message: `tool_id not in registry: ${t}`, tool_id: t },
      };
    }
  }
  for (const skill of manifest.skills) {
    for (const t of skill.tools) {
      if (!knownTools.has(t)) {
        return {
          ok: false,
          error: { code: "unknown_tool_id", message: `tool_id not in registry: ${t}`, tool_id: t },
        };
      }
    }
  }
  return {
    ok: true,
    value: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      manifest,
    },
  };
}
