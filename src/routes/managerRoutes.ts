/**
 *  —  manager skillset HTTP surface.
 *
 * Routes (all under `/api/manager/`, all auth-gated by the umbrella
 * `/api/*` `requireSecret` in `src/server.ts`):
 *
 *   GET    /api/manager/agents                    list agents (default = active roster;
 *                                                  excludes `archived` + `deleted_marker`
 *                                                  per ADR §2.1; `?includeArchived=1` to see both)
 *   POST   /api/manager/agents                    create agent
 *   PATCH  /api/manager/agents/:agent_id          update agent
 *   POST   /api/manager/agents/:agent_id/message  send work message (AWAIT semantics)
 *   GET    /api/manager/skillsets                 list (embedded ∪ custom)
 *   GET    /api/manager/skillsets/:id             read
 *   POST   /api/manager/skillsets                 create custom
 *   PATCH  /api/manager/skillsets/:id             update custom
 *
 * The handler delegates orchestration to `src/agent/managerOps.ts` so
 * dispatch adapters (`src/skillset/adapters/manager*.ts`) and this HTTP
 * surface share the same validation + persistence + audit-event path.
 *
 * Status mapping (per the YAML tool contracts):
 *   POST /agents              → 201 ok | 400 validation_failed|unknown_model|unsupported_model|unknown_skillset
 *                                | 409 name_conflict | 500 internal
 *   PATCH /agents/:id         → 200 ok | 400 validation_failed|unknown_*|unsupported_model | 404 not_found
 *                                | 409 name_conflict | 422 no_changes | 500 internal
 *   POST /agents/:id/message  → 200 ok (replied|accepted) | 400 invalid_input | 404 target_not_found
 *                                | 504 agent_loop_timeout | 500 internal
 *   POST /skillsets           → 201 ok | 400 validation codes | 409 id_conflict | 500 internal
 *   PATCH /skillsets/:id      → 200 ok | 400 validation codes | 404 not_found
 *                                | 403 embedded_skillset_readonly | 422 no_changes | 500 internal
 *
 * Returns `null` when no branch matches (so the composition root can
 * fall through to the next route family).
 */

import { json } from "../httpUtil";
import {
  managerCreateAgent,
  managerCreateSkillset,
  managerListAgents,
  managerListSkillsets,
  managerReadSkillset,
  managerUpdateAgent,
  managerUpdateSkillset,
  mintManagerTaskId,
  readManagerTaskEvents,
  readManagerTaskMergedEvents,
  readManagerTaskCompletedEvents,
  resolveRegistryStubForRoute,
  runManagerTaskBackground,
  type ManagerAgentMessageInput,
  type ManagerEnv,
} from "../agent/managerOps";
import {
  handleAsyncManagerMessage,
  handleManagerTaskStatus,
  handleSyncManagerMessage,
} from "../agent/managerAsyncTaskController";
import { buildMergeReaderResponse } from "../agent/managerTaskMergeReaderOps";
import { TaskContextSchema } from "../agent/taskContext";

const ROUTE_PREFIX = "/api/manager";

export interface ManagerRoutesDeps {
  env: ManagerEnv;
  /**
   *  — execution-context surface for async-default
   * `/api/manager/agents/:agent_id/message`. The route returns
   * `{status:"received"}` immediately and parks the actual manager
   * dispatch on `ctx.waitUntil(...)` so HTTP envelope ≪ 90s while the
   * subagent loop runs minutes.
   *
   * Optional so the existing test harness (which constructs `deps`
   * without a CF execution context) keeps working — the test bridges
   * a synchronous "run now" shim in its place. Production composition
   * root in `src/server.ts` MUST inject a real
   * `ctx.waitUntil.bind(ctx)`.
   */
  ctx?: { waitUntil: (promise: Promise<unknown>) => void };
}

function badJson(): Response {
  return json({ ok: false, error: { code: "invalid_json", message: "request body is not valid JSON" } }, 400);
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const value = await request.json();
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

//  — lifecycle consensus rewrite: initialized | archived | deleted_marker
const AGENT_STATUS_VALUES = ["initialized", "archived", "deleted_marker"] as const;
type AgentStatusValue = (typeof AGENT_STATUS_VALUES)[number];

function isAgentStatus(value: unknown): value is AgentStatusValue {
  return typeof value === "string" && (AGENT_STATUS_VALUES as readonly string[]).includes(value);
}

function invalidStatusResponse(value: unknown): Response {
  return json(
    {
      ok: false,
      error: {
        code: "validation_failed",
        message: `status must be one of: ${AGENT_STATUS_VALUES.join(", ")}; got ${JSON.stringify(value)}`,
      },
    },
    400,
  );
}

function agentCreateStatus(code: string): number {
  switch (code) {
    case "name_conflict": return 409;
    case "validation_failed":
    case "unknown_model":
    case "unsupported_model":
    case "unknown_skillset":
      return 400;
    default: return 500;
  }
}

function agentUpdateStatus(code: string): number {
  switch (code) {
    case "not_found": return 404;
    case "name_conflict": return 409;
    case "no_changes": return 422;
    case "validation_failed":
    case "unknown_model":
    case "unsupported_model":
    case "unknown_skillset":
      return 400;
    default: return 500;
  }
}

function agentMessageStatus(code: string): number {
  switch (code) {
    case "target_not_found": return 404;
    //  D — display-name-shaped agent_id surfaces here.
    case "agent_not_found": return 404;
    case "invalid_input": return 400;
    case "agent_loop_timeout": return 504;
    default: return 500;
  }
}

function skillsetCreateStatus(code: string): number {
  switch (code) {
    case "id_conflict": return 409;
    case "internal": return 500;
    // every CustomSkillsetValidationError code maps to 400
    default: return 400;
  }
}

function skillsetUpdateStatus(code: string): number {
  switch (code) {
    case "not_found": return 404;
    case "embedded_skillset_readonly": return 403;
    case "no_changes": return 422;
    case "internal": return 500;
    default: return 400;
  }
}

export async function handleManagerRoutes(
  request: Request,
  url: URL,
  deps: ManagerRoutesDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const env = deps.env;

  // ── /api/manager/agents ────────────────────────────────────────────
  if (pathname === `${ROUTE_PREFIX}/agents` && request.method === "GET") {
    const include_archived = url.searchParams.get("includeArchived") === "1";
    const result = await managerListAgents(env, { include_archived });
    return json(result, 200);
  }
  if (pathname === `${ROUTE_PREFIX}/agents` && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body.ok) return badJson();
    const raw = (body.value ?? {}) as Record<string, unknown>;
    if (raw.status !== undefined && !isAgentStatus(raw.status)) {
      return invalidStatusResponse(raw.status);
    }
    const result = await managerCreateAgent(env, {
      name: typeof raw.name === "string" ? raw.name : "",
      model: typeof raw.model === "string" ? raw.model : "",
      skillset: typeof raw.skillset === "string" ? raw.skillset : "",
      ...(typeof raw.persona === "string" ? { persona: raw.persona } : {}),
      ...(typeof raw.channel === "string" ? { channel: raw.channel } : {}),
      ...(isAgentStatus(raw.status) ? { status: raw.status } : {}),
    });
    if (!result.ok) {
      return json(result, agentCreateStatus(result.error.code));
    }
    return json(result, 201);
  }

  // ── /api/manager/agents/:agent_id/message ──────────────────────────
  // Matched BEFORE the generic `/agents/:agent_id` PATCH, since the
  // `pathname.startsWith` prefix check below would otherwise swallow
  // the suffix.
  //
  //  — async-default. Sync mode opt-in via `?sync=1` or body
  // `{"mode":"sync"}`. Async path returns `{status:"received"}` and
  // parks the dispatch on `ctx.waitUntil(...)`.
  {
    const msgMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/message$/);
    if (msgMatch !== null && request.method === "POST") {
      const agentId = decodeURIComponent(msgMatch[1]);
      const body = await readJsonBody(request);
      if (!body.ok) return badJson();
      const raw = (body.value ?? {}) as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text : "";

      //  E — validate task_context shape at the HTTP boundary
      // BEFORE the preflight controller. Without this, a malformed
      // `task_context` (e.g. null, primitive, missing required fields)
      // could surface as HTTP 500 once it reached
      // `applyManagerTaskContextFallback` (which dereferences
      // `tc.parent_task_id` unconditionally). Return 400 with a
      // structured `validation_failed` payload — the same shape the
      // pure controller already emits — so the client sees the same
      // error class regardless of which path validates first.
      if (raw.task_context !== undefined && raw.task_context !== null) {
        const parsed = TaskContextSchema.safeParse(raw.task_context);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const field = issue && issue.path.length > 0 ? issue.path.join(".") : "task_context";
          const reason = issue ? issue.message : "invalid shape";
          return json(
            {
              ok: false,
              status: "failed",
              agent_id: agentId,
              error: {
                code: "validation_failed",
                message: `task_context.${field}: ${reason}`,
              },
            },
            400,
          );
        }
      }
      const input: ManagerAgentMessageInput = {
        agent_id: agentId,
        text,
        ...(typeof raw.conversation_id === "string"
          ? { conversation_id: raw.conversation_id }
          : {}),
        ...(typeof raw.source === "string" ? { source: raw.source } : {}),
        //  — passthrough only; the pure preflight controller
        // re-validates against TaskContextSchema BEFORE recording the
        // `manager.task.received` event.  E already 400'd on
        // malformed shapes above, so this branch only sees valid data.
        ...(raw.task_context !== undefined && raw.task_context !== null
          ? { task_context: raw.task_context as ManagerAgentMessageInput["task_context"] }
          : {}),
      };

      const registry = await resolveRegistryStubForRoute(env);

      // ─── Sync opt-in (debug / smoke) ──────────────────────────────
      // Sync mode runs the same preflight as async (so
      // `manager.task.received` lands in event_log BEFORE dispatch),
      // then awaits `runManagerTaskBackground` inline. The bracket
      // events (`started` / `replied` / `failed`) fire on the same
      // path the async route uses — spec §"sync mode 仍记录相同
      // bracket events". The HTTP response is the
      // `ManagerAgentMessageResult` plus the route-minted
      // `manager_task_id` / `trace_id` so smoke callers can poll
      // `GET /api/manager/tasks/:task_id` afterwards.
      const syncQuery = url.searchParams.get("sync");
      const syncRequested =
        syncQuery === "1" || syncQuery === "true" || raw.mode === "sync";
      if (syncRequested) {
        const outcome = await handleSyncManagerMessage(
          registry,
          input,
          { mintTaskId: mintManagerTaskId, now: () => new Date() },
          async (managerTaskId) => {
            const r = await runManagerTaskBackground(env, input, managerTaskId);
            if (r === null) {
              // Registry stub resolve failed inside runManagerTaskBackground
              // — no `started`/`failed` event lands; operator sees only the
              // `received` bracket until `timed_out` derivation kicks in.
              return {
                ok: false,
                status: "failed",
                agent_id: input.agent_id,
                error: {
                  code: "internal",
                  message: "manager registry stub resolve failed",
                },
              };
            }
            return r;
          },
        );
        if (outcome.kind === "rejected") {
          return json(outcome.body, outcome.httpStatus);
        }
        const result = outcome.result;
        // Unify sync `task_id` with the async contract: `task_id` is the
        // route-minted managerTaskId (= `event_log.trace_id`), so
        // `GET /api/manager/tasks/<task_id>` works the same way for
        // both paths. The per-agent submit id moves to `submit_task_id`,
        // matching the field name `runManagerTaskBackground` already
        // uses inside the `replied` event payload.
        const { task_id: submitTaskId, ...resultRest } = result;
        const body = {
          ...resultRest,
          task_id: outcome.managerTaskId,
          submit_task_id: submitTaskId,
          manager_task_id: outcome.managerTaskId,
          trace_id: outcome.managerTaskId,
          accepted_at: outcome.acceptedAt,
        };
        if (!result.ok) {
          const errCode = result.error?.code ?? "internal";
          return json(body, agentMessageStatus(errCode));
        }
        return json(body, 200);
      }

      // ─── Async default ────────────────────────────────────────────
      // Delegates validation + target-check + `manager.task.received`
      // emission to the pure controller. The controller hands back a
      // spawn thunk we wire to ctx.waitUntil so the background runs
      // detached from the HTTP envelope.
      const outcome = await handleAsyncManagerMessage(registry, input, {
        mintTaskId: mintManagerTaskId,
        now: () => new Date(),
        spawnBackground: (managerTaskId) => () => {
          const bg = runManagerTaskBackground(env, input, managerTaskId);
          if (deps.ctx !== undefined) {
            deps.ctx.waitUntil(bg);
          } else {
            void bg;
          }
        },
      });
      if (outcome.kind === "rejected") {
        return json(outcome.body, outcome.httpStatus);
      }
      outcome.spawn();
      return json(outcome.body, outcome.httpStatus);
    }
  }

  // ── /api/manager/tasks/:task_id/merge (GET) ────────────────────────
  //  — dedicated `manager.task.merged` reader. Returns full
  // entries (event_id, created_at, payload) ORDER BY created_at ASC
  // plus a `latest` summary derived from the newest row. Unknown
  // parent_task_id returns 200 + `merged: false` + `merges: []` so
  // UI polling is uniform with the status endpoint.
  {
    const mergeMatch = pathname.match(/^\/api\/manager\/tasks\/([^/]+)\/merge$/);
    if (mergeMatch !== null && request.method === "GET") {
      const taskId = decodeURIComponent(mergeMatch[1]);
      try {
        const rows = await readManagerTaskMergedEvents(env, taskId);
        return json(buildMergeReaderResponse(taskId, rows), 200);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json(
          {
            ok: false,
            task_id: taskId,
            error: { code: "internal", message },
          },
          500,
        );
      }
    }
  }

  // ── /api/manager/tasks/:task_id (GET) ──────────────────────────────
  //  — status endpoint. Reads `manager.task.*` events keyed
  // by `event_log.trace_id = task_id` and derives status per ADR §4.3.
  //  §3 — additionally surfaces a bounded `merge` side field
  // by reading `manager.task.merged` rows on the same trace_id; the
  // existing `status` derivation is UNCHANGED (merge is non-terminal).
  // Unknown task_id returns 200 + `status:"unknown"` + `events:[]` +
  // `merge:{merged:false,...}` (NOT 404) so operator polling is uniform.
  {
    const taskMatch = pathname.match(/^\/api\/manager\/tasks\/([^/]+)$/);
    if (taskMatch !== null && request.method === "GET") {
      const taskId = decodeURIComponent(taskMatch[1]);
      try {
        const body = await handleManagerTaskStatus(
          {
            readManagerTaskEvents: (id) => readManagerTaskEvents(env, id),
            readManagerTaskMergedEvents: (id) => readManagerTaskMergedEvents(env, id),
            readManagerTaskCompletedEvents: (id) =>
              readManagerTaskCompletedEvents(env, id),
          },
          taskId,
          new Date(),
        );
        return json(body, 200);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json(
          {
            ok: false,
            task_id: taskId,
            error: { code: "internal", message },
          },
          500,
        );
      }
    }
  }

  // ── /api/manager/agents/:agent_id (PATCH) ──────────────────────────
  {
    const idMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)$/);
    if (idMatch !== null && request.method === "PATCH") {
      const agentId = decodeURIComponent(idMatch[1]);
      const body = await readJsonBody(request);
      if (!body.ok) return badJson();
      const raw = (body.value ?? {}) as Record<string, unknown>;
      if (raw.status !== undefined && !isAgentStatus(raw.status)) {
        return invalidStatusResponse(raw.status);
      }
      const result = await managerUpdateAgent(env, {
        agent_id: agentId,
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.model === "string" ? { model: raw.model } : {}),
        ...(typeof raw.skillset === "string" ? { skillset: raw.skillset } : {}),
        ...(typeof raw.persona === "string" ? { persona: raw.persona } : {}),
        ...(isAgentStatus(raw.status) ? { status: raw.status } : {}),
      });
      if (!result.ok) {
        return json(result, agentUpdateStatus(result.error.code));
      }
      return json(result, 200);
    }
  }

  // ── /api/manager/skillsets ─────────────────────────────────────────
  if (pathname === `${ROUTE_PREFIX}/skillsets` && request.method === "GET") {
    const result = await managerListSkillsets(env);
    return json(result, 200);
  }
  if (pathname === `${ROUTE_PREFIX}/skillsets` && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body.ok) return badJson();
    const raw = (body.value ?? {}) as Record<string, unknown>;
    const result = await managerCreateSkillset(env, {
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      manifest: raw.manifest,
    });
    if (!result.ok) {
      return json(result, skillsetCreateStatus(result.error.code));
    }
    return json(result, 201);
  }

  // ── /api/manager/skillsets/:skillset_id (GET / PATCH) ──────────────
  {
    const idMatch = pathname.match(/^\/api\/manager\/skillsets\/([^/]+)$/);
    if (idMatch !== null && request.method === "GET") {
      const skillsetId = decodeURIComponent(idMatch[1]);
      const result = await managerReadSkillset(env, { skillset_id: skillsetId });
      if (result.status === "failed") {
        const httpStatus = result.reason === "not_found" ? 404 : result.reason === "invalid_input" ? 400 : 500;
        return json(result, httpStatus);
      }
      return json(result, 200);
    }
    if (idMatch !== null && request.method === "PATCH") {
      const skillsetId = decodeURIComponent(idMatch[1]);
      const body = await readJsonBody(request);
      if (!body.ok) return badJson();
      const raw = (body.value ?? {}) as Record<string, unknown>;
      const result = await managerUpdateSkillset(env, {
        skillset_id: skillsetId,
        manifest: raw.manifest,
      });
      if (!result.ok) {
        return json(result, skillsetUpdateStatus(result.error.code));
      }
      return json(result, 200);
    }
  }

  return null;
}
