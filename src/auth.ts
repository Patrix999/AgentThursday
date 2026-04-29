/**
 * Single-User Shared-Secret Auth Layer.
 *
 * Validates `X-AgentThursday-Secret` header against `env.AGENT_THURSDAY_SHARED_SECRET`.
 * Behavior matrix (also in docs/ops/auth.md):
 *
 *   SECRET set                                    → enforce 401 on mismatch
 *   SECRET unset + ALLOW_INSECURE_DEV === "true"  → console.warn once, allow
 *   SECRET unset + ALLOW_INSECURE_DEV !== "true"  → 503 hard refusal (production safe-default)
 *
 * Exemptions (callers responsibility, not enforced here):
 *   GET /health  — kept open for Cloudflare health probes
 *   OPTIONS *    — CORS preflight
 *
 * NEVER set AGENT_THURSDAY_ALLOW_INSECURE_DEV=true in `wrangler.toml`,
 * `[env.production]`, `wrangler secret put`, or the dashboard env panel.
 * It must only ever appear in local `.dev.vars` (gitignored).
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "X-AgentThursday-Secret, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export type AuthEnv = {
  AGENT_THURSDAY_SHARED_SECRET?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
};

let warnedInsecureAllow = false;
let warnedRefusing = false;

export function requireSecret(request: Request, env: AuthEnv): Response | null {
  const expected = env.AGENT_THURSDAY_SHARED_SECRET;
  if (!expected) {
    if (env.AGENT_THURSDAY_ALLOW_INSECURE_DEV === "true") {
      if (!warnedInsecureAllow) {
        console.warn(
          "[agent-thursday-auth] AGENT_THURSDAY_SHARED_SECRET not set and AGENT_THURSDAY_ALLOW_INSECURE_DEV=true — allowing all traffic. This must NEVER appear in production.",
        );
        warnedInsecureAllow = true;
      }
      return null;
    }
    if (!warnedRefusing) {
      console.error(
        "[agent-thursday-auth] AGENT_THURSDAY_SHARED_SECRET not set and AGENT_THURSDAY_ALLOW_INSECURE_DEV not 'true'; refusing all traffic with 503.",
      );
      warnedRefusing = true;
    }
    return authJson(
      { code: "auth.misconfigured", message: "AGENT_THURSDAY_SHARED_SECRET not set; refusing all traffic" },
      503,
    );
  }
  const provided = request.headers.get("X-AgentThursday-Secret");
  if (provided !== expected) {
    return authJson({ code: "auth.required" }, 401);
  }
  return null;
}

function authJson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
