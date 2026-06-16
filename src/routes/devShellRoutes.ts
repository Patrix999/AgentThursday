import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import type { AgentThursdayAgent } from "../server";

/**
 *  — `/api/dev-shell/*` HTTP route handling extracted from
 * `server.ts`.
 *
 * Single entry point: `handleDevShell(request, url, deps)`.
 *
 * Behavior-preserving. Each handler is the verbatim body of the
 * original `server.ts` branch, lifted into one dispatch function.
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via the `DevShellDeps.getActiveStub` factory so this
 * module never imports `getCanonicalActiveAgentThursdayAgentStub`.
 *
 * Returns `null` when no `/api/dev-shell/*` branch matches so
 * `server.ts` can fall through to the remaining `/api/*` handlers and
 * eventually `routeAgentRequest` then `env.ASSETS.fetch`.
 *
 * Auth: gated by the `/api/`/`/cli/`/`/demo/` `requireSecret` umbrella
 * in `server.ts`. This handler never re-checks.
 *
 * Routes (all POST):
 *
 *   /api/dev-shell/dispatch              —  read+git dispatcher
 *   /api/dev-shell/gate            (POST)—  async gate start → { job_id }
 *   /api/dev-shell/gate/job         (GET)—  async gate poll  ← ?job_id=
 *   /api/dev-shell/envelope/start        —  envelope start
 *   /api/dev-shell/envelope/add-gate     —  envelope add-gate
 *   /api/dev-shell/envelope/add-tool     —  envelope add-tool
 *   /api/dev-shell/envelope/seal         —  envelope seal
 *   /api/dev-shell/write                 —  write dispatcher
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

export interface DevShellDeps {
  getActiveStub: () => Promise<AgentThursdayAgentStub>;
}

export async function handleDevShell(
  request: Request,
  url: URL,
  deps: DevShellDeps,
): Promise<Response | null> {
  //  — Developer Shell read + git inspect dispatcher.
  // POST /api/dev-shell/dispatch with body `{ tool_id, input, traceId? }`.
  // Auth-gated via the global secret check above. Dispatch goes through
  // the canonical active AgentThursdayAgent so events land in the same toolEvents
  // stream that /api/inspect.toolEvents reads.
  if (url.pathname === "/api/dev-shell/dispatch" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as {
      tool_id?: unknown;
      input?: unknown;
      traceId?: unknown;
    };
    const toolId = typeof body.tool_id === "string" ? body.tool_id : "";
    const inputArg = (body.input && typeof body.input === "object")
      ? body.input as Record<string, unknown>
      : {};
    const traceId = typeof body.traceId === "string" ? body.traceId : null;
    const stub = await deps.getActiveStub();
    const result = await stub.devShellDispatch({ tool_id: toolId, input: inputArg, traceId });
    return json(result);
  }

  //  — Gate runner endpoint (async).
  // POST /api/dev-shell/gate with body `{ target }`. target ∈
  // {typecheck, build, test, dry_run}. Returns `{ job_id, target,
  // status:"started", started_at }` immediately; gate runs in the
  // background via `ctx.waitUntil` so production gate_typecheck no
  // longer blows past Cloudflare's ~90s synchronous HTTP envelope
  // (CF 1101). Phase events stream into event_log keyed by
  // trace_id = job_id and can be retrieved via the `/job` poll
  // endpoint below.
  if (url.pathname === "/api/dev-shell/gate" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as { target?: unknown };
    const target = typeof body.target === "string" ? body.target : "";
    const stub = await deps.getActiveStub();
    const result = await stub.startGateJob({ target });
    return json(result);
  }

  //  — Gate runner poll endpoint.
  // GET /api/dev-shell/gate/job?job_id=<id>. Returns
  // `{ job_id, status: "in_progress"|"done"|"error"|"unknown",
  //   events: [{ event_type, payload, created_at }] }` ordered
  // oldest-first. Polled by validators/smoke harness until status
  // !== "in_progress".
  if (url.pathname === "/api/dev-shell/gate/job" && request.method === "GET") {
    const jobId = url.searchParams.get("job_id") ?? "";
    const stub = await deps.getActiveStub();
    const result = await stub.getGateJobStatus({ job_id: jobId });
    return json(result);
  }

  //  — Evidence envelope endpoints.
  if (url.pathname === "/api/dev-shell/envelope/start" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const stub = await deps.getActiveStub();
    const result = await stub.devShellEnvelopeStart({
      task_id: typeof body.task_id === "string" ? body.task_id : "",
      intent_source: (body.intent_source as "task_card" | "plan_step" | "human_directive" | "subagent_delegation") ?? "human_directive",
      intent_source_ref: typeof body.intent_source_ref === "string" ? body.intent_source_ref : "",
      intent_declared_goal: typeof body.intent_declared_goal === "string" ? body.intent_declared_goal : "",
      intent_expected_output: Array.isArray(body.intent_expected_output)
        ? body.intent_expected_output as Array<{ type: string; description: string; acceptance_check?: string }>
        : undefined,
      intent_workflow_pattern: typeof body.intent_workflow_pattern === "string" ? body.intent_workflow_pattern : undefined,
      traceId: typeof body.traceId === "string" ? body.traceId : null,
    });
    return json(result);
  }

  if (url.pathname === "/api/dev-shell/envelope/add-gate" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const stub = await deps.getActiveStub();
    const result = await stub.devShellEnvelopeAddGate({
      envelope_id: typeof body.envelope_id === "string" ? body.envelope_id : "",
      target: typeof body.target === "string" ? body.target : "",
      traceId: typeof body.traceId === "string" ? body.traceId : null,
    });
    return json(result);
  }

  //  — non-gate tool execution tracking. Wraps a read-side
  // dispatch (repo.read / repo.glob / repo.grep / git.*) and appends
  // the call into envelope.execution[] so seal can compute
  // fabricated_tools for non-gate tools the agent claims to have run.
  if (url.pathname === "/api/dev-shell/envelope/add-tool" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const stub = await deps.getActiveStub();
    const inputObj =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {};
    const result = await stub.devShellEnvelopeAddTool({
      envelope_id: typeof body.envelope_id === "string" ? body.envelope_id : "",
      tool_id: typeof body.tool_id === "string" ? body.tool_id : "",
      input: inputObj,
      traceId: typeof body.traceId === "string" ? body.traceId : null,
    });
    return json(result);
  }

  if (url.pathname === "/api/dev-shell/envelope/seal" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const stub = await deps.getActiveStub();
    const result = await stub.devShellEnvelopeSeal({
      envelope_id: typeof body.envelope_id === "string" ? body.envelope_id : "",
      claimed_tools: Array.isArray(body.claimed_tools) ? body.claimed_tools.filter((t: unknown): t is string => typeof t === "string") : [],
      traceId: typeof body.traceId === "string" ? body.traceId : null,
    });
    return json(result);
  }

  //  — Developer Shell write dispatcher.
  // POST /api/dev-shell/write with body `{ tool_id, input, traceId? }`.
  // tool_id ∈ {repo.write, repo.patch, repo.delete}. Manifest path
  // policy from software-dev v0 enforces allowlist + denylist; global
  // PATH_DENYLIST applies first. Each successful write returns a
  // unified-diff artifact in `diff` so callers (and inspect) can
  // verify the change without re-reading the file.
  if (url.pathname === "/api/dev-shell/write" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as {
      tool_id?: unknown;
      input?: unknown;
      traceId?: unknown;
      approval?: unknown;
    };
    const toolId = typeof body.tool_id === "string" ? body.tool_id : "";
    const inputArg = (body.input && typeof body.input === "object")
      ? body.input as Record<string, unknown>
      : {};
    const traceId = typeof body.traceId === "string" ? body.traceId : null;
    //  — approval payload is forwarded as-is to the DO; the
    // dispatcher inside the DO is the authority on tier-gating and
    // hash-binding. The route only does shape narrowing.
    let approvalArg: { token_id?: unknown; token?: unknown } | undefined;
    if (body.approval && typeof body.approval === "object") {
      approvalArg = body.approval as { token_id?: unknown; token?: unknown };
    }
    const stub = await deps.getActiveStub();
    const result = await stub.devShellWriteDispatch({
      tool_id: toolId,
      input: inputArg,
      traceId,
      ...(approvalArg !== undefined ? { approval: approvalArg } : {}),
    });
    return json(result);
  }

  return null;
}
