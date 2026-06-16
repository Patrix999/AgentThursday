import { useEffect, useRef } from "react";
import { formatMessageTime } from "./messageTime";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { MarkdownText } from "../components/MarkdownText";

type Props = { snapshot: WorkspaceSnapshot | null };

/**
 * Renders `summaryStream[]` — strings already humanized by the worker.
 *  guarantees no `event_payload` / raw tool JSON appears here.
 *
 * Newest at the bottom (the worker emits ascending order) with
 * auto-scroll on new entries so users see the latest line.
 *
 * v2: user messages are now rendered inline so the user's own input
 * shows up in the main dialog. Previously they were filtered out and
 * the user task only surfaced as a separate `CurrentTaskCard` above
 * the dialog. The task card is gone (moved to TopStatusBar badges);
 * the dialog is now the single source of "what was said by whom".
 */
export function SummaryStream({ snapshot }: Props) {
  const items = snapshot?.summaryStream ?? [];
  const visible = items;
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    const newest = visible[visible.length - 1];
    if (newest && newest.id !== lastIdRef.current) {
      lastIdRef.current = newest.id;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [visible]);

  if (snapshot === null) {
    return <SummaryLoadingSkeleton />;
  }

  if (visible.length === 0) {
    return <div className="px-4 py-3 text-sm text-slate-500">No activity yet.</div>;
  }

  return (
    <div className="px-4 py-3">
      <ul className="space-y-2">
        {visible.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-sm min-w-0">
            <KindLabel kind={m.kind} />
            <span className="shrink-0 text-[10px] text-slate-600 font-mono pt-0.5 tabular-nums">
              {formatMessageTime(m.at)}
            </span>
            {/*  — safe Markdown rendering. The renderer never
                uses dangerouslySetInnerHTML, so injected `<script>`
                tags or other raw HTML render as plain text. URL allowlist
                blocks `javascript:` / `data:` schemes. `min-w-0` on the
                <li> + overflow-x-auto on code blocks keep long URLs and
                fenced code from widening the page. */}
            <div className="flex-1 min-w-0">
              <MarkdownText text={m.text} className="space-y-2 text-slate-200" />
            </div>
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

function SummaryLoadingSkeleton() {
  return (
    <div className="px-4 py-3" aria-label="Loading messages">
      <ul className="space-y-3 animate-pulse">
        {[0, 1, 2].map((idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm min-w-0">
            <span className="h-4 w-10 rounded bg-slate-800" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-11/12 rounded bg-slate-800/80" />
              <div className="h-4 w-7/12 rounded bg-slate-800/60" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
