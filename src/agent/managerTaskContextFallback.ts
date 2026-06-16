/**
 *  — pure helper that fills missing `task_context` fields on a
 * `manager.agent_message` input from the calling manager's current task
 * context. Keeps the orchestrator/adapter free of branching logic.
 *
 * Rules (ADR §5.x extension,  必做 2):
 *   - If `input.task_context` is undefined (text-only call), return input
 *     unchanged.
 *   - If `task_context.parent_task_id` is missing/null, fill it with the
 *     current `manager_task_id`.
 *   - If `task_context.source_agent_id` is missing/empty, fill it with the
 *     current manager `agent_id`.
 *   - Explicit non-empty values are NEVER overridden — manager LLM can
 *     still cross-link to a parent outside the current task chain.
 *
 *  — `resolveDispatchTaskContext` is the dispatch-boundary
 * resolver: it composes (a) the manager-turn fallback above with (b)
 * strict `TaskContextSchema` validation and (c) a hard-required
 * `parent_task_id` gate so a parent-less subagent dispatch returns
 * `invalid_input` instead of silently breaking summary aggregation.
 *
 * Pure: no dependency on `cloudflare:workers`, the DO instance, or env.
 */

import type { ManagerAgentMessageInput } from "./managerOps";
import { TaskContextSchema, type TaskContext } from "./taskContext";

export interface CurrentManagerContext {
  manager_task_id: string;
  agent_id: string;
}

function isMissing(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === "";
}

export function applyManagerTaskContextFallback(
  input: ManagerAgentMessageInput,
  current: CurrentManagerContext,
): ManagerAgentMessageInput {
  if (input.task_context === undefined) return input;

  const tc = input.task_context;
  const needsParent = isMissing(tc.parent_task_id);
  const needsSource = isMissing(tc.source_agent_id);
  if (!needsParent && !needsSource) return input;

  const merged = { ...tc };
  if (needsParent) merged.parent_task_id = current.manager_task_id;
  if (needsSource) merged.source_agent_id = current.agent_id;
  return { ...input, task_context: merged };
}

/**
 *  — dispatch-boundary task_context resolver.
 *
 * Composes:
 *   1. The  manager-turn fallback when `current` is non-null.
 *   2. Strict `TaskContextSchema` validation.
 *   3. A hard-required `parent_task_id` gate. The canonical schema
 *      keeps `parent_task_id` `nullable().optional()` so audit/replay
 *      paths can read legacy rows; at the dispatch boundary, however,
 *      a missing parent silently breaks `manager.subagent.summary`
 *      aggregation ( push is keyed by `parent_task_id`).
 *
 * Returns:
 *   - `{ ok: true, taskContext: undefined }` for text-only calls.
 *   - `{ ok: true, taskContext: <strict> }` when validation passed.
 *   - `{ ok: false, error: { code: "invalid_input", message } }` for
 *     schema failures OR a missing/empty `parent_task_id` outside a
 *     manager turn. The adapter wraps this in its `{ok,status,agent_id,
 *     error}` shape.
 *
 * Pure: no `cloudflare:workers`, no env, no DO callable. Pull-only
 * dependency is the zod schema in `taskContext.ts`.
 */
export type ResolveDispatchTaskContextResult =
  | { ok: true; taskContext: TaskContext | undefined }
  | { ok: false; error: { code: "invalid_input"; message: string } };

export function resolveDispatchTaskContext(
  inputTaskContext: unknown,
  current: CurrentManagerContext | null,
): ResolveDispatchTaskContextResult {
  if (inputTaskContext === undefined) {
    return { ok: true, taskContext: undefined };
  }

  let working: unknown = inputTaskContext;
  if (current !== null) {
    const merged = applyManagerTaskContextFallback(
      {
        agent_id: "_resolveDispatchTaskContext_placeholder_",
        text: "_",
        task_context: working as TaskContext,
      },
      current,
    );
    working = merged.task_context;
  }

  const reparsed = TaskContextSchema.safeParse(working);
  if (!reparsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `task_context invalid after manager-context fallback: ${reparsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      },
    };
  }

  const strict = reparsed.data;
  const pid = strict.parent_task_id;
  if (pid === undefined || pid === null || pid === "") {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message:
          "task_context.parent_task_id is required outside manager turn context",
      },
    };
  }

  return { ok: true, taskContext: strict };
}
