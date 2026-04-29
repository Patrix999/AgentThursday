import type { ChannelSnapshot, ChannelInboxItem, ChannelOutboxItem, ChannelApprovalRow } from "../../shared/schema";

type Props = { data: ChannelSnapshot | null; loading: boolean; error: string | null };

/**
 * M7.3 Card 89 — Channel inspect tab.
 *
 * Sections (top → bottom):
 *   1. counts row (inbox / outbox / approvals / conversations / identities)
 *   2. recent timeline — interleaved inbox / outbox / approval entries by time
 *
 * Designed for inspect surface only (Card 81 lazy hook). Default `/` user
 * layer never mounts this; the leak guard blacklist (Card 81 + Card 89
 * extension) ensures no stray `providerMessageId/payloadHash` appears there.
 */
export function ChannelTimeline({ data, loading, error }: Props) {
  if (error) return <div className="text-xs text-rose-400">channel inspect fetch error: {error}</div>;
  if (loading && !data) return <div className="text-sm text-slate-500">Loading…</div>;
  if (!data) return null;

  return (
    <div className="space-y-4 text-xs">
      <Counts c={data.counts} />
      <Timeline data={data} />
    </div>
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
