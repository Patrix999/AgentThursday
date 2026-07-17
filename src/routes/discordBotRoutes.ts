/**
 * BYO Discord bot config. POST validates the token against Discord
 * (`/users/@me`) server-side and derives `bot_id` + username; the token is
 * write-only from then on. One channel belongs to exactly one bot (env channels
 * included).
 *
 * M1 (2026-07-01) — extracted verbatim from the `server.ts` inline fetch handler
 * into a route module (same `handleXRoutes(request, url, deps) → Response|null`
 * shape as the sibling route modules). Auth stays the `/api/*` umbrella gate in
 * the composition root.
 */
import type { getAgentByName } from "agents";
import type { AgentThursdayAgent } from "../server";
import type { RequestIdentity } from "../agent/requestIdentity";
import { parseChannelList, validateDiscordBotToken, findChannelConflict } from "../discordBotRegistry";

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

function botJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export interface DiscordBotRoutesDeps {
  env: Env;
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  /** gateway-verified tenant identity (admin when header absent). */
  identity: RequestIdentity;
}

export async function handleDiscordBotRoutes(
  request: Request,
  url: URL,
  deps: DiscordBotRoutesDeps,
): Promise<Response | null> {
  const { env, identity, getRegistryStub } = deps;
  if (url.pathname === "/api/channel/discord/bots") {
    const registry = await getRegistryStub();
    if (request.method === "GET") {
      return botJson({ ok: true, bots: await registry.listDiscordBots(identity) });
    }
    if (request.method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = (await request.json()) as Record<string, unknown>; }
      catch { return botJson({ ok: false, code: "invalid_json" }, 400); }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token.length === 0) return botJson({ ok: false, code: "missing_token" }, 400);
      const channels = parseChannelList(body.allowed_channels);
      if (channels === null || channels.length === 0) {
        return botJson({ ok: false, code: "invalid_channels", message: "allowed_channels must be a non-empty array of numeric Discord channel ids" }, 400);
      }
      const apiBase = (env as { DISCORD_API_BASE_URL?: string }).DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
      const v = await validateDiscordBotToken(token, apiBase);
      if (!v.ok) return botJson({ ok: false, code: "token_rejected", message: v.error }, 400);
      const envChannels = ((env as { DISCORD_ALLOWED_CHANNELS?: string }).DISCORD_ALLOWED_CHANNELS ?? "")
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      // conflict check is scoped to the caller's own bots
      // (admin sees all). env channels remain a global backstop.
      const others = (await registry.listDiscordBots(identity)).filter((b) => b.bot_id !== v.botId);
      const conflict = findChannelConflict(channels, envChannels, others);
      if (conflict !== null) {
        return botJson({ ok: false, code: "channel_conflict", message: `channel ${conflict.channel} is already served by ${conflict.ownedBy}` }, 409);
      }
      const label = typeof body.label === "string" ? body.label : null;
      const saved = await registry.saveDiscordBot({
        bot_id: v.botId, token, username: v.username, label, allowed_channels: channels,
      }, identity);
      if (!saved.ok) {
        return botJson({ ok: false, code: saved.code ?? "save_failed", message: "this bot is registered to another account" }, 409);
      }
      return botJson({ ok: true, bot_id: saved.bot_id, username: v.username, token_hint: saved.token_hint, allowed_channels: channels }, 201);
    }
  }
  const m = url.pathname.match(/^\/api\/channel\/discord\/bots\/(\d{5,30})$/);
  if (m !== null && request.method === "DELETE") {
    const registry = await getRegistryStub();
    await registry.deleteDiscordBot({ bot_id: m[1] }, identity);
    return botJson({ ok: true, bot_id: m[1] });
  }
  return null;
}
