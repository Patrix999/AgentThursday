/**
 * Archive / retrieval Inspect panel.
 *
 * Read-only dashboard over the registry's `conversation_archive`,
 * `conversation_archive_flushes`, and `conversation_retrieval_log`
 * tables. Hard-capped server-side; this UI only renders what the
 * backend returned.
 *
 * Sections:
 *   1. Totals strip — chunk total / context count / flush total /
 *      flush failed total / retrieval total.
 *   2. Recent flushes —  archive triggers (context.new /
 *      context.reset). Failure rows surface error excerpts.
 *   3. Recent retrievals —  conversation_search audit, with
 *      capped query preview + returned ref count.
 *   4. Counts by context — per-context chunk totals, sorted by latest
 *      archive time. Lets the operator see which contexts have data.
 */
import { useEffect, useState } from "react";
import { fetchArchiveInspectSummary } from "../api/conversationArchive";
import type { ArchiveInspectSummary } from "../../shared/schema";

export function ArchivePanel() {
  const [data, setData] = useState<ArchiveInspectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const r = await fetchArchiveInspectSummary({ recentLimit: 10, perContextLimit: 20 });
        if (!mounted) return;
        if (r) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (mounted) setError(String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    function onCompacted() {
      void load();
    }
    window.addEventListener("agentthursday:context:compacted", onCompacted);
    window.addEventListener("agentthursday:context:switched", onCompacted);
    return () => {
      mounted = false;
      window.removeEventListener("agentthursday:context:compacted", onCompacted);
      window.removeEventListener("agentthursday:context:switched", onCompacted);
    };
  }, []);

  return (
    <section className="m-4 space-y-4 text-xs text-slate-200">
      <SectionHeader title="Conversation archive" />
      {error && (
        <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-rose-300">
          archive inspect error: {error}
        </div>
      )}
      {!data && loading && <div className="text-slate-500">Loading…</div>}
      {!data && !loading && !error && (
        <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-slate-500">
          No archive activity yet.
        </div>
      )}
      {data && (
        <>
          <TotalsStrip totals={data.totals} />
          <SectionHeader title={`Recent flushes (${data.recentFlushes.length})`} />
          <FlushList rows={data.recentFlushes} />
          <SectionHeader title={`Recent retrievals (${data.recentRetrievals.length})`} />
          <RetrievalList rows={data.recentRetrievals} />
          <SectionHeader title={`Counts by context (${data.countsByContext.length})`} />
          <ContextCounts rows={data.countsByContext} />
          <p className="text-[10px] text-slate-600">
            Generated at {new Date(data.generatedAt).toISOString()}. Full archive text is intentionally not included
            — Inspect deep-reads ship in a later card.
          </p>
        </>
      )}
    </section>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{title}</h3>
  );
}

function TotalsStrip({ totals }: { totals: ArchiveInspectSummary["totals"] }) {
  const failedTone = totals.flushFailedTotal > 0 ? "text-rose-300" : "text-slate-300";
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-3 grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-1 text-[10px]">
      <Stat label="chunks" value={totals.archiveChunkTotal} />
      <Stat label="contexts" value={totals.archiveContextCount} />
      <Stat label="flushes" value={totals.flushTotal} />
      <Stat label="flush failed" value={totals.flushFailedTotal} valueClass={failedTone} />
      <Stat label="retrievals" value={totals.retrievalTotal} />
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: number; valueClass?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono ${valueClass ?? "text-slate-200"}`}>{value}</span>
    </div>
  );
}

function FlushList({ rows }: { rows: ArchiveInspectSummary["recentFlushes"] }) {
  if (rows.length === 0) {
    return <div className="text-[10px] text-slate-500">No flushes yet.</div>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.flushId}
          className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-0.5 text-[10px]"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <StatusChip status={r.status} />
            <span className="font-mono text-slate-300">{r.trigger}</span>
            <span className="font-mono text-slate-400 truncate">{shortId(r.contextId)}</span>
            <span className="ml-auto text-slate-500">
              {r.chunkCount}/{r.messageCount} chunks
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            <span className="font-mono">{shortId(r.flushId)}</span>
            {" · "}
            {new Date(r.createdAt).toISOString()}
            {r.reason ? <> · reason: <span className="text-slate-400">{r.reason}</span></> : null}
          </div>
          {r.error && (
            <div className="rounded border border-rose-900/60 bg-rose-950/30 px-2 py-1 text-rose-200 break-words">
              error: {r.error}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusChip({ status }: { status: "ok" | "failed" | "skipped" }) {
  const cls =
    status === "ok"
      ? "border-emerald-700/70 bg-emerald-950/40 text-emerald-200"
      : status === "failed"
        ? "border-rose-700/70 bg-rose-950/40 text-rose-200"
        : "border-slate-700 bg-slate-900/80 text-slate-400";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

function RetrievalList({ rows }: { rows: ArchiveInspectSummary["recentRetrievals"] }) {
  if (rows.length === 0) {
    return <div className="text-[10px] text-slate-500">No retrievals yet.</div>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.retrievalId}
          className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-0.5 text-[10px]"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-slate-400 truncate">{shortId(r.retrievalId)}</span>
            <span className="ml-auto text-slate-500">{r.resultCount} hits</span>
          </div>
          <div className="text-slate-200 break-words">
            <span className="text-slate-500">query:</span>{" "}
            <span className="font-mono">{r.query}</span>
          </div>
          <div className="text-slate-500">
            {new Date(r.createdAt).toISOString()}
            {r.callerContextId ? (
              <> · caller: <span className="font-mono text-slate-400">{shortId(r.callerContextId)}</span></>
            ) : null}
            {r.callerTaskId ? (
              <> · task: <span className="font-mono text-slate-400">{shortId(r.callerTaskId)}</span></>
            ) : null}
          </div>
          {r.returnedRefs.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
                returned refs ({r.returnedRefs.length})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {r.returnedRefs.map((ref) => (
                  <li key={ref.chunkId} className="flex gap-2 truncate font-mono">
                    <span className="text-slate-400">{shortId(ref.chunkId)}</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-slate-400">{shortId(ref.contextId)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {r.filtersJson && r.filtersJson !== "{}" && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
                filters
              </summary>
              <pre className="mt-1 rounded bg-slate-950/70 px-2 py-1 text-slate-300 whitespace-pre-wrap break-words">
                {r.filtersJson}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function ContextCounts({ rows }: { rows: ArchiveInspectSummary["countsByContext"] }) {
  if (rows.length === 0) {
    return <div className="text-[10px] text-slate-500">No archive entries yet.</div>;
  }
  return (
    <ul className="space-y-0.5">
      {rows.map((r, idx) => (
        <li
          key={`${r.contextId}-${r.trigger}-${idx}`}
          className="flex items-baseline gap-2 text-[10px]"
        >
          <span className="font-mono text-slate-400 truncate">{shortId(r.contextId)}</span>
          <span className="text-slate-500">{r.trigger}</span>
          <span className="ml-auto font-mono text-slate-300">{r.chunkCount}</span>
          <span className="text-slate-600">{new Date(r.latestArchivedAt).toISOString().slice(0, 19)}</span>
        </li>
      ))}
    </ul>
  );
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 14)}…`;
}
