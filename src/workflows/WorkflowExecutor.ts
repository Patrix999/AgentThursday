import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getAgentByName, type AgentNamespace } from "agents";
import { DEMO_INSTANCE } from "../demoConstants";
import type { AgentThursdayAgent } from "../server";
import {
  type WorkflowDescriptor,
  orderPhasesByDependency,
  deriveExecutorPhaseId,
  deriveExecutorAgentNodeId,
} from "../agent/workflowDescriptor";
import { safePromptPreview } from "../agent/workflowRunModel";
// phase-result piping ({{<phase_id>.result}} in prompts).
import { substitutePhaseResults } from "../agent/workflowNamed";
import { runManagerTaskBackground, type ManagerEnv } from "../agent/managerOps";
import { resolveRequestIdentity } from "../agent/requestIdentity";

/**
 * orchestration-as-code executor v1.
 *
 * A Cloudflare Workflow that drives a declarative workflow descriptor
 * (phases / agents / deps / caps) against the existing manager/subagent
 * message path and writes/updates the an earlier revision ledger
 * (`workflow_run / workflow_phase / workflow_agent`) under an
 * EXECUTOR-OWNED `run_id` (`wfr-exec-<short-id>`, minted by the trigger).
 *
 * Why a CF Workflow (not a worker `ctx.waitUntil` runner): the executor
 * awaits multiple subagent dispatches SERIALLY, each a full subagent
 * loop. A worker background runner would exceed the ~CF DO-RPC envelope
 * and die mid-run (the exact defect an earlier revision paid to fix). A Workflow
 * makes each agent dispatch a durable `step.do` — survives worker death,
 * resumes from the last completed step. Mirrors `AgentRunWorkflow`.
 *
 * v1 boundaries: phases run in dependency order, SERIALLY; agents within
 * a phase run serially. No concurrency pool / caps enforcement ,
 * no save-as-command , no pause/resume UX. A failed agent marks
 * its phase + the run `failed` but later phases still run (no conditional
 * dependency-skip in v1 — see completion report).
 */
export type WorkflowExecutorParams = {
  run_id: string;
  descriptor: WorkflowDescriptor;
  // when the run was started by a manager agent
  // (manager.workflow_execute / workflow_run_named), its agent_id.
  // On terminal status the executor dispatches a wake-up task to this
  // agent so multi-stage plans (e.g. draft run → review run) continue
  // without an operator nudge. Absent for HTTP-triggered runs.
  origin_agent_id?: string;
  // the run OWNER's id, resolved at the trigger from the
  // initiating agent (manager path) or the operator (HTTP execute is
  // operator-only → admin). Every dispatch this executor makes inherits this
  // identity so a scoped-owned workflow can only dispatch within its tenant.
  // Absent / 'user-admin' → admin (byte-identical to pre-426h).
  owner_user_id?: string;
};

export type WorkflowExecutorResult = {
  run_id: string;
  status: "completed" | "failed";
  phases: number;
  agents: number;
};

export class WorkflowExecutor extends WorkflowEntrypoint<Env, WorkflowExecutorParams> {
  async run(
    event: WorkflowEvent<WorkflowExecutorParams>,
    step: WorkflowStep,
  ): Promise<WorkflowExecutorResult> {
    const { run_id, descriptor } = event.payload;
    const env = this.env;
    // the dispatch identity for EVERY subagent message this run
    // makes. Resolved once from the run-owner param (set at the trigger);
    // replay-safe (pure, no I/O) and not a DO instance field. Admin when the
    // owner is absent / the admin sentinel.
    const dispatchIdentity = resolveRequestIdentity(event.payload.owner_user_id);
    const registry = await getAgentByName<Env, AgentThursdayAgent>(
      env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
      DEMO_INSTANCE,
    );

    // Re-derive phase order (pure, deterministic; the trigger already
    // validated the descriptor). Fallback to descriptor order if a cycle
    // slipped through (shouldn't — validateWorkflowDescriptor rejects it).
    const ordered = orderPhasesByDependency(descriptor.phases);
    const order = ordered.ok ? ordered.order : descriptor.phases.map((p) => p.phase_id);
    const phaseByDescId = new Map(descriptor.phases.map((p) => [p.phase_id, p]));
    const execPhaseId = (descPhaseId: string): string => deriveExecutorPhaseId(run_id, descPhaseId);

    // ── Step: init — create the full ledger tree, all rows pending ──
    await step.do("init", async (): Promise<{ created: true }> => {
      await registry.recordWorkflowRunStart({
        run_id,
        source_task_id: descriptor.descriptor_id,
        // link the run to the INITIATING manager agent so the
        // user-app can find "this agent's latest workflow" (root_agent_id was
        // previously only the rarely-set descriptor field → null on every
        // manager-triggered run). Prefer the params' origin_agent_id (the agent
        // that called workflow_execute); fall back to the descriptor field.
        root_agent_id: event.payload.origin_agent_id ?? descriptor.root_agent_id ?? null,
        caps_json: descriptor.caps ? JSON.stringify(descriptor.caps) : null,
        // Multi-tenancy — stamp the run owner so workflow_status can scope it.
        // Same param resolved into `dispatchIdentity` above; admin sentinel for
        // the operator HTTP path (owner absent).
        owner_user_id: event.payload.owner_user_id ?? null,
      });
      for (const p of descriptor.phases) {
        const pid = execPhaseId(p.phase_id);
        await registry.upsertWorkflowPhase({
          run_id,
          phase_id: pid,
          name: p.name,
          phase_order: Math.max(0, order.indexOf(p.phase_id)),
          depends_on_phase_ids_json: JSON.stringify(
            (p.depends_on_phase_ids ?? []).map((d) => execPhaseId(d)),
          ),
        });
        for (let j = 0; j < p.agents.length; j++) {
          await registry.recordWorkflowAgent({
            run_id,
            phase_id: pid,
            agent_node_id: deriveExecutorAgentNodeId(pid, j),
            agent_id: p.agents[j].agent_id,
            prompt_preview: safePromptPreview(p.agents[j].prompt),
          });
        }
      }
      return { created: true };
    });

    let runOk = true;
    let agentCount = 0;
    // full replies per descriptor phase id, accumulated from
    // step RESULTS (replay-safe: on resume, completed steps return
    // cached values, so the map rebuilds identically).
    const phaseReplies = new Map<string, string[]>();
    for (const descPhaseId of order) {
      const p = phaseByDescId.get(descPhaseId);
      if (!p) continue;
      const pid = execPhaseId(descPhaseId);
      await registry.updateWorkflowPhaseStatus({ phase_id: pid, status: "running" });
      let phaseOk = true;
      const thisPhaseReplies: string[] = [];
      // 2026-06-29 — agents within a phase run CONCURRENTLY, pooled to
      // caps.max_concurrency (no cap → all in parallel). Was serial (an earlier revision
      // v1 limit), which made a 5-agent phase take ~5× a single agent (glm-5.2
      // run took ~30min sequential). Phases stay dependency-serial; agents
      // within a phase are independent (an earlier revision pipes are cross-phase only),
      // so parallel dispatch is safe. CF Workflows run Promise.all'd step.do
      // calls concurrently AND durably.
      const maxConcurrency = descriptor.caps?.max_concurrency && descriptor.caps.max_concurrency > 0
        ? descriptor.caps.max_concurrency
        : p.agents.length;
      agentCount += p.agents.length;
      const dispatchAgent = async (j: number): Promise<{ ok: boolean; reply?: string }> => {
        const agentNodeId = deriveExecutorAgentNodeId(pid, j);
        const a = p.agents[j];
        // resolve {{<phase_id>.result}} against completed phases
        // before dispatch. Unresolved (forward/unknown) refs stay literal and
        // are recorded for inspectability. phaseReplies is frozen for this phase
        // (only prior phases populated it), so concurrent reads are safe.
        const piped = substitutePhaseResults(a.prompt, phaseReplies);
        if (piped.unresolved.length > 0) {
          try {
            await registry.recordManagerEvent("workflow.pipe.unresolved", {
              run_id,
              agent_node_id: agentNodeId,
              unresolved_phase_ids: piped.unresolved,
            });
          } catch { /* fail-soft */ }
        }
        const promptText = piped.prompt;
        return step.do(
          `agent-${agentNodeId}`,
          // step timeout above the 380b 30-min manager hard
          // window: a subagent turn that dies without its finally (RPC
          // never resolves) must fail the step instead of wedging the
          // run forever (observed on wfr-exec-003434ab).
          {
            retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
            timeout: "35 minutes",
          },
          async (): Promise<{ ok: boolean; reply?: string }> => {
            const taskId = `${agentNodeId}-t`;
            await registry.updateWorkflowAgentStatus({
              agent_node_id: agentNodeId,
              status: "running",
              task_id: taskId,
            });
            // Manager/subagent message path. NO task_context.parent_task_id
            // → an earlier revision's ad-hoc ledger hook does NOT fire, keeping the
            // executor run cleanly separate from ad-hoc dispatch.
            const result = await runManagerTaskBackground(
              env as unknown as ManagerEnv,
              { agent_id: a.agent_id, text: promptText },
              taskId,
              dispatchIdentity, // run-owner scoped dispatch
            );
            if (result && result.ok) {
              await registry.updateWorkflowAgentStatus({
                agent_node_id: agentNodeId,
                status: "replied",
                task_id: taskId,
                result_summary: safePromptPreview(result.reply ?? "") ?? "(no reply text)",
              });
              // full reply rides the step result for piping.
              return { ok: true, reply: result.reply ?? "" };
            }
            const reason = result && !result.ok ? result.error.message : "dispatch_failed";
            await registry.updateWorkflowAgentStatus({
              agent_node_id: agentNodeId,
              status: "failed",
              task_id: taskId,
              failure_reason: reason.slice(0, 200),
            });
            return { ok: false };
          },
        ).catch(async (e: unknown) => {
          // step timeout / retries exhausted: record the
          // failure in the ledger and keep the run moving to a clean
          // terminal status instead of letting the instance die with
          // the ledger stuck on "running".
          await registry.updateWorkflowAgentStatus({
            agent_node_id: agentNodeId,
            status: "failed",
            failure_reason: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          });
          return { ok: false } as { ok: boolean; reply?: string };
        });
      };
      // Run in batches of maxConcurrency; each batch dispatched in parallel.
      for (let batchStart = 0; batchStart < p.agents.length; batchStart += maxConcurrency) {
        const batchIdx: number[] = [];
        for (let j = batchStart; j < Math.min(batchStart + maxConcurrency, p.agents.length); j++) {
          batchIdx.push(j);
        }
        const batchResults = await Promise.all(batchIdx.map(dispatchAgent));
        for (const r of batchResults) {
          if (!r.ok) phaseOk = false;
          if (r.ok && typeof r.reply === "string" && r.reply.length > 0) {
            thisPhaseReplies.push(r.reply);
          }
        }
      }
      phaseReplies.set(descPhaseId, thisPhaseReplies);
      await registry.updateWorkflowPhaseStatus({
        phase_id: pid,
        status: phaseOk ? "completed" : "failed",
      });
      if (!phaseOk) runOk = false;
    }

    await step.do("complete", async (): Promise<{ status: "completed" | "failed" }> => {
      await registry.updateWorkflowRunStatus({ run_id, status: runOk ? "completed" : "failed" });
      return { status: runOk ? "completed" : "failed" };
    });

    // ── wake the originating manager on terminal status ──
    // The manager's turn ended right after launching this run; without
    // a callback its multi-stage plan stalls (an earlier revision dogfood finding).
    // The wake-up task awaits the manager's full continuation turn
    // inside this durable step. Fail-soft: a failed notification logs a
    // ledger event but never changes the run's terminal status. No
    // retries — duplicate wake-ups are worse than a lost one (the
    // operator still sees the run terminal via inspect).
    const originAgentId = event.payload.origin_agent_id;
    if (originAgentId) {
      await step.do(
        "notify-origin",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
        async (): Promise<{ notified: boolean }> => {
          try {
            const status = runOk ? "completed" : "failed";
            await runManagerTaskBackground(
              env as unknown as ManagerEnv,
              {
                agent_id: originAgentId,
                text: `你启动的 workflow ${run_id} 已终态：${status}（${agentCount} 个 agent）。请用 manager.workflow_status 查看结果；如果你的计划还有后续阶段（例如评审/定稿/汇报），现在继续执行并向操作员报告。`,
              },
              `${run_id}-notify`,
              dispatchIdentity, // run-owner scoped (origin is the owner's own agent)
            );
            return { notified: true };
          } catch (e) {
            try {
              await registry.recordManagerEvent("workflow.notify_origin.failed", {
                run_id,
                origin_agent_id: originAgentId,
                error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
              });
            } catch { /* nested fail-soft */ }
            return { notified: false };
          }
        },
      );
    }

    return {
      run_id,
      status: runOk ? "completed" : "failed",
      phases: descriptor.phases.length,
      agents: agentCount,
    };
  }
}
