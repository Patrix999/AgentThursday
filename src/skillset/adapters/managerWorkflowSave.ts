/**
 *  — adapter for `manager.workflow_save`. Persist a validated
 * workflow descriptor under a kebab-case name (version increments on
 * re-save). Prompts may carry `{{args.key}}` placeholders resolved at
 * run-named time.
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerWorkflowSave,
  type ManagerEnv,
  type ManagerWorkflowSaveResult,
} from "../../agent/managerOps";

const inputSchema = z.object({
  name: z.string().min(1).max(64),
  descriptor: z.record(z.string(), z.unknown()),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerWorkflowSaveResult;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.workflow_save",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId =
      ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string"
        ? (ctx as { name: string }).name
        : null;
    return managerWorkflowSave(
      env,
      { name: input.name, descriptor: input.descriptor },
      callingAgentId,
    );
  },
});
