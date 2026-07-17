/**
 * adapter for `manager.skillset_read`. Returns the resolved
 * manifest + per-row `source` + loader status + (for rejected entries)
 * the first validation reason. Uses `{status, reason}` envelope per
 * its tool YAML.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerReadSkillset, type ManagerEnv } from "../../agent/managerOps";
import { resolveCallerSkillsetScope } from "./managerCtx";

const inputSchema = z.object({
  skillset_id: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerReadSkillset>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_read",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerReadSkillset(env, input, await resolveCallerSkillsetScope(env, ctx));
  },
});
