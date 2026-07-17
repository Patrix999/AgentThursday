/**
 * adapter for `manager.skillset_create`. The manifest body
 * is canonicalised + validated (closed enum / known tool ids /
 * embedded id collision rejected) inside managerOps; this adapter
 * declares only the wrapper shape so the registry can route the
 * dispatch.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { managerCreateSkillset, resolveAgentOwnerIdentity, type ManagerEnv } from "../../agent/managerOps";
import { ADMIN_USER_ID } from "../../agent/requestIdentity";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  id: z.string().min(1).optional(),
  manifest: z.unknown(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerCreateSkillset>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.skillset_create",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    // Custom skillsets are owner-scoped: the new skillset inherits the CREATING
    // agent's owner (resolved from its own DO id, like an earlier revision dispatch).
    // FAIL CLOSED — never create an unattributable skillset (no admin fallback).
    const creatorId = tryGetOwnAgentId(ctx);
    const ownerIdentity =
      creatorId !== null ? await resolveAgentOwnerIdentity(env, creatorId) : null;
    if (ownerIdentity === null) {
      return {
        ok: false,
        error: { code: "internal", message: "cannot resolve the creating agent's owner; skillset create refused" },
      };
    }
    const ownerUserId = ownerIdentity.kind === "user" ? ownerIdentity.userId : ADMIN_USER_ID;
    return managerCreateSkillset(env, input, ownerUserId);
  },
});
