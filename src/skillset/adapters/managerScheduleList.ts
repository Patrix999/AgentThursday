/**
 * adapter for `manager.schedule_list`: the calling agent's
 * owner's schedules (optionally narrowed to one agent). Owner scope is
 * resolved from the caller itself, fail-closed (an earlier revision posture).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerScheduleList,
  resolveAgentOwnerIdentity,
  type ManagerEnv,
  type ManagerScheduleListResult,
} from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  agent_id: z.string().min(1).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerScheduleListResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.schedule_list",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    return managerScheduleList(env, input, identity);
  },
});
