/**
 * dispatch ownership gate (pure; node-importable).
 *
 * Lives in its own module (NOT managerOps.ts) because managerOps imports
 * `agents` → `cloudflare:workers`, which a node test cannot load. The result
 * type is imported type-only (erased at runtime), so this module has no
 * runtime dependency on managerOps and stays unit-testable with a fake stub.
 */
import type { RequestIdentity } from "./requestIdentity";
import type { ManagerAgentMessageResult } from "./managerOps";

/** The minimal registry surface the gate needs (owner-scoped profile read). */
export interface DispatchOwnershipRegistry {
  readAgentProfile(
    id: string,
    identity?: RequestIdentity,
  ): Promise<{ owner_user_id?: string } | null>;
}

/**
 * A scoped dispatcher may only dispatch to an agent it owns; a cross-tenant
 * target reads as `target_not_found` (indistinguishable from a nonexistent
 * agent for that caller — no existence leak). Admin/undefined proceeds.
 *
 * Returns the block result the caller should return, or `null` to proceed.
 */
export async function checkDispatchOwnership(
  registry: DispatchOwnershipRegistry,
  agentId: string,
  identity?: RequestIdentity,
): Promise<ManagerAgentMessageResult | null> {
  if (identity === undefined || identity.kind !== "user") return null;
  const target = await registry.readAgentProfile(agentId, identity);
  if (target !== null) return null;
  return {
    ok: false,
    status: "failed",
    agent_id: agentId,
    error: { code: "target_not_found", message: `no agent registered with agent_id: ${agentId}` },
  };
}
