import { useState, type KeyboardEvent } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { useComposerActions } from "../hooks/useComposerActions";

type Props = { snapshot: WorkspaceSnapshot | null };

/**
 * Desktop composer (). Mobile users get `MobileComposer` via
 * `ThumbReachLayout` ().
 */
export function Composer({ snapshot }: Props) {
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
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={a.busy}
          placeholder="Submit a task… (Enter to send, Shift+Enter for newline)"
          className="flex-1 bg-slate-800 text-slate-200 placeholder-slate-500 rounded px-3 py-2 resize-none h-12 outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-60"
        />
        <button
          disabled={a.busy || !text.trim()}
          onClick={onSend}
          className="px-4 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
        >
          {a.busy ? "…" : "Send"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {a.pendingApproval && (
          <>
            <button
              disabled={a.busy}
              onClick={() => void a.approve()}
              className="px-3 py-1 rounded text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Approve
            </button>
            <button
              disabled={a.busy}
              onClick={() => void a.reject()}
              className="px-3 py-1 rounded text-xs bg-rose-700 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Reject
            </button>
          </>
        )}
      </div>
      {a.error && <div className="text-xs text-rose-400">{a.error}</div>}
    </div>
  );
}
