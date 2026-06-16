/**
 *  — adapter for `manager.agent_create`. See managerOps for
 * the full validation chain (name shape, model runtime check, skillset
 * existence, name uniqueness).
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerCreateAgent, type ManagerEnv } from "../../agent/managerOps";

const inputSchema = z.object({
  name: z.string().min(1).max(80),
  model: z.string().min(1),
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
  execute: async (input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerCreateAgent(env, input);
  },
});
