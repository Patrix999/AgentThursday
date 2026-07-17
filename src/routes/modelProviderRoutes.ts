/**
 * model-provider discovery + enable curation (registry DO). GET
 * discovers a provider's live model list via its API (the key stays
 * server-side); POST sets the user-enabled model subset (the discover→enable
 * picker). Owner-scoped via `identity`.
 *
 * M1 (2026-07-01) — extracted verbatim from the `server.ts` inline fetch handler
 * into a route module. Auth stays the `/api/*` umbrella gate in the composition
 * root.
 */
import type { getAgentByName } from "agents";
import type { AgentThursdayAgent } from "../server";
import type { RequestIdentity } from "../agent/requestIdentity";

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

function mpJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export interface ModelProviderRoutesDeps {
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  /** gateway-verified tenant identity (admin when header absent). */
  identity: RequestIdentity;
}

export async function handleModelProviderRoutes(
  request: Request,
  url: URL,
  deps: ModelProviderRoutesDeps,
): Promise<Response | null> {
  const { identity, getRegistryStub } = deps;
  {
    const m = url.pathname.match(/^\/api\/models\/providers\/([^/]+)\/models$/);
    if (m !== null && request.method === "GET") {
      const provider = decodeURIComponent(m[1]);
      const registry = await getRegistryStub();
      const r = await registry.discoverProviderModels({ provider }, identity);
      return mpJson(r, r.ok ? 200 : 400);
    }
  }
  {
    const m = url.pathname.match(/^\/api\/models\/providers\/([^/]+)\/enabled$/);
    if (m !== null && request.method === "POST") {
      const provider = decodeURIComponent(m[1]);
      let body: unknown = {};
      try { body = await request.json(); } catch { /* {} */ }
      const ids = (body && typeof body === "object" && Array.isArray((body as { ids?: unknown }).ids))
        ? ((body as { ids: unknown[] }).ids.filter((x): x is string => typeof x === "string"))
        : [];
      const registry = await getRegistryStub();
      const r = await registry.setEnabledProviderModels({ provider, ids }, identity);
      return mpJson(r, 200);
    }
  }
  return null;
}
