/**
 * adapter for `manager.agent_create`. See managerOps for
 * the full validation chain (name shape, model runtime check, skillset
 * existence, name uniqueness).
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerCreateAgent, resolveAgentOwnerIdentity, resolveAgentModel, type ManagerEnv } from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  name: z.string().min(1).max(80),
  // 2026-06-29 — optional on the agent→agent path: when omitted, the subagent
  // inherits the dispatching manager's own model (the operator: 默认使用跟 manager 同源的模型).
  // The HTTP route's schema still requires model — only this adapter defaults it.
  model: z.string().min(1).optional(),
  skillset: z.string().min(1),
  persona: z.string().max(2000).optional(),
  channel: z.string().optional(),
  status: z.enum(["initialized", "archived", "deleted_marker"]).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerCreateAgent>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.agent_create",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    // an agent it creates is owned by the DISPATCHING agent's owner
    // (not admin). Fail closed: unresolvable owner → refuse (never create as admin).
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    if (identity === null || dispatcherId === null) {
      return { ok: false, error: { code: "internal", message: "cannot resolve the dispatching agent's owner; create refused" } };
    }
    // Default the subagent's model to the dispatching manager's own model when
    // the caller omits one. Fail closed if it can't be resolved (no silent default).
    let model = input.model;
    if (model === undefined || model.length === 0) {
      const inherited = await resolveAgentModel(env, dispatcherId);
      if (inherited === null) {
        return { ok: false, error: { code: "internal", message: "no model given and cannot resolve the dispatching agent's model for default; create refused" } };
      }
      model = inherited;
    }
    // lineage: the dispatching agent is the parent (drawer tree).
    return managerCreateAgent(env, { ...input, model, parentAgentId: dispatcherId }, identity);
  },
});
