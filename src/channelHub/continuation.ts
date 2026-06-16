/**
 *  — ChannelHub multipart continuation merge.
 *
 * When Discord splits an addressed instruction into multiple messages, only
 * the first carries the `<@bot>` mention. Continuation chunks fail the
 * `DISCORD_IGNORE_NO_MENTION` gate in `applyDirectFilters` and are dropped.
 *
 * This helper is invoked from `/api/channel/discord/direct` when the filter
 * rejects with reason `"guild message without @mention"`. It looks up a
 * recent anchor row authored by the same sender in the same conversation —
 * still `received` (not yet routed) and itself addressed-to-agent. If one
 * exists within `windowMs`, the continuation text is appended to the anchor
 * (so `routePending` builds a single merged prompt for `submitTask`) and a
 * marker inbox row is persisted with `status='ignored'` + `route_action='merged'`
 * for audit + idempotency.
 *
 * Safety rails:
 *   - Same provider, conversation, sender required (no cross-thread merge).
 *   - Anchor must itself be `addressed_to_agent=1` AND not already a
 *     continuation (depth cap = 1; merged text only grows on the anchor).
 *   - Anchor must be `status='received'`. If the anchor has already moved
 *     to `processing`/`handled`/`failed`, the merge is rejected with reason
 *     `anchor-not-received`; caller leaves the chunk dropped so we don't
 *     mutate a row whose prompt may already be in flight.
 *   - Time window defaults to 5s, env-overridable per call.
 *   - Continuation text is appended with a visible delimiter so the agent
 *     can see chunk boundaries; total length is clamped to `INBOX_TEXT_MAX`.
 *
 * No new SQL DDL is introduced. The marker row reuses existing columns:
 *   - `status='ignored'`
 *   - `addressed_to_agent=1`
 *   - `addressed_signals_json` contains `"continuation"`
 *   - `route_action='merged'`
 *   - `route_reason='merged-into-anchor:<anchorId>'`
 *   - `handoff_task_id=<anchorId>`  (overload: anchor inbox id, not a task id)
 *
 * `routePending` only picks up `status='received'` rows, so the marker row
 * is never independently routed.
 */

import type {
  ChannelInboxStatus,
  ChannelProvider,
  ChannelChatType,
  ChannelAttachment,
} from "../schema";
import {
  PENDING_CAP_PER_CONVERSATION,
  PENDING_INBOX_STATUSES,
  clampRawRef,
  INBOX_TEXT_MAX,
  INBOX_ATTACHMENTS_JSON_MAX,
} from "../channel";

/**
 * Structural host shape. We only use the `sql` tagged template, so a
 * structural type lets unit tests (smoke scripts) pass an in-memory shim
 * without dragging in the full `Agent<Env, ...>` graph. The value type
 * mirrors the agents-sdk constraint (primitives or null).
 */
export type ChannelHubContinuationHost = {
  sql: <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];
};

export const CHANNEL_CONTINUATION_WINDOW_MS_DEFAULT = 5_000;
/**
 *  — `applyDirectFilters` reject reasons that the route handler
 * should treat as "maybe-a-continuation-chunk; consult the merge path
 * before deciding to drop". The route handler calls `classifyFilterRejection`
 * with `filterRes.reason` to get a structured outcome; eligible reasons
 * carry a flag for whether the allowlist still needs re-checking (because
 * `applyDirectFilters` short-circuited before the allowlist gates).
 *
 * Reasons NOT in this set (self-loopback, `allowBots=none`, allowlist
 * gates, `not configured` denies) are NEVER eligible — those represent
 * "we don't trust this sender at all", so even continuation lookup is
 * skipped to avoid amplifying spam.
 */
export const CONTINUATION_ELIGIBLE_FILTER_REASONS: ReadonlySet<string> = new Set<string>([
  "guild message without @mention",
  "bot-author without mention (allowBots=mentions)",
]);

export type FilterRejectionClassification = {
  eligibleForContinuation: boolean;
  needsAllowlistRecheck: boolean;
};

/**
 * Pure classifier: given an `applyDirectFilters` reject reason, decide
 * whether the route handler should attempt continuation lookup. The
 * `needsAllowlistRecheck` flag is true for reasons that fire BEFORE the
 * allowlist gates inside `applyDirectFilters` (currently just the
 * bot-author no-mention reason). Callers MUST honour that flag — without
 * the re-check, an unallowlisted bot could merge into a victim's anchor.
 */
export function classifyFilterRejection(reason: string): FilterRejectionClassification {
  if (reason === "guild message without @mention") {
    return { eligibleForContinuation: true, needsAllowlistRecheck: false };
  }
  if (reason === "bot-author without mention (allowBots=mentions)") {
    return { eligibleForContinuation: true, needsAllowlistRecheck: true };
  }
  return { eligibleForContinuation: false, needsAllowlistRecheck: false };
}

/**
 *  v2 — first-chunk auto-route is debounced by this many ms when
 * the inserted anchor row is a guild-channel addressed Discord message.
 * The wait gives continuation chunks a window to land into the still-
 * `received` anchor; after the delay fires, `routePending` builds one
 * merged prompt for `submitTask`. Kept short so single-chunk messages
 * still feel responsive; not env-configurable on purpose.
 */
export const CONTINUATION_DEBOUNCE_MS_DEFAULT = 2_000;
export const CONTINUATION_SIGNAL = "continuation";
const MERGE_DELIMITER = "\n\n---continuation---\n";

/**
 *  v2 — pure decision for whether the first-chunk's `routePending`
 * call should be deferred. Only guild-channel addressed Discord messages
 * are vulnerable to the multipart drop, so we limit the wait to that
 * shape; DMs accept all chunks (no mention requirement) and non-Discord
 * providers don't share the filter semantics.
 */
export function shouldDeferRoute(envelope: {
  provider: ChannelProvider;
  chatType: ChannelChatType;
  addressedToAgent: boolean;
}): boolean {
  return envelope.provider === "discord"
    && envelope.chatType !== "dm"
    && envelope.addressedToAgent === true;
}

export type TryIngestContinuationInput = {
  provider: ChannelProvider;
  conversationId: string;
  senderProviderUserId: string;
  senderDisplayName?: string | null;
  chatType: ChannelChatType;
  providerChannelId?: string | null;
  providerThreadId?: string | null;
  continuationProviderMessageId: string;
  continuationText: string;
  attachments?: ChannelAttachment[];
  replyToProviderMessageId?: string | null;
  rawSnippet?: string | null;
  receivedAt?: number;
  windowMs?: number;
};

export type TryIngestContinuationResult = {
  ok: boolean;
  merged: boolean;
  anchorId: string | null;
  anchorProviderMessageId: string | null;
  continuationInboxId: string | null;
  alreadyExisted: boolean;
  totalCharsAfterMerge: number | null;
  mergedSequence: number | null;
  reason: string;
};

type AnchorCandidateRow = {
  id: string;
  provider_message_id: string;
  status: string;
  addressed_signals_json: string;
  text: string;
  created_at: number | bigint;
};

/**
 * Find the most-recent addressed-to-agent anchor in this conversation/sender
 * that is still `received` and not itself a continuation. Returns null if
 * none exists within the window.
 *
 * Selecting in-JS (rather than building a JSON LIKE in SQL) is intentional:
 * the candidate set is bounded by the pending-cap per conversation (defaults
 * to a couple dozen rows), and the JS filter is easier to reason about than
 * a SQLite JSON1 query that may or may not be available.
 */
function findRecentAddressedAnchor(
  agent: ChannelHubContinuationHost,
  input: TryIngestContinuationInput,
  now: number,
): AnchorCandidateRow | null {
  const windowMs = Math.max(0, input.windowMs ?? CHANNEL_CONTINUATION_WINDOW_MS_DEFAULT);
  const earliestAcceptable = now - windowMs;
  const rows = agent.sql<AnchorCandidateRow>`
    SELECT id, provider_message_id, status, addressed_signals_json, text, created_at
    FROM channel_inbox
    WHERE provider = ${input.provider}
      AND conversation_id = ${input.conversationId}
      AND sender_provider_user_id = ${input.senderProviderUserId}
      AND addressed_to_agent = 1
      AND status = 'received'
      AND created_at >= ${earliestAcceptable}
    ORDER BY created_at DESC, id DESC
    LIMIT 5
  `;
  for (const r of rows) {
    let signals: string[] = [];
    try {
      const parsed = JSON.parse(r.addressed_signals_json ?? "[]");
      if (Array.isArray(parsed)) signals = parsed.map(String);
    } catch {
      // malformed JSON — treat as "no signals known"; we'll still
      // consider this row an anchor if other constraints hold.
      signals = [];
    }
    if (!signals.includes(CONTINUATION_SIGNAL)) {
      return r;
    }
  }
  return null;
}

function clampAppendedText(existing: string, appended: string): { merged: string; truncated: boolean } {
  const joined = existing + MERGE_DELIMITER + appended;
  if (joined.length <= INBOX_TEXT_MAX) {
    return { merged: joined, truncated: false };
  }
  const headroom = INBOX_TEXT_MAX - existing.length - MERGE_DELIMITER.length;
  if (headroom <= 0) {
    // anchor is already at/over the cap; we still record a continuation
    // marker but the appended text becomes a single ellipsis pointer.
    const noteOnly = existing + MERGE_DELIMITER + `…(+${appended.length} chars dropped — anchor at cap)`;
    return { merged: noteOnly.slice(0, INBOX_TEXT_MAX), truncated: true };
  }
  const truncatedAppended = `${appended.slice(0, headroom)}…(+${appended.length - headroom})`;
  return { merged: existing + MERGE_DELIMITER + truncatedAppended, truncated: true };
}

function countExistingContinuations(
  agent: ChannelHubContinuationHost,
  anchorId: string,
): number {
  const rows = agent.sql<{ n: number | bigint }>`
    SELECT COUNT(*) AS n FROM channel_inbox
    WHERE handoff_task_id = ${anchorId}
      AND route_action = 'merged'
  `;
  return Number(rows[0]?.n ?? 0);
}

export function tryIngestContinuationImpl(
  agent: ChannelHubContinuationHost,
  input: TryIngestContinuationInput,
): TryIngestContinuationResult {
  const now = input.receivedAt ?? Date.now();

  // Idempotency: if the continuation row already exists (Discord webhook
  // retry or operator replay), report the prior decision without mutating.
  const existing = agent.sql<{
    id: string;
    status: string;
    route_action: string | null;
    route_reason: string | null;
    handoff_task_id: string | null;
  }>`
    SELECT id, status, route_action, route_reason, handoff_task_id
    FROM channel_inbox
    WHERE provider = ${input.provider}
      AND provider_message_id = ${input.continuationProviderMessageId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    const row = existing[0];
    const wasMerged = row.route_action === "merged" && typeof row.handoff_task_id === "string";
    let anchorProviderMessageId: string | null = null;
    if (wasMerged && row.handoff_task_id) {
      const a = agent.sql<{ provider_message_id: string }>`
        SELECT provider_message_id FROM channel_inbox WHERE id = ${row.handoff_task_id} LIMIT 1
      `;
      anchorProviderMessageId = a[0]?.provider_message_id ?? null;
    }
    return {
      ok: true,
      merged: wasMerged,
      anchorId: wasMerged ? row.handoff_task_id : null,
      anchorProviderMessageId,
      continuationInboxId: row.id,
      alreadyExisted: true,
      totalCharsAfterMerge: null,
      mergedSequence: null,
      reason: wasMerged ? "already-merged" : `already-ingested:${row.status}`,
    };
  }

  const anchor = findRecentAddressedAnchor(agent, input, now);
  if (!anchor) {
    return {
      ok: true,
      merged: false,
      anchorId: null,
      anchorProviderMessageId: null,
      continuationInboxId: null,
      alreadyExisted: false,
      totalCharsAfterMerge: null,
      mergedSequence: null,
      reason: "no-recent-anchor",
    };
  }

  // Pending cap still applies to the marker row so a runaway split can't
  // bloat the inbox forever. Mirrors `ingestInboundImpl`.
  const pending = Number(
    (agent.sql<{ n: number | bigint }>`
      SELECT COUNT(*) AS n FROM channel_inbox
      WHERE conversation_id = ${input.conversationId}
        AND status IN (${PENDING_INBOX_STATUSES[0]}, ${PENDING_INBOX_STATUSES[1]}, ${PENDING_INBOX_STATUSES[2]}, ${PENDING_INBOX_STATUSES[3]})
    `)[0]?.n ?? 0,
  );
  const overCap = pending >= PENDING_CAP_PER_CONVERSATION;

  // Clamp the appended text up-front (defensive — caller is expected to
  // hand us already-clamped chunks, but `INBOX_TEXT_MAX` is the contract).
  const chunkClamped = input.continuationText.length > INBOX_TEXT_MAX
    ? `${input.continuationText.slice(0, INBOX_TEXT_MAX)}…(+${input.continuationText.length - INBOX_TEXT_MAX})`
    : input.continuationText;
  const { merged: mergedText, truncated } = clampAppendedText(anchor.text ?? "", chunkClamped);

  const attachmentsRaw = JSON.stringify(input.attachments ?? []);
  const attachmentsJson = attachmentsRaw.length > INBOX_ATTACHMENTS_JSON_MAX
    ? `${attachmentsRaw.slice(0, INBOX_ATTACHMENTS_JSON_MAX)}…(+${attachmentsRaw.length - INBOX_ATTACHMENTS_JSON_MAX})`
    : attachmentsRaw;
  const rawRef = clampRawRef(input.rawSnippet ?? null);
  const candidateId = crypto.randomUUID();
  const signalsJson = JSON.stringify([CONTINUATION_SIGNAL]);
  const markerStatus: ChannelInboxStatus = overCap ? "deferred" : "ignored";
  const routeReason = overCap
    ? `merged-into-anchor:${anchor.id} (deferred: pending cap)`
    : `merged-into-anchor:${anchor.id}`;

  // Persist the continuation marker row. INSERT OR IGNORE so a racing
  // duplicate webhook delivery (provider, provider_message_id) doesn't
  // double-merge.
  agent.sql`
    INSERT OR IGNORE INTO channel_inbox (
      id, provider, conversation_id, provider_message_id,
      sender_provider_user_id, chat_type,
      addressed_to_agent, addressed_signals_json,
      text, attachments_json, raw_ref, status,
      created_at, updated_at,
      route_action, route_reason, routed_at, handoff_task_id
    ) VALUES (
      ${candidateId}, ${input.provider}, ${input.conversationId}, ${input.continuationProviderMessageId},
      ${input.senderProviderUserId}, ${input.chatType},
      1, ${signalsJson},
      ${chunkClamped}, ${attachmentsJson}, ${rawRef}, ${markerStatus},
      ${now}, ${now},
      'merged', ${routeReason}, ${now}, ${anchor.id}
    )
  `;

  // Read back canonical row (we may have lost the INSERT race).
  const persisted = agent.sql<{ id: string }>`
    SELECT id FROM channel_inbox
    WHERE provider = ${input.provider} AND provider_message_id = ${input.continuationProviderMessageId}
    LIMIT 1
  `;
  const continuationInboxId = persisted[0]?.id ?? null;
  if (overCap) {
    return {
      ok: true,
      merged: false,
      anchorId: anchor.id,
      anchorProviderMessageId: anchor.provider_message_id,
      continuationInboxId,
      alreadyExisted: false,
      totalCharsAfterMerge: null,
      mergedSequence: null,
      reason: `pending-cap-${markerStatus}`,
    };
  }

  // Apply the merge to the anchor row. The WHERE guard on `status='received'`
  // is a belt-and-braces check: SQLite within this DO is single-threaded but
  // an `await` between `findRecentAddressedAnchor` and this UPDATE (none in
  // this function) would otherwise admit a race with `routePending`.
  agent.sql`
    UPDATE channel_inbox
    SET text = ${mergedText}, updated_at = ${now}
    WHERE id = ${anchor.id} AND status = 'received'
  `;

  // Re-read to confirm the UPDATE landed.
  const verify = agent.sql<{ status: string; text: string }>`
    SELECT status, text FROM channel_inbox WHERE id = ${anchor.id} LIMIT 1
  `;
  const v = verify[0];
  if (!v || v.status !== "received") {
    // Anchor moved out of `received` between SELECT and UPDATE. The marker
    // row is still recorded so audit can see the dropped chunk; the small
    // operator-facing reason tells trace why.
    return {
      ok: true,
      merged: false,
      anchorId: anchor.id,
      anchorProviderMessageId: anchor.provider_message_id,
      continuationInboxId,
      alreadyExisted: false,
      totalCharsAfterMerge: null,
      mergedSequence: null,
      reason: "anchor-status-moved",
    };
  }

  const seq = countExistingContinuations(agent, anchor.id);
  return {
    ok: true,
    merged: true,
    anchorId: anchor.id,
    anchorProviderMessageId: anchor.provider_message_id,
    continuationInboxId,
    alreadyExisted: false,
    totalCharsAfterMerge: v.text.length,
    mergedSequence: seq,
    reason: truncated ? "merged-truncated" : "merged",
  };
}
