/**
 * M9.2 / 2026-06-26 — the tenant-isolation kernel for USER-side conversation→agent
 * binding ("补全 user 端"). Pure + exhaustively unit-tested because it is the whole
 * ballgame for this surface: a wrong answer is a cross-tenant leak.
 *
 * A scoped user (resolved from the gateway-injected `X-AgentThursday-User-Id`, never admin)
 * may only:
 *   - BIND a conversation they own to an agent they own, or
 *   - CLEAR a binding on a conversation they own.
 *
 * "Own a conversation" is derived: the conversation's `provider_channel_id` must be
 * in the union of the caller's BYO bots' `allowed_channels`. `findChannelConflict`
 * guarantees one channel → one bot (single-owner), so the membership test is
 * unambiguous. Fail CLOSED: a null/unknown channel (pre-seed rows, legacy, the env
 * system bot, DMs) is NOT owned by any BYO bot and is therefore non-bindable by a
 * scoped user — exactly the intended behavior, no special-casing.
 *
 * The route layer owns identity resolution + the admin (unscoped) bypass; this kernel
 * only answers "may THIS scoped caller perform THIS bind/clear".
 */

export type CanBindInput = {
  /** Union of the caller's BYO bots' allowed_channels (Discord channel snowflakes). */
  callerChannels: ReadonlySet<string>;
  /** The conversation's stored `provider_channel_id`; null when unknown/pre-seed. */
  conversationChannelId: string | null;
  /** True when the action clears the binding (agent_id === null). */
  clearing: boolean;
  /** Whether the target agent is owned by the caller. Ignored when clearing. */
  agentOwnedByCaller: boolean;
};

export type CanBindResult =
  | { allow: true }
  | { allow: false; reason: "conversation_not_owned" | "agent_not_owned" };

export function canBind(input: CanBindInput): CanBindResult {
  // Conversation ownership is required for BOTH bind and clear (a clear on another
  // tenant's conversation is a cross-tenant denial). Fail closed on a null channel.
  const channel = input.conversationChannelId;
  if (!channel || !input.callerChannels.has(channel)) {
    return { allow: false, reason: "conversation_not_owned" };
  }
  // Owned conversation. A clear needs nothing more.
  if (input.clearing) return { allow: true };
  // A bind additionally requires the target agent to be the caller's.
  if (!input.agentOwnedByCaller) return { allow: false, reason: "agent_not_owned" };
  return { allow: true };
}
