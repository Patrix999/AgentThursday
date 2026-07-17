/**
 * shared AgentProfile input validation. Extracted from
 * `src/routes/agentProfileRoutes.ts` so the manager surface
 * (`src/routes/managerRoutes.ts` + `src/skillset/adapters/manager*.ts`
 * via `src/agent/managerOps.ts`) shares the exact same validation
 * path as the existing `/api/agent-profiles` route.
 *
 * Validation is async only because the skillset set has to fetch
 * custom manifests off the registry DO via `listCustomSkillsets()`.
 * Model checks are synchronous (in-memory runtime registry from
 * `agentModelRuntime`).
 *
 * Error code conventions match the YAML tool contracts for
 * `manager.agent_create` / `manager.agent_update` so any caller can
 * map them 1:1 to HTTP status without a translation table.
 */
import {
  isRunnableAgentRuntimeModel,
  resolveAgentRuntimeModel,
} from "./agentModelRuntime";
import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "../skillset/manifests";
import { assembleEffectiveManifests } from "../skillset/loader";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";
import { manifestFromWire, type CustomSkillsetWireRecord } from "./customSkillsetOps";

/**
 * Narrow surface this module needs from the registry DO stub. Kept
 * minimal so tests (and future call sites) can pass a fake without
 * importing the full AgentThursdayAgent type.
 */
export interface SkillsetRegistryStub {
  listCustomSkillsets(scopeOwnerId?: string): Promise<CustomSkillsetWireRecord[]>;
}

export type AgentProfileValidationError =
  | { code: "unknown_model"; message: string }
  | { code: "unsupported_model"; message: string }
  | { code: "unknown_skillset"; message: string };

export type AgentProfileValidationResult =
  | { ok: true }
  | { ok: false; error: AgentProfileValidationError };

/**
 * Build the set of skillset ids the create/update validators accept:
 * embedded ∪ custom. Custom rows live on the registry DO; fail-soft
 * on RPC failure means we still validate against embedded so a
 * transient binding glitch doesn't block all writes.
 */
export async function knownSkillsetIds(
  stub: SkillsetRegistryStub,
  // Owner scope (the writing tenant). A scoped caller may only assign embedded
  // skillsets or its OWN custom ones — so another tenant's custom skillset id
  // is not "known" and create/update is rejected. This is the assignment-time
  // chokepoint that lets the per-agent custom cache stay unscoped.
  scopeOwnerId?: string,
): Promise<ReadonlySet<string>> {
  const ids = new Set(EMBEDDED_MANIFESTS.map((m) => m.id));
  try {
    const customs = await stub.listCustomSkillsets(scopeOwnerId);
    for (const c of customs) ids.add(c.id);
  } catch (err) {
    console.warn(
      `[agent-profile-validation] listCustomSkillsets failed; embedded only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return ids;
}

/**
 * Build the loader-input set used by GET /:id runtime probe and the
 * `manager.skillset_read` augmentation: merges registry-DO custom
 * manifests on top of embedded. Same fail-soft as `knownSkillsetIds`.
 */
export async function loadMergedManifests(
  stub: SkillsetRegistryStub,
  scopeOwnerId?: string,
): Promise<EmbeddedManifest[]> {
  try {
    const customs = await stub.listCustomSkillsets(scopeOwnerId);
    if (customs.length === 0) return [...EMBEDDED_MANIFESTS];
    const custom: EmbeddedManifest[] = customs.map((c) => ({
      id: c.id,
      source_yaml: c.source_yaml,
      manifest: manifestFromWire(c),
    }));
    // Stage 2 — same usability-keyed assembler as the getTools path: DB-sourced
    // system skillsets (seeded embedded ids) override code if they load clean,
    // deduped one-per-id; user custom appended. Never drifts from getTools.
    return assembleEffectiveManifests(EMBEDDED_MANIFESTS, custom, { knownToolIds: STUB_KNOWN_TOOL_IDS });
  } catch (err) {
    console.warn(
      `[agent-profile-validation] listCustomSkillsets failed during runtime probe; embedded only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [...EMBEDDED_MANIFESTS];
  }
}

/**
 * Validate an AgentProfile create / update input against the
 * runtime model registry and the merged skillset id set.
 *
 * Caller pre-checks shape (Zod schema, presence of agent_id, etc.);
 * this function only owns the cross-cutting model + skillset
 * existence rules so create and update never drift.
 */
export async function validateAgentProfileInput(
  input: { model: string; skillset: string },
  stub: SkillsetRegistryStub,
  // runnability env: which external providers have a
  // stored credential, plus `dynamicModelOk` for a model a configured
  // provider's list-models returned  that isn't in the static
  // registry. When set, the model checks are skipped; the skillset
  // rules below still run.
  runtimeEnv?: { configuredProviders?: string[]; anthropicKeyPresent?: boolean; dynamicModelOk?: boolean },
  // Owner scope (the writing tenant) — gates which custom skillsets are
  // assignable. Undefined = admin (any). See `knownSkillsetIds`.
  scopeOwnerId?: string,
): Promise<AgentProfileValidationResult> {
  const dynamicModelOk = runtimeEnv?.dynamicModelOk === true;
  const runtimeEntry = resolveAgentRuntimeModel(input.model);
  if (runtimeEntry === null && !dynamicModelOk) {
    return {
      ok: false,
      error: {
        code: "unknown_model",
        message: `model not in runtime registry: ${input.model}`,
      },
    };
  }
  if (runtimeEntry !== null && !dynamicModelOk && !isRunnableAgentRuntimeModel(input.model, runtimeEnv as never)) {
    const why = (runtimeEntry.provider === "anthropic" || runtimeEntry.provider === "deepseek")
      ? `no credential configured for ${runtimeEntry.provider} (add one on the Models page)`
      : runtimeEntry.runtimeStatus;
    return {
      ok: false,
      error: {
        code: "unsupported_model",
        message: `model is not runnable in this build: ${input.model} (${runtimeEntry.provider}, ${why})`,
      },
    };
  }
  const known = await knownSkillsetIds(stub, scopeOwnerId);
  if (!known.has(input.skillset)) {
    return {
      ok: false,
      error: {
        code: "unknown_skillset",
        message: `skillset not in registry: ${input.skillset}`,
      },
    };
  }
  return { ok: true };
}
