/**
 *  —  channel conversation → agent binding client.
 *  — agent-centric naming. Client surfaces both `activeAgentId`
 * (preferred) and `activeProfileId` (legacy alias, same value); POST
 * accepts an agent id and is sent over the wire under both `agent_id`
 * and `profile_id` so server can validate either alias path. The
 * underlying column is still `active_profile_id` — see the design
 * note ``.
 *
 * Wraps the new ChannelHub routes:
 *   GET  /api/channel/conversation-binding?conversation_id=<id>
 *   POST /api/channel/conversation-binding  { conversation_id, agent_id|null, profile_id|null }
 *
 * Auth piggybacks the `/api/*` umbrella via `authHeaders()` /
 * `postJson()`, same as every other agent / channel client.
 */
import { authHeaders, clearSecret } from "../auth/secret";
import { postJson } from "./client";

export interface ConversationBinding {
  conversationId: string;
  activeAgentId: string | null;
  /**  — legacy alias of `activeAgentId`; same value. */
  activeProfileId: string | null;
}

export interface SetConversationBindingError {
  code: string;
  message: string;
}

interface ConversationBindingWire {
  conversationId: string;
  activeAgentId?: string | null;
  activeProfileId?: string | null;
}

function normalizeBinding(wire: ConversationBindingWire): ConversationBinding {
  //  — server returns both fields. Older servers may only set
  // `activeProfileId`; coerce to the new shape so callers can read either.
  const bound =
    wire.activeAgentId !== undefined && wire.activeAgentId !== null
      ? wire.activeAgentId
      : wire.activeProfileId !== undefined && wire.activeProfileId !== null
        ? wire.activeProfileId
        : null;
  return {
    conversationId: wire.conversationId,
    activeAgentId: bound,
    activeProfileId: bound,
  };
}

export async function getConversationBinding(
  conversationId: string,
): Promise<ConversationBinding | null> {
  const url = `/api/channel/conversation-binding?conversation_id=${encodeURIComponent(conversationId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) return null;
  return normalizeBinding((await res.json()) as ConversationBindingWire);
}

export async function setConversationBinding(
  conversationId: string,
  agentId: string | null,
): Promise<{ ok: boolean; binding: ConversationBinding | null; error: SetConversationBindingError | null }> {
  const res = await postJson<ConversationBindingWire | (SetConversationBindingError & { ok: false })>(
    "/api/channel/conversation-binding",
    // Send both aliases so the server validates whichever it knows.
    { conversation_id: conversationId, agent_id: agentId, profile_id: agentId },
  );
  if (
    res.ok
    && res.data
    && ("activeAgentId" in (res.data as ConversationBindingWire)
      || "activeProfileId" in (res.data as ConversationBindingWire))
  ) {
    return { ok: true, binding: normalizeBinding(res.data as ConversationBindingWire), error: null };
  }
  const data = res.data as Partial<SetConversationBindingError> | null;
  return {
    ok: false,
    binding: null,
    error: {
      code: data?.code ?? "request_failed",
      message: data?.message ?? res.error ?? `HTTP ${res.status}`,
    },
  };
}
