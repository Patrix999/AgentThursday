/**
 * narrow agent-context surface for manager-side adapters.
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

/**
 * the DISPATCHING agent's own id (`this.name`), independent of any
 * in-flight manager round. Used to resolve the dispatcher's owner so an
 * agent-initiated dispatch inherits its owner (a scoped agent can only dispatch
 * within its own tenant). Returns null only if the ctx is not an AgentThursdayAgent
 * shape (legacy/test) — the security path treats null as fail-closed (no
 * dispatch), NOT as an admin fallback.
 */
export function tryGetOwnAgentId(ctx: unknown): string | null {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { getOwnAgentId?: unknown }).getOwnAgentId !== "function"
  ) {
    return null;
  }
  const id = (ctx as { getOwnAgentId: () => unknown }).getOwnAgentId();
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Owner-scope for the manager skillset READ tools (list / read / update),
 * resolved from the CALLING agent's own id: admin → `undefined` (sees all
 * custom); a scoped user → its own id; unresolvable owner → a sentinel that
 * matches no `owner_user_id`, so a transient failure degrades to embedded-only
 * (never a cross-tenant leak). Mirrors the create-path owner inheritance.
 */
export async function resolveCallerSkillsetScope(
  env: import("../../agent/managerOps").ManagerEnv,
  ctx: unknown,
): Promise<string | undefined> {
  const { resolveAgentOwnerIdentity } = await import("../../agent/managerOps");
  const callerId = tryGetOwnAgentId(ctx);
  const identity = callerId !== null ? await resolveAgentOwnerIdentity(env, callerId) : null;
  if (identity === null) return "__no_owner__";
  return identity.kind === "user" ? identity.userId : undefined;
}
