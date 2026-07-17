/**
 * adapter for `manager.workflow_run_named`. Load a saved
 * descriptor by name, substitute `{{args.key}}` placeholders, validate,
 * and start it on the durable executor (same path as
 * manager.workflow_execute). Missing args fail fast with the full list.
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerWorkflowRunNamed,
  type ManagerEnv,
  type ManagerWorkflowRunNamedResult,
} from "../../agent/managerOps";

const inputSchema = z.object({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.string()).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerWorkflowRunNamedResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.workflow_run_named",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId =
      ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string"
        ? (ctx as { name: string }).name
        : null;
    return managerWorkflowRunNamed(env, { name: input.name, args: input.args }, callingAgentId);
  },
});
