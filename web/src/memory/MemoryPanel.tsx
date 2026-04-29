import { useState } from "react";
import { useMemorySnapshot } from "../hooks/useMemorySnapshot";
import type { MemoryEntry } from "../../shared/schema";

/**
 * M7.2 Card 84 — compact agent memory summary in user layer.
 *
 * Shows counts by type + most-recent active facts/instructions/events/tasks.
 * Collapsible like WorkspaceFileManager. No raw IDs in headlines (id only
 * surfaces in inspect-style detail rows). No event_payload / debug fields.
 */
export function MemoryPanel() {
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useMemorySnapshot();

  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 m-4">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs uppercase tracking-wide text-slate-300 hover:text-slate-100"
        >
          {open ? "▾" : "▸"} Agent memory
        </button>
        {open && data && (
          <div className="text-xs text-slate-500 flex gap-3 flex-wrap justify-end">
            <Count label="facts" n={data.counts.fact} />
            <Count label="instr" n={data.counts.instruction} />
            <Count label="events" n={data.counts.event} />
            <Count label="tasks" n={data.counts.task} />
            {data.counts.inactive > 0 && <Count label="inactive" n={data.counts.inactive} dim />}
          </div>
        )}
      </header>
      {open && (
        <div className="p-3 grid lg:grid-cols-2 gap-3">
          {loading && !data && <div className="text-sm text-slate-500">Loading…</div>}
          {error && <div className="text-sm text-rose-400">{error}</div>}
          {data && (
            <>
              <Section label="Recent facts" entries={data.recentFacts} emptyMsg="No facts remembered." />
              <Section label="Recent instructions" entries={data.recentInstructions} emptyMsg="No instructions remembered." />
              <Section label="Recent events" entries={data.recentEvents} emptyMsg="No events remembered." />
              <Section label="Recent tasks" entries={data.recentTasks} emptyMsg="No tasks remembered." />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Count({ label, n, dim }: { label: string; n: number; dim?: boolean }) {
  return (
    <span className={dim ? "text-slate-600" : "text-slate-400"}>
      <span className="font-mono text-slate-300">{n}</span> {label}
    </span>
  );
}

function Section({ label, entries, emptyMsg }: { label: string; entries: MemoryEntry[]; emptyMsg: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      {entries.length === 0 ? (
        <div className="text-sm text-slate-500">{emptyMsg}</div>
      ) : (
        <ul className="space-y-2 text-sm">
          {entries.map((e) => (
            <li key={e.id} className="border-l-2 border-slate-700 pl-2">
              {e.key && <div className="text-xs text-sky-300 font-mono break-words">{e.key}</div>}
              <div className="text-slate-200 whitespace-pre-wrap break-words">{e.content}</div>
              <div className="text-xs text-slate-600 mt-0.5">
                {relativeTime(e.createdAt)}
                {e.confidence !== null && ` · conf ${(e.confidence * 100).toFixed(0)}%`}
              </div>
            </li>
          ))}
        </ul>
      )}
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
