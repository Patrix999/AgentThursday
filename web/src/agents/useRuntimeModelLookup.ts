import { useEffect, useState } from "react";
import {
  getAgentProfileOptions,
  type AgentRuntimeModelOption,
} from "../api/agentProfiles";

/**
 *  — fetch the runtime-model option list once and expose a
 * `lookup(modelId)` for the read-only surfaces (`/agents`,
 * `/agents/:id`, `/agent-runs/:id`).
 *
 * Returns `null` for the option until the fetch resolves; `null` for
 * an unknown id once loaded. Callers fail-soft to "show profile.model
 * unannotated" in both null cases — see usage sites for the exact
 * rendering.
 */
export function useRuntimeModelLookup(): {
  lookup: (modelId: string) => AgentRuntimeModelOption | null;
  loaded: boolean;
} {
  const [byId, setById] = useState<Map<string, AgentRuntimeModelOption> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentProfileOptions()
      .then(r => {
        if (cancelled || r === null) return;
        setById(new Map(r.models.map(m => [m.id, m])));
      })
      .catch(() => {
        // Fail-soft: caller treats undefined as "show id unannotated".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    lookup: (modelId: string) => byId?.get(modelId) ?? null,
    loaded: byId !== null,
  };
}
