/**
 * adapter for `manager.agent_list`.
 *
 * Thin shim over `managerListAgents` in `src/agent/managerOps.ts`.
 * Input validation is Zod; orchestration / persistence / event emission
 * live in managerOps so the HTTP route (`/api/manager/agents`) and the
 * dispatch route (`/api/dispatch/manager/agent_list`) cannot drift.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerListAgents, resolveAgentOwnerIdentity, type ManagerEnv } from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  include_archived: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerListAgents>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.agent_list",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    // an agent-initiated list inherits the DISPATCHING agent's owner
    // (resolved from its own DO id), so a scoped agent only ever sees its own
    // tenant's agents. 426h fixed agent_message dispatch; this closes the same
    // gap on the read/CRUD tools. Fail closed: unresolvable owner → empty list,
    // never the admin (cross-tenant) view.
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    if (identity === null) return { ok: true, agents: [], count: 0 };
    return managerListAgents(env, input, identity);
  },
});
