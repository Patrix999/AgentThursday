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
import type { ContentCaller } from "../schema";
import type { RequestIdentity } from "../agent/requestIdentity";

/**
 * `/api/content/*` route cluster extracted from `server.ts`.
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
 * an earlier revision fix: the stub type is a minimal structural interface — the
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
  getSources(args: { includeHealth: boolean; sourceId?: string }, traceId?: string | null, caller?: ContentCaller): Promise<unknown>;
  list(args: unknown, traceId?: string | null, caller?: ContentCaller): Promise<unknown>;
  read(args: unknown, traceId?: string | null, caller?: ContentCaller): Promise<unknown>;
  search(args: unknown, traceId?: string | null, caller?: ContentCaller): Promise<unknown>;
  registerUserContentSource(
    args: { repo: string; label?: string | null; default_ref?: string | null },
    identity?: RequestIdentity,
  ): Promise<{ ok: true; source_id: string } | { ok: false; code: string; message: string }>;
  deleteUserContentSource(args: { source_id: string }, identity?: RequestIdentity): Promise<{ ok: boolean }>;
}

/** Minimal structural view of the registry's BYO-key store (PAT storage). */
export interface CredentialRegistryStub {
  saveProviderCredential(
    args: { provider: string; api_key: string; base_url?: string | null; label?: string | null },
    identity?: RequestIdentity,
  ): Promise<{ ok: boolean; provider: string; key_hint: string }>;
}

export interface ContentRoutesDeps {
  getContentHubStub: () => Promise<ContentHubStub>;
  getRegistryStub: () => Promise<CredentialRegistryStub>;
  /**
   * BYO GitHub (2026-06-26) — the request's server-resolved identity (from the
   * gateway-verified `X-AgentThursday-User-Id`, NEVER the body). Reads derive an owner-scoped
   * `ContentCaller` from it (admin → operator; scoped user → own sources); registration
   * stamps the owner from it. The single source of truth for who the caller is.
   */
  identity: RequestIdentity;
}

/**
 * admin (console/secret, no user-id) → operator; a scoped user → its own sources only.
 * NOTE: admin maps to `ownerUserId: null` here, whereas the tool-path
 * (`_resolveCallerOwnerForContent`) uses `ADMIN_USER_ID`. Harmless — no personal source
 * is ever owned by admin, so both yield an empty personal list — but don't mistake this
 * for the owner of a personal source.
 */
function callerFromIdentity(identity: RequestIdentity): ContentCaller {
  return identity.kind === "admin"
    ? { ownerUserId: null, isOperator: true }
    : { ownerUserId: identity.userId, isOperator: false };
}

export async function handleApiContent(
  request: Request,
  url: URL,
  deps: ContentRoutesDeps,
): Promise<Response | null> {
  // BYO GitHub — every content read is owner-scoped to the server-resolved identity.
  const caller = callerFromIdentity(deps.identity);

  // ContentHub registry listing. an earlier revision returns the
  // hardcoded `agentthursday-github` source with static `registry-only` health.
  // an earlier revision swaps the health probe for a real GitHub fetch and an earlier revision
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
    }, null, caller);
    return json(ContentSourcesResponseSchema.parse(result));
  }

  // BYO GitHub (Unit 3) — register a personal GitHub content source for the
  // CALLER. Owner + scope + source_id are server-stamped inside the @callable
  // from `deps.identity` (NEVER the body). Body: { repo, pat?, label?, default_ref? }.
  // A provided `pat` is stored under the owner's encrypted
  // `user_provider_credential('github')` (the token the 2B gate later reads).
  if (url.pathname === "/api/content/sources" && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { return json({ ok: false, code: "request.invalid-json" }, 400); }
    const repo = typeof body.repo === "string" ? body.repo : "";
    const label = typeof body.label === "string" ? body.label : null;
    const defaultRef = typeof body.default_ref === "string" && body.default_ref.length > 0 ? body.default_ref : null;
    const pat = typeof body.pat === "string" ? body.pat.trim() : "";
    if (pat.length > 0) {
      const registry = await deps.getRegistryStub();
      const saved = await registry.saveProviderCredential(
        { provider: "github", api_key: pat, label: "GitHub (BYO repos)" },
        deps.identity,
      );
      if (!saved.ok) return json({ ok: false, code: "credential_store_failed" }, 502);
    }
    const stub = await deps.getContentHubStub();
    const result = await stub.registerUserContentSource({ repo, label, default_ref: defaultRef }, deps.identity);
    return json(result, result.ok ? 201 : 400);
  }

  // BYO GitHub (Unit 3) — remove one of the CALLER's own sources. Owner-scoped
  // delete inside the @callable (a non-owner can't delete another tenant's id).
  if (url.pathname.startsWith("/api/content/sources/") && request.method === "DELETE") {
    const sourceId = decodeURIComponent(url.pathname.slice("/api/content/sources/".length));
    if (sourceId.length === 0) return json({ ok: false, code: "missing_source_id" }, 400);
    const stub = await deps.getContentHubStub();
    const result = await stub.deleteUserContentSource({ source_id: sourceId }, deps.identity);
    return json(result, result.ok ? 200 : 404);
  }

  // ContentHub list endpoint. Body shape:
  //   { sourceId, path, ref? } → ContentListResponse (`{ ok, result|error }`)
  if (url.pathname === "/api/content/list" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = ContentListRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getContentHubStub();
    const result = await stub.list(parsed.data, null, caller);
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
    const result = await stub.read(parsed.data, null, caller);
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
    const result = await stub.search(parsed.data, null, caller);
    return json(ContentSearchResponseSchema.parse(result));
  }

  return null;
}
