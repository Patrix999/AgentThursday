/**
 * Channel/Console agent live binding.
 *
 * Pure resolver: given a conversation's binding (if any) plus pre-fetched
 * agent validation, decide where an inbox row should route.
 *
 * Pulled out of `ChannelHubAgent.routePending` for two reasons:
 *   1. testability — no DO / sql / RPC dependencies;
 *   2. so the per-row decision can be reasoned about as a single switch,
 *      not buried in the loop. an earlier revision batch-level
 *      `readiness ↔ submit must share a route` invariant still holds, but
 *      now per-row: the caller picks one resolved target per row and uses
 *      it for both readiness and submit.
 *
 * Side effects belong to the caller:
 *   - binding lookup (`channel_conversations.active_profile_id` — legacy
 *     column name, stores the bound agent_id; see an earlier revision design note)
 *   - agent RPC (`registryStub.readAgentProfile(agentId)` — legacy
 *     callable name on the registry DO, returns the agent row)
 *   - canonical active context resolution (`getActiveContextId()`)
 *
 * The caller hands all three in pre-resolved; this function only decides.
 *
 * agent-centric naming. Output kind is `agent_binding`
 * (was `profile_binding` in an earlier revision). The reason strings for invalid
 * bindings are now `"invalid_binding:agent:<agentId>:<cause>"` so
 * verifier logs / inspect rows are self-describing.
 */


export type ChannelRouteKind =
  | "agent_binding"
  | "active_context_fallback"
  | "invalid_binding";

/**
 * Input contract.
 *
 * - `conversationBinding.activeAgentId` is the raw `channel_conversations`
 *   value — `null` (or empty string after trimming) means unbound. The
 *   physical column is still named `active_profile_id` for storage
 *   compatibility (an earlier revision §compat); the caller maps column → field.
 * - `agentValidation` is the result of looking up the bound agent on
 *   the registry DO. Caller must populate it when `activeAgentId` is set;
 *   `null` is treated as "validation_unavailable" so the row fails safe
 *   instead of silently routing to the fallback (which would mask a
 *   misconfigured binding).
 * - `activeContextId` is the resolved canonical-active fallback target.
 *   Caller passes the registry instance name when the active pointer is
 *   empty / RPC failed — matching `getAgentThursdayRoute()`'s existing behavior.
 */
export interface ResolveChannelAgentRouteArgs {
  conversationBinding: { activeAgentId: string | null } | null;
  agentValidation: { exists: boolean; status: string | null } | null;
  activeContextId: string;
}

export type ResolveChannelAgentRouteResult =
  | {
      kind: "agent_binding";
      targetName: string;
      agentId: string;
      reason: null;
    }
  | {
      kind: "active_context_fallback";
      targetName: string;
      agentId: null;
      reason: null;
    }
  | {
      kind: "invalid_binding";
      targetName: null;
      agentId: string;
      reason: string;
    };

/**
 * Decide route for one inbox row.
 *
 * Invariants enforced here:
 *   - Unbound conversation → active-context fallback (preserves an earlier revision
 *     behavior for every conversation that hasn't opted in).
 *   - Bound conversation with an `initialized` agent → per-agent DO
 *     by `agent_id`. The DO name is the agent id itself, matching
 *     `AgentRunWorkflow.step.do`: `getAgentByName(env.AgentThursdayAgent, agent_id)`.
 *   - Bound conversation with a missing / archived / deleted_marker
 *     agent (or where validation was unavailable) → `invalid_binding`
 *     with a structured reason of the form
 *     `invalid_binding:agent:<agentId>:<cause>` so verifier logs /
 *     inspect rows are self-describing. Caller MUST NOT fall back to
 *     active context — that would silently route to the wrong agent,
 *     defeating the binding contract.
 *
 * status semantics (ADR `docs/adr/2026-05-26-agent-lifecycle-product-contract.md`):
 *   - `initialized`     : active agent (may be Paused via `accepts_tasks=false`;
 *                         that is the binding UI's concern, not the router);
 *   - `archived`        : soft-deleted; routing must refuse;
 *   - `deleted_marker`  : audit tombstone; routing must refuse.
 *   The `accepts_tasks=false` policy flag is not consulted here — the
 *   binding UI is the place to gate which paused agents users can
 *   send to, and a paused agent should still own its own conversation
 *   binding so resume works without re-binding.
 */
export function resolveChannelAgentRoute(
  args: ResolveChannelAgentRouteArgs,
): ResolveChannelAgentRouteResult {
  const rawBound = args.conversationBinding?.activeAgentId ?? null;
  const boundAgentId = typeof rawBound === "string" && rawBound.trim().length > 0
    ? rawBound.trim()
    : null;

  if (boundAgentId === null) {
    return {
      kind: "active_context_fallback",
      targetName: args.activeContextId,
      agentId: null,
      reason: null,
    };
  }

  if (args.agentValidation === null) {
    return {
      kind: "invalid_binding",
      targetName: null,
      agentId: boundAgentId,
      reason: `invalid_binding:agent:${boundAgentId}:validation_unavailable`,
    };
  }

  if (!args.agentValidation.exists) {
    return {
      kind: "invalid_binding",
      targetName: null,
      agentId: boundAgentId,
      reason: `invalid_binding:agent:${boundAgentId}:missing`,
    };
  }

  const status = args.agentValidation.status;
  if (status === "archived" || status === "deleted_marker") {
    return {
      kind: "invalid_binding",
      targetName: null,
      agentId: boundAgentId,
      reason: `invalid_binding:agent:${boundAgentId}:${status}`,
    };
  }

  return {
    kind: "agent_binding",
    targetName: boundAgentId,
    agentId: boundAgentId,
    reason: null,
  };
}
