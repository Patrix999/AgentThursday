/**
 * the operator/debug surface that is ADMIN-ONLY.
 *
 * These route families resolve a Durable Object from the caller-supplied
 * `X-AgentThursday-Context-Id` header (any agent_id), so a scoped tenant must never
 * reach them — they would expose another tenant's workspace / inspect /
 * memory / artifacts / dev-shell. The user product uses its own tenant-scoped
 * routes; the operator console sends no `X-AgentThursday-User-Id` (→ admin) and is
 * unaffected. Kept as a pure predicate so it is unit-testable and the list
 * is a single source of truth.
 */
/**
 * the partyserver/agents-SDK RPC routes
 * (`/agents/<namespace>/<instance>[/...]`, ≥3 segments) reach a per-agent
 * Durable Object directly and bypass the `/api` auth umbrella. The console SPA
 * only ever uses `/agents` and `/agents/<id>` (≤2 segments) served from
 * ASSETS, and the gateway/web client speak `/api/*` — so requiring the secret
 * for the ≥3-segment SDK shape closes an unauthenticated DO-access path
 * without touching any real route. Segment-count test is namespace-casing
 * agnostic (robust to how the SDK spells the class in the path).
 */
export function isAgentsSdkPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === "agents";
}

/**
 * defense-in-depth, NOT a fix for a live hole.
 *
 * The owner-scoped @callables (agent_profile / agent_run / credentials / bots,
 * an earlier revision/c/d/e) take an OPTIONAL `identity` that the agents-SDK RPC path
 * (`/agents/<class>/<instance>/<method>`) cannot carry — over that path it
 * defaults to `undefined` ⇒ the admin (unscoped) branch. That path is already
 * unreachable by a scoped user: it is secret-gated  and the secret
 * IS admin authority (a no-secret OAuth user can never present it), and the
 * gateway only ever calls `/api/*` (identity-threaded), never `/agents/*`.
 *
 * This guard makes that cross-component invariant LOCAL and regression-proof:
 * a scoped (gateway-on-behalf-of-user) request must use `/api/*`, never the raw
 * DO RPC. Admin/system traffic carries no `X-AgentThursday-User-Id` (→ admin) and the
 * console SPA's own SDK connections are admin, so neither is affected. It
 * retroactively hardens the identical SDK-RPC property on 426b/c/d as well.
 */
export function isScopedSdkRpcForbidden(isScopedUser: boolean, pathname: string): boolean {
  return isScopedUser && isAgentsSdkPath(pathname);
}

export function isOperatorOnlyPath(pathname: string): boolean {
  return (
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/inspect" ||
    pathname.startsWith("/api/inspect/") ||
    pathname === "/api/memory" ||
    pathname.startsWith("/api/memory/") ||
    pathname.startsWith("/api/skillset/") ||
    pathname.startsWith("/api/artifact/") ||
    pathname.startsWith("/api/dev-shell/") ||
    pathname.startsWith("/api/dispatch/") ||
    pathname.startsWith("/api/diag/") ||
    // operator/debug surfaces the 426f inventory missed; with no
    // internal identity check they are gated ONLY by the secret umbrella, so a
    // scoped caller (via the gateway proxy, secret-bearing) would otherwise
    // reach them. `/api/sandbox/exec` runs commands (RCE-class), `/api/admin/*`
    // is an operator probe, `/api/discord-gateway/*` controls ingestion.
    pathname.startsWith("/api/sandbox/") ||
    pathname.startsWith("/api/admin/") ||
    pathname.startsWith("/api/discord-gateway/") ||
    pathname.startsWith("/cli/")
  );
}
