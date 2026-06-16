/**
 *  — narrow agent-context surface for manager-side adapters.
 *
 * The dynamic-tool dispatch path passes `agentCtx` as the third arg to
 * `DispatchHandler.execute`. For `manager.agent_message` we only need
 * a single read method: `getCurrentManagerContext()`, exposed by
 * `AgentThursdayAgent`. Keeping the surface narrow means the adapter doesn't
 * cross the encapsulation boundary with `as AgentThursdayAgent`.
 *
 * Returns null when the adapter is invoked without `agentCtx` (legacy
 * paths) OR the ctx is not the AgentThursdayAgent shape OR the agent has no
 * `submitManagerTask` round in flight. Callers fall back to no-op:
 * no manager-context merge, original `task_context` passes through.
 */

export interface ManagerAgentCtx {
  getCurrentManagerContext(): {
    manager_task_id: string;
    agent_id: string;
    source?: string;
    conversation_id?: string;
  } | null;
}

export function tryGetManagerCtx(ctx: unknown): ManagerAgentCtx | null {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { getCurrentManagerContext?: unknown }).getCurrentManagerContext !==
      "function"
  ) {
    return null;
  }
  return ctx as ManagerAgentCtx;
}
