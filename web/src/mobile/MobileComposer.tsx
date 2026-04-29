import { useState, type KeyboardEvent } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { useComposerActions } from "../hooks/useComposerActions";

type Props = { snapshot: WorkspaceSnapshot | null };

/**
 * Mobile composer — same logic as desktop, but tap targets ≥44pt and the
 * Approve/Reject pair is hoisted to the top of this bar so it sits in the
 * lower half of the screen with the home indicator margin (`safe-area-inset-bottom`).
 *
 * Layout structure (top → bottom):
 *   1. Pending action row (Approve / Reject) — most prominent
 *   2. Textarea + Send
 *
 * The whole component is meant to be placed inside `ThumbReachLayout` which
 * provides the fixed bottom positioning + keyboard inset compensation.
 */
export function MobileComposer({ snapshot }: Props) {
  const [text, setText] = useState("");
  const a = useComposerActions(snapshot);

  function onSend() {
    if (!text.trim() || a.busy) return;
    void a.submit(text.trim(), () => setText(""));
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3 space-y-2">
      {a.pendingApproval && (
        <div className="flex flex-wrap gap-2">
          <button
            disabled={a.busy}
            onClick={() => void a.approve()}
            className="flex-1 min-w-[120px] min-h-[44px] px-4 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-base font-semibold"
          >
            {a.busy ? "…" : "Approve"}
          </button>
          <button
            disabled={a.busy}
            onClick={() => void a.reject()}
            className="flex-1 min-w-[120px] min-h-[44px] px-4 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-base font-semibold"
          >
            {a.busy ? "…" : "Reject"}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={a.busy}
          placeholder="Submit a task…"
          className="flex-1 min-h-[44px] bg-slate-800 text-slate-200 placeholder-slate-500 rounded px-3 py-2 resize-none h-14 outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-60 text-base"
        />
        <button
          disabled={a.busy || !text.trim()}
          onClick={onSend}
          className="min-h-[44px] min-w-[64px] px-4 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-base font-semibold"
        >
          {a.busy ? "…" : "Send"}
        </button>
      </div>
      {a.error && <div className="text-xs text-rose-400">{a.error}</div>}
    </div>
  );
}
