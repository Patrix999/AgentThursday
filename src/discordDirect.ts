/**
 * direct Discord adapter (pure helpers).
 *
 * Cloudflare Worker constraint: no persistent Gateway WebSocket. So this
 * adapter:
 *   1. Receives via Discord **HTTP Interactions** (slash commands + button
 *      clicks) — with Ed25519 signature verification, no `X-AgentThursday-Secret`.
 *   2. Receives normal MESSAGE_CREATE-style events via an auth-gated test
 *      path `POST /api/channel/discord/direct` (same payload shape as 
 *      so future gateway-runners can post the same body).
 *
 * Pure helpers only here (verify / filter / normalize / splitter / button
 * builder / custom_id codec). REST send lives in `src/discordSender.ts`.
 */

import { z } from "zod";
import { conversationIdForDiscordChannel, conversationIdForDiscordDm, conversationIdForDiscordDmByChannel, clampRawRef } from "./channel";
import type { ChannelMessageEnvelope, ChannelApprovalCard, ApprovalScope } from "./schema";

// ── Ed25519 signature verification ─────────────────────────────────────────

/**
 * Verify a Discord interactions payload. Raw body MUST be the unparsed text
 * (Discord signs `timestamp + body`). On any error → false (don't throw).
 */
export async function verifyDiscordSignature(input: {
  rawBody: string;
  signatureHex: string;
  timestamp: string;
  publicKeyHex: string;
}): Promise<boolean> {
  try {
    const pubKey = hexToBytes(input.publicKeyHex);
    const sig = hexToBytes(input.signatureHex);
    if (pubKey.length !== 32 || sig.length !== 64) return false;
    const data = new TextEncoder().encode(input.timestamp + input.rawBody);
    const key = await crypto.subtle.importKey("raw", pubKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ── Filtering policy (Hermes-inspired) ─────────────────────────────────────

export type DirectDiscordConfig = {
  botUserId: string | null;
  applicationId: string | null;
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  ignoreNoMentionInGuild: boolean;
  allowBots: "none" | "mentions" | "all";
  /**
   *  §A-1 conservative defaults: empty allowedUserIds /
   * allowedChannelIds means DENY (not allow). Dev mode bypasses these so
   * local smoke can run without a real allowlist. Reuses 's
   * existing dev escape hatch (`AGENT_THURSDAY_ALLOW_INSECURE_DEV`); semantics are
   * orthogonal to auth (auth still requires `AGENT_THURSDAY_SHARED_SECRET` when set).
   */
  devModeBypass: boolean;
};

export function loadDirectDiscordConfig(env: {
  AGENT_THURSDAY_DISCORD_BOT_ID?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_ALLOWED_USERS?: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  DISCORD_IGNORE_NO_MENTION?: string;
  DISCORD_ALLOW_BOTS?: string;
}): DirectDiscordConfig {
  return {
    botUserId: env.AGENT_THURSDAY_DISCORD_BOT_ID || null,
    applicationId: env.DISCORD_APPLICATION_ID || null,
    allowedUserIds: parseCsvSet(env.DISCORD_ALLOWED_USERS),
    allowedChannelIds: parseCsvSet(env.DISCORD_ALLOWED_CHANNELS),
    // Default true per Card §A-1 / Hermes ref
    ignoreNoMentionInGuild: (env.DISCORD_IGNORE_NO_MENTION ?? "true").toLowerCase() !== "false",
    allowBots: (env.DISCORD_ALLOW_BOTS ?? "none") === "all"
      ? "all"
      : (env.DISCORD_ALLOW_BOTS === "mentions" ? "mentions" : "none"),
    devModeBypass: env.AGENT_THURSDAY_ALLOW_INSECURE_DEV === "true",
  };
}

function parseCsvSet(s: string | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(/[,\s]+/).map(x => x.trim()).filter(x => x.length > 0));
}

/**
 * Apply Hermes-style filter pipeline to a normalized event before
 * deciding whether to ingest it. Returns either `{ accept: true }` or
 * `{ accept: false, reason }`.
 */
export type DirectFilterInput = {
  authorId: string;
  authorIsBot: boolean;
  isDm: boolean;
  channelId: string;
  mentionsBot: boolean;
  mentionedUserIds: string[]; // all users mentioned in the message
};

export type DirectFilterResult =
  | { accept: true }
  | { accept: false; reason: string };

export function applyDirectFilters(input: DirectFilterInput, cfg: DirectDiscordConfig): DirectFilterResult {
  // Self-loopback (we never ingest our own bot messages)
  if (cfg.botUserId && input.authorId === cfg.botUserId) {
    return { accept: false, reason: "self-loopback" };
  }
  // Bot-author policy
  if (input.authorIsBot) {
    if (cfg.allowBots === "none") return { accept: false, reason: "bot-author (allowBots=none)" };
    if (cfg.allowBots === "mentions" && !input.mentionsBot) {
      return { accept: false, reason: "bot-author without mention (allowBots=mentions)" };
    }
  }
  // Card §A-1 conservative defaults: empty allowlist means DENY in production.
  // Dev mode (AGENT_THURSDAY_ALLOW_INSECURE_DEV=true) bypasses these so smoke testing
  // works without a real allowlist.
  if (cfg.allowedUserIds.size === 0) {
    if (!cfg.devModeBypass) {
      return {
        accept: false,
        reason: "DISCORD_ALLOWED_USERS not configured (production deny; set the var or enable AGENT_THURSDAY_ALLOW_INSECURE_DEV)",
      };
    }
    // dev mode: allow regardless of empty allowlist
  } else if (!cfg.allowedUserIds.has(input.authorId)) {
    return { accept: false, reason: "user not in DISCORD_ALLOWED_USERS" };
  }
  // Channel allowlist applies only to non-DM traffic. DMs are always
  // 1-on-1 and rely on the user allowlist; "broad public guild traffic"
  // (Card §A-1) is the explicit risk this gate addresses.
  if (!input.isDm) {
    if (cfg.allowedChannelIds.size === 0) {
      if (!cfg.devModeBypass) {
        return {
          accept: false,
          reason: "DISCORD_ALLOWED_CHANNELS not configured (production deny for guild traffic; set the var or enable AGENT_THURSDAY_ALLOW_INSECURE_DEV)",
        };
      }
      // dev mode: allow guild traffic without channel allowlist
    } else if (!cfg.allowedChannelIds.has(input.channelId)) {
      return { accept: false, reason: "channel not in DISCORD_ALLOWED_CHANNELS" };
    }
  }
  // Multi-bot scenario: another bot is mentioned but not us → don't steal
  if (cfg.botUserId && input.mentionedUserIds.length > 0 && !input.mentionsBot) {
    // Has mentions but not us — this might be aimed at another bot/user
    // We DO ingest if it's a DM (DM is always for us) or no other bot is involved.
    // Conservative: only ignore in guild channels where some user was mentioned.
    if (!input.isDm) {
      // We can't reliably tell from the event whether the mentioned user is a bot
      // without an extra lookup; the bridge can pass `mentionedBotIds` to refine.
      // For v1 we let it through and let the @mention requirement (below) decide.
    }
  }
  // Guild channels require @mention unless explicitly opted out
  if (!input.isDm && cfg.ignoreNoMentionInGuild && !input.mentionsBot) {
    return { accept: false, reason: "guild message without @mention" };
  }
  return { accept: true };
}

// ── Inbound interaction normalization ──────────────────────────────────────

/**
 * Discord HTTP Interaction shape (subset we care about for v1).
 * type 1 = PING, 2 = APPLICATION_COMMAND, 3 = MESSAGE_COMPONENT.
 */
export const DiscordInteractionSchema = z.object({
  id: z.string(),
  application_id: z.string().optional(),
  type: z.number().int(),
  data: z.unknown().optional(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  channel: z.object({
    id: z.string().optional(),
    type: z.number().int().optional(),
  }).optional(),
  member: z.object({
    user: z.object({
      id: z.string(),
      username: z.string().optional(),
      bot: z.boolean().optional(),
      global_name: z.string().nullable().optional(),
    }).optional(),
  }).optional(),
  user: z.object({
    id: z.string(),
    username: z.string().optional(),
    bot: z.boolean().optional(),
    global_name: z.string().nullable().optional(),
  }).optional(),
  message: z.object({
    id: z.string().optional(),
  }).optional(),
  token: z.string(),
  version: z.number().int().optional(),
});
export type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;

/**
 * Pull the slash-command text the user typed. Returns null if this isn't
 * a slash command we handle. v1 supports `/ask <prompt>` and `/agent-thursday <prompt>`.
 */
export function extractSlashPrompt(interaction: DiscordInteraction): { command: string; prompt: string } | null {
  if (interaction.type !== 2) return null;
  const data = interaction.data as { name?: string; options?: Array<{ name?: string; value?: unknown }> } | undefined;
  if (!data?.name) return null;
  const supported = new Set(["ask", "agent-thursday"]);
  if (!supported.has(data.name)) return null;
  const promptOpt = data.options?.find(o => o.name === "prompt" || o.name === "text" || o.name === "message");
  const value = promptOpt?.value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return { command: data.name, prompt: value.trim() };
}

/**
 * Normalize a slash-command interaction into the ChannelHub envelope.
 * The slash command implies addressed (the user explicitly summoned us).
 */
export async function normalizeSlashInteraction(
  interaction: DiscordInteraction,
  prompt: string,
  cfg: DirectDiscordConfig,
): Promise<ChannelMessageEnvelope> {
  const author = interaction.member?.user ?? interaction.user;
  if (!author) throw new Error("discord:interaction-missing-user");
  const channelId = interaction.channel_id ?? interaction.channel?.id ?? "";
  const isDm = !interaction.guild_id;
  const conversationId = isDm
    ? cfg.botUserId
      ? await conversationIdForDiscordDm({ userId: author.id, botUserId: cfg.botUserId })
      : await conversationIdForDiscordDmByChannel({ channelId })
    : await conversationIdForDiscordChannel({
        guildId: interaction.guild_id ?? "no-guild",
        channelId,
        threadId: null,
      });
  return {
    provider: "discord",
    providerMessageId: interaction.id, // interaction id is unique; idempotent
    providerThreadId: null,
    providerChannelId: channelId,
    conversationId,
    chatType: isDm ? "dm" : "channel",
    sender: {
      providerUserId: author.id,
      displayName: author.global_name ?? author.username ?? null,
      isBot: author.bot ?? false,
    },
    addressedToAgent: true,
    addressedSignals: isDm ? ["dm", "slash"] : ["mention", "slash"],
    text: prompt,
    attachments: [],
    replyToProviderMessageId: null,
    rawRef: clampRawRef(`slash:${interaction.id}`),
    receivedAt: Date.now(),
  };
}

// ── Approval button custom_id codec ────────────────────────────────────────

/**
 * Encode/decode approval button custom_ids. Discord limits custom_id to 100
 * chars; our format is `apr:<approvalId>:<scope>:<hash12>` ≈ 60 chars.
 * Hash prefix is the first 12 chars of the approval's payload hash — used
 * server-side as the `payloadHashEcho` for `resolveApproval`.
 */
export function encodeApprovalCustomId(input: {
  approvalId: string;
  scope: ApprovalScope;
  payloadHash: string;
}): string {
  return `apr:${input.approvalId}:${input.scope}:${input.payloadHash.slice(0, 12)}`;
}

export function decodeApprovalCustomId(customId: string): {
  approvalId: string;
  scope: ApprovalScope;
  payloadHashPrefix: string;
} | null {
  const m = customId.match(/^apr:([^:]+):(once|session|always|deny):([0-9a-f]{12})$/);
  if (!m) return null;
  return { approvalId: m[1], scope: m[2] as ApprovalScope, payloadHashPrefix: m[3] };
}

// ── Outbound build helpers ─────────────────────────────────────────────────

const DISCORD_MSG_LIMIT = 2000;
const SAFE_LIMIT = 1900; // headroom

/**
 * Split a long text into chunks ≤ 2000 chars. Tries to break on the last
 * blank line / newline before the limit. Code-fence safety: if a chunk
 * leaves an unclosed ``` fence, append ``` to close and prepend ``` to the
 * next chunk. Per Card §C-4 / Hermes ref.
 */
export function splitForDiscord2000(text: string): string[] {
  if (text.length <= SAFE_LIMIT) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > SAFE_LIMIT) {
    let cut = remaining.lastIndexOf("\n\n", SAFE_LIMIT);
    if (cut < 200) cut = remaining.lastIndexOf("\n", SAFE_LIMIT);
    if (cut < 200) cut = SAFE_LIMIT;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  // Code-fence balancing pass
  let openFenceLang: string | null = null;
  return parts.map((part) => {
    let chunk = part;
    if (openFenceLang !== null) chunk = `\`\`\`${openFenceLang}\n${chunk}`;
    const fenceMatches = chunk.matchAll(/```(\w*)/g);
    let newOpen: string | null = null;
    for (const m of fenceMatches) {
      newOpen = newOpen === null ? (m[1] || "") : null;
    }
    if (newOpen !== null) chunk = `${chunk}\n\`\`\``;
    openFenceLang = newOpen;
    return chunk;
  });
}

/**
 * Build the Discord REST POST body for a text message.
 */
export function buildDiscordTextSendBody(input: {
  text: string;
  replyToProviderMessageId?: string | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: input.text,
    // Conservative allowed_mentions: don't ping everyone; only reply target
    allowed_mentions: { parse: [], replied_user: false },
  };
  if (input.replyToProviderMessageId) {
    body.message_reference = { message_id: input.replyToProviderMessageId };
  }
  return body;
}

/**
 * Build the Discord REST POST body for an approval card with button row.
 * Always-allow button is omitted when `card.alwaysAllowEnabled === false`.
 */
export function buildDiscordApprovalSendBody(input: {
  text: string;
  card: ChannelApprovalCard;
  replyToProviderMessageId?: string | null;
}): Record<string, unknown> {
  // Discord button styles: 1=primary 2=secondary 3=success 4=danger
  const btn = (label: string, scope: ApprovalScope, style: number) => ({
    type: 2,
    label,
    style,
    custom_id: encodeApprovalCustomId({
      approvalId: input.card.id,
      scope,
      payloadHash: input.card.payloadHash,
    }),
  });
  const components: Array<Record<string, unknown>> = [
    btn("Allow Once", "once", 3),
    btn("Allow Session", "session", 2),
  ];
  if (input.card.alwaysAllowEnabled) {
    components.push(btn("Always Allow", "always", 1));
  }
  components.push(btn("Deny", "deny", 4));
  const body: Record<string, unknown> = {
    content: input.text,
    components: [{ type: 1, components }],
    allowed_mentions: { parse: [], replied_user: false },
  };
  if (input.replyToProviderMessageId) {
    body.message_reference = { message_id: input.replyToProviderMessageId };
  }
  return body;
}
