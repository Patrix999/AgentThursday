import { useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";

export function ToolEventList({ toolEvents }: { toolEvents: InspectSnapshot["toolEvents"] }) {
  if (toolEvents.length === 0) {
    return <div className="text-sm text-slate-500">No tool calls recorded.</div>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {toolEvents.map((e) => (
        <ToolRow key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function ToolRow({ entry }: { entry: InspectSnapshot["toolEvents"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-slate-800/60 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-2"
      >
        <KindPill kind={entry.kind} />
        <span className="text-slate-200 font-medium">{entry.toolName}</span>
        <span className="ml-auto text-slate-600 shrink-0 font-mono">
          {new Date(entry.at).toLocaleTimeString()}
        </span>
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-slate-950/80 rounded text-slate-300 whitespace-pre-wrap break-words overflow-x-auto">
          {safeStringify(entry.payload)}
        </pre>
      )}
    </li>
  );
}

function KindPill({ kind }: { kind: "call" | "result" }) {
  const cls = kind === "call" ? "bg-sky-900/60 text-sky-200" : "bg-emerald-900/60 text-emerald-200";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${cls}`}>{kind}</span>;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
