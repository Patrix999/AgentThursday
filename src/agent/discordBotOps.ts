/**
 * BYO Discord bot registry, owner-scoped. Extracted from the inline
 * `AgentThursdayAgent` @callables (M2, 2026-07-01) so the tenant-isolation SQL routing
 * is unit-testable with a fake sql host — matching `providerCredentialOps`. The
 * @callables keep the token encryption/decryption (`credentialCrypto`) + the
 * `logEvent` calls; this module owns only the SQL routing. Behavior is verbatim.
 */
import type { RequestIdentity } from "./requestIdentity";

/** Tagged-template sql, same shape as `AgentThursdayAgent`'s `this.sql`. */
export type DiscordBotSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

export interface DiscordBotHost {
  sql: DiscordBotSqlTag;
}

export function safeJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** Owner of an existing bot row, or null if none — for the save-conflict guard. */
export function findDiscordBotOwner(host: DiscordBotHost, botId: string): string | null {
  const rows = host.sql<{ owner_user_id: string }>`
    SELECT owner_user_id FROM discord_bot WHERE bot_id = ${botId} LIMIT 1
  `;
  return rows.length > 0 ? rows[0].owner_user_id : null;
}

export function saveDiscordBotRow(host: DiscordBotHost, input: {
  bot_id: string; storedToken: string; hint: string; username: string;
  label: string | null; channelsJson: string; owner: string; now: string;
}): void {
  host.sql`
    INSERT INTO discord_bot (bot_id, token, token_hint, username, label, allowed_channels_json, owner_user_id, created_at, updated_at)
    VALUES (${input.bot_id}, ${input.storedToken}, ${input.hint}, ${input.username}, ${input.label}, ${input.channelsJson}, ${input.owner}, ${input.now}, ${input.now})
    ON CONFLICT(bot_id) DO UPDATE SET
      token = ${input.storedToken},
      token_hint = ${input.hint},
      username = ${input.username},
      label = ${input.label},
      allowed_channels_json = ${input.channelsJson},
      owner_user_id = ${input.owner},
      updated_at = ${input.now}
  `;
}

export type DiscordBotListRow = {
  bot_id: string; token_hint: string; username: string;
  label: string | null; allowed_channels: string[]; updated_at: string;
};

/** Owner-scoped list (scoped user sees only their own; admin/undefined sees all).
 *  Intentionally omits the token — write-only secret. */
export function listDiscordBotRows(host: DiscordBotHost, identity?: RequestIdentity): DiscordBotListRow[] {
  type Row = { bot_id: string; token_hint: string; username: string; label: string | null; allowed_channels_json: string; updated_at: string };
  const rows = identity?.kind === "user"
    ? host.sql<Row>`
        SELECT bot_id, token_hint, username, label, allowed_channels_json, updated_at
        FROM discord_bot WHERE owner_user_id = ${identity.userId} ORDER BY bot_id ASC
      `
    : host.sql<Row>`
        SELECT bot_id, token_hint, username, label, allowed_channels_json, updated_at
        FROM discord_bot ORDER BY bot_id ASC
      `;
  return rows.map((r) => ({
    bot_id: r.bot_id,
    token_hint: r.token_hint,
    username: r.username,
    label: r.label,
    allowed_channels: safeJsonStringArray(r.allowed_channels_json),
    updated_at: r.updated_at,
  }));
}

/** Owner-scoped delete — a scoped user can only delete their own bot. */
export function deleteDiscordBotRow(host: DiscordBotHost, botId: string, identity?: RequestIdentity): void {
  if (identity?.kind === "user") {
    host.sql`DELETE FROM discord_bot WHERE bot_id = ${botId} AND owner_user_id = ${identity.userId}`;
    return;
  }
  host.sql`DELETE FROM discord_bot WHERE bot_id = ${botId}`;
}

export type DiscordBotSecretRow = { bot_id: string; token: string; allowed_channels_json: string };

export function getDiscordBotSecretRows(host: DiscordBotHost): DiscordBotSecretRow[] {
  return host.sql<DiscordBotSecretRow>`
    SELECT bot_id, token, allowed_channels_json FROM discord_bot
  `;
}

export function reencryptDiscordBotTokenRow(host: DiscordBotHost, botId: string, enc: string): void {
  host.sql`UPDATE discord_bot SET token = ${enc} WHERE bot_id = ${botId}`;
}
