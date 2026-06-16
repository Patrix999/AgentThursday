import { useEffect, useState } from "react";
import { fetchCompactions } from "../api/contextActions";
import type { StoredCompactionView } from "../../shared/schema";

/**
 * Compaction history list. Polls `fetchCompactions`
 * on mount and re-fetches on the `agentthursday:context:compacted` event so the
 * inspect panel reflects new compactions immediately after a Compact
 * action completes.
 *
 *  (2026-05-21) — extracted from ContextPanel.tsx; behavior
 * unchanged (same event name, same fetch, same render order).
 */
export function CompactionHistory() {
  const [items, setItems] = useState<StoredCompactionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetchCompactions();
        if (!active) return;
        if (res === null) return; // 401 path
        setItems(res.compactions);
      } catch (e) {
        if (active) setError(String(e));
      }
    }
    void load();
    function onCompacted() {
      void load();
    }
    window.addEventListener("agentthursday:context:compacted", onCompacted);
    return () => {
      active = false;
      window.removeEventListener("agentthursday:context:compacted", onCompacted);
    };
  }, []);

  if (error) {
    return (
      <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-[10px] text-rose-300">
        compactions fetch error: {error}
      </div>
    );
  }
  if (items === null) {
    return <div className="text-[10px] text-slate-500">loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-3 py-3 text-[10px] text-slate-500 text-center">
        No compactions yet.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {items.map((c) => (
        <CompactionRow key={c.id} compaction={c} />
      ))}
    </div>
  );
}

function CompactionRow({ compaction }: { compaction: StoredCompactionView }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 text-[10px] text-slate-300">
      <div className="flex items-center gap-2">
        <span className="font-mono text-slate-400 truncate">{compaction.id.slice(0, 12)}…</span>
        <span className="text-slate-500">{compaction.createdAt}</span>
        <span className="ml-auto text-slate-500">{compaction.summaryLength} chars</span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">summary</summary>
        <pre className="mt-1 rounded bg-slate-950/70 px-2 py-1.5 text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {compaction.summaryPreview}
        </pre>
      </details>
    </div>
  );
}
