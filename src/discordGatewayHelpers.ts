/**
 * pure helpers for the Cloudflare-native Discord Gateway DO.
 *
 * Worker-safe duplicate of `scripts/discord-gateway-runner-helpers.ts`. The
 * worker tsconfig (`tsconfig.json`) only includes `src/**`; the host-side
 * runner's helpers live under `scripts/` and can't be imported directly.
 * Functions are byte-identical to the host helpers; if either side changes,
 * keep both in sync until consolidation.  §B endorses this temporary
 * duplication while the host runner remains the documented fallback.
 *
 * No I/O here. Pure helpers so dry-run, self-check, and the live DO all
 * exercise the same conversion path the live Gateway would.
 */

export type DiscordMessageAuthor = {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
};

export type DiscordAttachment = {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
};

export type DiscordMessageCreate = {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  author: DiscordMessageAuthor;
  content?: string;
  type?: number;
  timestamp?: string;
  mentions?: DiscordMessageAuthor[];
  attachments?: DiscordAttachment[];
  message_reference?: { message_id?: string | null; channel_id?: string | null; guild_id?: string | null };
  //  — Discord MESSAGE_CREATE for type=19 (reply) carries the
  // referenced message inline. We only need the original author's id so
  // we can flag `replyToBot` for the inbound filter.
  referenced_message?: {
    id?: string | null;
    author?: { id?: string | null; bot?: boolean | null } | null;
  } | null;
  __thread_id_hint?: string | null;
};

export type DirectIngestPayload = {
  guildId?: string | null;
  channelId: string;
  threadId?: string | null;
  messageId: string;
  replyToMessageId?: string | null;
  authorId: string;
  authorDisplayName?: string | null;
  authorIsBot?: boolean;
  content: string;
  attachments?: Array<{
    id: string;
    name?: string;
    url?: string;
    contentType?: string;
    size?: number;
  }>;
  isDm?: boolean;
  //  — explicit chatType companion to `isDm`. Polling REST
  // doesn't carry `guild_id`, so downstream sites that re-derive
  // "is this a DM?" from `guildId == null` would otherwise un-do
  // the `isDmOverride: false`  set. Emitting `chatType`
  // alongside lets `/api/channel/discord/direct` filter and
  // `discordBridge.deriveChatType` honour the caller's explicit
  // classification without falling back to the guild-id heuristic.
  chatType?: "dm" | "group" | "channel";
  mentionsBot?: boolean;
  //  — true when this is a reply (type=19) whose referenced
  // message was authored by the agentthursday bot. Lets the direct filter and
  // `deriveAddressing` recognise reply-to-agent follow-ups as
  // addressed even without an explicit `<@bot>` mention.
  replyToBot?: boolean;
  rawSnippet?: string;
};

const DISCORD_MSG_TYPE_DEFAULT = 0;
const DISCORD_MSG_TYPE_REPLY = 19;

export function shouldForwardEvent(event: DiscordMessageCreate, botUserId: string): { forward: boolean; reason?: string } {
  if (event.type !== undefined && event.type !== DISCORD_MSG_TYPE_DEFAULT && event.type !== DISCORD_MSG_TYPE_REPLY) {
    return { forward: false, reason: `system message type ${event.type}` };
  }
  if (event.author?.id === botUserId) {
    return { forward: false, reason: "self-authored" };
  }
  return { forward: true };
}

export function eventToDirectPayload(
  event: DiscordMessageCreate,
  botUserId: string,
  opts?: { isDmOverride?: boolean },
): DirectIngestPayload {
  //  — Discord Gateway WebSocket frames carry `guild_id` for
  // guild messages, so `!event.guild_id` is a reliable DM detector
  // there. The REST `GET /channels/{id}/messages` (polling path) does
  // NOT include `guild_id`, so the same heuristic mistakes guild
  // messages for DMs, bypasses `DISCORD_IGNORE_NO_MENTION`, and lets
  // unrelated channel chatter route through. Callers that already
  // know the message is from a guild channel (the polling sweep
  // iterating `DISCORD_ALLOWED_CHANNELS`) pass `isDmOverride: false`
  // to short-circuit the heuristic. True DM polling, if we ever add
  // it, would explicitly pass `true`.
  const isDm = opts?.isDmOverride ?? !event.guild_id;
  const mentionsBot = (event.mentions ?? []).some((m) => m.id === botUserId);
  //  — reply (type=19) with referenced_message.author == bot.
  // Discord delivers `referenced_message` inline on the MESSAGE_CREATE,
  // so this is the cheapest signal we have without an extra REST fetch.
  const replyToBot = event.referenced_message?.author?.id === botUserId;
  const author = event.author;
  const attachments = (event.attachments ?? []).map((a) => ({
    id: a.id,
    name: a.filename,
    url: a.url,
    contentType: a.content_type,
    size: a.size,
  }));
  const rawSnippet = JSON.stringify({
    id: event.id,
    type: event.type,
    channel_id: event.channel_id,
    guild_id: event.guild_id ?? null,
    author_id: author?.id,
    content_chars: (event.content ?? "").length,
    mentions: (event.mentions ?? []).length,
    attachments: (event.attachments ?? []).length,
  }).slice(0, 200);

  return {
    guildId: event.guild_id ?? null,
    channelId: event.channel_id,
    threadId: event.__thread_id_hint ?? null,
    messageId: event.id,
    replyToMessageId: event.message_reference?.message_id ?? null,
    authorId: author.id,
    authorDisplayName: author.global_name ?? author.username ?? null,
    authorIsBot: author.bot ?? false,
    content: event.content ?? "",
    attachments,
    isDm,
    //  — explicit chatType paired with `isDm`. Without
    // this field, downstream `/api/channel/discord/direct` filter
    // and `discordBridge.deriveChatType()` would still re-derive
    // DM-ness from `guildId == null` and undo the  fix on
    // the polling REST path (which omits guild_id).
    chatType: isDm ? "dm" : "channel",
    mentionsBot,
    replyToBot,
    rawSnippet,
  };
}

export const DISCORD_INTENT = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

export function buildIntentsBitfield(opts: {
  guilds?: boolean;
  guildMessages?: boolean;
  directMessages?: boolean;
  messageContent?: boolean;
}): number {
  let bits = 0;
  if (opts.guilds !== false) bits |= DISCORD_INTENT.GUILDS;
  if (opts.guildMessages !== false) bits |= DISCORD_INTENT.GUILD_MESSAGES;
  if (opts.directMessages !== false) bits |= DISCORD_INTENT.DIRECT_MESSAGES;
  if (opts.messageContent !== false) bits |= DISCORD_INTENT.MESSAGE_CONTENT;
  return bits;
}

export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function nextBackoffMs(attempt: number): number {
  const idx = Math.min(Math.max(0, attempt), RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[idx];
}
