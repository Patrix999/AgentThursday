/**
 * adapter for `manager.task_merge`.
 *
 * Thin shim over `managerTaskMerge` in `src/agent/managerOps.ts`. The
 * calling manager's agent_id is read off `ctx.name` (DO instance name
 * === agent_id) and threaded into the orchestrator, which delegates
 * permission enforcement to the an earlier revision
 * `source_agent_id === callingAgentId` boundary in
 * `filterSubagentSummariesForReader`.
 *
 * Inputs mirror `ManagerTaskMergeInput` (parent_task_id +
 * subagent_task_refs + merge_verdict + optional note/merged_at).
 * `manager_agent_id` is NOT accepted from caller — the helper derives
 * it from `ctx.name` so a manager cannot forge a peer's identity on
 * the merge event.
 *
 * Output: `ManagerTaskMergeResult` discriminated union with audit
 * fields (`task_id`, `parent_task_id`, `merge_verdict`,
 * `subagent_count`, `merged_at`, full payload echoed for inspect).
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerTaskMerge,
  type ManagerEnv,
  type ManagerTaskMergeInput,
  type ManagerTaskMergeResult,
} from "../../agent/managerOps";

const refSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  summary_id: z.string().min(1),
  verdict: z.enum(["success", "partial", "failed", "ignored"]),
  superseded_by: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).optional(),
});

const inputSchema = z.object({
  parent_task_id: z.string().min(1),
  subagent_task_refs: z.array(refSchema),
  merge_verdict: z.enum(["success", "partial", "failed"]),
  note: z.string().min(1).optional(),
  merged_at: z.string().min(1).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerTaskMergeResult;

function extractCallingAgentId(ctx: unknown): string | null {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { name?: unknown }).name !== "string"
  ) {
    return null;
  }
  const name = (ctx as { name: string }).name;
  return name.length > 0 ? name : null;
}

registerDispatchHandler<Input, Output>({
  tool_id: "manager.task_merge",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;
    const callingAgentId = extractCallingAgentId(ctx);
    if (callingAgentId === null) {
      // Return a structured validation_failed envelope rather than
      // throwing. Throwing surfaces as CF 1101 over HTTP; the typed
      // body lets the route mapper return a clean 400.
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message:
            "manager.task_merge requires a non-empty calling agent_id (DO `this.name` or `X-AgentThursday-Context-Id` header)",
        },
      } satisfies ManagerTaskMergeResult;
    }
    return managerTaskMerge(env, input as ManagerTaskMergeInput, callingAgentId);
  },
});
