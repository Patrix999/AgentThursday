import { useEffect, useRef } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";

type Props = { snapshot: WorkspaceSnapshot | null };

/**
 * Renders only `summaryStream[]` — strings already humanized by the worker.
 * Card 76 guarantees no `event_payload` / raw tool JSON appears here.
 *
 * Card 79 §B-5: newest at the bottom (the worker emits ascending order),
 * with auto-scroll on new entries so users see the latest line.
 */
export function SummaryStream({ snapshot }: Props) {
  const items = snapshot?.summaryStream ?? [];
  const visible = items.filter((m) => m.kind !== "user");
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    const newest = visible[visible.length - 1];
    if (newest && newest.id !== lastIdRef.current) {
      lastIdRef.current = newest.id;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [visible]);

  if (visible.length === 0) {
    return <div className="px-4 py-3 text-sm text-slate-500">No activity yet.</div>;
  }

  return (
    <div className="px-4 py-3">
      <ul className="space-y-2">
        {visible.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-sm">
            <KindLabel kind={m.kind} />
            <span className="text-slate-200 whitespace-pre-wrap break-words">{m.text}</span>
          </li>
        ))}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}

function KindLabel({ kind }: { kind: "system" | "assistant" | "user" | "summary" }) {
  const map = {
    system: { label: "SYS", cls: "text-slate-400" },
    assistant: { label: "AGT", cls: "text-sky-400" },
    user: { label: "YOU", cls: "text-emerald-400" },
    summary: { label: "SUM", cls: "text-amber-400" },
  } as const;
  const { label, cls } = map[kind];
  return <span className={`text-xs font-mono ${cls} shrink-0 w-10`}>{label}</span>;
}
