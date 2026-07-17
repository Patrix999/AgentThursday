import { useEffect, useState } from "react";
import type {
  MemoryCandidatesResult,
  MemoryCandidateInspectItem,
} from "../../shared/schema";
import { fetchMemoryCandidates } from "../api/memoryCandidates";

/**
 * read-only memory candidate inspect panel.
 *
 * Shows heuristic candidates derived from conversation_archive,
 * recent dialog, and existing memories. Display-only: no promote /
 * dismiss actions in v1 (those are an earlier revision territory). Buttons
 * are rendered but `disabled` with a tooltip so the surface is
 * forward-compatible with 154b.
 *
 * Privacy contract: the server-side generator already strips raw
 * tool payloads / SOUL / system prompt content; this component
 * only renders text + reason + sourceRefs as-is. No
 * `dangerouslySetInnerHTML`, no payload accessors.
 */
export function MemoryCandidatesPanel() {
  const [data, setData] = useState<MemoryCandidatesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchMemoryCandidates({ limit: 20 })
      .then((res) => {
        if (!active) return;
        setData(res);
        setError(null);
      })
      .catch((e) => {
        if (!active) return;
        setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 m-4">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
        <span className="text-xs uppercase tracking-wide text-slate-300">
          Memory candidates · read-only
        </span>
        <span
          className="text-[10px] text-slate-500 italic"
          title="v1 read-only; promote/dismiss in an earlier revision"
        >
          v1: read-only draftbox
        </span>
      </header>
      <div className="p-3 space-y-3">
        {loading && !data && <div className="text-sm text-slate-500">Loading…</div>}
        {error && <div className="text-sm text-rose-400">{error}</div>}
        {data && data.items.length === 0 && (
          <div className="text-sm text-slate-500">
            No candidates above threshold.
            {data.blockedReason && (
              <span className="ml-2 text-slate-600 italic">({data.blockedReason})</span>
            )}
          </div>
        )}
        {data && data.items.length > 0 && (
          <ul className="space-y-2">
            {data.items.map((item) => (
              <CandidateRow key={item.candidateId} item={item} />
            ))}
          </ul>
        )}
        {data && (
          <div className="text-[10px] text-slate-600 mt-2">
            Generated at {new Date(data.generatedAt).toLocaleTimeString()}.
            Items: {data.items.length}.
          </div>
        )}
      </div>
    </section>
  );
}

function CandidateRow({ item }: { item: MemoryCandidateInspectItem }) {
  const confidencePct = Math.round(item.confidence * 100);
  return (
    <li className="rounded border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <TypeBadge type={item.type} />
        <span className="text-xs font-mono text-slate-500">{confidencePct}%</span>
        {item.dedupeHint?.maybeExistingMemoryId && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300"
            title={item.dedupeHint.similarityReason ?? "Possible overlap with existing memory"}
          >
            ≈ memory #{item.dedupeHint.maybeExistingMemoryId}
          </span>
        )}
      </div>
      <div className="mt-1.5 text-sm text-slate-200 whitespace-pre-wrap break-words">
        {item.text}
      </div>
      <div className="mt-1.5 text-[11px] text-slate-400 italic">{item.reason}</div>
      {item.sourceRefs.length > 0 && (
        <details className="mt-2">
          <summary className="text-[10px] text-slate-500 cursor-pointer">
            sources ({item.sourceRefs.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {item.sourceRefs.map((ref, i) => (
              <li key={i} className="text-[10px] text-slate-400 font-mono break-all">
                <span className="text-slate-500 uppercase">[{ref.kind}]</span>{" "}
                <span>{ref.ref}</span>
                {ref.preview && (
                  <span className="block ml-2 text-slate-500 italic">
                    {ref.preview.length > 200
                      ? `${ref.preview.slice(0, 200)}…`
                      : ref.preview}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled
          title="v1 read-only; promote in an earlier revision"
          className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-500 cursor-not-allowed"
        >
          Promote
        </button>
        <button
          type="button"
          disabled
          title="v1 read-only; dismiss in an earlier revision"
          className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-500 cursor-not-allowed"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

function TypeBadge({ type }: { type: MemoryCandidateInspectItem["type"] }) {
  const cls =
    type === "fact" ? "bg-sky-900/60 text-sky-200"
    : type === "instruction" ? "bg-violet-900/60 text-violet-200"
    : type === "decision" ? "bg-emerald-900/60 text-emerald-200"
    : type === "task" ? "bg-amber-900/60 text-amber-200"
    : type === "event" ? "bg-rose-900/60 text-rose-200"
    : "bg-fuchsia-900/60 text-fuchsia-200";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${cls}`}>
      {type}
    </span>
  );
}
