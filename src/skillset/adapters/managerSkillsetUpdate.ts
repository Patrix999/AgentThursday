/**
 * adapter for `manager.skillset_update`. Rejects embedded
 * skillset ids (`embedded_skillset_readonly`). The URL-supplied
 * skillset_id is enforced against `manifest.id` via the
 * `expectedId` option in `validateCustomSkillset`.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerUpdateSkillset, type ManagerEnv } from "../../agent/managerOps";
import { resolveCallerSkillsetScope } from "./managerCtx";

const inputSchema = z.object({
  skillset_id: z.string().min(1),
  manifest: z.unknown(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerUpdateSkillset>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_update",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    // Scope to the caller's tenant so a manager can only update its OWN custom
    // skillsets (not another tenant's). Update of embedded ids is rejected
    // upstream (embedded_skillset_readonly).
    return managerUpdateSkillset(env, input, await resolveCallerSkillsetScope(env, ctx));
  },
});
