/**
 *  — BYO Discord bot helpers. Pure parsing + the server-side
 * token validation call (`GET /users/@me`). The token never appears in
 * any return value other than `validateDiscordBotToken`'s pass-through
 * caller; errors carry Discord's status, never the token.
 */

export interface DiscordBotRow {
  bot_id: string;
  token_hint: string;
  username: string;
  label: string | null;
  allowed_channels: string[];
  updated_at: string;
}

/** Internal shape (includes the raw token) — never serialized over HTTP. */
export interface DiscordBotSecretRow {
  bot_id: string;
  token: string;
  allowed_channels: string[];
}

export function tokenHint(token: string): string {
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

export function parseChannelList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const c of input) {
    if (typeof c !== "string") return null;
    const id = c.trim();
    if (!/^\d{5,30}$/.test(id)) return null; // Discord snowflakes are numeric
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * One channel belongs to exactly one bot (same single-owner semantics
 * as conversation binding). Returns the first conflicting channel id,
 * or null when the proposed set is clean. `existing` excludes the bot
 * being upserted (so re-saving the same bot keeps its own channels).
 */
export function findChannelConflict(
  proposed: string[],
  envChannels: string[],
  existing: Array<{ bot_id: string; allowed_channels: string[] }>,
): { channel: string; ownedBy: string } | null {
  for (const ch of proposed) {
    if (envChannels.includes(ch)) return { channel: ch, ownedBy: "env (DISCORD_ALLOWED_CHANNELS)" };
    for (const b of existing) {
      if (b.allowed_channels.includes(ch)) return { channel: ch, ownedBy: b.bot_id };
    }
  }
  return null;
}

/**
 * Validate a bot token against Discord and derive the bot identity.
 * Fail-soft: returns a structured error (with Discord's HTTP status)
 * rather than throwing; the token is never included in the result.
 */
export async function validateDiscordBotToken(
  token: string,
  apiBase: string,
): Promise<{ ok: true; botId: string; username: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, "")}/users/@me`, {
      headers: { "Authorization": `Bot ${token}`, "User-Agent": "agentthursday-discord-bot-setup/1" },
    });
    if (!res.ok) {
      return { ok: false, error: `Discord rejected the token: HTTP ${res.status}` };
    }
    const body = (await res.json()) as { id?: unknown; username?: unknown };
    if (typeof body.id !== "string" || body.id.length === 0) {
      return { ok: false, error: "Discord /users/@me returned no bot id" };
    }
    return {
      ok: true,
      botId: body.id,
      username: typeof body.username === "string" ? body.username : "",
    };
  } catch (e) {
    return { ok: false, error: `validation fetch failed: ${e instanceof Error ? e.message.slice(0, 150) : "error"}` };
  }
}

/**
 * Resolve which stored bot owns a channel (for outbound token pick and
 * ingest allowlist). Linear scan — bot count is operator-scale.
 */
export function botForChannel(
  bots: DiscordBotSecretRow[],
  channelId: string,
): DiscordBotSecretRow | null {
  for (const b of bots) {
    if (b.allowed_channels.includes(channelId)) return b;
  }
  return null;
}
