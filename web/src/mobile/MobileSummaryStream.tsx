import { useEffect, useRef, useState } from "react";
import { formatMessageTime } from "../shell/messageTime";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { MarkdownText } from "../components/MarkdownText";

type Props = { snapshot: WorkspaceSnapshot | null };

const DEFAULT_VISIBLE = 3;

/**
 * mobile-only summary stream wrapper.
 *
 * Renders the same `summaryStream[]` content as the desktop
 * `SummaryStream`, but collapses anything older than the latest
 * `DEFAULT_VISIBLE` (3) turns behind a `Show N earlier turns` toggle
 * so the first screen at 360×780 keeps the dialog calm. Once expanded
 * the toggle stays expanded for the rest of the mount (a hard refresh
 * resets to collapsed).
 *
 * Auto-scroll-to-bottom is preserved when new turns arrive.
 *
 * Privacy / safety: identical content path as `SummaryStream` —
 * server-sanitized strings rendered via `MarkdownText` (no
 * `dangerouslySetInnerHTML`, URL allowlist, etc.).
 */
export function MobileSummaryStream({ snapshot }: Props) {
  const items = snapshot?.summaryStream ?? [];
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    const newest = items[items.length - 1];
    if (newest && newest.id !== lastIdRef.current) {
      lastIdRef.current = newest.id;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [items]);

  if (snapshot === null) {
    return <MobileSummaryLoadingSkeleton />;
  }

  if (items.length === 0) {
    return <div className="px-4 py-3 text-sm text-slate-500">No activity yet.</div>;
  }

  const overflow = Math.max(0, items.length - DEFAULT_VISIBLE);
  const visible = expanded ? items : items.slice(-DEFAULT_VISIBLE);

  return (
    <div className="px-4 py-3" data-testid="mobile-summary-stream">
      {overflow > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full mb-2 text-xs text-slate-400 hover:text-slate-100 underline underline-offset-2"
          data-testid="mobile-show-earlier"
        >
          ⤴ Show {overflow} earlier turn{overflow === 1 ? "" : "s"}
        </button>
      )}
      <ul className="space-y-2">
        {visible.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-sm min-w-0">
            <KindLabel kind={m.kind} />
            <span className="shrink-0 text-[10px] text-slate-600 font-mono pt-0.5 tabular-nums">
              {formatMessageTime(m.at)}
            </span>
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

function MobileSummaryLoadingSkeleton() {
  return (
    <div className="px-4 py-3" aria-label="Loading messages">
      <ul className="space-y-3 animate-pulse">
        {[0, 1].map((idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm min-w-0">
            <span className="h-4 w-10 rounded bg-slate-800" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-10/12 rounded bg-slate-800/80" />
              <div className="h-4 w-6/12 rounded bg-slate-800/60" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
