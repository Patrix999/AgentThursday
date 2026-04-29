/**
 * ChannelHub helpers (provider-agnostic; conversation id
 * derivation, raw payload redaction). The actual storage / DO lives in
 * `src/channelHub.ts`. Keep this file pure so we can unit-test paths
 * without DO context if/when a test rig lands.
 */

const RAW_REF_MAX = 200;
const PENDING_CAP_PER_CONVERSATION = 50;

export const CHANNEL_HUB_INSTANCE = "channel-hub";

export const PENDING_INBOX_STATUSES = ["received", "routed", "processing", "deferred"] as const;
export type PendingInboxStatus = typeof PENDING_INBOX_STATUSES[number];

export { RAW_REF_MAX, PENDING_CAP_PER_CONVERSATION };

/**
 * sha256 → first 16 hex chars (64 bits). Enough collision-resistant id
 * for conversation routing — exact prefix tradeoff balances readability
 * with low birthday-collision risk for a single-tenant inbox.
 */
async function sha256short(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Discord guild channel / thread → stable conversation id.
 * Same `(guildId, channelId, threadId)` always produces the same id.
 */
export function conversationIdForDiscordChannel(input: {
  guildId: string;
  channelId: string;
  threadId?: string | null;
}): Promise<string> {
  const t = input.threadId && input.threadId.length > 0 ? input.threadId : "root";
  return sha256short(`discord:channel:${input.guildId}:${input.channelId}:${t}`);
}

/**
 * Discord DM → stable, order-independent conversation id between two users.
 * Sorting the user pair guarantees the same id no matter which side initiates.
 */
export function conversationIdForDiscordDm(input: {
  userId: string;
  botUserId: string;
}): Promise<string> {
  const pair = [input.userId, input.botUserId].sort().join(":");
  return sha256short(`discord:dm:${pair}`);
}

/**
 * Fallback DM id when bot user id is not configured. Discord assigns one
 * stable channel per DM pair so `channelId` alone is canonical. Used by
 *  bridge when `AGENT_THURSDAY_DISCORD_BOT_ID` env var is unset ( §D-19:
 * missing optional bot id should not crash on DM path).
 */
export function conversationIdForDiscordDmByChannel(input: {
  channelId: string;
}): Promise<string> {
  return sha256short(`discord:dm:by-channel:${input.channelId}`);
}

/**
 * Email thread → stable id from the root Message-ID (preferred) or the
 * In-Reply-To header chain. Helper kept here so when email lands the
 * adapter doesn't have to invent the rule.
 */
export function conversationIdForEmailThread(input: {
  rootMessageId?: string | null;
  inReplyTo?: string | null;
  subject?: string | null;
}): Promise<string> {
  const root =
    (input.rootMessageId && input.rootMessageId.length > 0 && input.rootMessageId) ||
    (input.inReplyTo && input.inReplyTo.length > 0 && input.inReplyTo) ||
    (input.subject ?? "");
  return sha256short(`email:thread:${root}`);
}

/**
 * Truncate caller-supplied raw payload reference / dump to `RAW_REF_MAX`
 * characters so a single hostile webhook can't bloat the inbox row size.
 *  §E-16 explicit: P0 stores compact pointer / first 200 chars only.
 */
export function clampRawRef(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw.length <= RAW_REF_MAX) return raw;
  return `${raw.slice(0, RAW_REF_MAX)}…(+${raw.length - RAW_REF_MAX})`;
}
