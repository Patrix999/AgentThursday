import { useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";

/**
 * Newest-first event log. Worker caps at 200 today so a plain scrolling list
 * is fine; if the cap is lifted (>1k) drop in a virtualizer
 * (`@tanstack/react-virtual`) here without changing the contract.
 */
export function TraceList({ trace }: { trace: InspectSnapshot["trace"] }) {
  if (trace.length === 0) {
    return <div className="text-sm text-slate-500">No trace events.</div>;
  }
  return (
    <ul className="space-y-1 text-xs font-mono">
      {trace.map((e) => (
        <TraceRow key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function TraceRow({ entry }: { entry: InspectSnapshot["trace"][number] }) {
  const [open, setOpen] = useState(false);
  const time = new Date(entry.at).toLocaleTimeString();
  const previewable = entry.payload !== null && entry.payload !== "" && entry.payload !== undefined;
  return (
    <li className="border-b border-slate-800/60 py-1">
      <button
        type="button"
        onClick={() => previewable && setOpen((v) => !v)}
        className="w-full text-left flex gap-2"
      >
        <span className="text-slate-600 shrink-0 w-20">{time}</span>
        <span className="text-sky-300 break-all">{entry.type}</span>
        {entry.traceId && (
          <span className="ml-auto text-slate-600 shrink-0 truncate max-w-[10ch]">{entry.traceId}</span>
        )}
      </button>
      {open && (
        <pre className="mt-1 ml-22 p-2 bg-slate-950/80 rounded text-slate-300 whitespace-pre-wrap break-words overflow-x-auto">
          {safeStringify(entry.payload)}
        </pre>
      )}
    </li>
  );
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
