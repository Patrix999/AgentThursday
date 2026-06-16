import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowSleepDuration,
} from "cloudflare:workers";
import { getAgentByName, type AgentNamespace } from "agents";
import { DEMO_INSTANCE } from "../demoConstants";
import type { AgentThursdayAgent } from "../server";

/**
 *  —  `AgentRunWorkflow` multi-step orchestration.
 *
 * Five-step plan (one `waitForEvent` pause max per run;  D-2):
 *
 *   1. step.do("load-profile")   — registry lookup; fail-fast if profile
 *                                  not found.
 *   2. step.do("first-turn")     — per-profile DO `submitTask`; returns
 *                                  `{turn_id, envelope_id, status}`.
 *                                  `status === "awaiting_event"` parks
 *                                  the run on step (3).
 *   3. step.waitForEvent         — only entered when (2) signals pause.
 *                                  `type === "user-reply"`; timeout
 *                                  configurable via env var (D-1).
 *                                  Timeout flips row to "timeout" and
 *                                  re-throws.
 *   4. step.do("resume-turn")    — submits the user reply payload back
 *                                  to the SAME per-profile DO; refs
 *                                  only on step return.
 *   5. step.do("mark-complete")  — durable row → `status: "ok"`.
 *
 * Constraints carried from :
 *  - Idempotency (§D-2): step.do bodies check `readAgentRun(run_id)`
 *    state before mutating; at-least-once semantics across retries.
 *  - Step output cap (§D-3): every step returns refs only
 *    (`{turn_id, envelope_id, status}`); never the full reply text.
 *  - Failure recording: caught errors call `markAgentRunFailed` (or
 *    `markAgentRunTimedOut`) before re-throw so the workflow instance
 *    AND the durable row both surface the error context.
 *
 * Awaiting-event trigger ( Q1 (a)): only the test fixture
 * `AGENT_THURSDAY_AGENT_RUN_FORCE_PAUSE === "true"` causes `first-turn` to
 * return `"awaiting_event"`. Real AgentThursdayAgent-driven pauses are
 * deferred to the persona-weave card.
 */
export type AgentRunWorkflowParams = {
  run_id: string;
  profile_id: string;
  input: unknown;
};

export type AgentRunStepStatus = "ok" | "awaiting_event";

export type AgentRunFirstTurnResult = {
  turn_id: string;
  envelope_id: string;
  status: AgentRunStepStatus;
};

export type AgentRunFinalResult = {
  turn_id: string;
  envelope_id: string;
  resume_turn_id?: string;
  status: "ok";
};

/**
 * Default 24h waitForEvent timeout ( D-1, recommendation (b)).
 * Overridable at deploy time via `AGENT_THURSDAY_AGENT_RUN_WAIT_TIMEOUT` in
 * `wrangler.toml [vars]` (e.g. "1 hour", "7 days"). Cloudflare's
 * Workflows duration grammar accepts `"<N> <unit>"` strings.
 */
const DEFAULT_WAIT_TIMEOUT = "24 hours";

function resolveWaitTimeout(env: Env): WorkflowSleepDuration {
  const raw = (env as unknown as { AGENT_THURSDAY_AGENT_RUN_WAIT_TIMEOUT?: string })
    .AGENT_THURSDAY_AGENT_RUN_WAIT_TIMEOUT;
  // CF's literal template (`${number} ${unit}${'s'|''}`) cannot be
  // narrowed at compile time from an env-supplied string; runtime
  // validation is on the Workflows side. Cast through unknown.
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim() as unknown as WorkflowSleepDuration;
  }
  return DEFAULT_WAIT_TIMEOUT as unknown as WorkflowSleepDuration;
}

function forcePauseEnabled(env: Env): boolean {
  const raw = (env as unknown as { AGENT_THURSDAY_AGENT_RUN_FORCE_PAUSE?: string })
    .AGENT_THURSDAY_AGENT_RUN_FORCE_PAUSE;
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunWorkflowParams> {
  async run(
    event: WorkflowEvent<AgentRunWorkflowParams>,
    step: WorkflowStep,
  ): Promise<AgentRunFinalResult> {
    const { run_id, profile_id, input } = event.payload;
    const env = this.env;

    // ── Step 1: load-profile ────────────────────────────────────────
    const profileRef = await step.do(
      "load-profile",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async (): Promise<{ profile_id: string }> => {
        const registry = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          DEMO_INSTANCE,
        );
        const profile = await registry.readAgentProfile(profile_id);
        if (!profile) {
          await registry.markAgentRunFailed({
            run_id,
            error: `profile_not_found:${profile_id}`,
          });
          throw new Error(`profile_not_found:${profile_id}`);
        }
        return { profile_id: profile.id };
      },
    );

    // ── Step 2: first-turn ──────────────────────────────────────────
    const firstTurn = await step.do(
      "first-turn",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async (): Promise<AgentRunFirstTurnResult> => {
        const registry = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          DEMO_INSTANCE,
        );

        const existing = await registry.readAgentRun(run_id);
        if (existing && existing.turn_id) {
          // Cached ref. If the row was already moved past `started`
          // (awaiting_event / ok / failed / timeout), preserve that.
          const cachedStatus: AgentRunStepStatus =
            existing.status === "awaiting_event" ? "awaiting_event" : "ok";
          return {
            turn_id: existing.turn_id,
            envelope_id: existing.envelope_id ?? "",
            status: cachedStatus,
          };
        }

        const contextStub = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          profileRef.profile_id,
        );

        const taskText = typeof input === "string" ? input : JSON.stringify(input);

        let turnResult: Awaited<ReturnType<AgentThursdayAgent["submitTask"]>>;
        try {
          turnResult = await contextStub.submitTask(taskText);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await registry.markAgentRunFailed({
            run_id,
            error: `submit_task_error:${message}`,
          });
          throw e;
        }

        const envelopeId = turnResult.envelopeId ?? "";

        //  Q1 (a): only env-flag fixture triggers the pause
        // branch. Real AgentThursdayAgent-driven pause lands in persona-weave.
        if (forcePauseEnabled(env)) {
          await registry.markAgentRunAwaitingEvent({ run_id });
          // Record the first turn ref now so the cached-ref idempotency
          // path works on retry and the GET surface shows the turn.
          await registry.markAgentRunComplete({
            run_id,
            turn_id: turnResult.taskId,
            envelope_id: envelopeId,
          });
          // markAgentRunComplete sets status='ok'; re-flip to
          // awaiting_event so the row reflects the paused state.
          await registry.markAgentRunAwaitingEvent({ run_id });
          return {
            turn_id: turnResult.taskId,
            envelope_id: envelopeId,
            status: "awaiting_event",
          };
        }

        await registry.markAgentRunComplete({
          run_id,
          turn_id: turnResult.taskId,
          envelope_id: envelopeId,
        });
        return {
          turn_id: turnResult.taskId,
          envelope_id: envelopeId,
          status: "ok",
        };
      },
    );

    // ── Short-circuit when no pause was requested ──────────────────
    if (firstTurn.status === "ok") {
      await step.do(
        "mark-complete",
        async (): Promise<{ status: "ok" }> => {
          //  already set status='ok' inside first-turn via
          // markAgentRunComplete; this step is a no-op marker so the
          // workflow describe output shows the full 5-step plan when
          // someone wants to inspect the orchestration shape. Refs-
          // only return (no `replyText`).
          return { status: "ok" };
        },
      );
      return {
        turn_id: firstTurn.turn_id,
        envelope_id: firstTurn.envelope_id,
        status: "ok",
      };
    }

    // ── Step 3: waitForEvent ────────────────────────────────────────
    const waitTimeout = resolveWaitTimeout(env);

    type UserReplyPayload = { text?: string; payload?: unknown };
    type WaitForEventResult = { payload: UserReplyPayload } | UserReplyPayload;

    let userReply: UserReplyPayload;
    try {
      const evt = (await step.waitForEvent("user-reply", {
        type: "user-reply",
        timeout: waitTimeout,
      })) as WaitForEventResult;
      // Cloudflare's runtime returns the event object; `.payload` holds
      // what `sendEvent` was called with. Fall through directly for
      // local-dev simulators that may flatten the shape.
      const flat = (evt as { payload?: UserReplyPayload }).payload;
      userReply = flat ?? (evt as UserReplyPayload);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const registry = await getAgentByName<Env, AgentThursdayAgent>(
        env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
        DEMO_INSTANCE,
      );
      // CF wraps waitForEvent timeouts; treat any throw from this step
      // as a timeout for the row's purpose, capturing the upstream
      // message so the inspect surface preserves the cause.
      await registry.markAgentRunTimedOut({
        run_id,
        reason: `waitForEvent_timeout:${String(waitTimeout)}:${message}`,
      });
      throw e;
    }

    // ── Step 4: resume-turn ─────────────────────────────────────────
    const resumeTurn = await step.do(
      "resume-turn",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async (): Promise<{ turn_id: string; envelope_id: string; status: "ok" }> => {
        const registry = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          DEMO_INSTANCE,
        );
        const contextStub = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          profileRef.profile_id,
        );

        const resumeText =
          typeof userReply.text === "string"
            ? userReply.text
            : typeof userReply.payload === "string"
              ? userReply.payload
              : JSON.stringify(userReply);

        let turnResult: Awaited<ReturnType<AgentThursdayAgent["submitTask"]>>;
        try {
          turnResult = await contextStub.submitTask(resumeText);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await registry.markAgentRunFailed({
            run_id,
            error: `resume_submit_task_error:${message}`,
          });
          throw e;
        }

        const envelopeId = turnResult.envelopeId ?? "";
        //  D-3 (c): row.turn_id stays = first-turn id; the
        // resume-turn id lives in this step's workflow describe output
        // only. We do NOT overwrite registry.markAgentRunComplete with
        // the resume id.
        return {
          turn_id: turnResult.taskId,
          envelope_id: envelopeId,
          status: "ok",
        };
      },
    );

    // ── Step 5: mark-complete ──────────────────────────────────────
    await step.do(
      "mark-complete",
      async (): Promise<{ status: "ok" }> => {
        const registry = await getAgentByName<Env, AgentThursdayAgent>(
          env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          DEMO_INSTANCE,
        );
        // Re-write to status='ok' explicitly (the row was
        // 'awaiting_event' during the pause). markAgentRunComplete
        // is idempotent and preserves the original turn_id.
        await registry.markAgentRunComplete({
          run_id,
          turn_id: firstTurn.turn_id,
          envelope_id: firstTurn.envelope_id,
        });
        return { status: "ok" };
      },
    );

    return {
      turn_id: firstTurn.turn_id,
      envelope_id: firstTurn.envelope_id,
      resume_turn_id: resumeTurn.turn_id,
      status: "ok",
    };
  }
}
