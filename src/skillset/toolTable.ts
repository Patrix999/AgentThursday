/**
 * M8.1 Tool table builder.
 *
 * Authority: ADR 2026-05-07 IM-4 — every loaded skillset's tools[]
 * is projected into the agent's tool table with x_* metadata used
 * by fabric dispatcher to enforce tier / approval / evidence emit.
 *
 * Pure function: takes (manifest, registry) → array of tool table
 * entries. No skillset-id branching.
 *
 * For tools whose contract is `implemented: false`, fabric should
 * surface them as "available but disabled" in the agent's view, OR
 * omit them entirely. M8.1 chooses to **include** all entries with
 * an `x_implemented: false` flag, so agents can introspect what is
 * planned vs available; future M8.2 fabric may filter at runtime.
 */

import { TOOL_CONTRACTS, type ToolContract } from "./contractRegistry";
import type { ApprovalSpec, SkillsetManifest, Tier } from "./types";

export interface ToolTableEntry {
  name: string;
  description: string;
  input_schema: unknown;
  output_schema: unknown;
  x_tier: Tier;
  x_emit_events: string[];
  x_requires_approval: ApprovalSpec;
  x_idempotency_key_fields: string[] | null;
  x_dry_run_supported: boolean;
  x_implemented: boolean;
  x_skillset_id: string;
  x_skill_id: string;
}

/**
 * Resolve the effective approval requirement for a (skillset, skill,
 * contract) triple. Precedence (most → least specific):
 *   1. skill-level `requires_approval` override
 *   2. manifest-level `policy.per_tier_approval[tier]`
 *   3. fabric default by contract.tier (T1-T3 = none, T4-T5 = required)
 */
function resolveApproval(
  manifest: SkillsetManifest,
  skillRequires: ApprovalSpec | undefined,
  contractTier: Tier,
): ApprovalSpec {
  if (skillRequires) return skillRequires;
  const tierKey = String(contractTier);
  const perTier = manifest.policy.per_tier_approval?.[tierKey];
  if (perTier) return perTier;
  return contractTier >= 4
    ? {
        required: true,
        scope: "per_call",
        reason_required: true,
        reviewer: "human",
      }
    : { required: false };
}

export function buildToolTable(
  manifest: SkillsetManifest,
  registry: ReadonlyMap<string, ToolContract> = TOOL_CONTRACTS,
): ToolTableEntry[] {
  const table: ToolTableEntry[] = [];
  const seenToolIds = new Set<string>();
  for (const skill of manifest.skills) {
    for (const toolId of skill.tools) {
      // dedupe across skills to avoid double-injection
      const key = `${skill.id}:${toolId}`;
      if (seenToolIds.has(key)) continue;
      seenToolIds.add(key);
      const contract = registry.get(toolId);
      if (!contract) {
        // V2 should already have load-rejected this manifest;
        // defensively skip to avoid emitting a partial entry.
        continue;
      }
      const approval = resolveApproval(manifest, skill.requires_approval, contract.tier);
      table.push({
        name: contract.tool_id,
        description: contract.description,
        input_schema: contract.input_schema,
        output_schema: contract.output_schema,
        x_tier: contract.tier,
        x_emit_events: contract.emit_events.map(e => e.name),
        x_requires_approval: approval,
        x_idempotency_key_fields: contract.idempotency_key?.fields ?? null,
        x_dry_run_supported: contract.dry_run_supported,
        x_implemented: contract.implemented,
        x_skillset_id: manifest.id,
        x_skill_id: skill.id,
      });
    }
  }
  return table;
}

/**
 * Inspect-friendly summary: a flat list with key fields for /api/
 * inspect/skillset/<id>/tools.
 */
export function summarizeToolTable(entries: ToolTableEntry[]): Array<{
  name: string;
  tier: Tier;
  approval_required: boolean;
  implemented: boolean;
  emit_events: string[];
}> {
  return entries.map(e => ({
    name: e.name,
    tier: e.x_tier,
    approval_required: e.x_requires_approval.required,
    implemented: e.x_implemented,
    emit_events: e.x_emit_events,
  }));
}
