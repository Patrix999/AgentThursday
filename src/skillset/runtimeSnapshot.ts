/**
 * an earlier revision/c — agent runtime skillset snapshot.
 *
 * an earlier revision established `docs/skillsets/*.yaml` → generated
 * manifests → loader as the build-time pipeline. an earlier revision added the
 * runtime control plane on top: the agent caches the loader output as
 * a `SkillsetRuntimeSnapshot` and the dynamic tool mapper consumes
 * that same cached snapshot, so the agent's `getTools()` surface and
 * the inspect surface are guaranteed not to diverge between rebuilds.
 *
 * an earlier revision adds operator-side disable/enable: `BuildSnapshotArgs`
 * accepts a `disabledSkillsetIds` set; manifests in that set are
 * moved from `skillset_ids.loaded` to `skillset_ids.disabled`, and
 * their tool bindings are filtered out of `agent_tools` + `tool_ids`.
 * The legacy `state` / `detail` projections remain raw so the existing
 * inspect routes continue to describe what the loader saw; the
 * disable filter is exclusively a runtime / agent-surface concern.
 *
 * The reload action (`POST /api/skillset/reload`) increments
 * `reload_count`, re-runs the loader against the same deployed
 * `EMBEDDED_MANIFESTS`, re-applies env-binding readiness downgrade,
 * applies the current disabled set, and writes a `skillset.reload`
 * event. The disable / enable actions
 * (`POST /api/skillset/{disable,enable}`) mutate the agent's disabled
 * set, rebuild the snapshot, and write `skillset.disable` /
 * `skillset.enable` events. None of these are DB-backed production
 * hot reload — the deployed bundle is still the source of truth.
 *
 * Provider-neutral: no skillset id appears in this module.
 */

import {
  loadSkillsets,
  summarizeLoaderDetail,
  downgradeCapabilityClassByEnvBinding,
  type LoaderDetailSummary,
} from "./loader";
import { STUB_KNOWN_TOOL_IDS } from "./contractRegistry";
import {
  describeDynamicToolBindings,
  type DynamicToolBindingProof,
} from "./agentDynamicTools";
import type { EmbeddedManifest } from "./manifests";
import type { LoaderState } from "./types";

/**
 * Per-skillset disable record. `reason` is operator-supplied free
 * text (truncated by the agent before being passed in); `disabled_at`
 * is the ISO timestamp at which the operator triggered disable.
 */
export interface DisabledSkillsetEntry {
  skillset_id: string;
  disabled_at: string;
  reason: string | null;
}

export interface SkillsetRuntimeSnapshot {
  loaded_at: string;
  reload_count: number;
  schema_version: string;
  source_shas: Record<string, string>;
  /**
   * an earlier revision: `loaded` + `rejected` partitioned by loader.
   * an earlier revision: operator-disabled ids are split out of `loaded` into
   * `disabled` so the agent surface can hide them without losing the
   * loader-accepted distinction. `loaded ∪ disabled ∪ rejected` covers
   * every embedded manifest.
   */
  skillset_ids: { loaded: string[]; disabled: string[]; rejected: string[] };
  /**
   * an earlier revision: rich disable records (with `reason` + `disabled_at`)
   * kept alongside the id partition. Order matches `skillset_ids.disabled`.
   */
  disabled: DisabledSkillsetEntry[];
  tool_ids: string[];
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
  // Internal projections kept on the snapshot so the agent's tool
  // mapper and the inspect surface can consume the same data without
  // recomputing or re-downgrading. These reflect raw loader output —
  // operator disable is layered on top via the public `skillset_ids`
  // partition + `agent_tools` filter, NOT by mutating these.
  state: LoaderState;
  detail: LoaderDetailSummary;
  agent_tools: DynamicToolBindingProof[];
}

export interface BuildSnapshotArgs {
  env: unknown;
  envLookup: (binding: string) => string | undefined;
  reload_count: number;
  /** Test override; falls back to deployed `EMBEDDED_MANIFESTS`. */
  embedded?: ReadonlyArray<EmbeddedManifest>;
  /**
   * operator-disabled skillset ids. Manifests whose id is
   * in this map are moved out of `skillset_ids.loaded` into
   * `skillset_ids.disabled`, and any tool bindings sourced from them
   * are filtered out of `agent_tools` + `tool_ids`. Unknown ids are
   * tolerated (the caller is expected to validate before mutating
   * its disabled set); they appear in `disabled` only if they are
   * also in the loader-accepted set.
   */
  disabledSkillsets?: ReadonlyMap<string, { disabled_at: string; reason: string | null }>;
}

export function buildSkillsetRuntimeSnapshot(
  args: BuildSnapshotArgs,
): SkillsetRuntimeSnapshot {
  const state = loadSkillsets(args.embedded, {
    knownToolIds: STUB_KNOWN_TOOL_IDS,
  });
  const detail = summarizeLoaderDetail(state);
  downgradeCapabilityClassByEnvBinding(detail, args.envLookup);
  const rawAgentTools = describeDynamicToolBindings({
    state,
    env: args.env,
    envLookup: args.envLookup,
  });

  const disabledMap = args.disabledSkillsets ?? new Map();
  const loaded: string[] = [];
  const disabledIds: string[] = [];
  const rejected: string[] = [];
  const source_shas: Record<string, string> = {};
  for (const id of Object.keys(state.entries).sort()) {
    const entry = state.entries[id];
    source_shas[id] = entry.source_sha;
    if (entry.status === "loaded") {
      if (disabledMap.has(id)) disabledIds.push(id);
      else loaded.push(id);
    } else {
      rejected.push(id);
    }
  }
  const disabled: DisabledSkillsetEntry[] = disabledIds.map(id => {
    const rec = disabledMap.get(id)!;
    return {
      skillset_id: id,
      disabled_at: rec.disabled_at,
      reason: rec.reason,
    };
  });
  // Filter agent_tools: drop any binding sourced from a disabled
  // skillset. Pure projection — no state mutation.
  const disabledSet = new Set(disabledIds);
  const agentTools = rawAgentTools.filter(b => !disabledSet.has(b.skillset_id));
  const tool_ids = [...new Set(agentTools.map(b => b.tool_id))].sort();

  return {
    loaded_at: state.loaded_at,
    reload_count: args.reload_count,
    schema_version: state.schema_version,
    source_shas,
    skillset_ids: { loaded, disabled: disabledIds, rejected },
    disabled,
    tool_ids,
    total_soul_token_estimate: state.total_soul_token_estimate,
    total_soul_token_cap: state.total_soul_token_cap,
    per_skillset_token_cap: state.per_skillset_token_cap,
    state,
    detail,
    agent_tools: agentTools,
  };
}

/**
 * Non-sensitive summary for `GET /api/skillset/runtime` and the body
 * of `POST /api/skillset/reload`. Drops the heavyweight `state` /
 * `detail` projections (loader state carries raw manifest objects
 * and source_yaml). `agent_tools` is preserved because its fields
 * (`ai_sdk_name`, canonical `tool_id`, composed `description`, etc.)
 * are already provider-neutral and do not contain secret material.
 */
export interface SkillsetRuntimeSummary {
  loaded_at: string;
  reload_count: number;
  schema_version: string;
  source_shas: Record<string, string>;
  skillset_ids: { loaded: string[]; disabled: string[]; rejected: string[] };
  disabled: DisabledSkillsetEntry[];
  tool_ids: string[];
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
  agent_tools: DynamicToolBindingProof[];
}

export function summarizeSnapshot(
  snapshot: SkillsetRuntimeSnapshot,
): SkillsetRuntimeSummary {
  return {
    loaded_at: snapshot.loaded_at,
    reload_count: snapshot.reload_count,
    schema_version: snapshot.schema_version,
    source_shas: { ...snapshot.source_shas },
    skillset_ids: {
      loaded: [...snapshot.skillset_ids.loaded],
      disabled: [...snapshot.skillset_ids.disabled],
      rejected: [...snapshot.skillset_ids.rejected],
    },
    disabled: snapshot.disabled.map(d => ({ ...d })),
    tool_ids: [...snapshot.tool_ids],
    total_soul_token_estimate: snapshot.total_soul_token_estimate,
    total_soul_token_cap: snapshot.total_soul_token_cap,
    per_skillset_token_cap: snapshot.per_skillset_token_cap,
    agent_tools: snapshot.agent_tools.map(b => ({ ...b })),
  };
}
