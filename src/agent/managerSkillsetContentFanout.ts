/**
 *  — pure fan-out helper for custom-skillset content updates.
 *
 * Lives in its own module (NOT inside `managerOps.ts`) so the test
 * suite can `node --import tsx --test` it without triggering the
 * `agents` → `partyserver` → `cloudflare:workers` import chain that
 * `managerOps.ts` carries via `getAgentByName`.
 *
 * Behavior contract:
 *   1. Enumerate active-roster agents (default `listAgentProfiles` —
 *      excludes `archived` + `deleted_marker` per ADR §2.1) whose
 *      `profile.skillset === skillset_id`.
 *   2. For each, call `refreshCustomSkillsetCache()` on the resolved
 *      per-agent stub.
 *   3. Record `manager.skillset.content.refreshed` per success and
 *      `manager.skillset.content.refresh_failed` per failure (per-agent
 *      RPC error OR enumerate-phase listAgentProfiles error).
 *   4. Never throw — even if every per-agent call fails. The caller's
 *      canonical manifest update must not be rolled back by refresh
 *      failures.
 *
 * Scope: direct profile.skillset binding only. Transitive composition
 * (a custom skillset whose closure pulls another patched custom
 * skillset) is out of scope for .
 */
import type { AgentProfile } from "../schema/agent";

export const SKILLSET_CONTENT_REFRESHED_EVENT = "manager.skillset.content.refreshed" as const;
export const SKILLSET_CONTENT_REFRESH_FAILED_EVENT = "manager.skillset.content.refresh_failed" as const;

export interface FanoutRegistryStubSurface {
  listAgentProfiles(opts: { includeArchived?: boolean }): Promise<AgentProfile[]>;
  recordManagerEvent(type: string, payload: unknown): Promise<void> | void;
}

export interface FanoutPerAgentStubSurface {
  refreshCustomSkillsetCache(): Promise<{
    profile_id: string;
    custom_skillset_ids: string[];
    effective_skillset_ids: string[] | null;
    fallback_reason: string | null;
  }>;
}

export interface FanoutInput {
  stub: FanoutRegistryStubSurface;
  skillsetId: string;
  updatedAt: string;
  resolvePerAgent: (agentId: string) => Promise<FanoutPerAgentStubSurface>;
}

export interface FanoutResult {
  attempted: string[];
  refreshed: string[];
  failed: Array<{ agent_id: string | null; phase: "enumerate" | "refresh"; message: string }>;
}

export async function fanoutCustomSkillsetContentRefresh(
  input: FanoutInput,
): Promise<FanoutResult> {
  const { stub, skillsetId, updatedAt, resolvePerAgent } = input;
  const result: FanoutResult = { attempted: [], refreshed: [], failed: [] };
  let bound: AgentProfile[] = [];
  try {
    const all = await stub.listAgentProfiles({ includeArchived: false });
    bound = all.filter((p) => p.skillset === skillsetId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.failed.push({ agent_id: null, phase: "enumerate", message });
    await stub.recordManagerEvent(SKILLSET_CONTENT_REFRESH_FAILED_EVENT, {
      skillset_id: skillsetId,
      phase: "enumerate",
      message,
    });
    return result;
  }
  await Promise.all(
    bound.map(async (profile) => {
      result.attempted.push(profile.id);
      try {
        const perAgent = await resolvePerAgent(profile.id);
        const refresh = await perAgent.refreshCustomSkillsetCache();
        result.refreshed.push(profile.id);
        await stub.recordManagerEvent(SKILLSET_CONTENT_REFRESHED_EVENT, {
          skillset_id: skillsetId,
          agent_id: profile.id,
          custom_skillset_ids: refresh.custom_skillset_ids,
          effective_skillset_ids: refresh.effective_skillset_ids,
          fallback_reason: refresh.fallback_reason,
          updated_at: updatedAt,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.failed.push({ agent_id: profile.id, phase: "refresh", message });
        await stub.recordManagerEvent(SKILLSET_CONTENT_REFRESH_FAILED_EVENT, {
          skillset_id: skillsetId,
          agent_id: profile.id,
          phase: "refresh",
          message,
        });
      }
    }),
  );
  return result;
}
