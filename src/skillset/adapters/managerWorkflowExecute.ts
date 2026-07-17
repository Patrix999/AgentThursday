/**
 * adapter for `manager.workflow_execute`. Agent-side entry
 * to the an earlier revision orchestration-as-code executor: validates the
 * declarative descriptor with the same validator the HTTP execute
 * endpoint uses and starts the durable Cloudflare Workflow. Validation
 * failures return `{ok:false, errors[]}` so the agent can fix the
 * descriptor and retry.
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerWorkflowExecute,
  type ManagerEnv,
  type ManagerWorkflowExecuteResult,
} from "../../agent/managerOps";

const inputSchema = z.object({
  descriptor: z.record(z.string(), z.unknown()),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerWorkflowExecuteResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.workflow_execute",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId =
      ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string"
        ? (ctx as { name: string }).name
        : null;
    return managerWorkflowExecute(env, { descriptor: input.descriptor }, callingAgentId);
  },
});
