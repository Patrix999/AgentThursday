/**
 *  — adapter for `manager.agent_list`.
 *
 * Thin shim over `managerListAgents` in `src/agent/managerOps.ts`.
 * Input validation is Zod; orchestration / persistence / event emission
 * live in managerOps so the HTTP route (`/api/manager/agents`) and the
 * dispatch route (`/api/dispatch/manager/agent_list`) cannot drift.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerListAgents, type ManagerEnv } from "../../agent/managerOps";

const inputSchema = z.object({
  include_archived: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerListAgents>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.agent_list",
  inputSchema,
  execute: async (input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerListAgents(env, input);
  },
});
