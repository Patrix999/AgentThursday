/**
 * channel route policy.  split the active-task case.
 *
 * Pure function: takes an inbox row + minimal context and returns a
 * `ChannelRouteDecision`. No SQL, no RPC — keeps the policy testable and
 * makes it easy to swap rules later without touching ChannelHub.
 *
 * P0 policy (per  §A-4 +  §B-2):
 *   - DM/mention/reply from trusted + agent idle      → process
 *   - DM/mention/reply from trusted + agent BUSY      → busy-skip
 *     (DO NOT consume the row — keep status='received' so a later route
 *      attempt picks it up.  invariant: busy means do not consume
 *      the user's message.)
 *   - addressed but sender role=unknown               → wait (consumes;
 *     we need explicit human clarification before acting)
 *   - text empty + attachments only                   → wait
 *   - sender = self / loopback                        → ignore
 *   - everything else (casual chatter)                → ignore
 *
 * `memoryPolicy` is left at "none" by default — channel messages are NOT
 * memory candidates (review notes §4 +  SOUL prompt). The agent
 * itself decides to remember after a turn.
 */

import type { ChannelInboxItem, ChannelRouteDecision } from "./schema";

export type RouteContext = {
  /** Caller-supplied: is AgentThursdayAgent already mid-task and unable to accept a new submit? */
  activeTaskBusy: boolean;
  /** Caller-supplied: known role for this provider user, default "unknown". */
  senderRole?: "self" | "trusted" | "unknown";
};

export function decideRoute(row: ChannelInboxItem, ctx: RouteContext): ChannelRouteDecision {
  const senderRole = ctx.senderRole ?? "unknown";
  const signals = new Set(row.addressedSignals);

  // 1. Casual chatter without any addressed signal → ignore. Card §A-4.
  if (!row.addressedToAgent) {
    return {
      action: "ignore",
      reason: "not addressed (no dm/mention/reply signal)",
      memoryPolicy: "none",
    };
  }

  // 2. Sender from agent itself / loops back → ignore to break the loop.
  if (senderRole === "self") {
    return { action: "ignore", reason: "loopback from self", memoryPolicy: "none" };
  }

  // 3. Attachment-only message with no text → wait for clarification.
  if (row.text.trim().length === 0 && row.attachments.length > 0) {
    return {
      action: "wait",
      reason: "attachment-only message; cannot act without instruction text",
      memoryPolicy: "none",
    };
  }

  // 4. Unknown sender with an addressed signal → wait + escalate via reason.
  // Conservative: don't act on instructions from anyone we can't identify.
  // (Evaluated BEFORE the busy guard so unknown-sender rows still get
  // consumed to `deferred` even when the agent happens to be busy — they
  // need human clarification regardless of agent state.)
  if (senderRole === "unknown") {
    const why = signals.has("dm") ? "dm" : signals.has("mention") ? "mention" : "reply";
    return {
      action: "wait",
      reason: `addressed-by ${why} from unknown sender; needs human clarification before acting`,
      memoryPolicy: "none",
    };
  }

  // 5. Trusted + addressed + agent busy → busy-skip.  §B invariant:
  // do NOT consume the user's message just because the agent is mid-task.
  // The row stays at `received` and the next routePending picks it up when
  // the agent is free.
  if (ctx.activeTaskBusy) {
    const why = signals.has("dm") ? "DM" : signals.has("reply-to-agent") ? "reply-to-agent" : "mention";
    return {
      action: "busy-skip",
      reason: `agent busy (active task); leaving row received for next route attempt — ${why} from trusted sender`,
      memoryPolicy: "none",
    };
  }

  // 6. Trusted sender + addressed + agent available → process.
  const why = signals.has("dm")
    ? "DM"
    : signals.has("reply-to-agent")
    ? "reply-to-agent"
    : "mention";
  return {
    action: "process",
    reason: `addressed via ${why} from trusted sender; submit as AgentThursday task`,
    taskHint: row.text.slice(0, 80),
    memoryPolicy: "none",
  };
}

/**
 * Build a safe AgentThursday task prompt from a channel inbox row. Includes provider
 * metadata for traceability; explicitly does NOT include raw provider JSON.
 * Card §C-13 / §D-17.
 */
export function buildTaskPromptFromInbox(row: ChannelInboxItem): string {
  const senderLabel = row.senderProviderUserId;
  const provider = row.provider;
  const chat = row.chatType;
  const sigs = row.addressedSignals.length > 0 ? row.addressedSignals.join(",") : "none";
  return [
    `[${provider} ${chat} message — addressed via ${sigs}]`,
    `from: ${senderLabel}`,
    `conversation: ${row.conversationId}`,
    `provider_message_id: ${row.providerMessageId}`,
    ``,
    row.text,
    ``,
    `(This message arrived via the channel layer. Respond by addressing the sender; do not speak as the human operator. Do not include secrets in any reply or memory entry.)`,
  ].join("\n");
}
