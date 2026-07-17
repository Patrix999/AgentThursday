/**
 * adapter for `manager.agent_update`. Updates a subset of
 * fields on an existing agent. Validation chain matches agent_create
 * (model + skillset cross-cutting) via shared
 * `validateAgentProfileInput`, only running when those fields are
 * present in the patch.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerUpdateAgent, resolveAgentOwnerIdentity, type ManagerEnv } from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  model: z.string().min(1).optional(),
  skillset: z.string().min(1).optional(),
  persona: z.string().max(2000).optional(),
  status: z.enum(["initialized", "archived", "deleted_marker"]).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerUpdateAgent>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.agent_update",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    // a scoped agent can only update agents it owns (cross-tenant
    // target → not_found inside managerUpdateAgent). Fail closed.
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    if (identity === null) {
      return { ok: false, error: { code: "internal", message: "cannot resolve the dispatching agent's owner; update refused" } };
    }
    return managerUpdateAgent(env, input, identity);
  },
});
