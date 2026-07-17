import { useEffect, useState } from "react";
import { authHeaders, clearSecret } from "../auth/secret";

/**
 * the 6-layer memory diagnostic for the active agent.
 * Polls `/api/inspect/memory/layers` (operator-only). Each block can be a
 * `{ error }` marker (fail-soft server-side), so the panel renders defensively.
 */
export interface MemoryLayersView {
  generated_at: string;
  agent_id: string | null;
  L1_soul: {
    liveBaseSoulKind: "operator" | "neutral" | "unknown";
    frozenStored: boolean;
    soulPromptVersion: number | null;
    ownerIsOperator: boolean | null;
  };
  L2_compaction:
    | { contextHistoryCount: number; hygieneRuns: Array<{ trigger: string; decision: string; reason: string | null; beforeCount: number; afterCount: number | null; createdAt: number }> }
    | { error: string };
  L3_agent_memories: {
    counts: { fact: number; instruction: number; event: number; task: number; inactive: number };
    recentFacts?: Array<{ content: string; createdAt: number }>;
    recentInstructions?: Array<{ content: string; createdAt: number }>;
    recentEvents?: Array<{ content: string; createdAt: number }>;
    recentTasks?: Array<{ content: string; createdAt: number }>;
  };
  // the CF Agent Memory shadow, side-by-side (operator only).
  cf_shadow?:
    | { enabled: false; note: string }
    | { enabled: true; error: string }
    | { enabled: true; memories: Array<{ id: string; type: string; summary: string; createdAt: string | null }> };
  L4_knowledge: { rowCount: number; keys: string[] } | { error: string };
  L5_checkpoints: { count: number; recent: Array<{ key: string; createdAt: number }> } | { error: string };
  L5_review_notes: { count: number; recent: Array<{ source: string; createdAt: number }> } | { error: string };
  L6_conversation_archive: { chunkCount: number; flushCount: number; recentFlushes: Array<{ trigger: string; chunkCount: number; status: string; createdAt: number }> } | { error: string };
  crossA_candidates:
    | { ok: boolean; blockedReason: string | null; items: unknown[] }
    | { retired: true; superseded_by: string; note?: string }
    | { error: string };
  crossA_consolidation_runs: ConsolidationRun[];
  crossB_scoping: { agentId: string; ownerIsOperator: boolean | null };
}

export interface ConsolidationRun {
  run_id: string;
  mode: "write" | "dry_run";
  model: string | null;
  extracted: number;
  promoted: number;
  skipped_dup: number;
  below_threshold: number;
  parse_status: string;
  created_at: number;
}

/** POST the consolidation trigger (M9.4 an earlier revision). Returns the ledger entry. */
export async function triggerConsolidation(): Promise<Record<string, unknown>> {
  const res = await fetch("/api/inspect/memory/consolidate", { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

type State = { data: MemoryLayersView | null; loading: boolean; error: string | null };

export function useMemoryLayers(intervalMs = 15_000): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch("/api/inspect/memory/layers", { headers: authHeaders() });
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agentthursday:unauthorized"));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MemoryLayersView;
        if (active) setState({ data, loading: false, error: null });
      } catch (e) {
        if (active) setState((s) => ({ ...s, loading: false, error: String(e) }));
      }
    }
    void poll();
    const timer = window.setInterval(poll, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}
