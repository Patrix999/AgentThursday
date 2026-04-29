/**
 * Discord/OpenClaw bridge inbound adapter.
 *
 * Accepts a narrow, OpenClaw-friendly Discord payload (NOT raw Discord JSON
 * as our canonical schema), normalizes it into `ChannelMessageEnvelope`, and
 * computes addressed signals before persistence. Per  §A-3, raw
 * Discord JSON is not the contract — only this documented shape.
 *
 * What this file does NOT do:
 *  - direct Discord gateway / webhook signature verification ( §F)
 *  - routing to AgentThursdayAgent ()
 *  - outbound delivery ()
 */

import { z } from "zod";
import {
  conversationIdForDiscordChannel,
  conversationIdForDiscordDm,
  conversationIdForDiscordDmByChannel,
  clampRawRef,
} from "./channel";
import type {
  ChannelAttachment,
  ChannelChatType,
  ChannelMessageEnvelope,
} from "./schema";

/**
 * The contract OpenClaw must produce. Documented + zod-validated so a drift
 * on the bridge side is visible at the AgentThursday boundary, not silently swallowed.
 */
export const OpenClawDiscordInboundSchema = z.object({
  // Identity (Discord ids — keep as opaque strings)
  guildId: z.string().nullable().optional(),
  channelId: z.string().min(1),
  threadId: z.string().nullable().optional(),
  messageId: z.string().min(1),
  replyToMessageId: z.string().nullable().optional(),

  // Sender
  authorId: z.string().min(1),
  authorDisplayName: z.string().nullable().optional(),
  authorIsBot: z.boolean().optional(),

  // Content
  content: z.string().default(""),
  attachments: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    url: z.string().optional(),
    contentType: z.string().optional(),
    size: z.number().int().optional(),
  })).optional(),

  // Bridge-supplied addressing hints (avoid AgentThursday doing Discord-specific
  // mention parsing where the bridge already knows). All optional.
  isDm: z.boolean().optional(),
  chatType: z.enum(["dm", "group", "channel"]).optional(),
  mentionsBot: z.boolean().optional(),
  replyToBot: z.boolean().optional(),

  // Optional debug pointer; clamped to RAW_REF_MAX before storage.
  rawSnippet: z.string().optional(),
});
export type OpenClawDiscordInbound = z.infer<typeof OpenClawDiscordInboundSchema>;

/**
 * Pick the chat type, preferring an explicit bridge value, then `isDm`,
 * then guild presence. Group is not auto-detected — bridge must mark it.
 */
function deriveChatType(input: OpenClawDiscordInbound): ChannelChatType {
  if (input.chatType === "dm") return "dm";
  if (input.chatType === "group") return "group";
  if (input.chatType === "channel") return "channel";
  if (input.isDm === true) return "dm";
  if (input.guildId == null) return "dm"; // no guild → must be DM
  return "channel";
}

async function deriveConversationId(
  input: OpenClawDiscordInbound,
  chatType: ChannelChatType,
  botId: string | null,
): Promise<string> {
  if (chatType === "dm") {
    if (botId) {
      return conversationIdForDiscordDm({ userId: input.authorId, botUserId: botId });
    }
    // §D-19: missing bot id should not crash; channel-based fallback is
    // canonical for Discord DM (one channel per DM pair).
    return conversationIdForDiscordDmByChannel({ channelId: input.channelId });
  }
  // channel or group — both keyed by guild + channel + (optional) thread
  return conversationIdForDiscordChannel({
    guildId: input.guildId ?? "no-guild",
    channelId: input.channelId,
    threadId: input.threadId ?? null,
  });
}

/**
 * Compute `addressedToAgent` + signal labels. P0 signals:
 *   - "dm": chatType is dm
 *   - "mention": bridge says so OR content contains `<@${botId}>` (or `<@!id>`)
 *   - "reply-to-agent": bridge passes `replyToBot:true`
 * Casual chatter without any of the above ⇒ addressedToAgent:false.
 */
function deriveAddressing(
  input: OpenClawDiscordInbound,
  chatType: ChannelChatType,
  botId: string | null,
): { addressedToAgent: boolean; addressedSignals: string[] } {
  const signals: string[] = [];

  if (chatType === "dm") signals.push("dm");

  // mention: prefer bridge flag; else best-effort regex with botId
  let mentioned = input.mentionsBot === true;
  if (!mentioned && botId) {
    // Discord mention shape: <@123> (user) or <@!123> (legacy nickname).
    const escaped = botId.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const re = new RegExp(`<@!?${escaped}>`);
    if (re.test(input.content)) mentioned = true;
  }
  if (mentioned) signals.push("mention");

  if (input.replyToBot === true) signals.push("reply-to-agent");

  return { addressedToAgent: signals.length > 0, addressedSignals: signals };
}

function normalizeAttachments(input: OpenClawDiscordInbound): ChannelAttachment[] {
  return (input.attachments ?? []).map((a) => ({
    id: a.id,
    kind: classifyAttachmentKind(a.contentType, a.name),
    url: a.url,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
  }));
}

function classifyAttachmentKind(
  contentType: string | undefined,
  name: string | undefined,
): ChannelAttachment["kind"] {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("yaml")) return "file";
  // fallback by extension
  const n = (name ?? "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) return "image";
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(n)) return "audio";
  if (/\.(mp4|mov|webm|mkv)$/.test(n)) return "video";
  if (/\.(txt|md|json|yaml|yml|log|csv|ts|tsx|js|jsx|py|rs|go|java|rb)$/.test(n)) return "file";
  if (n) return "file";
  return "unknown";
}

/**
 * Normalize an OpenClaw Discord payload into the  envelope.
 * Bot id may be null (env unset); §D-19 guarantees graceful behavior.
 */
export async function normalizeOpenClawPayload(
  input: OpenClawDiscordInbound,
  env: { AGENT_THURSDAY_DISCORD_BOT_ID?: string },
): Promise<ChannelMessageEnvelope> {
  const botId = env.AGENT_THURSDAY_DISCORD_BOT_ID && env.AGENT_THURSDAY_DISCORD_BOT_ID.length > 0
    ? env.AGENT_THURSDAY_DISCORD_BOT_ID
    : null;

  const chatType = deriveChatType(input);
  const conversationId = await deriveConversationId(input, chatType, botId);
  const { addressedToAgent, addressedSignals } = deriveAddressing(input, chatType, botId);

  return {
    provider: "discord",
    providerMessageId: input.messageId,
    providerThreadId: input.threadId ?? null,
    providerChannelId: input.channelId,
    conversationId,
    chatType,
    sender: {
      providerUserId: input.authorId,
      displayName: input.authorDisplayName ?? null,
      isBot: input.authorIsBot ?? false,
    },
    addressedToAgent,
    addressedSignals,
    text: input.content,
    attachments: normalizeAttachments(input),
    replyToProviderMessageId: input.replyToMessageId ?? null,
    rawRef: clampRawRef(input.rawSnippet ?? null),
    receivedAt: Date.now(),
  };
}
