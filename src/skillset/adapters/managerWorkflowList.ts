/**
 * adapter for `manager.workflow_list`. Bounded list of
 * saved workflow descriptors (name / version / phase + agent counts /
 * updated_at).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerWorkflowList,
  type ManagerEnv,
  type ManagerWorkflowListResult,
} from "../../agent/managerOps";

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerWorkflowListResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.workflow_list",
  inputSchema,
  execute: async (_input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId =
      ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string"
        ? (ctx as { name: string }).name
        : null;
    return managerWorkflowList(env, callingAgentId);
  },
});
