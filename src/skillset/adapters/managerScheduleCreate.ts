/**
 * adapter for `manager.schedule_create`.
 *
 * Cross-agent variant of the self-only base tool : a manager puts
 * an agent of ITS OWN OWNER on a recurring schedule. Dispatcher identity is
 * resolved from the calling DO itself (`ctx.name` → profile owner, Card
 * 426h posture — never the manager turn ctx); the orchestrator's ownership
 * check makes a cross-tenant target read as target_not_found.
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerScheduleCreate,
  resolveAgentOwnerIdentity,
  type ManagerEnv,
  type ManagerScheduleResult,
} from "../../agent/managerOps";
import { tryGetOwnAgentId } from "./managerCtx";

const inputSchema = z.object({
  agent_id: z.string().min(1),
  kind: z.enum(["interval", "daily", "weekly"]),
  prompt: z.string().min(1).max(4000),
  interval_hours: z.number().min(0.25).max(24 * 30).optional(),
  at_hour: z.number().int().min(0).max(23).optional(),
  at_minute: z.number().int().min(0).max(59).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  utc_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerScheduleResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.schedule_create",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const dispatcherId = tryGetOwnAgentId(ctx);
    const identity = dispatcherId !== null ? await resolveAgentOwnerIdentity(env, dispatcherId) : null;
    return managerScheduleCreate(env, input, identity);
  },
});
