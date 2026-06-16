/**
 *  — adapter for `manager.agent_message`. Forwards a single
 * user-style message to a specific agent's per-agent DO and AWAITS
 * the agent loop. Pre-checks the registry for `target_not_found`
 * (/355 invariant: no implicit DO instantiation). Long loops
 * that exceed the ~90s CF DO RPC envelope surface as
 * `agent_loop_timeout` — the task is injected regardless, so the
 * manager should not treat timeout as undelivered.
 *
 *  — when the calling manager DO has a `submitManagerTask`
 * round in flight, default `task_context.parent_task_id` and
 * `task_context.source_agent_id` from the manager's current outer
 * task context. Manager-supplied non-empty values are preserved.
 *
 *  — `parent_task_id` is REQUIRED on the merged context.
 * `TaskContextSchema` keeps `parent_task_id` `nullable().optional()`
 * to support pure read paths ( reader, audit replay), but at
 * the dispatch boundary a subagent MUST inherit a parent so the
 * summary-aggregation ( push) keyed by `parent_task_id` is
 * not silently broken. Outside a manager turn, the adapter rejects
 * with `invalid_input` instead of forwarding a parent-less context.
 *
 * Input-schema note: the adapter's `task_context` accepts a RELAXED
 * variant (`source_agent_id` optional) so the manager LLM can omit
 * the field and let the adapter recover it from `agentCtx`. The
 * adapter strict-revalidates the merged context against the canonical
 * `TaskContextSchema` before forwarding to the orchestrator, so an
 * unfilled `id`/`title`/`objective` still surfaces as a fail-soft
 * dispatch error rather than a silent drop downstream.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  managerSendAgentMessage,
  type ManagerAgentMessageInput,
  type ManagerEnv,
} from "../../agent/managerOps";
import { TaskContextSchema } from "../../agent/taskContext";
import { resolveDispatchTaskContext } from "../../agent/managerTaskContextFallback";
import { tryGetManagerCtx } from "./managerCtx";

//  — relaxed task_context for the adapter input boundary.
// `source_agent_id` is `.optional()` here so the manager LLM can omit
// it; the adapter fills it from `agentCtx.getCurrentManagerContext()`
// and then strict-revalidates against `TaskContextSchema`.
const TaskContextInputSchema = TaskContextSchema.extend({
  source_agent_id: z.string().min(1).optional(),
});

const inputSchema = z.object({
  agent_id: z.string().min(1),
  text: z.string().min(1),
  conversation_id: z.string().optional(),
  source: z.string().optional(),
  //  — optional structured TaskContext (ADR §5). Manager LLM
  // populates this when dispatching to a subagent; the subagent first
  // turn receives it as a `<task-context>` block.
  //  — accepts the relaxed shape; adapter re-validates strict.
  task_context: TaskContextInputSchema.optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = Awaited<ReturnType<typeof managerSendAgentMessage>>;

registerDispatchHandler<Input, Output>({
  tool_id: "manager.agent_message",
  inputSchema,
  execute: async (input, envUnknown, ctx) => {
    const env = (envUnknown ?? {}) as ManagerEnv;

    //  + 376 — resolve the dispatch-boundary task_context:
    //   - manager turn → fill missing parent_task_id / source_agent_id
    //     from the calling manager's current outer task context;
    //   - strict-validate against `TaskContextSchema`;
    //   - reject parent-less dispatches with `invalid_input` so
    //     summary aggregation () is never silently broken.
    const managerCtx = tryGetManagerCtx(ctx);
    const current =
      managerCtx !== null ? managerCtx.getCurrentManagerContext() : null;
    const resolution = resolveDispatchTaskContext(input.task_context, current);
    if (!resolution.ok) {
      return {
        ok: false,
        status: "failed",
        agent_id: input.agent_id,
        error: resolution.error,
      };
    }
    const strictTaskContext = resolution.taskContext;

    const orchestratorInput: ManagerAgentMessageInput = {
      agent_id: input.agent_id,
      text: input.text,
      ...(input.conversation_id !== undefined
        ? { conversation_id: input.conversation_id }
        : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(strictTaskContext !== undefined
        ? { task_context: strictTaskContext }
        : {}),
    };

    return managerSendAgentMessage(env, orchestratorInput);
  },
});
