import { z } from "zod";
import { json } from "../httpUtil";
import { createAgentRun, type AgentRunOpsHost } from "../agent/agentRunOps";

/**
 *  — `POST /api/agent-runs` mints a workflow instance.
 *  — `GET /api/agent-runs/:id` returns the durable run row
 *            from the registry DO, optionally merged with the
 *            workflow backplane status.
 *  — `POST /api/agent-runs/:id/events` is the sendEvent
 *            ingress for resuming a workflow paused on
 *            `step.waitForEvent("user-reply", ...)`. Event-type
 *            vocabulary is locked to `"user-reply"` for now (D-6);
 *            other types reserved for future cards (approve / abort).
 *
 * Auth gated by the umbrella `/api/*` `requireSecret` check in
 * `src/server.ts` — never re-checked here. Returns `null` for
 * path / method mismatch so the composition root falls through to
 * the next route family.
 *
 * Route prefix `/api/agent-runs` is new — no shadowing risk against
 * 's `/api/agent-profiles` (different exact prefix; the
 * pathname.startsWith check is the same module pattern).
 */

const ROUTE_PREFIX = "/api/agent-runs";
const EVENTS_SUFFIX = "/events";

const AgentRunCreateInputSchema = z.object({
  profile_id: z.string().min(1),
  input: z.unknown().optional(),
});

const AgentRunEventInputSchema = z.object({
  type: z.literal("user-reply"),
  payload: z.unknown().optional(),
});

type WorkflowInstanceLike = {
  status: () => Promise<{ status?: string } | { status: string }>;
  sendEvent?: (event: { type: string; payload: unknown }) => Promise<unknown>;
};

export interface AgentRunRoutesDeps {
  host: AgentRunOpsHost;
  /**
   * Resolves a `WorkflowInstance` handle by id. Used by the GET branch
   * (status() — fail-soft) and the POST events branch (sendEvent —
   * surfaced as 5xx on failure since it's the route's primary action).
   */
  workflowInstance: (id: string) => Promise<WorkflowInstanceLike>;
}

export async function handleAgentRunRoutes(
  request: Request,
  url: URL,
  deps: AgentRunRoutesDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;

  if (pathname === ROUTE_PREFIX && request.method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ code: "invalid_json", message: "request body is not valid JSON" }, 400);
    }
    const parsed = AgentRunCreateInputSchema.safeParse(raw);
    if (!parsed.success) {
      return json(
        { code: "validation_failed", message: "input shape rejected", issues: parsed.error.issues },
        400,
      );
    }
    const result = await createAgentRun(deps.host, {
      profile_id: parsed.data.profile_id,
      input: parsed.data.input ?? null,
    });
    return json(result, 201);
  }

  //  — `GET /api/agent-runs` list. Optional `?profile_id=<id>`
  // and `?limit=<n>` (clamped server-side in the SQL helper).
  if (pathname === ROUTE_PREFIX && request.method === "GET") {
    const profileIdParam = url.searchParams.get("profile_id");
    const profileId = profileIdParam && profileIdParam.length > 0 ? profileIdParam : undefined;
    const limitParam = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) {
        return json(
          { code: "invalid_limit", message: "limit must be a positive integer" },
          400,
        );
      }
      limit = n;
    }
    const registry = await deps.host.getRegistryStub();
    const runs = await registry.listAgentRuns({ profile_id: profileId, limit });
    return json({ runs }, 200);
  }

  if (pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    const tail = pathname.slice(ROUTE_PREFIX.length + 1);

    // POST /api/agent-runs/<id>/events  — sendEvent ingress ()
    if (request.method === "POST" && tail.endsWith(EVENTS_SUFFIX)) {
      const runId = tail.slice(0, -EVENTS_SUFFIX.length);
      if (!runId || runId.includes("/")) {
        return json(
          { code: "invalid_run_id", message: "expected /api/agent-runs/<id>/events" },
          400,
        );
      }
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ code: "invalid_json", message: "request body is not valid JSON" }, 400);
      }
      const parsed = AgentRunEventInputSchema.safeParse(raw);
      if (!parsed.success) {
        return json(
          {
            code: "validation_failed",
            message: "event shape rejected (only type='user-reply' supported)",
            issues: parsed.error.issues,
          },
          400,
        );
      }
      const registry = await deps.host.getRegistryStub();
      const run = await registry.readAgentRun(runId);
      if (!run) {
        return json({ code: "not_found", message: `agent_run not found: ${runId}` }, 404);
      }
      if (run.status !== "awaiting_event") {
        return json(
          {
            code: "not_awaiting_event",
            message: `agent_run ${runId} is not pausing (status=${run.status})`,
          },
          409,
        );
      }
      let instance: WorkflowInstanceLike;
      try {
        instance = await deps.workflowInstance(run.workflow_instance_id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json(
          {
            code: "workflow_instance_unreachable",
            message: `failed to resolve workflow instance: ${message}`,
          },
          502,
        );
      }
      if (typeof instance.sendEvent !== "function") {
        return json(
          {
            code: "sendevent_unsupported",
            message: "workflow instance does not expose sendEvent in this runtime",
          },
          501,
        );
      }
      try {
        await instance.sendEvent({
          type: parsed.data.type,
          payload: parsed.data.payload ?? null,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json(
          { code: "sendevent_failed", message: `sendEvent threw: ${message}` },
          502,
        );
      }
      return json({ run_id: runId, accepted: true }, 202);
    }

    // GET /api/agent-runs/<id>  — row + workflow status ()
    if (request.method === "GET") {
      const runId = tail;
      if (!runId || runId.includes("/")) {
        return json({ code: "invalid_run_id", message: "expected /api/agent-runs/<id>" }, 400);
      }
      const registry = await deps.host.getRegistryStub();
      const run = await registry.readAgentRun(runId);
      if (!run) {
        return json({ code: "not_found", message: `agent_run not found: ${runId}` }, 404);
      }
      let workflowStatus: string | null = null;
      try {
        const instance = await deps.workflowInstance(run.workflow_instance_id);
        const s = await instance.status();
        const raw = (s as { status?: unknown }).status;
        workflowStatus = typeof raw === "string" ? raw : null;
      } catch {
        workflowStatus = null;
      }
      return json({ run, workflow_status: workflowStatus }, 200);
    }
  }

  return null;
}
