import { json } from "../httpUtil";
import {
  ContentSourcesResponseSchema,
  ContentListRequestSchema,
  ContentListResponseSchema,
  ContentReadRequestSchema,
  ContentReadResponseSchema,
  ContentSearchRequestSchema,
  ContentSearchResponseSchema,
} from "../schema";

/**
 *  — `/api/content/*` route cluster extracted from `server.ts`.
 *
 * Single entry point: `handleApiContent(request, url, deps)`.
 *
 * Scope:
 *
 *   GET  /api/content/sources
 *   POST /api/content/list
 *   POST /api/content/read
 *   POST /api/content/search
 *
 * Returns `null` when no `/api/content/*` branch matches so `server.ts`
 * can fall through to subsequent route handlers (e.g. `/api/browser/run`).
 *
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `ContentRoutesDeps.getContentHubStub` so this module
 * never imports `CONTENT_HUB_INSTANCE`.
 *
 *  fix: the stub type is a minimal structural interface — the
 * four callable methods only. The route module never imports
 * `ContentHubAgent` or `getAgentByName`, so it does not pull the agent
 * class's type graph back into the import tree (which previously
 * surfaced `this.env` typecheck errors in `src/contentHub.ts`).
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts`. This handler
 * never re-checks. Behavior at the route boundary is byte-equivalent
 * to the pre-extraction inline branches at `server.ts:10018-10078`.
 */

export interface ContentHubStub {
  getSources(args: { includeHealth: boolean; sourceId?: string }): Promise<unknown>;
  list(args: unknown): Promise<unknown>;
  read(args: unknown): Promise<unknown>;
  search(args: unknown): Promise<unknown>;
}

export interface ContentRoutesDeps {
  getContentHubStub: () => Promise<ContentHubStub>;
}

export async function handleApiContent(
  request: Request,
  url: URL,
  deps: ContentRoutesDeps,
): Promise<Response | null> {
  // ContentHub registry listing.  returns the
  // hardcoded `agentthursday-github` source with static `registry-only` health.
  //  swaps the health probe for a real GitHub fetch and
  // adds inspect-layer events. Query params:
  //   ?includeHealth=false  → cheap listing without health field
  //   ?sourceId=<id>        → filter to a single source (404-shaped: empty array)
  if (url.pathname === "/api/content/sources" && request.method === "GET") {
    const includeHealth = url.searchParams.get("includeHealth") !== "false";
    const sourceIdParam = url.searchParams.get("sourceId");
    const stub = await deps.getContentHubStub();
    const result = await stub.getSources({
      includeHealth,
      ...(sourceIdParam ? { sourceId: sourceIdParam } : {}),
    });
    return json(ContentSourcesResponseSchema.parse(result));
  }

  // ContentHub list endpoint. Body shape:
  //   { sourceId, path, ref? } → ContentListResponse (`{ ok, result|error }`)
  if (url.pathname === "/api/content/list" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = ContentListRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getContentHubStub();
    const result = await stub.list(parsed.data);
    return json(ContentListResponseSchema.parse(result));
  }

  // ContentHub read endpoint. Body shape:
  //   { sourceId, path, ref?, maxBytes? } → ContentReadResponse
  if (url.pathname === "/api/content/read" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = ContentReadRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getContentHubStub();
    const result = await stub.read(parsed.data);
    return json(ContentReadResponseSchema.parse(result));
  }

  // ContentHub literal-search endpoint. Body shape:
  //   { sourceId, query, path?, ref?, strategy?, maxResults? } → ContentSearchResponse
  // `strategy:"api-search"` (default) is fail-loud on quota; explicit
  // `strategy:"bounded-local"` returns degraded grep with searchedPaths +
  // omittedReason populated.
  if (url.pathname === "/api/content/search" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = ContentSearchRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getContentHubStub();
    const result = await stub.search(parsed.data);
    return json(ContentSearchResponseSchema.parse(result));
  }

  return null;
}
