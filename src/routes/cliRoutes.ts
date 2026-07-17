import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import { DEMO_INSTANCE, buildCliResultView } from "../demoConstants";
import type {
  CompactPlanInput,
  CompactPlanResult,
  HygieneRunInput,
} from "../schema";
import type { DashboardCore, DashboardSection, AgentThursdayAgent } from "../server";

/**
 * `/cli/*` HTTP route handling extracted from `server.ts`.
 *
 * Single entry point: `handleCli(request, url, deps)`.
 *
 * Behavior-preserving. Each handler is the verbatim body of the
 * original `server.ts` branch, lifted into one dispatch function.
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `CliDeps` factories so this module never imports
 * `getCanonicalActiveAgentThursdayAgentStub` / `DEMO_INSTANCE` /
 * `resolveCanonicalActiveContextRoute`.
 *
 * Returns `null` when no `/cli/*` branch matches so `server.ts` can
 * fall through to `routeAgentRequest` then `env.ASSETS.fetch`.
 *
 * Auth: gated by the `/api/`/`/cli/`/`/demo/` `requireSecret` umbrella
 * in `server.ts`. This handler never re-checks.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

// Local mirror of `server.ts` constant. `/cli/context/conversation/search`
// reads the caller's pinned context id from this request header so the
// retrieval log records who searched. Two declarations of an identical
// string constant are intentional — keeps `server.ts` untouched and
// confines the cliRoutes module's import surface to types only.
const CONTEXT_HEADER = "X-AgentThursday-Context-Id";

export interface CliDeps {
  env: Env;
  getActiveStub: () => Promise<AgentThursdayAgentStub>;
  resolveActiveRoute: () => Promise<{ name: string; stub: AgentThursdayAgentStub }>;
  // an earlier revision (A3) — getRegistryStub removed: after an earlier revision every /cli
  // surface operates on the routed DO; registry data is reachable via the
  // explicit /api/inspect/*?agent_id= paths.
  buildDashboardSection: (core: DashboardCore) => Promise<DashboardSection>;
}

export async function handleCli(
  request: Request,
  url: URL,
  deps: CliDeps,
): Promise<Response | null> {
  if (url.pathname === "/cli/status" && request.method === "GET") {
    const stub = await deps.getActiveStub();
    // lazy sweeper trigger. Fire-and-forget so /cli/status
    // stays cheap; sweeper itself is fail-soft and bounded by the
    // 20-min draft-age threshold. Verifier polling /cli/status is a
    // common path during demo, so this naturally heals stuck rounds
    // before the alarm backstop fires.
    void (stub as unknown as { sweepStaleDraftEnvelopes(input?: { source?: string }): Promise<unknown> })
      .sweepStaleDraftEnvelopes({ source: "cli_status_lazy" })
      .catch(() => undefined);
    const [session, loopReview, approvalPolicy, pendingToolApproval, debugTrace, usageStats, dashboardCore] = await Promise.all([
      stub.getCliSession(), stub.getDeveloperLoopReview(), stub.getApprovalPolicy(), stub.getPendingToolApproval(), stub.getDebugTrace(), stub.getUsageStats(), stub.getDashboardCore(),
    ]);
    const activeInterventions = approvalPolicy.interventions
      .filter(i => i.active)
      .map(i => `[${i.kind}] ${i.reason}`);
    // daily dogfood observability dashboard v1.
    // Inline read-only section. Fail-soft on cross-DO outbox lookup so
    // a transient ChannelHub glitch never breaks /cli/status.
    const dashboard = await deps.buildDashboardSection(dashboardCore);
    return json({ session, loopSummary: loopReview.summary, activeInterventions, pendingToolApproval, debugTrace, usageStats, dashboard });
  }

  if (url.pathname === "/cli/submit" && request.method === "POST") {
    const { task } = await request.json<{ task: string }>();
    const stub = await deps.getActiveStub();
    await stub.submitTask(task);
    const [session, loopReview] = await Promise.all([stub.getCliSession(), stub.getDeveloperLoopReview()]);
    return json({
      ok: true,
      taskId: session.taskId ?? DEMO_INSTANCE,
      submittedTask: task.slice(0, 120),
      loopStageAfter: session.loopStage,
      suggestedNextCommand: session.suggestedNextCommand,
      loopSummary: loopReview.summary,
    });
  }

  if (url.pathname === "/cli/continue" && request.method === "POST") {
    const stub = await deps.getActiveStub();
    await stub.continueTask();
    const session = await stub.getCliSession();
    return json({ ok: true, session });
  }

  if (url.pathname === "/cli/approve" && request.method === "POST") {
    const body = await request.json<{ kind: "human-response" | "mutation-confirm"; fromHuman?: string; content?: string; mutationId?: number; mutationStatus?: string; evidence?: string }>();
    const stub = await deps.getActiveStub();
    let description: string;
    if (body.kind === "mutation-confirm" && body.mutationId !== undefined) {
      await stub.confirmKanbanMutation(body.mutationId, body.mutationStatus ?? "applied", body.evidence ?? "");
      description = `mutation #${body.mutationId} 已 ${body.mutationStatus ?? "applied"}`;
    } else {
      await stub.acknowledgeHumanResponse(body.fromHuman ?? "human", body.content ?? "");
      description = `human-response 已接收：${(body.content ?? "").slice(0, 80)}`;
    }
    const [session, loopReview, approvalPolicy] = await Promise.all([
      stub.getCliSession(),
      stub.getDeveloperLoopReview(),
      stub.getApprovalPolicy(),
    ]);
    const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
    return json({
      ok: true,
      kind: body.kind,
      description,
      loopStageAfter: session.loopStage,
      suggestedNextCommand: session.suggestedNextCommand,
      loopSummary: loopReview.summary,
      activeInterventionCount,
    });
  }

  if (url.pathname === "/cli/result" && request.method === "GET") {
    const stub = await deps.getActiveStub();
    const [deliverableGate, loopReview, approvalPolicy, session] = await Promise.all([
      stub.getDeliverableGate(), stub.getDeveloperLoopReview(), stub.getApprovalPolicy(), stub.getCliSession(),
    ]);
    return json(buildCliResultView(session, loopReview, approvalPolicy, deliverableGate));
  }

  if (url.pathname === "/cli/tool-approval" && request.method === "POST") {
    const { toolCallId, approved } = await request.json<{ toolCallId: string; approved: boolean }>();
    const stub = await deps.getActiveStub();
    const result = await stub.approvePendingTool(toolCallId, approved);
    return json({ ok: result.ok, toolCallId, approved });
  }

  if (url.pathname === "/cli/clear-stale-state" && request.method === "POST") {
    const stub = await deps.getActiveStub();
    const result = await stub.clearStaleBlockingState();
    return json(result);
  }

  // Context lifecycle (inspect + reset). See
  // docs/milestones/context-lifecycle-management.md. `context.new`
  // is deferred until Think SDK exposes traceable multi-thread sessions.
  if (url.pathname === "/cli/context/inspect" && request.method === "GET") {
    const lastNRaw = url.searchParams.get("lastN");
    const lastN = lastNRaw !== null ? Math.max(1, Math.min(200, Number(lastNRaw) || 20)) : 20;
    const stub = await deps.getActiveStub();
    const result = await stub.inspectContext({ lastN });
    return json(result);
  }

  if (url.pathname === "/cli/context/reset" && request.method === "POST") {
    let body: { reason?: string | null } = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      // Tolerate empty / malformed body; reason is optional.
    }
    // pass `routedContextId` so the DO knows whether it's
    // running on the registry (DEMO_INSTANCE) and can skip the
    // self-RPC for archive write.
    // paired resolver guarantees `routedContextId` and
    // `stub` point at the same DO. Previously the reset path called
    // `resolveContextDoName(request)` (sync) and
    // `getActiveAgentThursdayAgentStub(...)` separately; with the canonical
    // resolver in place, doing the lookup twice could in principle
    // race the registry pointer. One lookup, paired return.
    const { name: routedContextId, stub } = await deps.resolveActiveRoute();
    try {
      const result = await stub.resetContext({ reason: body.reason ?? null, routedContextId });
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // new-context (v1 reset-style fallback). Closes
  // the active context_history row, opens a new one, clears messages.
  // Auth-gated via the global /cli/* requireSecret check above.
  if (url.pathname === "/cli/context/new" && request.method === "POST") {
    let body: { reason?: string | null } = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      // Tolerate empty / malformed body.
    }
    // an earlier revision (A2) — context lifecycle runs on the ROUTED DO (the operator
    // agent since an earlier revision), not the registry. Pre-452 this wrote the
    // registry's `context_active` — which 451c made the operator ROUTING
    // pointer, so a console "new context" silently rerouted operator turns
    // off the operator DO. Now it rotates the routed DO's own internal
    // context label (drain-to-self archive semantics, an earlier revision); the
    // registry pointer's only writer is the cutover/rollback endpoint.
    const { stub } = await deps.resolveActiveRoute();
    const result = await stub.newContext({ reason: body.reason ?? null });
    return json(result);
  }

  if (url.pathname === "/cli/context/active" && request.method === "GET") {
    // an earlier revision (A2) — reads the routed DO's own internal context label (the
    // routing target itself is fixed by the registry pointer; see cutover).
    const { stub } = await deps.resolveActiveRoute();
    const result = await stub.getActiveContextId();
    return json(result);
  }

  if (url.pathname === "/cli/context/history" && request.method === "GET") {
    // an earlier revision (A2) — the routed DO's own context history.
    const { stub } = await deps.resolveActiveRoute();
    const result = await stub.listContextHistory();
    return json(result);
  }

  // `conversation_search` over the registry's
  // canonical archive. Registry-only routing (always DEMO_INSTANCE)
  // because per-context DOs don't hold the archive table. Inputs
  // come via query params for GET ergonomics; POST body would also
  // work but GET is friendlier for the agent's tool surface and for
  // dogfood curl.
  // context hygiene loop. Manual-trigger only in v1
  // (the callable rejects other triggers). Routes through the
  // canonical active context  so hygiene runs ON the
  // DO whose messages it would compact.
  if (url.pathname === "/cli/context/hygiene/run" && request.method === "POST") {
    let body: HygieneRunInput = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      // Tolerate empty body — defaults apply.
    }
    const stub = await deps.getActiveStub();
    try {
      const result = await stub.runContextHygiene(body);
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (url.pathname === "/cli/context/archive/inspect" && request.method === "GET") {
    const recentLimit = Number(url.searchParams.get("recentLimit") ?? "");
    const perContextLimit = Number(url.searchParams.get("perContextLimit") ?? "");
    // an earlier revision (A3) — the routed DO's own archive summary (see /cli/memory/
    // candidates below).
    const { stub } = await deps.resolveActiveRoute();
    const result = await stub.getArchiveInspectSummary({
      recentLimit: Number.isFinite(recentLimit) && recentLimit > 0 ? recentLimit : undefined,
      perContextLimit: Number.isFinite(perContextLimit) && perContextLimit > 0 ? perContextLimit : undefined,
    });
    return json(result);
  }

  // read-only memory candidate inspect.
  // an earlier revision (A3) — routed-DO reads: the operator's live archive/memories
  // moved to its own DO , so the console inspect surfaces follow
  // the routed DO like the lifecycle routes . The registry's
  // legacy data stays reachable via /api/inspect/*?agent_id=<registry>.
  if (url.pathname === "/cli/memory/candidates" && request.method === "GET") {
    const limitParam = Number(url.searchParams.get("limit") ?? "");
    const { stub } = await deps.resolveActiveRoute();
    const result = await stub.listMemoryCandidates({
      limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined,
    });
    return json(result);
  }

  if (url.pathname === "/cli/context/conversation/search" && request.method === "GET") {
    const queryParam = url.searchParams.get("query");
    if (!queryParam || queryParam.trim().length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "missing_query" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const parseInt = (v: string | null, hi: number): number | undefined => {
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(1, Math.min(hi, Math.floor(n))) : undefined;
    };
    const parseTimestamp = (v: string | null): number | undefined => {
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? Math.floor(n) : undefined;
    };
    const roleParam = url.searchParams.get("role");
    const role = (roleParam === "user" || roleParam === "assistant" || roleParam === "system")
      ? roleParam
      : undefined;
    // The caller's active context (so the retrieval log records who
    // searched). Optional — default to whatever the route resolver
    // would pick.
    const callerContextId = request.headers.get(CONTEXT_HEADER) ?? undefined;
    // an earlier revision (A3) — search the routed DO's own archive (see /cli/memory/
    // candidates above).
    const { stub } = await deps.resolveActiveRoute();
    try {
      const result = await stub.conversationSearch({
        query: queryParam,
        contextId: url.searchParams.get("contextId") ?? undefined,
        fromTimestamp: parseTimestamp(url.searchParams.get("fromTimestamp")),
        toTimestamp: parseTimestamp(url.searchParams.get("toTimestamp")),
        role,
        topK: parseInt(url.searchParams.get("topK"), 10),
        snippetCap: parseInt(url.searchParams.get("snippetCap"), 2000),
        callerContextId,
        callerTaskId: url.searchParams.get("taskId") ?? undefined,
        traceId: url.searchParams.get("traceId") ?? undefined,
      });
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // switch the active context to an existing
  // context_history row. Registry-only (always DEMO_INSTANCE) so the
  // active pointer stays the single source of truth across requests.
  if (url.pathname === "/cli/context/switch" && request.method === "POST") {
    let body: { contextId?: string; reason?: string | null } = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (typeof body.contextId !== "string" || body.contextId.trim().length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "missing_contextId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // an earlier revision (A2) — switch rotates the ROUTED DO's own internal context
    // (target must be in ITS context_history); the registry routing pointer
    // is not touched — only the cutover/rollback endpoint writes it.
    const { stub } = await deps.resolveActiveRoute();
    try {
      const result = await stub.switchContext({
        contextId: body.contextId.trim(),
        reason: body.reason ?? null,
      });
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (url.pathname === "/cli/context/compact" && request.method === "POST") {
    let body: { reason?: string | null; lastN?: number; keepRecent?: number } = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      // Tolerate empty body; defaults apply.
    }
    const stub = await deps.getActiveStub();
    try {
      const result = await stub.compactContext({
        reason: body.reason ?? null,
        lastN: typeof body.lastN === "number" ? body.lastN : undefined,
        keepRecent: typeof body.keepRecent === "number" ? body.keepRecent : undefined,
      });
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (url.pathname === "/cli/context/compactions" && request.method === "GET") {
    const stub = await deps.getActiveStub();
    const result = await stub.listCompactions();
    return json(result);
  }

  // v2 Read-only context snapshot for anchor planning.
  // Auth-gated by the global /cli/* requireSecret check above. No audit
  // row server-side; matches /cli/context/inspect's polling contract.
  if (url.pathname === "/cli/context/snapshot" && request.method === "GET") {
    const lastNRaw = url.searchParams.get("lastN");
    const lastN = lastNRaw !== null ? Math.max(1, Math.min(200, Number(lastNRaw) || 20)) : 20;
    const stub = await deps.getActiveStub();
    const result = await stub.inspectContextSnapshot({ lastN });
    return json(result);
  }

  // v2 Read-only deterministic anchor classifier.
  // Same auth contract as /cli/context/snapshot.
  if (url.pathname === "/cli/context/anchors" && request.method === "GET") {
    const lastNRaw = url.searchParams.get("lastN");
    const firstKRaw = url.searchParams.get("firstK");
    const parsedLastN = lastNRaw !== null ? Number(lastNRaw) : NaN;
    const parsedFirstK = firstKRaw !== null ? Number(firstKRaw) : NaN;
    const lastN = Number.isFinite(parsedLastN) ? Math.max(1, Math.min(200, Math.floor(parsedLastN))) : 50;
    const firstK = Number.isFinite(parsedFirstK) ? Math.max(0, Math.min(50, Math.floor(parsedFirstK))) : 4;
    const stub = await deps.getActiveStub();
    const result = await stub.classifyContextAnchors({ lastN, firstK });
    return json(result);
  }

  // v2 Read-only compact-plan dry-run.
  if (url.pathname === "/cli/context/compact-plan" && request.method === "POST") {
    let body: CompactPlanInput = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      // Tolerate empty body — defaults apply.
    }
    const stub = await deps.getActiveStub();
    const result = await stub.compactPlan(body);
    return json(result);
  }

  // v2 Explicit apply of a previously proposed plan.
  // Pre-flight runs against a fresh snapshot per range.
  if (url.pathname === "/cli/context/apply-compact-plan" && request.method === "POST") {
    type ApplyBody = {
      plan?: CompactPlanResult;
      semanticAdvisor?: boolean;
      semanticAdvisorTrigger?: "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";
    };
    let body: ApplyBody = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.plan || typeof body.plan.planId !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "missing_plan" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const stub = await deps.getActiveStub();
    try {
      const result = await stub.applyCompactPlan({
        plan: body.plan,
        semanticAdvisor: body.semanticAdvisor === true,
        semanticAdvisorTrigger: body.semanticAdvisorTrigger,
      });
      return json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return null;
}
