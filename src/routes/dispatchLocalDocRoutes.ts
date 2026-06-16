import { json } from "../httpUtil";

/**
 *  — dispatch LocalDoc HTTP route extracted from `server.ts`.
 *
 * Single entry point: `handleDispatchLocalDocRoutes(request, url, deps)`.
 *
 * Scope (one route):
 *
 *   POST /api/dispatch/localdoc/convert_text
 *
 * `/api/diag/dispatch` (also named in  §27) was already
 * extracted to `src/routes/diagRoutes.ts` under ; the inline
 * `fetch()` branch is a 2-line passthrough to `handleDiagDispatch`.
 * Per card §59, this card is narrowed to localdoc only so we do not add
 * indirection over an already-extracted helper.
 *
 * Returns `null` when no branch matches (including method-mismatch on
 * the matching path) so `server.ts` can fall through to subsequent
 * handlers. Never returns 405; the original inline branch gated on
 * `pathname === X && method === Y` and fell through otherwise — that
 * is preserved exactly.
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts` (`requireSecret`).
 * This handler never re-checks.
 *
 * The LocalDoc adapter handler reads `env.LOCALDOC_API_KEY` and makes
 * network egress to the LocalDoc API; the module receives `env` via
 * `DispatchLocalDocDeps.env` so the adapter has the same execution
 * context it had inline. No agent stub is needed — the dispatch route
 * goes through the adapter registry, not the AgentThursdayAgent.
 *
 * Status mapping (preserved exactly):
 *   - evidence.status === "ok"                                 → 200
 *   - evidence.status === "blocked"                            → 503
 *   - evidence.status === "failed" && reason === "invalid_input" → 400
 *   - else (failed, other reason)                              → 502
 *   - dispatch missing handler                                 → 500
 */

export interface DispatchLocalDocDeps {
  env: Env;
}

export async function handleDispatchLocalDocRoutes(
  request: Request,
  url: URL,
  deps: DispatchLocalDocDeps,
): Promise<Response | null> {
  //  +  — LocalDoc callable dispatch. Auth-gated via
  // the global `/api/*` requireSecret. Body: `{ title?, content }`.
  // Returns non-sensitive evidence `{ status, id?, url?,
  // markdownUrl?, http_status?, reason?, error_message? }` from the
  // adapter. The route looks up the handler via the
  // adapter-registry path (`getDispatchHandler`) —  moved
  // the LocalDoc handler into `src/skillset/adapters/localdocConvertText.ts`,
  // so the URL route and the agent's dynamic tool surface share the
  // exact same execute path. The API key (`env.LOCALDOC_API_KEY`) is
  // never logged, echoed, or returned. Missing key → 503 with
  // `{ status: "blocked", reason: "missing_secret" }`.
  if (url.pathname === "/api/dispatch/localdoc/convert_text" && request.method === "POST") {
    const { getDispatchHandler } = await import("../skillset/dispatchRegistry");
    const handler = getDispatchHandler("localdoc.convert_text");
    if (!handler) {
      return json({ status: "error", reason: "handler_not_registered" }, 500);
    }
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      content?: unknown;
    };
    const content = typeof body.content === "string" ? body.content : "";
    const title = typeof body.title === "string" ? body.title : undefined;
    const evidence = (await handler.execute(
      { content, ...(title !== undefined ? { title } : {}) },
      deps.env,
    )) as {
      status: "ok" | "blocked" | "failed";
      reason?: string;
    };
    const httpStatus =
      evidence.status === "ok"
        ? 200
        : evidence.status === "blocked"
          ? 503
          : evidence.reason === "invalid_input"
            ? 400
            : 502;
    return json(evidence, httpStatus);
  }

  return null;
}
