/**
 * pure resolver for the workspace's "active agent".
 *
 * The workspace console picks one cloud agent (an `AgentThursdayAgent` DO,
 * keyed on `agent_id` per an earlier revision) to drive: composer/send/continue
 * and the polled snapshot all route via this id. This module decides
 * which id to use from three sources in priority order:
 *
 *   1. `pinnedAgentId` — the user's explicit selector pick. Sticky in
 *      localStorage; survives reload; suppresses the canonical-pointer
 *      reconcile in `useWorkspace` so the user's choice isn't undone.
 *   2. `storedAgentId` — last-known `agentthursday.contextId` cache (set by
 *      the M7.7v3 reconcile flow). Used as fallback when no explicit
 *      pin is present.
 *   3. First agent in `agents` — sensible default when neither prior
 *      key matches anything currently visible.
 *
 * `agentId: null` means the agents list is empty. `pinIsStale: true`
 * means a pin was set but the pinned agent is no longer in the list;
 * the caller is responsible for clearing the pin in that case.
 *
 * Kept here (server-side `src/agent/`) for the existing node:test
 * stack — web/ has no test runner. Imported from
 * `web/src/agents/ActiveAgentSelector.tsx` via relative path.
 */

export interface ResolveActiveAgentInput {
  /** localStorage `agentthursday.activeAgentPin.id`; null if user hasn't pinned. */
  pinnedAgentId: string | null;
  /** localStorage `agentthursday.contextId`; empty string if unset. */
  storedAgentId: string;
  /** Current cloud agents list — only the `id` field is read. */
  agents: ReadonlyArray<{ id: string }>;
}

export interface ResolveActiveAgentResult {
  agentId: string | null;
  source: "pinned" | "stored" | "first" | "none";
  /**
   * `true` iff `pinnedAgentId` was non-null but no agent in the list
   * matched. Caller should clear the pin.
   */
  pinIsStale: boolean;
}

export function resolveActiveAgent(
  input: ResolveActiveAgentInput,
): ResolveActiveAgentResult {
  const has = (id: string): boolean => input.agents.some((a) => a.id === id);
  const pin = input.pinnedAgentId;
  if (pin !== null && pin.length > 0) {
    if (has(pin)) return { agentId: pin, source: "pinned", pinIsStale: false };
    return resolveNoPin(input, true);
  }
  return resolveNoPin(input, false);
}

function resolveNoPin(
  input: ResolveActiveAgentInput,
  pinIsStale: boolean,
): ResolveActiveAgentResult {
  const stored = input.storedAgentId;
  if (stored.length > 0 && input.agents.some((a) => a.id === stored)) {
    return { agentId: stored, source: "stored", pinIsStale };
  }
  if (input.agents.length > 0) {
    return { agentId: input.agents[0].id, source: "first", pinIsStale };
  }
  return { agentId: null, source: "none", pinIsStale };
}
