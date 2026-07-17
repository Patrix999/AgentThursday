/**
 * adapter for `manager.schedule_cancel`: delete one schedule by
 * id, owner-scoped to the calling agent's owner (fail-closed; a foreign
 * schedule reads as not_found).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerScheduleCancel,
  resolveAgentOwnerIdentity,
  type ManagerEnv,
  type ManagerScheduleCancelResult,
} from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  schedule_id: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerScheduleCancelResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.schedule_cancel",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    return managerScheduleCancel(env, input, identity);
  },
});
