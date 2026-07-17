/**
 * BYO-key provider credential store (registry DO). Auth is the
 * `/api/*` umbrella gate in the fetch handler. The raw key is write-only: POST
 * accepts it, GET returns only `key_hint`, and it never round-trips.
 *
 * M1 (2026-07-01) — extracted verbatim from the `server.ts` inline fetch
 * handler into a route module (same `handleXRoutes(request, url, deps) →
 * Response|null` shape as the sibling route modules), so the composition-root
 * `fetch` handler stays a thin delegator.
 */
import type { getAgentByName } from "agents";
import type { AgentThursdayAgent } from "../server";
import type { RequestIdentity } from "../agent/requestIdentity";

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

// Providers that accept a stored credential. 2026-06-22 openai+google (getModel
// dispatch via @ai-sdk/openai / @ai-sdk/google); 2026-06-29 zhipu (OpenAI-compatible,
// @ai-sdk/openai with the Zhipu baseURL).
const ALLOWED_CREDENTIAL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "deepseek", "openai", "google", "zhipu", "grok"]);
const ROUTE = "/api/models/credentials";

function credJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export interface CredentialRoutesDeps {
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  /** gateway-verified tenant identity (admin when header absent). */
  identity: RequestIdentity;
}

export async function handleCredentialRoutes(
  request: Request,
  url: URL,
  deps: CredentialRoutesDeps,
): Promise<Response | null> {
  const { identity, getRegistryStub } = deps;
  if (url.pathname === ROUTE) {
    const registry = await getRegistryStub();
    if (request.method === "GET") {
      const list = await registry.listProviderCredentials(identity);
      return credJson({ ok: true, credentials: list });
    }
    if (request.method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = (await request.json()) as Record<string, unknown>; }
      catch { return credJson({ ok: false, code: "invalid_json" }, 400); }
      const provider = typeof body.provider === "string" ? body.provider : "";
      const apiKey = typeof body.api_key === "string" ? body.api_key : "";
      const baseUrl = typeof body.base_url === "string" && body.base_url.length > 0 ? body.base_url : null;
      const label = typeof body.label === "string" ? body.label : null;
      if (!ALLOWED_CREDENTIAL_PROVIDERS.has(provider)) {
        return credJson({ ok: false, code: "unknown_provider", message: `provider must be one of: ${[...ALLOWED_CREDENTIAL_PROVIDERS].join(", ")}` }, 400);
      }
      if (apiKey.length === 0) {
        return credJson({ ok: false, code: "missing_api_key" }, 400);
      }
      const saved = await registry.saveProviderCredential({ provider, api_key: apiKey, base_url: baseUrl, label }, identity);
      // the callable fail-closes ({ok:false}, not persisted) when a
      // master key is set but encryption fails; don't report 201 success then.
      if (!saved.ok) {
        return credJson({ ok: false, code: "encrypt_failed", message: "credential encryption failed — not saved" }, 500);
      }
      return credJson({ ok: true, provider: saved.provider, key_hint: saved.key_hint }, 201);
    }
  }
  if (url.pathname.startsWith(`${ROUTE}/`) && request.method === "DELETE") {
    const provider = decodeURIComponent(url.pathname.slice(`${ROUTE}/`.length));
    if (provider.length === 0) return credJson({ ok: false, code: "missing_provider" }, 400);
    const registry = await getRegistryStub();
    await registry.deleteProviderCredential({ provider }, identity);
    return credJson({ ok: true, provider });
  }
  return null;
}
