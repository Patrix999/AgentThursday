import type {
  CliSession,
  DeveloperLoopReview,
  ApprovalPolicy,
  DeliverableConvergence,
  CliResultView,
  M3CliLoopStep,
  M3CliLoopDemo,
  M4TuiWorkflowStep,
  M4TuiWorkflowDemo,
} from "./types";

/**
 * an earlier revision v2 — constants and pure builders shared by `src/server.ts`
 * and `src/routes/*`.
 *
 * Why this module exists: `src/server.ts` is the Cloudflare Worker
 * entry module. Cloudflare validates every named export on the entry
 * module as a Worker handler / Durable Object class binding (must be
 * `function or ExportedHandler`). String constants like
 * `DEMO_INSTANCE` and `DOGFOOD_TASK` were rejected at runtime startup
 * — `tsc --noEmit` and `wrangler deploy --dry-run` don't catch this
 * because the type check only happens when the workerd loader maps
 * exports to bindings.
 *
 * Keep this module pure: no side effects, no DO references, no imports
 * from `./server`. Both `server.ts` and `routes/*` import from here.
 */

export const DEMO_INSTANCE = "agentthursday-dev-fresh-108a-1";

// A1 Phase 2: the operator's OWN DO (the registry/operator split
// target). Fixed name, canonical `agent-<uuid>` shape so Phase 3 can re-key
// the operator's agent_profile row to it and route operator turns here like
// any per-agent DO. The constant IS the pointer — no DB indirection.
export const OPERATOR_INSTANCE = "agent-operator-0000-4000-8000-000000000001";

// A1 Phase 3: "is this DO an operator surface?" — the predicate
// behind the operator soul/owner/identity fallbacks and the persona-skip.
// The DEMO_INSTANCE half is the D3 residue (the operator 2026-07-02: registry identity
// unchanged in 451c): after the routing cutover no operator turns land on the
// registry, and A2/A3 retire this half when the registry's residual
// conversational surface goes away.
export function isOperatorSurfaceName(name: string): boolean {
  return name === DEMO_INSTANCE || name === OPERATOR_INSTANCE;
}

export const DOGFOOD_TASK = "如何使用新构建的 agent 开发当前项目？";

export function buildCliResultView(session: CliSession, loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): CliResultView {
  const activeInterventions = approvalPolicy.interventions.filter(i => i.active).map(i => `[${i.kind}] ${i.reason}`);
  return {
    taskId: session.taskId,
    taskTitle: session.taskTitle,
    taskLifecycle: session.taskLifecycle,
    loopStage: session.loopStage,
    deliverableFormed: deliverableGate.deliverable.readyForReview,
    deliverableSummary: deliverableGate.deliverable.resultSummary,
    gatePassed: deliverableGate.reviewGate.gate === "open",
    gateReason: deliverableGate.reviewGate.reason,
    readyForNextRound: session.readyForNextRound,
    activeInterventions,
    suggestedNextCommand: session.suggestedNextCommand,
    loopSummary: loopReview.summary,
  };
}

export function buildM3CliLoopDemo(session: CliSession, loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): M3CliLoopDemo {
  const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
  const steps: M3CliLoopStep[] = session.availableCommands.map(cmd => {
    let statusNote: string;
    if (cmd.name === "submit") {
      statusNote = session.taskId
        ? `✓ task: ${session.taskTitle ?? "—"}  lifecycle: ${session.taskLifecycle}`
        : "→ 发送 POST /cli/submit { task } 启动 loop";
    } else if (cmd.name === "status") {
      statusNote = `✓ loopStage: ${session.loopStage}  readyForNextRound: ${session.readyForNextRound}`;
    } else if (cmd.name === "continue") {
      statusNote = session.readyForNextRound
        ? "✓ loop ready — 可执行 continue 推进下一轮"
        : "→ 等待 loop 条件满足后推进";
    } else if (cmd.name === "approve") {
      statusNote = activeInterventionCount > 0
        ? `⚠ ${activeInterventionCount} 个干预点待处理`
        : "✓ 无活跃干预点";
    } else if (cmd.name === "result") {
      statusNote = deliverableGate.deliverable.readyForReview
        ? `✓ deliverable 已形成  gate: ${deliverableGate.reviewGate.gate}`
        : "→ 等待 deliverable 形成后查看";
    } else {
      statusNote = "—";
    }
    return { name: cmd.name, endpoint: cmd.endpoint, method: cmd.method, description: cmd.description, statusNote };
  });
  return {
    loopReady: session.readyForNextRound && activeInterventionCount === 0,
    steps,
    currentLoopStage: session.loopStage,
    readyForNextRound: session.readyForNextRound,
    activeInterventionCount,
    summary: loopReview.summary,
  };
}

export function buildM4TuiWorkflowDemo(session: CliSession, _loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): M4TuiWorkflowDemo {
  const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
  const interventionClear = activeInterventionCount === 0;

  const TUI_WORKFLOW: Array<{ name: string; endpoint: string; method: "GET" | "POST"; description: string }> = [
    { name: "submit",   endpoint: "/cli/submit",   method: "POST", description: "提交任务，启动 developer loop" },
    { name: "status",   endpoint: "/cli/status",   method: "GET",  description: "观察 loop stage / interventions / readiness" },
    { name: "continue", endpoint: "/cli/continue", method: "POST", description: "执行当前 committedAction，推进 loop" },
    { name: "approve",  endpoint: "/cli/approve",  method: "POST", description: "处理卡点：人类响应或 confirm mutation" },
    { name: "result",   endpoint: "/cli/result",   method: "GET",  description: "查看 deliverable / gate / readiness" },
  ];

  const steps: M4TuiWorkflowStep[] = TUI_WORKFLOW.map(s => {
    let statusNote: string;
    if (s.name === "submit") {
      statusNote = session.taskId
        ? `✓ task active: ${session.taskTitle ?? "—"}  [${session.taskLifecycle}]`
        : "→ 在 INPUT 区按 S 提交任务";
    } else if (s.name === "status") {
      statusNote = `✓ loopStage: ${session.loopStage}  interventions: ${activeInterventionCount}  ready: ${session.readyForNextRound}`;
    } else if (s.name === "continue") {
      statusNote = session.readyForNextRound
        ? "✓ loop ready — 按 C 推进"
        : "→ 等待 loop 条件满足后继续";
    } else if (s.name === "approve") {
      statusNote = activeInterventionCount > 0
        ? `⚠ ${activeInterventionCount} 个卡点待处理 — 按 A 响应`
        : "✓ 无活跃卡点";
    } else {
      statusNote = deliverableGate.deliverable.readyForReview
        ? `✓ deliverable 已形成  gate: ${deliverableGate.reviewGate.gate}`
        : "→ 等待 deliverable 形成";
    }
    return { ...s, statusNote };
  });

  const cloudStateReady = !!session.taskId;
  const workflowReady = cloudStateReady && interventionClear && session.readyForNextRound;

  let summary: string;
  if (!cloudStateReady) {
    summary = "TUI 已就绪，等待提交第一个 task 启动 loop。使用 npm run tui 启动终端界面。";
  } else if (activeInterventionCount > 0) {
    summary = `Loop 推进中，有 ${activeInterventionCount} 个卡点待处理。在 TUI 中按 A 响应。`;
  } else if (session.readyForNextRound) {
    summary = `完整 developer loop 已就绪：task → loop → deliverable → gate open。TUI 端到端链路成立。`;
  } else {
    summary = `Loop 推进中（stage: ${session.loopStage}）。在 TUI 中按 C 继续推进。`;
  }

  return { workflowReady, steps, cloudStateReady, interventionClear, readyForNextMilestone: workflowReady, summary };
}
