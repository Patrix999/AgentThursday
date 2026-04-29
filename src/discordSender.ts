/**
 * Discord REST sender. Mockable via `DISCORD_API_BASE_URL`
 * (defaults to the real Discord API). Returns a sanitized result; never
 * surfaces the bot token or full provider response in errors.
 */

import { sanitizeOutboundError } from "./channelOutbound";

export type DiscordSendInput = {
  channelId: string;             // target Discord channel/thread id
  body: Record<string, unknown>; // message JSON (content + components + ...)
};

export type DiscordSendResult = {
  ok: boolean;
  providerMessageId: string | null;
  error: string | null;
};

export async function sendDiscordMessage(
  env: { DISCORD_BOT_TOKEN?: string; DISCORD_API_BASE_URL?: string },
  input: DiscordSendInput,
): Promise<DiscordSendResult> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, providerMessageId: null, error: "discord:no-bot-token" };
  if (!input.channelId) return { ok: false, providerMessageId: null, error: "discord:no-channel-id" };

  const base = (env.DISCORD_API_BASE_URL ?? "https://discord.com/api/v10").replace(/\/+$/, "");
  const url = `${base}/channels/${encodeURIComponent(input.channelId)}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (AgentThursday, 0.1.0)",
      },
      body: JSON.stringify(input.body),
    });
    if (!res.ok) {
      // Read body but do NOT include the token in any return value. Discord
      // error bodies sometimes echo headers — sanitize broadly.
      let snippet = "";
      try {
        const text = await res.text();
        snippet = text.slice(0, 200);
      } catch { /* ignore */ }
      return {
        ok: false,
        providerMessageId: null,
        error: sanitizeOutboundError(`discord HTTP ${res.status}: ${snippet}`),
      };
    }
    let providerMessageId: string | null = null;
    try {
      const json = await res.json() as { id?: unknown };
      if (typeof json.id === "string") providerMessageId = json.id;
    } catch { /* mock or empty body — accept */ }
    return { ok: true, providerMessageId, error: null };
  } catch (e) {
    return { ok: false, providerMessageId: null, error: sanitizeOutboundError(e) };
  }
}
