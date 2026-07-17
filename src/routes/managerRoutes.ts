/**
 * manager skillset HTTP surface.
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
import { CORS_HEADERS } from "../auth";
import {
  managerCreateAgent,
  managerCreateSkillset,
  managerListAgents,
  managerListSkillsets,
  managerReadSkillset,
  managerUpdateAgent,
  managerUpdateSkillset,
  managerDeleteSkillset,
  mintManagerTaskId,
  readManagerTaskEvents,
  readManagerTaskMergedEvents,
  readManagerTaskCompletedEvents,
  resolveRegistryStubForRoute,
  runManagerTaskBackground,
  getAgentDialog,
  getAgentLivePartial,
  getAgentContext,
  getAgentActivity,
  getAgentWorkflowRun,
  getUserActivity,
  managerListSharedFiles,
  managerReadSharedFile,
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
import { ADMIN_USER_ID, ownerUserIdFor, scopeOwnerIdFor, type RequestIdentity } from "../agent/requestIdentity";

const ROUTE_PREFIX = "/api/manager";

export interface ManagerRoutesDeps {
  env: ManagerEnv;
  /**
   * execution-context surface for async-default
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
  /**
   * gateway-verified tenant identity (admin when the
   * `X-AgentThursday-User-Id` header is absent). Threaded into every manager
   * agent read/write + the message-dispatch ownership preflight.
   * Optional so the existing test harness keeps constructing `deps`
   * without it (→ admin / unchanged).
   */
  identity?: RequestIdentity;
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

// lifecycle consensus rewrite: initialized | archived | deleted_marker
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
    // an earlier revision D — display-name-shaped agent_id surfaces here.
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
    const result = await managerListAgents(env, { include_archived }, deps.identity);
    return json(result, 200);
  }

  // ── /api/manager/activity (GET) ────────────────────────────────────
  // Owner-scoped cross-agent activity feed (console parity). Aggregates each
  // of the caller's agents' default-feed actionUiIntents (dispatch / browser /
  // file / repo / execution). A subagent's browser/file work lives in ITS own
  // DO, so this fans out across the tenant's agents rather than reading one.
  if (pathname === `${ROUTE_PREFIX}/activity` && request.method === "GET") {
    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 50);
    }
    const activity = await getUserActivity(env, deps.identity, { limit });
    return json({ ok: true, activity }, 200);
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
    }, deps.identity);
    if (!result.ok) {
      return json(result, agentCreateStatus(result.error.code));
    }
    return json(result, 201);
  }

  // ── /api/manager/agents/:agent_id/dialog (GET) ─────────────────────
  // Owner-scoped conversation restore — the per-agent DO's recent dialog
  // turns, so opening a workspace shows prior history (console parity).
  // Ownership is checked inside `getAgentDialog` (404 when not owned, same
  // as nonexistent — no existence leak). Matched before the generic PATCH.
  {
    const dialogMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/dialog$/);
    if (dialogMatch !== null && request.method === "GET") {
      const agentId = decodeURIComponent(dialogMatch[1]);
      const limitParam = url.searchParams.get("limit");
      let limit = 30;
      if (limitParam !== null) {
        const n = Number(limitParam);
        if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 100);
      }
      const result = await getAgentDialog(env, agentId, deps.identity, limit);
      if (!result.ok) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      return json({ ok: true, turns: result.turns }, 200);
    }
  }

  // ── /api/manager/agents/:agent_id/live-partial (GET) ───────────────
  // live partial text of the in-flight turn, for the streaming
  // card. Owner-gate identical to /dialog (404 = not owned = nonexistent).
  {
    const lpMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/live-partial$/);
    if (lpMatch !== null && request.method === "GET") {
      const agentId = decodeURIComponent(lpMatch[1]);
      const result = await getAgentLivePartial(env, agentId, deps.identity);
      if (!result.ok) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      return json({ ok: true, partial: result.partial }, 200);
    }
  }

  // ── /api/manager/agents/:agent_id/context (GET) ────────────────────
  // Owner-scoped context-window inspect — the per-agent DO's sanitized
  // `inspectContext` (no SOUL / system prompt / tool payloads). Powers the
  // user-app context viewer + title-bar token usage. Ownership is checked
  // inside `getAgentContext` (404 when not owned, same as nonexistent — no
  // existence leak). Matched before the generic PATCH.
  {
    const ctxMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/context$/);
    if (ctxMatch !== null && request.method === "GET") {
      const agentId = decodeURIComponent(ctxMatch[1]);
      const lastNParam = url.searchParams.get("lastN");
      let lastN = 24;
      if (lastNParam !== null) {
        const n = Number(lastNParam);
        if (Number.isFinite(n) && n > 0) lastN = Math.min(Math.floor(n), 100);
      }
      const result = await getAgentContext(env, agentId, deps.identity, lastN);
      if (!result.ok) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      return json({ ok: true, context: result.context }, 200);
    }
  }

  // ── /api/manager/agents/:agent_id/activity (GET) ───────────────────
  // Owner-scoped PER-AGENT activity feed — this agent's default-feed
  // actionUiIntents (dispatch / browser / file / repo / execution), so each
  // agent's workspace shows ITS own activity (console parity), not a shared
  // global feed. Ownership checked in `getAgentActivity` (404 when not owned).
  {
    const actMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/activity$/);
    if (actMatch !== null && request.method === "GET") {
      const agentId = decodeURIComponent(actMatch[1]);
      const limitParam = url.searchParams.get("limit");
      let limit = 16;
      if (limitParam !== null) {
        const n = Number(limitParam);
        if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 50);
      }
      const result = await getAgentActivity(env, agentId, deps.identity, limit);
      if (!result.ok) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      return json({ ok: true, activity: result.activity }, 200);
    }
  }

  // ── /api/manager/agents/:agent_id/workflow-run (GET) ───────────────
  // ── /api/manager/schedules  ─────────────────────────────
  // The schedules page read: ALL of the caller's schedules across agents,
  // each with recent execution history. Owner-scoped by identity.
  if (pathname === `${ROUTE_PREFIX}/schedules` && request.method === "GET") {
    const registry = await resolveRegistryStubForRoute(env);
    const rows = await registry.listScheduledTaskRowsWithRuns({
      scopeOwnerId: scopeOwnerIdFor(deps.identity),
      runLimit: 8,
    });
    return json({ ok: true, schedules: rows }, 200);
  }

  // ── /api/manager/agents/:agent_id/schedules  ─────────────
  // Owner-scoped scheduled-task CRUD. The agent-ownership gate runs first
  // (readAgentProfile with identity — null for a foreign agent, exactly like
  // a nonexistent one, so no existence leak). Row-level owner scoping is
  // enforced again inside scheduledTaskOps (scopeOwnerId), so even a bad
  // gate can't read/mutate foreign rows. Validation + safety valves
  // (per-owner cap, min interval, auto-disable) live in the ops layer.
  {
    const schedMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/schedules(?:\/([^/]+))?$/);
    if (schedMatch !== null) {
      const agentId = decodeURIComponent(schedMatch[1]);
      const scheduleId = schedMatch[2] !== undefined ? decodeURIComponent(schedMatch[2]) : null;
      const registry = await resolveRegistryStubForRoute(env);
      const profile = await registry.readAgentProfile(agentId, deps.identity);
      if (profile === null) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      if (scheduleId === null && request.method === "GET") {
        // the per-agent schedules modal wants execution history
        // inline, so this read embeds recent_runs.
        const rows = await registry.listScheduledTaskRowsWithRuns({
          agentId,
          scopeOwnerId: scopeOwnerIdFor(deps.identity),
          runLimit: 8,
        });
        return json({ ok: true, schedules: rows }, 200);
      }
      if (scheduleId === null && request.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: { code: "invalid_json", message: "body must be JSON" } }, 400);
        }
        const result = await registry.createScheduledTaskRow({
          id: `sched-${crypto.randomUUID()}`,
          ownerUserId: deps.identity ? ownerUserIdFor(deps.identity) : ADMIN_USER_ID,
          agentId,
          spec: {
            schedule_kind: body.schedule_kind,
            interval_s: body.interval_s ?? null,
            at_hour: body.at_hour ?? null,
            at_minute: body.at_minute ?? null,
            at_weekday: body.at_weekday ?? null,
            prompt: body.prompt,
          },
          nowIso: new Date().toISOString(),
        });
        if (!result.ok) {
          return json({ ok: false, error: { code: result.code, message: result.message } }, 400);
        }
        return json({ ok: true, schedule: result.row }, 201);
      }
      if (scheduleId !== null && request.method === "PATCH") {
        let body: Record<string, unknown>;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: { code: "invalid_json", message: "body must be JSON" } }, 400);
        }
        const changes: Record<string, unknown> = {};
        for (const k of ["schedule_kind", "interval_s", "at_hour", "at_minute", "at_weekday", "prompt"]) {
          if (body[k] !== undefined) changes[k] = body[k];
        }
        if (typeof body.enabled === "boolean") changes.enabled = body.enabled;
        const result = await registry.updateScheduledTaskRow({
          id: scheduleId,
          scopeOwnerId: scopeOwnerIdFor(deps.identity),
          nowIso: new Date().toISOString(),
          changes,
        });
        if (!result.ok) {
          const status = result.code === "not_found" ? 404 : 400;
          return json({ ok: false, error: { code: result.code, message: result.message } }, status);
        }
        return json({ ok: true, schedule: result.row }, 200);
      }
      if (scheduleId !== null && request.method === "DELETE") {
        const r = await registry.deleteScheduledTaskRow({
          id: scheduleId,
          scopeOwnerId: scopeOwnerIdFor(deps.identity),
        });
        if (!r.deleted) {
          return json({ ok: false, error: { code: "not_found", message: `schedule not found: ${scheduleId}` } }, 404);
        }
        return json({ ok: true }, 200);
      }
    }
  }

  // owner-scoped LATEST workflow run for this agent as a
  // run→phases→agents tree (or null). Powers the user-app workflow flowchart
  // shown below activity when the session involves a declared workflow.
  // Ownership checked in `getAgentWorkflowRun` (404 when not owned); the run
  // read is itself owner-scoped.
  {
    const wfMatch = pathname.match(/^\/api\/manager\/agents\/([^/]+)\/workflow-run$/);
    if (wfMatch !== null && request.method === "GET") {
      const agentId = decodeURIComponent(wfMatch[1]);
      const result = await getAgentWorkflowRun(env, agentId, deps.identity);
      if (!result.ok) {
        return json({ ok: false, error: { code: "not_found", message: `agent not found: ${agentId}` } }, 404);
      }
      return json({ ok: true, run: result.run }, 200);
    }
  }

  // ── /api/manager/agents/:agent_id/message ──────────────────────────
  // Matched BEFORE the generic `/agents/:agent_id` PATCH, since the
  // `pathname.startsWith` prefix check below would otherwise swallow
  // the suffix.
  //
  // async-default. Sync mode opt-in via `?sync=1` or body
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

      // an earlier revision E — validate task_context shape at the HTTP boundary
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
        // passthrough only; the pure preflight controller
        // re-validates against TaskContextSchema BEFORE recording the
        // `manager.task.received` event. an earlier revision E already 400'd on
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
          { mintTaskId: mintManagerTaskId, now: () => new Date(), identity: deps.identity },
          async (managerTaskId) => {
            // pass the header identity (the async controller already
            // prechecks ownership; this makes runManagerTaskBackground a single
            // chokepoint so no caller silently dispatches as admin).
            const r = await runManagerTaskBackground(env, input, managerTaskId, deps.identity);
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
        identity: deps.identity,
        spawnBackground: (managerTaskId) => () => {
          // same chokepoint identity (header) on the async path.
          const bg = runManagerTaskBackground(env, input, managerTaskId, deps.identity);
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
  // dedicated `manager.task.merged` reader. Returns full
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
  // status endpoint. Reads `manager.task.*` events keyed
  // by `event_log.trace_id = task_id` and derives status per ADR §4.3.
  // an earlier revision §3 — additionally surfaces a bounded `merge` side field
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
      }, deps.identity);
      if (!result.ok) {
        return json(result, agentUpdateStatus(result.error.code));
      }
      return json(result, 200);
    }
  }

  // ── /api/manager/turn-share  ──────────────────────────────────
  // POST creates a FROZEN turn snapshot readable BY LINK (the /t/:id public
  // page on the gateway). Owner comes from the verified identity. The GET is
  // the internal read the gateway's public passthrough calls (secret-gated
  // here like every /api/* — the PUBLIC face lives on the gateway only).
  // owner-scoped: list my shares / revoke one.
  if (pathname === `${ROUTE_PREFIX}/turn-share` && request.method === "GET") {
    const registry = await resolveRegistryStubForRoute(env);
    const shares = await registry.listTurnShares(deps.identity);
    return json({ ok: true, shares }, 200);
  }
  {
    const delMatch = pathname.match(/^\/api\/manager\/turn-share\/([^/]+)$/);
    if (delMatch !== null && request.method === "DELETE") {
      const registry = await resolveRegistryStubForRoute(env);
      const r = await registry.deleteTurnShare({ share_id: decodeURIComponent(delMatch[1]) }, deps.identity);
      if (!r.ok) return json({ ok: false, error: { code: "not_found", message: "share not found" } }, 404);
      return json({ ok: true }, 200);
    }
  }
  if (pathname === `${ROUTE_PREFIX}/turn-share` && request.method === "POST") {
    let body: { agent_id?: string; agent_name?: string; title?: string; content_md?: string };
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: { code: "invalid_json", message: "body must be JSON" } }, 400);
    }
    if (!body.agent_id || typeof body.content_md !== "string") {
      return json({ ok: false, error: { code: "bad_request", message: "agent_id and content_md required" } }, 400);
    }
    const registry = await resolveRegistryStubForRoute(env);
    const r = await registry.createTurnShare(
      {
        agent_id: String(body.agent_id),
        agent_name: body.agent_name ? String(body.agent_name).slice(0, 80) : null,
        title: String(body.title || ""),
        content_md: body.content_md,
      },
      deps.identity,
    );
    if (!r.ok) return json({ ok: false, error: { code: "create_failed", message: r.error } }, 400);
    return json({ ok: true, share_id: r.share_id }, 200);
  }
  {
    const tsMatch = pathname.match(/^\/api\/manager\/turn-share\/([^/]+)$/);
    if (tsMatch !== null && request.method === "GET") {
      const registry = await resolveRegistryStubForRoute(env);
      const row = await registry.readTurnShare({ share_id: decodeURIComponent(tsMatch[1]) });
      if (row === null) {
        return json({ ok: false, error: { code: "not_found", message: "share not found" } }, 404);
      }
      // Public-face fields only — no owner id in the payload.
      return json(
        {
          ok: true,
          share: {
            share_id: row.share_id,
            agent_name: row.agent_name,
            title: row.title,
            content_md: row.content_md,
            created_at: row.created_at,
          },
        },
        200,
      );
    }
  }

  // ── /api/manager/shared-files (2026-06-19, replaces localdoc) ─────────────
  // GET (owner-scoped metadata list) + GET /:id (serve file content). The :id
  // route is the target of the share link an agent pastes into chat; the
  // gateway injects the verified user id, so a user only opens its OWN files
  // (mismatch → 404, no existence leak) and there is no public access.
  if (pathname === `${ROUTE_PREFIX}/shared-files` && request.method === "GET") {
    const files = await managerListSharedFiles(env, deps.identity);
    return json({ ok: true, files }, 200);
  }
  {
    const sfMatch = pathname.match(/^\/api\/manager\/shared-files\/([^/]+)$/);
    if (sfMatch !== null && request.method === "GET") {
      const fileId = decodeURIComponent(sfMatch[1]);
      const file = await managerReadSharedFile(env, fileId, deps.identity);
      if (file === null) {
        return json({ ok: false, error: { code: "not_found", message: "shared file not found" } }, 404);
      }
      const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      return new Response(file.content, {
        status: 200,
        headers: {
          "Content-Type": `${file.mime}; charset=utf-8`,
          "Content-Disposition": `inline; filename="${safeName}"`,
          ...CORS_HEADERS,
        },
      });
    }
  }

  // ── /api/manager/skillsets ─────────────────────────────────────────
  if (pathname === `${ROUTE_PREFIX}/skillsets` && request.method === "GET") {
    const result = await managerListSkillsets(env, scopeOwnerIdFor(deps.identity));
    return json(result, 200);
  }
  if (pathname === `${ROUTE_PREFIX}/skillsets` && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body.ok) return badJson();
    const raw = (body.value ?? {}) as Record<string, unknown>;
    const ownerUserId = deps.identity ? ownerUserIdFor(deps.identity) : ADMIN_USER_ID;
    const result = await managerCreateSkillset(env, {
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      manifest: raw.manifest,
    }, ownerUserId);
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
      const result = await managerReadSkillset(env, { skillset_id: skillsetId }, scopeOwnerIdFor(deps.identity));
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
      }, scopeOwnerIdFor(deps.identity));
      if (!result.ok) {
        return json(result, skillsetUpdateStatus(result.error.code));
      }
      return json(result, 200);
    }
    if (idMatch !== null && request.method === "DELETE") {
      const skillsetId = decodeURIComponent(idMatch[1]);
      const result = await managerDeleteSkillset(env, skillsetId, scopeOwnerIdFor(deps.identity));
      if (!result.ok) {
        return json(result, result.error.code === "not_found" ? 404 : 500);
      }
      return json(result, 200);
    }
  }

  return null;
}
