/**
 * sandbox repo materialization.
 *
 * Idempotently ensures the AgentThursday working tree is checked out at a
 * known path inside the `agentthursday-dev-shell` sandbox so the read/git/
 * gate tools have something real to look at. Subsequent calls are
 * cheap: a `test -d <baseDir>/.git` short-circuit returns immediately.
 *
 * Auth model (token selection):
 *   - `AGENT_THURSDAY_REPO_URL` overrides the default https URL (defaults to
 *     this project's known public/private GitHub source).
 *   - Token selection priority (highest to lowest):
 *       1. `AGENT_THURSDAY_GIT_TOKEN`       — narrowest-scoped override.
 *       2. `GITHUB_TOKEN`          — Cloudflare-wide secret often
 *                                    already set; fallback so 189
 *                                    doesn't need a duplicate secret.
 *       3. (no token)              — public-repo / unauthenticated.
 *     The selected token is recorded structurally as a `token_source`
 *     enum on the result, NEVER as the value itself.
 *   - Whichever token is selected, redaction (`***GIT_TOKEN***`)
 *     covers it before any stderr/stdout payload is surfaced.
 *
 * The function returns `{baseDir, existed, head_sha?, source_url_
 * redacted, token_source, error?}` so callers can record provenance
 * (commit sha + source URL + which token slot was picked) without
 * leaking the secret.
 */

import type { SandboxExec } from "./devShell";

export const REPO_BASE_DIR = "/workspace/AgentThursday";
const DEFAULT_REPO_URL = "https://github.com/your-org/AgentThursday.git";

export interface RepoCheckoutEnv {
  AGENT_THURSDAY_REPO_URL?: string;
  /** Narrow-scope PAT specific to AgentThursday automations. Highest priority. */
  AGENT_THURSDAY_GIT_TOKEN?: string;
  /**
   * 189b: fallback to the Cloudflare-wide `GITHUB_TOKEN` secret when
   * no narrower `AGENT_THURSDAY_GIT_TOKEN` is configured. Identical handling
   * (URL injection + redaction) once selected.
   */
  GITHUB_TOKEN?: string;
}

export type TokenSource = "AGENT_THURSDAY_GIT_TOKEN" | "GITHUB_TOKEN" | "none";

export interface CheckoutResult {
  baseDir: string;
  existed: boolean;
  head_sha?: string;
  source_url_redacted: string;
  /**
   * Records WHICH env slot supplied the auth token, never the value.
   * Useful for verifier audits and post-deploy debugging without
   * exposing secrets.
   */
  token_source: TokenSource;
  error?: string;
}

/**
 * Pick the active token by priority and report which slot we used.
 * Pure: returns `{token, source}` so the rest of the flow can treat
 * any non-`none` source uniformly.
 */
export function selectToken(env: RepoCheckoutEnv): {
  token: string | undefined;
  source: TokenSource;
} {
  if (typeof env.AGENT_THURSDAY_GIT_TOKEN === "string" && env.AGENT_THURSDAY_GIT_TOKEN.length > 0) {
    return { token: env.AGENT_THURSDAY_GIT_TOKEN, source: "AGENT_THURSDAY_GIT_TOKEN" };
  }
  if (typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0) {
    return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  }
  return { token: undefined, source: "none" };
}

function redactToken(text: string, token: string | undefined): string {
  if (!token || token.length < 6) return text;
  // Replace token with stable placeholder so logs are reproducible.
  return text.split(token).join("***GIT_TOKEN***");
}

function buildAuthedUrl(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  // git supports https://<token>@host/path for PAT auth.
  return repoUrl.replace(/^https:\/\//, `https://${token}@`);
}

function buildRedactedUrl(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  return repoUrl.replace(/^https:\/\//, `https://***GIT_TOKEN***@`);
}

export async function ensureRepoCheckout(
  exec: SandboxExec,
  env: RepoCheckoutEnv,
): Promise<CheckoutResult> {
  const repoUrl = env.AGENT_THURSDAY_REPO_URL ?? DEFAULT_REPO_URL;
  const { token, source } = selectToken(env);
  const sourceUrlRedacted = buildRedactedUrl(repoUrl, token);

  // Already cloned?
  const check = await exec(`test -d ${REPO_BASE_DIR}/.git && echo HAS || echo MISSING`);
  if (check.stdout.includes("HAS")) {
    const headProbe = await exec(`cd ${REPO_BASE_DIR} && git rev-parse HEAD 2>/dev/null || echo UNKNOWN`);
    const headSha = headProbe.stdout.trim();
    return {
      baseDir: REPO_BASE_DIR,
      existed: true,
      head_sha: headSha === "UNKNOWN" || headSha.length < 7 ? undefined : headSha,
      source_url_redacted: sourceUrlRedacted,
      token_source: source,
    };
  }

  // Clone fresh. Use --depth 50 to keep clone bounded; full history
  // can be deepened later if a tool needs it.
  const authedUrl = buildAuthedUrl(repoUrl, token);
  const cloneCmd = `mkdir -p $(dirname ${REPO_BASE_DIR}) && cd $(dirname ${REPO_BASE_DIR}) && git clone --depth 50 ${authedUrl} $(basename ${REPO_BASE_DIR}) 2>&1`;
  const clone = await exec(cloneCmd);
  if (clone.exit_code !== 0) {
    return {
      baseDir: REPO_BASE_DIR,
      existed: false,
      source_url_redacted: sourceUrlRedacted,
      token_source: source,
      error: redactToken(clone.stderr || clone.stdout, token).slice(0, 500),
    };
  }
  const headProbe = await exec(`cd ${REPO_BASE_DIR} && git rev-parse HEAD 2>/dev/null || echo UNKNOWN`);
  const headSha = headProbe.stdout.trim();
  return {
    baseDir: REPO_BASE_DIR,
    existed: false,
    head_sha: headSha === "UNKNOWN" || headSha.length < 7 ? undefined : headSha,
    source_url_redacted: sourceUrlRedacted,
    token_source: source,
  };
}
