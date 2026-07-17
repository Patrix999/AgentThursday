/**
 * adapter for `manager.task_complete`.
 *
 * Thin shim over `managerTaskComplete` in `src/agent/managerOps.ts`.
 * The calling manager's agent_id is read off `ctx.name` (DO instance
 * name === agent_id, or `X-AgentThursday-Context-Id` over HTTP). It is threaded
 * into the orchestrator as `callingAgentId`, which the pure helper uses
 * to populate `manager_agent_id` on the recorded payload — the field
 * is NEVER taken from caller input.
 *
 * Inputs mirror `ManagerTaskCompleteInput` (parent_task_id +
 * completion_verdict + summary + optional evidence / next_step /
 * card_ref / allow_without_merge / allow_without_merge_reason +
 * optional completed_at for deterministic test smokes).
 *
 * Output: `ManagerTaskCompleteResult` discriminated union with
 * `task_id`, `parent_task_id`, `completion_verdict`, `completed_at`
 * and the full payload echoed for inspect.
 */
import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerTaskComplete,
  type ManagerEnv,
  type ManagerTaskCompleteInput,
  type ManagerTaskCompleteResult,
} from "../../agent/managerOps";

const evidenceSchema = z
  .object({
    merge_event_id: z.number().int().nonnegative().optional(),
    subagent_task_ids: z.array(z.string().min(1)).optional(),
    envelope_id: z.string().min(1).optional(),
  })
  .strict();

const cardRefSchema = z
  .object({
    card_id: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

const inputSchema = z.object({
  parent_task_id: z.string().min(1),
  completion_verdict: z.enum(["success", "partial", "failed"]),
  summary: z.string().min(1),
  evidence: evidenceSchema.optional(),
  next_step: z.string().min(1).optional(),
  card_ref: cardRefSchema.optional(),
  allow_without_merge: z.boolean().optional(),
  allow_without_merge_reason: z.string().min(1).optional(),
  completed_at: z.string().min(1).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = ManagerTaskCompleteResult;

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
  tool_id: "manager.task_complete",
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
            "manager.task_complete requires a non-empty calling agent_id (DO `this.name` or `X-AgentThursday-Context-Id` header)",
        },
      } satisfies ManagerTaskCompleteResult;
    }
    return managerTaskComplete(
      env,
      input as ManagerTaskCompleteInput,
      callingAgentId,
    );
  },
});
