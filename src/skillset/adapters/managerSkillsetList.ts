/**
 *  — adapter for `manager.skillset_list`. Returns the merged
 * embedded ∪ custom skillset set with per-row `source` + loader
 * `status` (loaded / rejected / unknown).
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerListSkillsets, type ManagerEnv } from "../../agent/managerOps";

const inputSchema = z.object({}).optional().transform((v) => v ?? {});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerListSkillsets>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_list",
  inputSchema,
  execute: async (_input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerListSkillsets(env);
  },
});
