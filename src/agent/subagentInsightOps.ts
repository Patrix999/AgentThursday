/**
 * M9.4 A: 群体记忆第二步 (subagent insight promotion v1).
 *
 * Pure helpers — no DO, no env, no SQL. The DO @callable wrappers
 * (`pushSubagentInsight` / `readSubagentInsights`) and the
 * `consolidateMemories` ingest/push glue in `src/server.ts` compose these.
 *
 * Flow: a subagent, at finalize, consolidates its own insights into its own
 * `agent_memories`, then PUSHES the freshly-promoted ones to the registry
 * keyed by `parent_task_id` (mirror of an earlier revision's summary push). The
 * dispatching parent, at its own consolidation, READS the insights keyed by
 * its finalizing task id, OWNER-checks them (fail-closed), and ingests them as
 * extraction candidates tagged `source="subagent:<id>"` — reusing an earlier revision's
 * dedup / supersede / confidence promote path. Insights die with neither DO;
 * they compound in the parent's memory.
 *
 * Trust boundary: promotion is a cross-agent amplifier — a hallucinated
 * subagent insight would otherwise propagate. `filterInsightsByOwner` is the
 * fail-closed gate (same-owner only, never cross-tenant); confidence + an earlier revision
 * contradiction-pruning run downstream in `consolidateMemoriesFree`.
 */
import type { ExtractedMemory } from "./memoryOps";

export const SUBAGENT_INSIGHT_EVENT_NAME = "manager.subagent.insight";
export const MAX_INSIGHTS_PER_PUSH = 10;
export const MAX_INGEST_CANDIDATES = 20;

export interface PromotedInsight {
  type: string;
  content: string;
  confidence: number;
}

export interface SubagentInsightPayload {
  parent_task_id: string;
  source_agent_id: string;
  /** The subagent's resolved owner — the parent-side read filters on this. */
  owner_user_id: string;
  insights: PromotedInsight[];
  completed_at: string;
}

export interface BuildSubagentInsightInput {
  parent_task_id: string;
  source_agent_id: string;
  owner_user_id: string;
  insights: PromotedInsight[];
  completed_at: string;
}

export function buildSubagentInsightPayload(
  input: BuildSubagentInsightInput,
): SubagentInsightPayload {
  return {
    parent_task_id: input.parent_task_id,
    source_agent_id: input.source_agent_id,
    owner_user_id: input.owner_user_id,
    insights: (input.insights ?? []).slice(0, MAX_INSIGHTS_PER_PUSH),
    completed_at: input.completed_at,
  };
}

/**
 * Owner fail-closed gate (the security boundary). Keeps ONLY payloads whose
 * `owner_user_id` matches the ingesting parent's owner. A non-string or
 * mismatched owner is dropped — a subagent's insight never crosses tenants.
 */
export function filterInsightsByOwner(
  payloads: readonly SubagentInsightPayload[],
  parentOwnerId: string,
): SubagentInsightPayload[] {
  if (typeof parentOwnerId !== "string" || parentOwnerId.length === 0) return [];
  return payloads.filter(
    (p) => typeof p.owner_user_id === "string" && p.owner_user_id === parentOwnerId,
  );
}

/**
 * Flatten owner-checked insight payloads into extraction candidates, tagged
 * with `source="subagent:<agent-id>"` provenance so the promoted parent memory
 * is attributable. Bounded to `MAX_INGEST_CANDIDATES`; skips blank content.
 */
export function insightsToCandidates(
  payloads: readonly SubagentInsightPayload[],
): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  for (const p of payloads) {
    for (const ins of p.insights ?? []) {
      const content = typeof ins.content === "string" ? ins.content.trim() : "";
      if (content.length === 0) continue;
      out.push({
        type: ins.type === "instruction" || ins.type === "preference" ? "instruction" : "fact",
        content,
        confidence: typeof ins.confidence === "number" ? ins.confidence : 0,
        reason: `promoted from subagent ${p.source_agent_id}`,
        source: `subagent:${p.source_agent_id}`,
      });
      if (out.length >= MAX_INGEST_CANDIDATES) return out;
    }
  }
  return out;
}
