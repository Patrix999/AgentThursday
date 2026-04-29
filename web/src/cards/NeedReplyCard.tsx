import { useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import { sendHumanResponse } from "../api/actions";

type ReplyNeed = NonNullable<WorkspaceSnapshot["replyNeed"]>;

export function NeedReplyCard({ replyNeed }: { replyNeed: ReplyNeed | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!replyNeed) {
    return (
      <Card label="Need Your Reply">
        <div className="text-sm text-slate-400">Nothing waiting on you.</div>
      </Card>
    );
  }

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await sendHumanResponse(text.trim());
    if (res.ok) {
      setText("");
    } else if (res.status !== 401) {
      setError(res.error ?? `HTTP ${res.status}`);
    }
    setBusy(false);
  }

  return (
    <Card label="Need Your Reply">
      <div className="text-sm text-slate-200 whitespace-pre-wrap break-words">
        {replyNeed.question}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        placeholder="Your response…"
        className="mt-3 w-full bg-slate-800 text-slate-100 placeholder-slate-500 rounded px-3 py-2 resize-none h-20 outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-60"
      />
      <div className="mt-2 flex justify-end">
        <button
          disabled={busy || !text.trim()}
          onClick={() => void send()}
          className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
    </Card>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
