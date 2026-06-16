/**
 *  — adapter for `manager.agent_update`. Updates a subset of
 * fields on an existing agent. Validation chain matches agent_create
 * (model + skillset cross-cutting) via shared
 * `validateAgentProfileInput`, only running when those fields are
 * present in the patch.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerUpdateAgent, type ManagerEnv } from "../../agent/managerOps";

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
  execute: async (input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerUpdateAgent(env, input);
  },
});
