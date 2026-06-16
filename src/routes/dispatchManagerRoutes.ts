/**
 *  —  manager skillset dispatch HTTP surface.
 *
 * Mirrors `dispatchLocalDocRoutes.ts`: each `/api/dispatch/manager/<tool>`
 * path resolves the handler via the adapter registry
 * (`getDispatchHandler`) so the agent's dynamic-tool surface and the
 * HTTP surface share the exact same execute path.
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts` (`requireSecret`).
 *
 * Status mapping: the manager tools settled on a richer body shape
 * than the original `{status: ok|blocked|failed, reason}` envelope —
 * most use `{ok: boolean, agent|skillset|error}`, `skillset_read`
 * uses `{status: ok|failed, reason}`, and `agent_message` adds a
 * tri-state `status: replied|accepted|failed` alongside `ok`. This
 * mapper recognises both shapes:
 *   - `status === "ok"` or `ok === true`                        → 200
 *   - `ok === false`, error.code → HTTP per the YAML enums:
 *       validation / unknown_* / manifest_* / id_mismatch / etc. → 400
 *       target_not_found / not_found                            → 404
 *       embedded_skillset_readonly                              → 403
 *       name_conflict / id_conflict                             → 409
 *       no_changes                                              → 422
 *       agent_loop_timeout                                      → 504
 *       internal / unknown                                      → 500
 *   - `status === "failed"`, reason → equivalent of the above   → see code
 *   - `status === "blocked"`                                    → 503 (parity with localdoc)
 *   - dispatch missing handler                                  → 500
 *
 * Adapters MUST return the same body shape declared in each tool's
 * YAML `output_schema`; this mapper never rewrites the body.
 */

import { json } from "../httpUtil";

const MANAGER_TOOL_IDS = new Set([
  "manager.agent_list",
  "manager.agent_create",
  "manager.agent_update",
  "manager.skillset_list",
  "manager.skillset_read",
  "manager.skillset_create",
  "manager.skillset_update",
  "manager.agent_message",
  //  — audit-grade merge event emitter. HTTP-callable for
  // deterministic verifier smoke; the same handler is reused by the
  // manager DO's dynamic-tool surface via the adapter registry.
  "manager.task_merge",
  //  — post-merge completion report emitter. HTTP-callable
  // for deterministic verifier smoke; identical adapter registry
  // wiring as task_merge. Coexists with `manager.task.replied`;
  // completion is report/archive evidence, not a lifecycle terminal.
  "manager.task_complete",
]);

const PATH_PREFIX = "/api/dispatch/manager/";

export interface DispatchManagerDeps {
  env: Env;
}

function httpStatusForCode(code: string): number {
  switch (code) {
    // 400 — input shape / closed enum / canonicalisation failures
    case "validation_failed":
    case "invalid_input":
    case "unknown_model":
    case "unsupported_model":
    case "unknown_skillset":
    case "manifest_required":
    case "manifest_invalid_shape":
    case "missing_id":
    case "id_mismatch":
    case "unknown_tool_id":
    //  — manager.task_merge ref-shape mismatch is a 400-class
    // client error (ref.task_id/agent_id contradicts the referenced
    // summary row).
    case "ref_mismatch":
      return 400;
    // 403 — write to immutable surface OR cross-manager permission
    // boundary ( / ).
    case "embedded_skillset_readonly":
    case "permission_denied":
      return 403;
    // 404 — row not found
    case "target_not_found":
    //  D — display-name-shaped agent_id surfaces here when
    // the caller skipped `manager.agent_list` resolution and passed
    // a skillset / display name instead.
    case "agent_not_found":
    case "not_found":
    //  — manager.task_merge ref pointed at a parent/summary
    // pair with no matching `manager.subagent.summary` row.
    case "summary_not_found":
      return 404;
    // 409 — uniqueness clash
    case "name_conflict":
    case "id_conflict":
      return 409;
    // 422 — well-formed but caused no state change
    case "no_changes":
      return 422;
    // 504 — DO loop exceeded the sync envelope
    case "agent_loop_timeout":
      return 504;
    case "internal":
      return 500;
    default:
      return 500;
  }
}

function mapEnvelopeToHttp(evidence: unknown): number {
  if (typeof evidence !== "object" || evidence === null) return 200;
  const ev = evidence as Record<string, unknown>;
  // `manager.agent_message` returns both `status: "failed"|"replied"|"accepted"`
  // AND an `error.code` envelope; prefer the structured code, fall back to
  // `reason` (the `manager.skillset_read` shape).
  if (ev.ok === false) {
    const err = ev.error as { code?: unknown } | undefined;
    const code = typeof err?.code === "string" ? err.code : null;
    if (code !== null) return httpStatusForCode(code);
  }
  if (ev.status === "ok") return 200;
  if (ev.status === "blocked") return 503;
  if (ev.status === "failed") {
    const reason = typeof ev.reason === "string" ? ev.reason : "internal";
    return httpStatusForCode(reason);
  }
  if (ev.ok === true) return 200;
  return 200;
}

export async function handleDispatchManagerRoutes(
  request: Request,
  url: URL,
  deps: DispatchManagerDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith(PATH_PREFIX)) return null;
  if (request.method !== "POST") return null;
  const tail = url.pathname.slice(PATH_PREFIX.length);
  if (tail.length === 0 || tail.includes("/")) return null;
  const toolId = `manager.${tail}`;
  if (!MANAGER_TOOL_IDS.has(toolId)) return null;

  const { getDispatchHandler } = await import("../skillset/dispatchRegistry");
  const handler = getDispatchHandler(toolId);
  if (!handler) {
    return json({ status: "error", reason: "handler_not_registered" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  //  E — validate body shape via the handler's zod inputSchema
  // BEFORE calling execute. Without this, malformed shapes (e.g.
  // `task_context: null` on `manager.agent_message`) reached the
  // adapter which assumed structural typing and surfaced as HTTP 500
  // when downstream helpers dereferenced fields. Return 400 with a
  // structured `validation_failed` payload so the client sees the same
  // error class the rest of `/api/manager/*` already emits.
  const parsed = handler.inputSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join(".") : "input";
    const reason = issue ? issue.message : "invalid shape";
    return json(
      {
        ok: false,
        status: "failed",
        error: {
          code: "validation_failed",
          message: `${field}: ${reason}`,
        },
      },
      400,
    );
  }
  const validBody = parsed.data;
  //  — adapters that enforce a per-caller permission boundary
  // (currently `manager.task_merge`; `manager.subagent_summaries` may
  // be wired the same way in a future patch) require `ctx.name` to be
  // the calling agent_id. The DO-internal call path threads
  // `this.name` natively; over HTTP we thread the
  // `X-AgentThursday-Context-Id` header — the same header  already
  // uses as the DO routing key — into a synthetic ctx object so the
  // adapter's `requireCallingAgentCtx` succeeds. The umbrella secret
  // gate (`requireSecret`) still applies; the permission boundary
  // inside the helper still rejects cross-manager refs.
  const contextId = request.headers.get("X-AgentThursday-Context-Id");
  const ctx = typeof contextId === "string" && contextId.length > 0
    ? { name: contextId }
    : undefined;
  const evidence = await handler.execute(validBody, deps.env, ctx);
  return json(evidence, mapEnvelopeToHttp(evidence));
}
