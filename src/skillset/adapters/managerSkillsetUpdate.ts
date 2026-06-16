/**
 *  — adapter for `manager.skillset_update`. Rejects embedded
 * skillset ids (`embedded_skillset_readonly`). The URL-supplied
 * skillset_id is enforced against `manifest.id` via the
 * `expectedId` option in `validateCustomSkillset`.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerUpdateSkillset, type ManagerEnv } from "../../agent/managerOps";

const inputSchema = z.object({
  skillset_id: z.string().min(1),
  manifest: z.unknown(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerUpdateSkillset>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_update",
  inputSchema,
  execute: async (input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerUpdateSkillset(env, input);
  },
});
