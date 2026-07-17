/**
 * ChannelHub helpers (provider-agnostic; conversation id
 * derivation, raw payload redaction). The actual storage / DO lives in
 * `src/channelHub.ts`. Keep this file pure so we can unit-test paths
 * without DO context if/when a test rig lands.
 */

const RAW_REF_MAX = 200;
const PENDING_CAP_PER_CONVERSATION = 50;

// hard caps on inbound text + attachments JSON.
// A pathological webhook (or pasted novel) can otherwise persist a
// row whose later read trips the DO isolate memory limit. The agent
// only ever reads the first couple thousand chars when building the
// task prompt, so a 16k cap is generous.
const INBOX_TEXT_MAX = 16_000;
const INBOX_ATTACHMENTS_JSON_MAX = 16_000;

export const CHANNEL_HUB_INSTANCE = "channel-hub";

export const PENDING_INBOX_STATUSES = ["received", "routed", "processing", "deferred"] as const;
export type PendingInboxStatus = typeof PENDING_INBOX_STATUSES[number];

export { RAW_REF_MAX, PENDING_CAP_PER_CONVERSATION, INBOX_TEXT_MAX, INBOX_ATTACHMENTS_JSON_MAX };

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
  // 2026-06-26: `guildId` is accepted for caller compatibility but DELIBERATELY
  // excluded from the id. Discord channel ids are globally-unique snowflakes, so
  // guildId is redundant (same rationale as `conversationIdForDiscordDmByChannel`).
  // Including it caused DUPLICATE conversations for one channel: the WebSocket
  // ingest path carries the real `guild_id` while REST polling omits it
  // (guildId=null), so the same channel hashed to two different ids across modes —
  // splitting its history + bindings. Excluding guildId makes the id stable across
  // ingest modes. NOTE: this re-keys existing channel conversations once, so any
  // channel→agent binding must be re-set after this ships.
  guildId?: string | null;
  channelId: string;
  threadId?: string | null;
}): Promise<string> {
  const t = input.threadId && input.threadId.length > 0 ? input.threadId : "root";
  return sha256short(`discord:channel:${input.channelId}:${t}`);
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
 * an earlier revision bridge when `AGENT_THURSDAY_DISCORD_BOT_ID` env var is unset (an earlier revision §D-19:
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
 * an earlier revision §E-16 explicit: P0 stores compact pointer / first 200 chars only.
 */
export function clampRawRef(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw.length <= RAW_REF_MAX) return raw;
  return `${raw.slice(0, RAW_REF_MAX)}…(+${raw.length - RAW_REF_MAX})`;
}
