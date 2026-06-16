/**
 *  — adapter for `manager.skillset_create`. The manifest body
 * is canonicalised + validated (closed enum / known tool ids /
 * embedded id collision rejected) inside managerOps; this adapter
 * declares only the wrapper shape so the registry can route the
 * dispatch.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerCreateSkillset, type ManagerEnv } from "../../agent/managerOps";

const inputSchema = z.object({
  id: z.string().min(1).optional(),
  manifest: z.unknown(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerCreateSkillset>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_create",
  inputSchema,
  execute: async (input, envUnknown) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    return managerCreateSkillset(env, input);
  },
});
