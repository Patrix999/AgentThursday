import { useState } from "react";
import { useChannelSummary } from "../hooks/useChannelSummary";

/**
 * M7.3 Card 89 — compact, leak-safe channel status for the user-layer.
 * Shows ONLY counts + last-inbound relative time. No provider message ids,
 * no payloads, no audit strings. The full inspect view (with row detail) is
 * gated behind the `/inspect` Channel tab.
 *
 * Collapsible like MemoryPanel / WorkspaceFileManager.
 */
export function ChannelSummaryPanel() {
  const [open, setOpen] = useState(false);
  const { data, loading, error } = useChannelSummary();

  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 m-4">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs uppercase tracking-wide text-slate-300 hover:text-slate-100"
        >
          {open ? "▾" : "▸"} Channels
        </button>
        {open && data && (
          <div className="text-xs text-slate-500">
            {data.conversations} conversation{data.conversations === 1 ? "" : "s"}
          </div>
        )}
      </header>
      {open && (
        <div className="p-3 grid gap-2 lg:grid-cols-3 text-sm">
          {loading && !data && <div className="text-slate-500">Loading…</div>}
          {error && <div className="text-rose-400">{error}</div>}
          {data && (
            <>
              <Card label="Awaiting attention" value={data.inboxAddressedPending}
                hint="addressed inbound, not yet routed" />
              <Card label="Outbound queued" value={data.outboxPending}
                hint="text or approval cards waiting to deliver" />
              <Card label="Approvals pending" value={data.approvalsPending}
                hint="open approval cards" warn={data.approvalsPending > 0} />
              <div className="lg:col-span-3 text-xs text-slate-500">
                {data.lastInboundAt
                  ? <>last inbound: <span className="text-slate-300">{relativeTime(data.lastInboundAt)}</span> · open <code className="text-slate-400">/inspect</code> Channel tab for detail</>
                  : <>no inbound activity yet</>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Card({ label, value, hint, warn }: { label: string; value: number; hint: string; warn?: boolean }) {
  return (
    <div className={`rounded border ${warn && value > 0 ? "border-amber-700 bg-amber-950/20" : "border-slate-800 bg-slate-950/40"} p-3`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${warn && value > 0 ? "text-amber-200" : "text-slate-100"}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
    </div>
  );
}

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
