import { useState } from "react";
import { useMemoryLayers, triggerConsolidation, type MemoryLayersView } from "./useMemoryLayers";

/**
 * the 6-layer memory observability panel. Renders all six
 * memory layers + two cross-cutting concerns of the active agent with live
 * prod data, so the layered memory system is verifiable, not just described.
 * Most layers are usually empty today — that emptiness IS the current-state
 * evidence (memory adoption is the M9.4 gap).
 */
function hasError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

function LayerCard({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm text-slate-100 font-medium">
          <span className="text-slate-500 mr-1.5">{n}</span>
          {title}
        </h3>
        {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
      </div>
      <div className="text-xs text-slate-300 space-y-1">{children}</div>
    </section>
  );
}

function Kv({ k, v, dim }: { k: string; v: React.ReactNode; dim?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 min-w-[7rem]">{k}</span>
      <span className={dim ? "text-slate-500" : "text-slate-200"}>{v}</span>
    </div>
  );
}

function Empty() {
  return <span className="text-slate-600 italic">empty</span>;
}

function Err({ v }: { v: { error: string } }) {
  return <div className="text-rose-400">error: {v.error}</div>;
}

export function MemoryLayersPanel() {
  const { data, loading, error } = useMemoryLayers();
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  if (loading && !data) return <div className="p-4 text-sm text-slate-500">Loading memory layers…</div>;
  if (error && !data) return <div className="p-4 text-sm text-rose-400">{error}</div>;
  if (!data) return null;

  const d: MemoryLayersView = data;
  const mem = d.L3_agent_memories.counts;
  const memTotal = mem.fact + mem.instruction + mem.event + mem.task;
  const runs = d.crossA_consolidation_runs ?? [];

  async function onConsolidate() {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await triggerConsolidation();
      setRunMsg(`${r.mode} · extracted ${r.extracted} · promoted ${r.promoted} · dup ${r.skipped_dup} · ${r.parse_status}`);
    } catch (e) {
      setRunMsg(`error: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-4 space-y-3">
      <div className="text-xs text-slate-500 flex justify-between flex-wrap gap-2 items-center">
        <span>agent <span className="font-mono text-slate-400">{d.agent_id}</span></span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onConsolidate}
            disabled={running}
            className="text-[11px] px-2 py-0.5 rounded bg-indigo-800/70 hover:bg-indigo-700 text-indigo-100 disabled:opacity-50"
            title="Run LLM memory extraction → promote durable memories (M9.4 an earlier revision). Operator agents write; scoped users dry-run."
          >
            {running ? "consolidating…" : "↻ Run consolidation"}
          </button>
          <span>updated {new Date(d.generated_at).toLocaleTimeString()}</span>
        </div>
      </div>
      {runMsg && <div className="text-[11px] text-indigo-300 bg-indigo-950/40 rounded px-2 py-1">consolidation: {runMsg}</div>}

      <div className="grid lg:grid-cols-2 gap-3">
        <LayerCard n="L1" title="SOUL / system prompt" sub={d.L1_soul.ownerIsOperator ? "operator" : "scoped"}>
          <Kv k="base soul" v={d.L1_soul.liveBaseSoulKind} />
          <Kv k="frozen cached" v={d.L1_soul.frozenStored ? "yes" : "no"} dim={!d.L1_soul.frozenStored} />
          <Kv k="prompt version" v={d.L1_soul.soulPromptVersion ?? "—"} />
        </LayerCard>

        <LayerCard n="L2" title="Compaction / context window">
          {hasError(d.L2_compaction) ? <Err v={d.L2_compaction} /> : (
            <>
              <Kv k="context history" v={d.L2_compaction.contextHistoryCount} />
              <Kv k="hygiene runs" v={d.L2_compaction.hygieneRuns.length === 0 ? <Empty /> : d.L2_compaction.hygieneRuns.map((r, i) => (
                <span key={i} className="mr-2">{r.decision}({r.trigger})</span>
              ))} />
            </>
          )}
        </LayerCard>

        <LayerCard n="L3" title="Agent memories (remember/recall)" sub={`${memTotal} active`}>
          <Kv k="fact / instr" v={`${mem.fact} / ${mem.instruction}`} dim={memTotal === 0} />
          <Kv k="event / task" v={`${mem.event} / ${mem.task}`} dim={memTotal === 0} />
          <Kv k="inactive" v={mem.inactive} dim />
          {memTotal === 0 && <div className="text-amber-400/80 text-[11px] mt-1">empty — agents aren't calling remember yet (M9.4 adoption gap)</div>}
          {/* the memories themselves, not just counts. */}
          <MemList label="facts" items={d.L3_agent_memories.recentFacts} />
          <MemList label="instructions" items={d.L3_agent_memories.recentInstructions} />
        </LayerCard>

        <LayerCard n="CF" title="CF Agent Memory shadow (双路 · operator)" sub="an earlier revision">
          {!d.cf_shadow || d.cf_shadow.enabled === false ? (
            <div className="text-slate-500 text-[11px]">{d.cf_shadow && "note" in d.cf_shadow ? d.cf_shadow.note : "n/a"}</div>
          ) : "error" in d.cf_shadow ? (
            <div className="text-amber-400/80 text-[11px]">shadow unreachable（token/网络）— native layers unaffected</div>
          ) : (
            <div className="mt-1 space-y-1 max-h-56 overflow-y-auto pr-1">
              {d.cf_shadow.memories.length === 0 ? (
                <Empty />
              ) : (
                d.cf_shadow.memories.map((m) => (
                  <div key={m.id} className="text-[11px] leading-snug text-slate-300">
                    <span className="inline-block w-10 text-slate-500 uppercase text-[9px]">{m.type}</span>
                    {m.summary}
                  </div>
                ))
              )}
            </div>
          )}
        </LayerCard>

        <LayerCard n="L4" title="Knowledge (injected into SOUL)">
          {hasError(d.L4_knowledge) ? <Err v={d.L4_knowledge} /> : (
            <Kv k="rows" v={d.L4_knowledge.rowCount === 0 ? <Empty /> : `${d.L4_knowledge.rowCount} (${d.L4_knowledge.keys.slice(0, 6).join(", ")})`} />
          )}
        </LayerCard>

        <LayerCard n="L5" title="Checkpoints / review notes">
          {hasError(d.L5_checkpoints) ? <Err v={d.L5_checkpoints} /> : <Kv k="checkpoints" v={d.L5_checkpoints.count === 0 ? <Empty /> : d.L5_checkpoints.count} />}
          {hasError(d.L5_review_notes) ? <Err v={d.L5_review_notes} /> : <Kv k="review notes" v={d.L5_review_notes.count === 0 ? <Empty /> : d.L5_review_notes.count} />}
        </LayerCard>

        <LayerCard n="L6" title="Conversation archive (cross-session)" sub="registry">
          {hasError(d.L6_conversation_archive) ? <Err v={d.L6_conversation_archive} /> : (
            <>
              <Kv k="chunks" v={d.L6_conversation_archive.chunkCount} />
              <Kv k="flushes" v={d.L6_conversation_archive.flushCount} />
            </>
          )}
        </LayerCard>

        <LayerCard n="✛A" title="Candidates + consolidation (adoption)">
          {hasError(d.crossA_candidates) ? <Err v={d.crossA_candidates} /> : "retired" in d.crossA_candidates && d.crossA_candidates.retired ? (
            <Kv k="kw candidates" v="retired  — see consolidation runs" dim />
          ) : "items" in d.crossA_candidates ? (
            <>
              <Kv k="kw candidates" v={d.crossA_candidates.items.length === 0 ? <Empty /> : d.crossA_candidates.items.length} dim={d.crossA_candidates.items.length === 0} />
              {d.crossA_candidates.blockedReason && <Kv k="blocked" v={d.crossA_candidates.blockedReason} dim />}
            </>
          ) : null}
          <div className="pt-1 mt-1 border-t border-slate-800">
            {runs.length === 0 ? (
              <Kv k="consolidation" v={<Empty />} />
            ) : (
              runs.slice(0, 3).map((r) => (
                <div key={r.run_id} className="flex gap-2 text-[11px]">
                  <span className="text-slate-500 min-w-[7rem]">{new Date(r.created_at).toLocaleDateString()} {r.mode}</span>
                  <span className="text-slate-300">extracted {r.extracted} · promoted {r.promoted} · dup {r.skipped_dup} · {r.parse_status}</span>
                </div>
              ))
            )}
          </div>
        </LayerCard>

        <LayerCard n="✛B" title="Scoping / isolation">
          <Kv k="owner" v={d.crossB_scoping.ownerIsOperator ? "operator" : "scoped user"} />
          <Kv k="agent DO" v={<span className="font-mono">{d.crossB_scoping.agentId}</span>} />
        </LayerCard>
      </div>
    </div>
  );
}

// bounded content list for L3 (the memories themselves).
function MemList({ label, items }: { label: string; items?: Array<{ content: string }> }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-1">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
        {items.map((m, i) => (
          <div key={i} className="text-[11px] leading-snug text-slate-300">{m.content}</div>
        ))}
      </div>
    </div>
  );
}
