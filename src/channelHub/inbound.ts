/**
 * `ChannelHubAgent.ingestInbound` body extracted from
 * `src/channelHub.ts`.
 *
 * `ingestInboundImpl(agent, envelopeRaw, agentthursdayDiscordBotId)` carries the
 * same body the inline `@callable()` method had. The decorator + public
 * method signature stay on `ChannelHubAgent`; only the body delegates
 * here.
 *
 * `env` is `protected` on the Agent base class, so the caller reads
 * `AGENT_THURSDAY_DISCORD_BOT_ID` once (at the @callable wrapper) and passes the
 * value in. Everything else is `agent.sql` (public) + pure parsing.
 *
 * Behavior preserved verbatim: idempotent INSERT OR IGNORE on
 * `(provider, provider_message_id)`, per-conversation pending cap →
 * `deferred`, text/attachments byte clamps, identity / conversation
 * touch UPSERTs, an earlier revision `is_self` policy.
 */

import type { Agent } from "agents";
import {
  ChannelMessageEnvelopeSchema,
  type ChannelInboundResult,
  type ChannelInboxStatus,
} from "../schema";
import {
  PENDING_CAP_PER_CONVERSATION,
  PENDING_INBOX_STATUSES,
  clampRawRef,
  INBOX_TEXT_MAX,
  INBOX_ATTACHMENTS_JSON_MAX,
} from "../channel";

export type ChannelHubInboundHost = Agent<Env, Record<string, never>>;

export async function ingestInboundImpl(
  agent: ChannelHubInboundHost,
  envelopeRaw: unknown,
  agentthursdayDiscordBotId: string | undefined,
): Promise<ChannelInboundResult> {
  const parsed = ChannelMessageEnvelopeSchema.parse(envelopeRaw);
  const now = Date.now();

  // Pending cap check before insert. Avoid bloating the inbox if a single
  // conversation goes wild. New rows over cap are stored as `deferred` —
  // they are visible in the snapshot but are not "received" for routing.
  const pending = Number(
    (agent.sql<{ n: number | bigint }>`
      SELECT COUNT(*) as n FROM channel_inbox
      WHERE conversation_id = ${parsed.conversationId}
        AND status IN (${PENDING_INBOX_STATUSES[0]}, ${PENDING_INBOX_STATUSES[1]}, ${PENDING_INBOX_STATUSES[2]}, ${PENDING_INBOX_STATUSES[3]})
    `)[0]?.n ?? 0,
  );
  const status: ChannelInboxStatus = pending >= PENDING_CAP_PER_CONVERSATION ? "deferred" : "received";

  const candidateId = parsed.id ?? crypto.randomUUID();
  const senderUid = parsed.sender.providerUserId;
  const signalsJson = JSON.stringify(parsed.addressedSignals);
  // cap inbound text and attachments JSON before persist.
  // Prevents a pathological large payload from later memory-resetting
  // any DO that reads the row (snapshot, route, dialog).
  const text = parsed.text.length > INBOX_TEXT_MAX
    ? `${parsed.text.slice(0, INBOX_TEXT_MAX)}…(+${parsed.text.length - INBOX_TEXT_MAX})`
    : parsed.text;
  const attachmentsRaw = JSON.stringify(parsed.attachments);
  const attachmentsJson = attachmentsRaw.length > INBOX_ATTACHMENTS_JSON_MAX
    ? `${attachmentsRaw.slice(0, INBOX_ATTACHMENTS_JSON_MAX)}…(+${attachmentsRaw.length - INBOX_ATTACHMENTS_JSON_MAX})`
    : attachmentsRaw;
  const rawRef = clampRawRef(parsed.rawRef ?? null);
  const receivedAt = parsed.receivedAt ?? now;

  // INSERT OR IGNORE so a concurrent duplicate webhook does not create a
  // second row. The dedup key is the UNIQUE(provider, provider_message_id)
  // constraint declared in onStart.
  agent.sql`
    INSERT OR IGNORE INTO channel_inbox (
      id, provider, conversation_id, provider_message_id,
      sender_provider_user_id, chat_type,
      addressed_to_agent, addressed_signals_json,
      text, attachments_json, raw_ref, status,
      created_at, updated_at
    ) VALUES (
      ${candidateId}, ${parsed.provider}, ${parsed.conversationId}, ${parsed.providerMessageId},
      ${senderUid}, ${parsed.chatType},
      ${parsed.addressedToAgent ? 1 : 0}, ${signalsJson},
      ${text}, ${attachmentsJson}, ${rawRef}, ${status},
      ${receivedAt}, ${now}
    )
  `;

  // Read back the canonical row (either the one we just inserted, or the
  // pre-existing duplicate). If the canonical id matches our candidate,
  // we won the insert.
  const row = agent.sql<{ id: string; status: string }>`
    SELECT id, status FROM channel_inbox
    WHERE provider = ${parsed.provider} AND provider_message_id = ${parsed.providerMessageId}
    LIMIT 1
  `;
  if (row.length === 0) {
    // Should not happen — INSERT OR IGNORE either inserted or the row exists.
    throw new Error("channel_inbox: ingest failed to materialize a row");
  }
  const inserted = row[0].id === candidateId;

  // Touch the conversation row (UPSERT). Capability/policy left empty.
  agent.sql`
    INSERT OR IGNORE INTO channel_conversations (
      conversation_id, provider, chat_type,
      provider_channel_id, provider_thread_id,
      first_seen_at, last_seen_at
    ) VALUES (
      ${parsed.conversationId}, ${parsed.provider}, ${parsed.chatType},
      ${parsed.providerChannelId ?? null}, ${parsed.providerThreadId ?? null},
      ${now}, ${now}
    )
  `;
  // 2026-06-26 — backfill the provider/channel placeholders on a row that was
  // SEEDED ahead of its first inbound (setConversationBinding UPSERTs a row with
  // provider='unknown', provider_channel_id=NULL so a binding can be set before any
  // message arrives). Without this, that pre-bound row never learns which Discord
  // channel it maps to, and every outbound reply fails with
  // `discord:no-target-channel-on-conversation`. COALESCE / CASE only FILL missing
  // placeholders — they never overwrite a value the conversation already has.
  agent.sql`
    UPDATE channel_conversations
    SET last_seen_at = ${now},
        provider = CASE WHEN provider IS NULL OR provider = 'unknown' THEN ${parsed.provider} ELSE provider END,
        chat_type = CASE WHEN chat_type IS NULL OR chat_type = 'unknown' THEN ${parsed.chatType} ELSE chat_type END,
        provider_channel_id = COALESCE(provider_channel_id, ${parsed.providerChannelId ?? null}),
        provider_thread_id = COALESCE(provider_thread_id, ${parsed.providerThreadId ?? null})
    WHERE conversation_id = ${parsed.conversationId}
  `;

  // `is_self=1` only for AgentThursday bot itself (small d / AGENT_THURSDAY_DISCORD_BOT_ID),
  // not for any author with `isBot=true`. Other bots (verifier agentP, helper agentC, future
  // bots) are gated by direct filter (DISCORD_ALLOWED_USERS) + DISCORD_ALLOW_BOTS,
  // not by self-loopback.
  const selfProviderUserId = parsed.provider === "discord"
    ? agentthursdayDiscordBotId ?? null
    : null;
  const isSelfSender = selfProviderUserId != null && senderUid === selfProviderUserId;

  // Touch identity row so we know who has talked to us.
  agent.sql`
    INSERT OR IGNORE INTO channel_identities (
      provider, provider_user_id, display_name, role, is_self, created_at
    ) VALUES (
      ${parsed.provider}, ${senderUid}, ${parsed.sender.displayName ?? null},
      'unknown', ${isSelfSender ? 1 : 0}, ${now}
    )
  `;
  // repair already-existing rows that may have been mis-marked
  // by the previous `parsed.sender.isBot` heuristic. Bounded to the current
  // sender; the broader Discord-wide repair runs once in onStart below.
  agent.sql`
    UPDATE channel_identities
    SET is_self = ${isSelfSender ? 1 : 0}
    WHERE provider = ${parsed.provider} AND provider_user_id = ${senderUid}
  `;

  return { ok: true, inserted, id: row[0].id, status: row[0].status as ChannelInboxStatus };
}
