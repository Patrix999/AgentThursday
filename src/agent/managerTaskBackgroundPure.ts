/**
 * pure dispatch helper for `runManagerTaskBackground`.
 *
 * Lives in its own module (NOT inside `managerOps.ts`) so the test
 * suite can `node --import tsx --test` it without triggering the
 * `agents` → `partyserver` → `cloudflare:workers` import chain that
 * `managerOps.ts` carries via `getAgentByName`.
 *
 * The function takes already-resolved registry + per-agent factory
 * dependencies, so a test can inject spy stubs and assert the
 * expected event sequence + perAgent call pattern. The wrapper in
 * `managerOps.ts:runManagerTaskBackground` resolves both stubs and
 * delegates here.
 *
 * Bracket-event contract (worker-side, 359a):
 *   - emit `manager.task.started` (fast, before any long await)
 *   - readAgentProfile → on null, emit `manager.task.failed`
 *     (failure_class:"target_not_found") and return
 *   - perAgent.submitManagerTask(text, managerTaskId, opts) — the DO
 *     itself records the terminal `replied` event on success. Worker
 *     does NOT double-emit on the happy path.
 *   - on perAgent throw: classify timeout-shaped messages as
 *     `agent_loop_timeout`, record `manager.task.failed` worker-side
 *     (so the operator sees a terminal event even if the DO died
 *     before recording its own). If the DO also emitted a terminal
 *     event before the RPC raised, the `deriveManagerTaskStatus`
 *     fold picks the earlier event (created_at ASC), so worker-side
 *     `failed` after DO-side `replied` does not regress the operator
 *     view.
 */

export interface ManagerTaskBackgroundRegistry {
  readAgentProfile(id: string): Promise<{ id: string } | null>;
  recordManagerTaskEvent(
    type: string,
    payload: unknown,
    taskId: string,
  ): Promise<void> | void;
}

export interface ManagerTaskBackgroundPerAgent {
  submitManagerTask(
    text: string,
    managerTaskId: string,
    opts?: {
      displayText?: string;
      source?: string;
      conversationId?: string;
      // structured TaskContext threaded through to the DO.
      taskContext?: unknown;
    },
  ): Promise<{
    ok: boolean;
    taskId: string;
    loopTriggered: boolean;
    replyText: string;
    envelopeId: string | null;
  }>;
}

export interface ManagerTaskBackgroundInput {
  agent_id: string;
  text: string;
  source?: string;
  conversation_id?: string;
  // optional structured TaskContext (loose-typed at this
  // boundary so the pure helper does not import the zod-typed schema).
  task_context?: unknown;
}

export type ManagerTaskBackgroundErrorCode =
  | "agent_loop_timeout"
  | "target_not_found"
  | "internal";

export type ManagerTaskBackgroundResult =
  | {
      ok: true;
      status: "replied" | "accepted";
      agent_id: string;
      task_id: string;
      envelope_id?: string;
      reply?: string;
      conversation_id?: string;
      loop_triggered: boolean;
    }
  | {
      ok: false;
      status: "failed";
      agent_id: string;
      error: { code: ManagerTaskBackgroundErrorCode; message: string };
    };

export const FAILURE_MESSAGE_BYTE_CAP = 1024;

export function clampUtf8Bytes(s: string, cap: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.byteLength <= cap) return s;
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
    bytes.slice(0, cap),
  );
}

export const MANAGER_TASK_EVENT_STARTED = "manager.task.started";
export const MANAGER_TASK_EVENT_FAILED = "manager.task.failed";

export async function runManagerTaskBackgroundPure(
  registry: ManagerTaskBackgroundRegistry,
  getPerAgent: (agentId: string) => Promise<ManagerTaskBackgroundPerAgent>,
  input: ManagerTaskBackgroundInput,
  managerTaskId: string,
): Promise<ManagerTaskBackgroundResult> {
  try {
    await registry.recordManagerTaskEvent(
      MANAGER_TASK_EVENT_STARTED,
      {
        task_id: managerTaskId,
        agent_id: input.agent_id,
        source: input.source,
        ...(input.conversation_id !== undefined
          ? { conversation_id: input.conversation_id }
          : {}),
      },
      managerTaskId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[manager.task ${managerTaskId}] started event failed: ${message}`);
  }

  try {
    const target = await registry.readAgentProfile(input.agent_id);
    if (target === null) {
      const failureResult: ManagerTaskBackgroundResult = {
        ok: false,
        status: "failed",
        agent_id: input.agent_id,
        error: {
          code: "target_not_found",
          message: `no agent registered with agent_id: ${input.agent_id}`,
        },
      };
      try {
        await registry.recordManagerTaskEvent(
          MANAGER_TASK_EVENT_FAILED,
          {
            task_id: managerTaskId,
            agent_id: input.agent_id,
            reason: "target_not_found",
            message: failureResult.error.message,
            failure_class: "target_not_found",
            source: input.source,
            ...(input.conversation_id !== undefined
              ? { conversation_id: input.conversation_id }
              : {}),
          },
          managerTaskId,
        );
      } catch (logErr) {
        const lm = logErr instanceof Error ? logErr.message : String(logErr);
        console.warn(
          `[manager.task ${managerTaskId}] target_not_found event record failed: ${lm}`,
        );
      }
      return failureResult;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[manager.task ${managerTaskId}] readAgentProfile preflight failed: ${message}`,
    );
  }

  try {
    const perAgent = await getPerAgent(input.agent_id);
    const raw = await perAgent.submitManagerTask(input.text, managerTaskId, {
      source: input.source,
      ...(input.conversation_id !== undefined
        ? { conversationId: input.conversation_id }
        : {}),
      // propagate structured task_context through to the
      // DO-side @callable so the subagent's first-turn user message
      // receives the `<task-context>` block.
      ...(input.task_context !== undefined
        ? { taskContext: input.task_context }
        : {}),
    });
    const status: "replied" | "accepted" = raw.loopTriggered ? "replied" : "accepted";
    return {
      ok: true,
      status,
      agent_id: input.agent_id,
      task_id: raw.taskId,
      loop_triggered: raw.loopTriggered,
      ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
      ...(raw.envelopeId !== null ? { envelope_id: raw.envelopeId } : {}),
      ...(raw.replyText.length > 0 ? { reply: raw.replyText } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|exceeded|envelope/i.test(message);
    const errorCode: ManagerTaskBackgroundErrorCode = isTimeout
      ? "agent_loop_timeout"
      : "internal";
    const failureResult: ManagerTaskBackgroundResult = {
      ok: false,
      status: "failed",
      agent_id: input.agent_id,
      error: {
        code: errorCode,
        message: clampUtf8Bytes(message, FAILURE_MESSAGE_BYTE_CAP),
      },
    };
    try {
      await registry.recordManagerTaskEvent(
        MANAGER_TASK_EVENT_FAILED,
        {
          task_id: managerTaskId,
          agent_id: input.agent_id,
          reason: errorCode,
          message: clampUtf8Bytes(message, FAILURE_MESSAGE_BYTE_CAP),
          failure_class: errorCode,
          source: input.source,
          ...(input.conversation_id !== undefined
            ? { conversation_id: input.conversation_id }
            : {}),
        },
        managerTaskId,
      );
    } catch (logErr) {
      const lm = logErr instanceof Error ? logErr.message : String(logErr);
      console.warn(
        `[manager.task ${managerTaskId}] failed event record also failed: ${lm}`,
      );
    }
    return failureResult;
  }
}
