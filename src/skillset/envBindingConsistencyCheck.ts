import type { SkillsetManifest } from "./types";
import { getContract } from "./contractRegistry";

export interface EnvBindingMismatch {
  tool_id: string;
  skillset_id: string;
  skill_id: string;
  expected: string;
  actual: string;
}

export function checkEnvBindingConsistency(
  manifests: SkillsetManifest[],
  getContractFn = getContract,
): EnvBindingMismatch[] {
  const mismatches: EnvBindingMismatch[] = [];

  for (const manifest of manifests) {
    for (const skill of manifest.skills) {
      for (const toolId of skill.tools) {
        const contract = getContractFn(toolId);
        if (contract?.env_binding) {
          const actual =
            (skill.source_ref as Record<string, unknown> | undefined)?.env_binding ?? "<missing>";
          if (actual !== contract.env_binding) {
            mismatches.push({
              tool_id: toolId,
              skillset_id: manifest.id,
              skill_id: skill.id,
              expected: contract.env_binding,
              actual: String(actual),
            });
          }
        }
      }
    }
  }

  return mismatches;
}
