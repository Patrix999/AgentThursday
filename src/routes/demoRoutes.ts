import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import {
  DEMO_INSTANCE,
  DOGFOOD_TASK,
  buildCliResultView,
  buildM3CliLoopDemo,
  buildM4TuiWorkflowDemo,
} from "../demoConstants";

/**
 *  — `/demo/*` routes extracted from `server.ts`.
 *
 * Each handler is the exact body of the original `server.ts` branch,
 * lifted into its own function. No behavior changes:
 *   - Same `DEMO_INSTANCE` resolution.
 *   - Same `Promise.all` shape for the heavy `/demo/status` payload.
 *   - Same JSON response shapes (verbatim field set + ordering).
 *
 * Auth is still gated by the composition root in `server.ts` under the
 * `/demo/*` umbrella; these handlers never re-check.
 */

type DemoAgentStub = {
  getStatus(): Promise<unknown>;
  getEventLog(): Promise<unknown>;
  getMemoryLayers(): Promise<unknown>;
  getLastTrace(): Promise<unknown>;
  getProfileAwareness(): Promise<unknown>;
  getEffectiveIntelligenceSignal(): Promise<unknown>;
  getRecoveryTimeline(): Promise<unknown>;
  getRecoveryReview(): Promise<unknown>;
  getRecentCheckpoints(): Promise<unknown>;
  getRecentReviewNotes(): Promise<unknown>;
  getOutcomeVerification(): Promise<unknown>;
  getRecentKanbanMutations(): Promise<unknown>;
  getMutationReview(): Promise<unknown>;
  getCurrentTaskObject(): Promise<unknown>;
  getLoopContract(): Promise<unknown>;
  getDeliverableGate(): Promise<unknown>;
  getApprovalPolicy(): Promise<unknown>;
  getDeveloperLoopReview(): Promise<unknown>;
  getCliSession(): Promise<unknown>;
  getWorkspaceInfo(): Promise<unknown>;
  submitTask(task: string): Promise<unknown>;
  continueTask(): Promise<unknown>;
  setModelProfile(provider: string, model: string): Promise<unknown>;
  acknowledgeHumanResponse(fromHuman: string, content: string): Promise<unknown>;
  getPendingKanbanMutations(): Promise<unknown>;
  confirmKanbanMutation(id: number, status: string, evidence: string): Promise<unknown>;
};

async function getDemoStub(env: Env): Promise<DemoAgentStub> {
  const resolveByName = getAgentByName as unknown as (
    namespace: unknown,
    name: string,
  ) => Promise<DemoAgentStub>;
  return resolveByName(env.AgentThursdayAgent, DEMO_INSTANCE);
}

export async function handleDemoStatus(env: Env): Promise<Response> {
  const stub = await getDemoStub(env);
  const [
    status,
    recentEvents,
    memoryLayers,
    lastTrace,
    profileAwareness,
    intelligenceSignal,
    recoveryTimeline,
    recoveryReview,
    recentCheckpoints,
    recentReviewNotes,
    outcomeVerification,
    recentKanbanMutations,
    mutationReview,
    currentTaskObject,
    loopContract,
    deliverableGate,
    approvalPolicy,
    developerLoopReview,
    cliSession,
    workspaceInfo,
  ] = await Promise.all([
    stub.getStatus(),
    stub.getEventLog(),
    stub.getMemoryLayers(),
    stub.getLastTrace(),
    stub.getProfileAwareness(),
    stub.getEffectiveIntelligenceSignal(),
    stub.getRecoveryTimeline(),
    stub.getRecoveryReview(),
    stub.getRecentCheckpoints(),
    stub.getRecentReviewNotes(),
    stub.getOutcomeVerification(),
    stub.getRecentKanbanMutations(),
    stub.getMutationReview(),
    stub.getCurrentTaskObject(),
    stub.getLoopContract(),
    stub.getDeliverableGate(),
    stub.getApprovalPolicy(),
    stub.getDeveloperLoopReview(),
    stub.getCliSession(),
    stub.getWorkspaceInfo(),
  ]);
  const cliResultView = buildCliResultView(
    cliSession as never,
    developerLoopReview as never,
    approvalPolicy as never,
    deliverableGate as never,
  );
  const m3CliLoopDemo = buildM3CliLoopDemo(
    cliSession as never,
    developerLoopReview as never,
    approvalPolicy as never,
    deliverableGate as never,
  );
  const m4TuiWorkflowDemo = buildM4TuiWorkflowDemo(
    cliSession as never,
    developerLoopReview as never,
    approvalPolicy as never,
    deliverableGate as never,
  );
  return json({
    status,
    profileAwareness,
    intelligenceSignal,
    memoryLayers,
    lastTrace,
    recentEvents,
    recoveryTimeline,
    recoveryReview,
    recentCheckpoints,
    recentReviewNotes,
    outcomeVerification,
    recentKanbanMutations,
    mutationReview,
    currentTaskObject,
    loopContract,
    deliverableGate,
    approvalPolicy,
    developerLoopReview,
    cliSession,
    cliResultView,
    m3CliLoopDemo,
    m4TuiWorkflowDemo,
    workspaceInfo,
  });
}

export async function handleDemoRun(env: Env): Promise<Response> {
  const stub = await getDemoStub(env);
  const result = await stub.submitTask(DOGFOOD_TASK);
  return json(result);
}

export async function handleDemoLoop(env: Env): Promise<Response> {
  const stub = await getDemoStub(env);
  const result = await stub.continueTask();
  return json(result);
}

export async function handleDemoProfile(request: Request, env: Env): Promise<Response> {
  const { provider, model } = (await request.json()) as { provider: string; model: string };
  const stub = await getDemoStub(env);
  await stub.setModelProfile(provider, model);
  return json({ ok: true, modelProfile: { provider, model } });
}

export async function handleDemoRespond(request: Request, env: Env): Promise<Response> {
  const { fromHuman, content } = (await request.json()) as { fromHuman: string; content: string };
  const stub = await getDemoStub(env);
  await stub.acknowledgeHumanResponse(fromHuman, content);
  return json({ ok: true, fromHuman, content });
}

export async function handleDemoPendingMutations(env: Env): Promise<Response> {
  const stub = await getDemoStub(env);
  const pending = await stub.getPendingKanbanMutations();
  return json({ pending });
}

export async function handleDemoConfirmMutation(request: Request, env: Env): Promise<Response> {
  const { id, status, evidence } = (await request.json()) as { id: number; status: string; evidence: string };
  const stub = await getDemoStub(env);
  await stub.confirmKanbanMutation(id, status, evidence);
  return json({ ok: true, id, status, evidence });
}

/**
 *  — `/demo/*` path/method dispatch facade.
 *
 * Single entry point used by `server.ts` instead of seven inline
 * `if (pathname === X && method === Y)` branches. The seven per-handler
 * exports above stay public so smoke / future call sites can target
 * them directly; this facade just collapses the dispatch boilerplate.
 *
 * Returns `null` when no branch matches — including method-mismatch on
 * a matching path — so `server.ts` falls through to the next route
 * family. Never returns 405; the original inline branches were
 * `pathname === X && method === Y` gates that fell through otherwise.
 *
 * Auth: the composition root in `server.ts` runs `requireSecret` on
 * the `/api/`/`/cli/`/`/demo/` umbrella above the delegate; this
 * facade never re-checks.
 */
export async function handleDemoRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname === "/demo/status" && request.method === "GET") {
    return handleDemoStatus(env);
  }
  if (url.pathname === "/demo/run" && request.method === "POST") {
    return handleDemoRun(env);
  }
  if (url.pathname === "/demo/loop" && request.method === "POST") {
    return handleDemoLoop(env);
  }
  if (url.pathname === "/demo/profile" && request.method === "POST") {
    return handleDemoProfile(request, env);
  }
  if (url.pathname === "/demo/respond" && request.method === "POST") {
    return handleDemoRespond(request, env);
  }
  if (url.pathname === "/demo/pending-mutations" && request.method === "GET") {
    return handleDemoPendingMutations(env);
  }
  if (url.pathname === "/demo/confirm-mutation" && request.method === "POST") {
    return handleDemoConfirmMutation(request, env);
  }
  return null;
}
