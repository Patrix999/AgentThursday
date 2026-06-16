/**
 *  — adapter for `manager.subagent_summaries`.
 *
 * Thin shim over `managerSubagentSummaries` in `src/agent/managerOps.ts`.
 * The calling manager's agent_id is read off `ctx.name` (the DO
 * instance name === agent_id for per-agent AgentThursdayAgent DOs) and threaded
 * into the orchestrator which enforces the
 * `source_agent_id === callingAgentId` permission boundary
 * (ADR §6.3 /  §4).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerSubagentSummaries,
  type ManagerEnv,
  type ManagerSubagentSummariesResult,
} from "../../agent/managerOps";

const inputSchema = z.object({
  parent_task_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerSubagentSummariesResult;

interface CallingAgentCtx {
  name: string;
}

function requireCallingAgentCtx(ctx: unknown): CallingAgentCtx {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { name?: unknown }).name !== "string" ||
    ((ctx as { name: string }).name as string).length === 0
  ) {
    throw new Error(
      "manager.subagent_summaries requires agentCtx with a non-empty name (calling agent_id)",
    );
  }
  return ctx as CallingAgentCtx;
}

registerDispatchHandler<Input, Output>({
  tool_id: "manager.subagent_summaries",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingCtx = requireCallingAgentCtx(ctx);
    return managerSubagentSummaries(env, input, callingCtx.name);
  },
});
