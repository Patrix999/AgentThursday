/**
 * adapter for `manager.workflow_status`. Read-only view of
 * the an earlier revision workflow run ledger tree (run → phases → agents) for a
 * run started via manager.workflow_execute (or any other run id).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerWorkflowStatus,
  type ManagerEnv,
  type ManagerWorkflowStatusResult,
} from "../../agent/managerOps";

const inputSchema = z.object({
  run_id: z.string().min(1).max(200),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerWorkflowStatusResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.workflow_status",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId =
      ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string"
        ? (ctx as { name: string }).name
        : null;
    return managerWorkflowStatus(env, { run_id: input.run_id }, callingAgentId);
  },
});
