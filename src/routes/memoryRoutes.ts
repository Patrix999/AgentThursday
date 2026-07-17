import type { getAgentByName } from "agents";
import { json } from "../httpUtil";
import { MemorySnapshotSchema } from "../schema";
import type { AgentThursdayAgent } from "../server";

/**
 * `GET /api/memory` route extracted from `src/server.ts`.
 *
 * Body lifted verbatim from the original inline branch (was an earlier revision +
 * an earlier revision):
 *   - Agent Memory v1 read-only snapshot, routed through the canonical
 *     active context DO (not DEMO_INSTANCE) so the Memory tab reflects
 *     the active session's `agent_memories` / `memory_knowledge`.
 *   - `MemorySnapshotSchema.parse(snapshot)` still enforces the
 *     boundary contract.
 *
 * Auth: still gated by the composition-root `/api/*` umbrella
 * `requireSecret` check in `src/server.ts`. This module never re-checks.
 *
 * Return shape: `Promise<Response | null>` — `null` means
 * path/method-mismatch so `server.ts` falls through to the next route
 * family. Method mismatch (e.g. POST /api/memory) falls through to the
 * next handler rather than returning a route-local 405, mirroring the
 * original inline gate's `pathname === X && method === Y` pattern.
 *
 * DI signature: the composition root resolves the canonical-active stub
 * lazily via `deps.getActiveStub()` so this module never imports
 * `getCanonicalActiveAgentThursdayAgentStub` or `DEMO_INSTANCE`. Preserves the
 * rule that `server.ts` only exports DO classes + the default fetch
 * handler (an earlier revision v2 runtime fix).
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

export interface MemoryRoutesDeps {
  getActiveStub: () => Promise<AgentThursdayAgentStub>;
}

export async function handleMemoryRoutes(
  request: Request,
  url: URL,
  deps: MemoryRoutesDeps,
): Promise<Response | null> {
  if (url.pathname === "/api/memory" && request.method === "GET") {
    const stub = await deps.getActiveStub();
    const snapshot = await stub.getMemorySnapshot();
    return json(MemorySnapshotSchema.parse(snapshot));
  }
  return null;
}
