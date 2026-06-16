import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import type { DiscordGatewayAgent } from "../discordGatewayAgent";

/**
 *  — `/api/discord-gateway/*` HTTP route handling extracted
 * from `server.ts`.
 *
 * Single entry point: `handleDiscordGateway(request, url, deps)`.
 *
 * Behavior-preserving. Each handler is the verbatim body of the
 * original `server.ts` branch, lifted into one dispatch function.
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `DiscordGatewayDeps.getGatewayStub` so this module
 * never imports `env.DiscordGatewayAgent` / `DISCORD_GATEWAY_INSTANCE`.
 *
 * Returns `null` when no `/api/discord-gateway/*` branch matches so
 * `server.ts` can fall through to the remaining `/api/*` handlers.
 *
 * Auth: gated by the `/api/`/`/cli/`/`/demo/` `requireSecret` umbrella
 * in `server.ts`. This handler never re-checks. Status fields never
 * include tokens / shared secret / raw gateway frames.
 *
 * Routes:
 *
 *   /api/discord-gateway/start  POST   start
 *   /api/discord-gateway/stop   POST   stop
 *   /api/discord-gateway/status GET    status
 */

type DiscordGatewayStub = Awaited<ReturnType<typeof getAgentByName<Env, DiscordGatewayAgent>>>;

export interface DiscordGatewayDeps {
  getGatewayStub: () => Promise<DiscordGatewayStub>;
}

export async function handleDiscordGateway(
  request: Request,
  url: URL,
  deps: DiscordGatewayDeps,
): Promise<Response | null> {
  // Discord Gateway DO control surface. Auth-gated by
  // the global `requireSecret` check above. POST /start and /stop are
  // idempotent; GET /status is safe to poll. Status fields never include
  // tokens / shared secret / raw gateway frames.
  if (url.pathname === "/api/discord-gateway/start" && request.method === "POST") {
    const stub = await deps.getGatewayStub();
    const workerOrigin = `${url.protocol}//${url.host}`;
    try {
      const status = await stub.start({ workerOrigin });
      return json(status);
    } catch (e) {
      return json({ error: "start_failed", message: String(e instanceof Error ? e.message : e).slice(0, 300) }, 500);
    }
  }

  if (url.pathname === "/api/discord-gateway/stop" && request.method === "POST") {
    const stub = await deps.getGatewayStub();
    const status = await stub.stop();
    return json(status);
  }

  if (url.pathname === "/api/discord-gateway/status" && request.method === "GET") {
    const stub = await deps.getGatewayStub();
    const status = await stub.getStatus();
    return json(status);
  }

  return null;
}
