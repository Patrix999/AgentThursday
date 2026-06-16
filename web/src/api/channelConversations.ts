/**
 *  — recent channel conversations for the create-form binding
 * picker. Reads the already-existing `GET /api/channel/snapshot`
 * ( added `recentConversations`) — no new backend route.
 */
import { authHeaders, clearSecret } from "../auth/secret";

export interface RecentConversation {
  conversationId: string;
  provider: string;
  chatType: string;
  activeAgentId: string | null;
  lastSeenAt: number;
}

interface SnapshotWire {
  recentConversations?: Array<{
    conversationId: string;
    provider: string;
    chatType: string;
    activeAgentId?: string | null;
    activeProfileId?: string | null;
    lastSeenAt: number;
  }>;
}

export async function listRecentConversations(): Promise<RecentConversation[]> {
  const res = await fetch("/api/channel/snapshot", { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return [];
  }
  if (!res.ok) return [];
  const d = (await res.json()) as SnapshotWire;
  return (d.recentConversations ?? []).map((c) => ({
    conversationId: c.conversationId,
    provider: c.provider,
    chatType: c.chatType,
    activeAgentId: c.activeAgentId ?? c.activeProfileId ?? null,
    lastSeenAt: c.lastSeenAt,
  }));
}
