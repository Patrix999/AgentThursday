import { useEffect, useState } from "react";
import type { ChannelSnapshot, ChannelInboxItem, ChannelOutboxItem, ChannelApprovalRow } from "../../shared/schema";
import { listAgentProfiles, type AgentProfileWithLifecycle } from "../api/agentProfiles";
import { setConversationBinding } from "../api/channelBinding";

type Props = { data: ChannelSnapshot | null; loading: boolean; error: string | null };

type RecentConversation = NonNullable<ChannelSnapshot["recentConversations"]>[number];

/**
 * Channel inspect tab.
 *
 * Sections (top → bottom):
 *   1. counts row (inbox / outbox / approvals / conversations / identities)
 *   2. recent timeline — interleaved inbox / outbox / approval entries by time
 *
 * Designed for inspect surface only (an earlier revision lazy hook). Default `/` user
 * layer never mounts this; the leak guard blacklist (an earlier revision + an earlier revision
 * extension) ensures no stray `providerMessageId/payloadHash` appears there.
 */
export function ChannelTimeline({ data, loading, error }: Props) {
  if (error) return <div className="text-xs text-rose-400">channel inspect fetch error: {error}</div>;
  if (loading && !data) return <div className="text-sm text-slate-500">Loading…</div>;
  if (!data) return null;

  return (
    <div className="space-y-4 text-xs">
      <Counts c={data.counts} />
      <ConversationBindings conversations={data.recentConversations ?? []} />
      <Timeline data={data} />
    </div>
  );
}

/**
 * per-conversation agent binding management.
 * agent-centric copy. The row says "Bound to agent X", not
 * "profile X"; the column under the hood is still `active_profile_id`
 * for storage compat (see docs/design/2026-05-24-m9.0-agent-centric-correction.md).
 *
 * Renders one row per recently-seen conversation with a selector +
 * Save / Clear actions. Honest copy:
 *   - "Unbound: routes to current active context"
 *   - "Bound: routes addressed messages in this conversation to <agent>"
 *
 * Agent list is fetched once on mount from /api/agent-profiles (legacy
 * route name; same row IS the agent). The current binding is sourced
 * from `data.recentConversations[].activeAgentId` (with fallback to the
 * legacy `activeProfileId` for older snapshots), which getSnapshot()
 * already populated, so this section doesn't add a polling loop of
 * its own — it reuses the inspect snapshot's existing 4s tick.
 */
function ConversationBindings({ conversations }: { conversations: RecentConversation[] }) {
  const [agents, setAgents] = useState<AgentProfileWithLifecycle[] | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentProfiles()
      .then((p) => {
        if (cancelled) return;
        setAgents(p ?? []);
        setLoadingAgents(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setAgentError(String(e instanceof Error ? e.message : e));
        setLoadingAgents(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (conversations.length === 0) {
    return (
      <div>
        <div className="text-slate-500 uppercase tracking-wide mb-1">Conversation bindings</div>
        <div className="text-slate-500">No conversations yet.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide mb-1">Conversation bindings</div>
      {agentError && (
        <div className="text-rose-400 mb-1">Failed to load agents: {agentError}</div>
      )}
      <ul className="space-y-2">
        {conversations.map((c) => (
          <BindingRow
            key={c.conversationId}
            conversation={c}
            agents={agents ?? []}
            agentsLoading={loadingAgents}
          />
        ))}
      </ul>
    </div>
  );
}

function BindingRow({
  conversation,
  agents,
  agentsLoading,
}: {
  conversation: RecentConversation;
  agents: AgentProfileWithLifecycle[];
  agentsLoading: boolean;
}) {
  // snapshot may carry `activeAgentId` (new) or only
  // `activeProfileId` (legacy); prefer the new field, fall back to the
  // legacy alias. Same value either way.
  const initial = conversation.activeAgentId ?? conversation.activeProfileId ?? null;
  // Optimistic UI: `current` reflects the last persisted binding. After a
  // successful save/clear we update `current` so the row's "Bound to X"
  // line refreshes without waiting for the next snapshot poll.
  const [current, setCurrent] = useState<string | null>(initial);
  const [selected, setSelected] = useState<string>(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentAgent = agents.find((a) => a.id === current) ?? null;

  async function save(agentId: string | null) {
    setSaving(true);
    setError(null);
    const r = await setConversationBinding(conversation.conversationId, agentId);
    setSaving(false);
    if (!r.ok) {
      setError(r.error?.message ?? "request failed");
      return;
    }
    setCurrent(r.binding?.activeAgentId ?? null);
    setSelected(r.binding?.activeAgentId ?? "");
  }

  const dirty = (selected || null) !== current;

  return (
    <li className="border-l-2 border-slate-700 pl-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-slate-300 font-mono text-[11px] break-all">{conversation.conversationId}</span>
        <span className="text-slate-500">{conversation.provider}/{conversation.chatType}</span>
        <span className="ml-auto text-slate-600 font-mono shrink-0">{shortTime(conversation.lastSeenAt)}</span>
      </div>
      <div className="text-slate-500 mt-0.5">
        {current === null ? (
          <span>Unbound: routes to current active context</span>
        ) : (
          <span>
            Bound: routes addressed messages in this conversation to agent{" "}
            <span className="text-slate-200">{currentAgent?.name ?? current}</span>
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={saving || agentsLoading}
          className="bg-slate-800 text-slate-200 border border-slate-700 rounded px-1 py-0.5 text-xs"
        >
          <option value="">{agentsLoading ? "Loading agents…" : "(unbound)"}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} {a.status !== "initialized" && a.status !== "archived" && a.status !== "deleted_marker" ? `(${a.status})` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => save(selected.length > 0 ? selected : null)}
          className="px-2 py-0.5 text-xs rounded bg-sky-800 text-sky-100 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving || current === null}
          onClick={() => save(null)}
          className="px-2 py-0.5 text-xs rounded bg-slate-700 text-slate-200 disabled:opacity-40"
        >
          Clear
        </button>
        {error && <span className="text-rose-400">{error}</span>}
      </div>
    </li>
  );
}

function Counts({ c }: { c: ChannelSnapshot["counts"] }) {
  return (
    <div className="space-y-1">
      <Row label="inbox" entries={Object.entries(c.inbox)} />
      <Row label="outbox" entries={Object.entries(c.outbox)} />
      <Row label="approvals" entries={Object.entries(c.approvals)} />
      <div className="text-slate-500">
        conversations: <span className="font-mono text-slate-300">{c.conversations}</span>
        {"  ·  "}identities: <span className="font-mono text-slate-300">{c.identities}</span>
      </div>
    </div>
  );
}

function Row({ label, entries }: { label: string; entries: [string, number][] }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-slate-500 uppercase tracking-wide w-20">{label}</span>
      {entries.map(([k, n]) => (
        <span key={k} className={`text-slate-400 ${n === 0 ? "opacity-50" : ""}`}>
          <span className="font-mono text-slate-300">{n}</span> {k}
        </span>
      ))}
    </div>
  );
}

type TimelineEntry =
  | { kind: "inbox"; at: number; row: ChannelInboxItem }
  | { kind: "outbox"; at: number; row: ChannelOutboxItem }
  | { kind: "approval"; at: number; row: ChannelApprovalRow };

function Timeline({ data }: { data: ChannelSnapshot }) {
  const entries: TimelineEntry[] = [
    ...data.recentInbox.map((row) => ({ kind: "inbox" as const, at: row.createdAt, row })),
    ...data.recentOutbox.map((row) => ({ kind: "outbox" as const, at: row.createdAt, row })),
    ...data.recentApprovals.map((row) => ({ kind: "approval" as const, at: row.createdAt, row })),
  ].sort((a, b) => b.at - a.at).slice(0, 30);

  if (entries.length === 0) {
    return <div className="text-sm text-slate-500">No channel activity yet.</div>;
  }

  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide mb-1">Recent channel events</div>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={`${e.kind}-${e.row.id}`} className="border-l-2 border-slate-700 pl-2">
            {e.kind === "inbox" && <InboxLine row={e.row} />}
            {e.kind === "outbox" && <OutboxLine row={e.row} />}
            {e.kind === "approval" && <ApprovalLine row={e.row} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InboxLine({ row }: { row: ChannelInboxItem }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <KindPill kind="IN" cls="bg-sky-900/60 text-sky-200" />
        <span className="text-slate-200 truncate">{shorten(row.text || "(empty)", 80)}</span>
        <span className="ml-auto text-slate-600 font-mono shrink-0">{shortTime(row.createdAt)}</span>
      </div>
      <div className="text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
        <span>{row.provider}/{row.chatType}</span>
        <span>from <span className="text-slate-300">{row.senderProviderUserId}</span></span>
        <span>signals: <span className="text-slate-300">{row.addressedSignals.join(",") || "none"}</span></span>
        <span>status: <span className="text-slate-300">{row.status}</span></span>
        {row.routeAction && (
          <span>route: <span className="text-slate-300">{row.routeAction}</span></span>
        )}
        {row.handoffTaskId && (
          <span>task: <span className="text-slate-300 font-mono">{row.handoffTaskId.slice(0, 12)}</span></span>
        )}
      </div>
      {row.routeReason && (
        <div className="text-slate-500 mt-0.5 italic break-words">{row.routeReason}</div>
      )}
    </div>
  );
}

function OutboxLine({ row }: { row: ChannelOutboxItem }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <KindPill kind="OUT" cls="bg-emerald-900/60 text-emerald-200" />
        <span className="text-slate-300 uppercase font-mono">{row.kind}</span>
        <span className="text-slate-200 truncate">{shorten(row.text, 80)}</span>
        <span className="ml-auto text-slate-600 font-mono shrink-0">{shortTime(row.createdAt)}</span>
      </div>
      <div className="text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
        <span>{row.provider}</span>
        <span>status: <span className="text-slate-300">{row.status}</span></span>
        <span>attempts: <span className="text-slate-300">{row.attemptCount}</span></span>
        {row.sentAt && <span>sent: {shortTime(row.sentAt)}</span>}
      </div>
      {row.error && (
        <div className="text-rose-400 mt-0.5 break-words">{shorten(row.error, 200)}</div>
      )}
    </div>
  );
}

function ApprovalLine({ row }: { row: ChannelApprovalRow }) {
  const warnCls = row.warning === "high" ? "text-rose-300" : row.warning === "medium" ? "text-amber-300" : "text-slate-300";
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <KindPill kind="APPROVAL" cls="bg-amber-900/60 text-amber-200" />
        <span className={`uppercase font-mono ${warnCls}`}>{row.warning}</span>
        <span className="text-slate-200 truncate">{row.title}</span>
        <span className="ml-auto text-slate-600 font-mono shrink-0">{shortTime(row.createdAt)}</span>
      </div>
      <div className="text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
        <span>kind: <span className="text-slate-300">{row.kind}</span></span>
        <span>status: <span className="text-slate-300">{row.status}</span></span>
        {row.effectiveScope && <span>scope: <span className="text-slate-300">{row.effectiveScope}</span></span>}
      </div>
      <div className="text-slate-400 mt-0.5 break-words">reason: {shorten(row.reason, 200)}</div>
      {row.audit && (
        <div className="text-slate-500 mt-0.5 italic break-words">audit: {row.audit}</div>
      )}
    </div>
  );
}

function KindPill({ kind, cls }: { kind: string; cls: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0 ${cls}`}>{kind}</span>
  );
}

function shorten(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}
