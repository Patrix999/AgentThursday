/**
 * Skillset runtime capability snapshot derivation.
 *
 * Pure read-only derivation: maps the existing inspect/runtime payloads
 * (`/api/inspect/skillset/detail`, `/api/inspect/skillset/tools`,
 * `/api/skillset/runtime`) into a snapshot the `/skillsets/:id` page
 * renders above the existing detail sections.
 *
 * Inputs are declared as minimal structural interfaces so this module
 * stays in the backend `src/` tree without importing frontend api types;
 * the frontend types satisfy them by duck typing.
 */

export type RuntimeState = "loaded" | "disabled" | "rejected" | "absent";

export interface ToolContractInput {
  tier: number;
  approval_required: boolean;
  implemented: boolean;
  emit_events: ReadonlyArray<string>;
}

export interface DetailSkillInput {
  id: string;
}

export interface DetailEntryInput {
  skills: ReadonlyArray<DetailSkillInput>;
}

export interface AgentToolBindingInput {
  skillset_id: string;
  has_handler: boolean;
}

export interface RuntimeDisabledEntryInput {
  skillset_id: string;
  reason: string | null;
}

export interface RuntimeSummaryInput {
  skillset_ids: {
    loaded: ReadonlyArray<string>;
    disabled: ReadonlyArray<string>;
    rejected: ReadonlyArray<string>;
  };
  disabled: ReadonlyArray<RuntimeDisabledEntryInput>;
  agent_tools: ReadonlyArray<AgentToolBindingInput>;
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
}

export interface RuntimeStateInfo {
  state: RuntimeState;
  reason: string | null;
  raw: {
    in_loaded: boolean;
    in_disabled: boolean;
    in_rejected: boolean;
    reason: string | null;
  } | null;
}

export interface SnapshotCounts {
  declared_skills: number;
  tool_contracts: number;
  active_agent_bindings: number;
  approval_required: number;
  not_implemented: number;
  no_handler: number;
  event_emitting: number;
}

export interface SnapshotCaps {
  per_skillset_token_cap: number;
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
}

export interface RuntimeCapabilitySnapshot {
  state: RuntimeState;
  reason: string | null;
  counts: SnapshotCounts;
  tier_distribution: Record<string, number>;
  caps: SnapshotCaps | null;
}

export function resolveRuntimeState(
  id: string,
  runtime: RuntimeSummaryInput | null,
): RuntimeStateInfo {
  if (!runtime) {
    return { state: "absent", reason: null, raw: null };
  }
  const inLoaded = runtime.skillset_ids.loaded.includes(id);
  const inDisabled = runtime.skillset_ids.disabled.includes(id);
  const inRejected = runtime.skillset_ids.rejected.includes(id);
  const disabledEntry = runtime.disabled.find((d) => d.skillset_id === id);
  const reason = disabledEntry?.reason ?? null;
  let state: RuntimeState = "absent";
  if (inDisabled) state = "disabled";
  else if (inRejected) state = "rejected";
  else if (inLoaded) state = "loaded";
  return {
    state,
    reason,
    raw: { in_loaded: inLoaded, in_disabled: inDisabled, in_rejected: inRejected, reason },
  };
}

export function deriveRuntimeCapabilitySnapshot(args: {
  id: string;
  detailEntry: DetailEntryInput | null;
  toolRows: ReadonlyArray<ToolContractInput>;
  runtime: RuntimeSummaryInput | null;
}): RuntimeCapabilitySnapshot {
  const { id, detailEntry, toolRows, runtime } = args;
  const stateInfo = resolveRuntimeState(id, runtime);

  const skillsetBindings = runtime
    ? runtime.agent_tools.filter((b) => b.skillset_id === id)
    : [];

  const counts: SnapshotCounts = {
    declared_skills: detailEntry ? detailEntry.skills.length : 0,
    tool_contracts: toolRows.length,
    active_agent_bindings: skillsetBindings.length,
    approval_required: toolRows.filter((t) => t.approval_required).length,
    not_implemented: toolRows.filter((t) => !t.implemented).length,
    no_handler: skillsetBindings.filter((b) => !b.has_handler).length,
    event_emitting: toolRows.filter((t) => t.emit_events.length > 0).length,
  };

  const tier_distribution: Record<string, number> = {};
  for (const t of toolRows) {
    const k = String(t.tier);
    tier_distribution[k] = (tier_distribution[k] ?? 0) + 1;
  }

  const caps: SnapshotCaps | null = runtime
    ? {
        per_skillset_token_cap: runtime.per_skillset_token_cap,
        total_soul_token_estimate: runtime.total_soul_token_estimate,
        total_soul_token_cap: runtime.total_soul_token_cap,
      }
    : null;

  return {
    state: stateInfo.state,
    reason: stateInfo.reason,
    counts,
    tier_distribution,
    caps,
  };
}
