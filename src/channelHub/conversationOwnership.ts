/**
 * read-only `channel_conversations` ownership inspect surface.
 *
 * `inspectConversationOwnershipImpl(host, input)` is the pure body the
 * `ChannelHubAgent.inspectConversationOwnership` callable delegates to.
 * Lives in its own module mirroring `./inboxInspect.ts` so a unit test
 * can exercise the shape without importing the partyserver /
 * cloudflare:workers chain.
 *
 * Answers agentP's 369a observability ask: "current workspace agent vs
 * channel route owner mismatch / unbound" — given a `conversation_id`,
 * return the current binding owner (= the agent_id stored in
 * `channel_conversations.active_profile_id` under an earlier revision vocab);
 * given an `agent_id`, return the list of conversations currently
 * bound to that agent.
 *
 * No write side. Caller (route handler) is auth-gated by the global
 * `/api/*` `requireSecret` umbrella; this helper additionally
 * validates input shape so a broken caller can't smuggle LIKE-pattern
 * wildcards into the SQL.
 *
 * Scope decision: this is operator-facing observability and stays on
 * `/api/inspect/*`, not `/api/workspace`. The workspace polls every
 * 3s and the mismatch signal isn't part of user UX — it's diagnostic.
 * If agentP / verifier want it on `/api/workspace` instead, the pure
 * helper here is shape-stable and easy to re-wire.
 */

import type { Agent } from "agents";

export type ChannelHubOwnershipInspectHost = Agent<Env, Record<string, never>>;

export type InspectConversationOwnershipInput = {
  conversation_id?: string;
  agent_id?: string;
  inbox_limit?: number;
};

export type ConversationOwnershipRow = {
  conversation_id: string;
  route_owner_agent_id: string | null;
  is_bound: boolean;
  provider: string;
  chat_type: string;
  first_seen_at: number;
  last_seen_at: number;
};

export type ConversationOwnershipInboxRow = {
  created_at: number;
  status: string;
  route_action: string | null;
  route_reason: string | null;
  handoff_task_id: string | null;
};

export type InspectConversationOwnershipResult =
  | {
      kind: "conversation";
      conversation: ConversationOwnershipRow | null;
      recent_inbox: ConversationOwnershipInboxRow[];
    }
  | {
      kind: "agent";
      agent_id: string;
      bound_conversations: ConversationOwnershipRow[];
      bound_count: number;
    }
  | { kind: "empty" };

type ConversationQRow = {
  conversation_id: string;
  active_profile_id: string | null;
  provider: string;
  chat_type: string;
  first_seen_at: number;
  last_seen_at: number;
};

type RecentInboxQRow = {
  created_at: number;
  status: string;
  route_action: string | null;
  route_reason: string | null;
  handoff_task_id: string | null;
};

const SAFE_ID_RE = /^[A-Za-z0-9_.:\-]+$/;
const INBOX_LIMIT_DEFAULT = 10;
const INBOX_LIMIT_MAX = 50;
const AGENT_BOUND_LIMIT = 100;

function toOwnershipRow(r: ConversationQRow): ConversationOwnershipRow {
  return {
    conversation_id: r.conversation_id,
    route_owner_agent_id: r.active_profile_id,
    is_bound: r.active_profile_id !== null && r.active_profile_id.length > 0,
    provider: r.provider,
    chat_type: r.chat_type,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
  };
}

export function inspectConversationOwnershipImpl(
  agent: ChannelHubOwnershipInspectHost,
  input: InspectConversationOwnershipInput,
): InspectConversationOwnershipResult {
  const inboxLimitRaw = typeof input.inbox_limit === "number" && Number.isFinite(input.inbox_limit)
    ? Math.floor(input.inbox_limit)
    : INBOX_LIMIT_DEFAULT;
  const inboxLimit = Math.max(1, Math.min(INBOX_LIMIT_MAX, inboxLimitRaw));

  if (typeof input.conversation_id === "string" && input.conversation_id.length > 0) {
    if (!SAFE_ID_RE.test(input.conversation_id)) return { kind: "empty" };
    const rows = agent.sql<ConversationQRow>`
      SELECT conversation_id, active_profile_id, provider, chat_type,
             first_seen_at, last_seen_at
      FROM channel_conversations
      WHERE conversation_id = ${input.conversation_id}
      LIMIT 1
    `;
    const inbox = agent.sql<RecentInboxQRow>`
      SELECT created_at, status, route_action, route_reason, handoff_task_id
      FROM channel_inbox
      WHERE conversation_id = ${input.conversation_id}
      ORDER BY created_at DESC
      LIMIT ${inboxLimit}
    `;
    return {
      kind: "conversation",
      conversation: rows.length > 0 ? toOwnershipRow(rows[0]) : null,
      recent_inbox: inbox.map((r) => ({
        created_at: r.created_at,
        status: r.status,
        route_action: r.route_action,
        route_reason: r.route_reason,
        handoff_task_id: r.handoff_task_id,
      })),
    };
  }

  if (typeof input.agent_id === "string" && input.agent_id.length > 0) {
    if (!SAFE_ID_RE.test(input.agent_id)) return { kind: "empty" };
    const rows = agent.sql<ConversationQRow>`
      SELECT conversation_id, active_profile_id, provider, chat_type,
             first_seen_at, last_seen_at
      FROM channel_conversations
      WHERE active_profile_id = ${input.agent_id}
      ORDER BY last_seen_at DESC
      LIMIT ${AGENT_BOUND_LIMIT}
    `;
    return {
      kind: "agent",
      agent_id: input.agent_id,
      bound_conversations: rows.map(toOwnershipRow),
      bound_count: rows.length,
    };
  }

  return { kind: "empty" };
}
