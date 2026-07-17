import { json } from "../httpUtil";

/**
 * skillset runtime HTTP route family extracted from
 * `server.ts`.
 *
 * Single entry point: `handleSkillsetRuntimeRoutes(request, url, deps)`.
 *
 * Scope (five routes, two URL prefixes):
 *
 *   GET  /api/skillset/runtime
 *   POST /api/skillset/reload
 *   POST /api/skillset/disable
 *   POST /api/skillset/enable
 *   POST /api/dispatch/skillset/runtime_summary
 *
 * Returns `null` when no branch matches (including method-mismatch on a
 * matching path) so `server.ts` can fall through to subsequent
 * handlers. Never returns 405; the original inline branches gated on
 * `pathname === X && method === Y` and fell through otherwise — that is
 * preserved exactly.
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts` (`requireSecret`).
 * This handler never re-checks.
 *
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `SkillsetRuntimeDeps.getActiveStub` so this module
 * never imports `getCanonicalActiveAgentThursdayAgentStub` or `AgentThursdayAgent`.
 * Per an earlier revision hint, the deps type is a minimal structural
 * interface — the four callable methods only — to avoid pulling the
 * agent class's type graph back into the route-module import tree.
 * The disable/enable error literal unions are kept verbatim so the
 * status mapping below remains type-checked.
 *
 * Status mapping (preserved exactly):
 *   - disableSkillset:  error="missing_skillset_id" → 400,
 *                       error="unknown_skillset_id" → 404,
 *                       else (not_loaded)           → 409.
 *   - enableSkillset:   error="missing_skillset_id" → 400,
 *                       else (unknown_skillset_id)  → 404.
 *   - dispatch missing handler → 500.
 */

export interface SkillsetRuntimeStub {
  getSkillsetRuntimeSummary(): Promise<unknown>;
  reloadSkillsetRuntime(): Promise<unknown>;
  disableSkillset(input: { skillset_id: unknown; reason?: unknown }): Promise<
    | { ok: true; summary: unknown }
    | { ok: false; error: "missing_skillset_id" | "unknown_skillset_id" | "not_loaded" }
  >;
  enableSkillset(input: { skillset_id: unknown; reason?: unknown }): Promise<
    | { ok: true; summary: unknown; changed: boolean }
    | { ok: false; error: "missing_skillset_id" | "unknown_skillset_id" }
  >;
}

export interface SkillsetRuntimeDeps {
  getActiveStub: () => Promise<SkillsetRuntimeStub>;
  env: Env;
}

export async function handleSkillsetRuntimeRoutes(
  request: Request,
  url: URL,
  deps: SkillsetRuntimeDeps,
): Promise<Response | null> {
  // runtime skillset snapshot read.
  // GET /api/skillset/runtime. Auth-gated via the global
  // `/api/*` requireSecret. Routes through the canonical active
  // AgentThursdayAgent so the snapshot returned is exactly the one the
  // agent's `getTools()` consumed (or will consume on next read).
  if (url.pathname === "/api/skillset/runtime" && request.method === "GET") {
    const stub = await deps.getActiveStub();
    const summary = await stub.getSkillsetRuntimeSummary();
    return json(summary);
  }

  // explicit reload action.
  // POST /api/skillset/reload. Auth-gated. Increments the agent's
  // in-memory `reload_count`, rebuilds the snapshot from the
  // currently deployed `EMBEDDED_MANIFESTS`, re-applies env-binding
  // readiness downgrade, writes a `skillset.reload` event, and
  // returns the non-sensitive summary. NOT a DB-backed production
  // hot reload — the deployed bundle is still the source of truth.
  if (url.pathname === "/api/skillset/reload" && request.method === "POST") {
    const stub = await deps.getActiveStub();
    const summary = await stub.reloadSkillsetRuntime();
    return json(summary);
  }

  // operator disable action.
  // POST /api/skillset/disable. Auth-gated. Body: `{ skillset_id,
  // reason? }`. Validates that `skillset_id` is a currently loaded
  // skillset; rebuilds the snapshot with the id moved from
  // `loaded` to `disabled`; writes `skillset.disable` event;
  // returns the new runtime summary. HTTP 400 for missing id,
  // 404 for unknown id, 409 for ids the loader rejected.
  // Disable is in-memory ("since DO woke up"); see
  // `docs/tests/2026-05-12-card238c-runtime-disable.md` for the
  // documented persistence boundary.
  if (url.pathname === "/api/skillset/disable" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      skillset_id?: unknown;
      reason?: unknown;
    };
    const stub = await deps.getActiveStub();
    const result = await stub.disableSkillset({
      skillset_id: body.skillset_id,
      reason: body.reason,
    });
    if (!result.ok) {
      const status =
        result.error === "missing_skillset_id"
          ? 400
          : result.error === "unknown_skillset_id"
            ? 404
            : 409;
      return json({ error: result.error }, status);
    }
    return json(result.summary);
  }

  // operator enable action.
  // POST /api/skillset/enable. Auth-gated. Body: `{ skillset_id,
  // reason? }`. Idempotent: enabling an id that isn't currently
  // disabled returns the same summary without an event. 400 for
  // missing id; 404 for unknown id.
  if (url.pathname === "/api/skillset/enable" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      skillset_id?: unknown;
      reason?: unknown;
    };
    const stub = await deps.getActiveStub();
    const result = await stub.enableSkillset({
      skillset_id: body.skillset_id,
      reason: body.reason,
    });
    if (!result.ok) {
      const status = result.error === "missing_skillset_id" ? 400 : 404;
      return json({ error: result.error }, status);
    }
    return json(result.summary);
  }

  // skillset.runtime_summary dispatch route.
  // POST /api/dispatch/skillset/runtime_summary with optional empty body.
  // Auth-gated via the global secret check above. Goes through the
  // adapter-registered handler so verifier prod-smoke can replay the
  // exact path the agent uses internally; returns the non-sensitive
  // loader/tool-surface summary documented in
  // docs/tools/skillset.runtime_summary.0.1.0.yaml. No secret read,
  // no network egress, no write side effect.
  if (url.pathname === "/api/dispatch/skillset/runtime_summary" && request.method === "POST") {
    const { getDispatchHandler } = await import("../skillset/dispatchRegistry");
    const handler = getDispatchHandler("skillset.runtime_summary");
    if (!handler) {
      return json({ status: "error", reason: "handler_not_registered" }, 500);
    }
    const evidence = await handler.execute({}, deps.env);
    return json(evidence, 200);
  }

  return null;
}
