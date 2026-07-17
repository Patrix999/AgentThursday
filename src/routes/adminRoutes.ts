import { getAgentByName, type AgentNamespace } from "agents";
import { json } from "../httpUtil";
import { DEMO_INSTANCE } from "../demoConstants";
import type { AgentThursdayAgent } from "../server";

/**
 * `POST /api/admin/codemode-probe` route extracted from
 * `src/server.ts`.
 *
 * Body lifted verbatim from the original inline branch (was M7.3
 * an earlier revision):
 *   - Codemode self-probe. Bypasses the model loop; calls
 *     `executor.execute("return 1+1", [])` directly so reviewers get
 *     ground truth about whether `execute` is registered + functional.
 *
 * Stub resolution: registry stub via
 * `getAgentByName(env.AgentThursdayAgent, DEMO_INSTANCE)` — NOT the
 * canonical-active stub. The probe is a registry-scoped diagnostic;
 * routing it through the canonical-active stub would mask code-mode
 * runtime issues that only manifest on the registry DO.
 *
 * Auth: still gated by the composition-root `/api/*` umbrella
 * `requireSecret` check in `src/server.ts`. This module never re-checks.
 *
 * Return shape: `Promise<Response | null>` — `null` means
 * path/method-mismatch so `server.ts` falls through to the next route
 * family. Method mismatch falls through rather than returning a
 * route-local 405, mirroring the original inline `pathname === X &&
 * method === Y` gate.
 */
export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname === "/api/admin/codemode-probe" && request.method === "POST") {
    const stub = await getAgentByName<Env, AgentThursdayAgent>(
      env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
      DEMO_INSTANCE,
    );
    const probe = await stub.codemodeProbe();
    return json(probe);
  }
  return null;
}
