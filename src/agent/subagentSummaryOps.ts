/**
 * Subagent Artifact Summary Aggregation v1.
 *
 * Pure helpers — no DO, no env, no SQL. The DO @callable wrappers in
 * `src/server.ts` and the manager adapter in
 * `src/skillset/adapters/managerSubagentSummaries.ts` compose these.
 *
 * ADR §6 (PUSH v1) contract:
 *   - Subagent emits one `manager.subagent.summary` event on
 *     `task.reply.finalized` when `task_context.parent_task_id` is
 *     present. Keyed by `parent_task_id` via `event_log.trace_id` so
 *     manager-side reads scope by trace_id without a join.
 *   - Summary shape is bounded: `reply_excerpt` is truncated by UTF-8
 *     byte count (NOT JS string length — multi-byte chars otherwise
 *     slip past a `.length` cap; see an earlier revision memo).
 *   - `artifact_refs` are self-reported by the subagent (v1 trusts the
 *     subagent — full artifact content reads across DOs are DEFERRED
 *     per ADR §6.4 / an earlier revision §5).
 *
 * Permission boundary (ADR §6.3 / an earlier revision §4):
 *   - Manager A can read summaries it issued (`source_agent_id ===
 *     callingAgentId`). Manager B querying A's `parent_task_id` gets
 *     an empty list — NOT an error, NOT leaked metadata.
 */
import type { ArtifactRef } from "./taskContext";

export const SUBAGENT_SUMMARY_EVENT_NAME = "manager.subagent.summary";
export const MAX_REPLY_EXCERPT_BYTES = 500;
export const DEFAULT_SUMMARIES_LIMIT = 20;
export const MAX_SUMMARIES_LIMIT = 50;

export interface SubagentSummary {
  task_id: string;
  agent_id: string;
  parent_task_id: string;
  source_agent_id: string;
  artifact_refs: ArtifactRef[];
  reply_excerpt: string;
  completed_at: string;
}

export interface BuildSubagentSummaryInput {
  task_id: string;
  agent_id: string;
  parent_task_id: string;
  source_agent_id: string;
  artifact_refs?: ArtifactRef[];
  reply_text: string;
  completed_at: string;
}

export function capByUtf8Bytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).byteLength <= maxBytes) return s;
  let head = "";
  let used = 0;
  for (const ch of s) {
    const chBytes = enc.encode(ch).byteLength;
    if (used + chBytes > maxBytes) break;
    head += ch;
    used += chBytes;
  }
  return head;
}

export function buildSubagentSummary(
  input: BuildSubagentSummaryInput,
): SubagentSummary {
  return {
    task_id: input.task_id,
    agent_id: input.agent_id,
    parent_task_id: input.parent_task_id,
    source_agent_id: input.source_agent_id,
    artifact_refs: input.artifact_refs ?? [],
    reply_excerpt: capByUtf8Bytes(input.reply_text ?? "", MAX_REPLY_EXCERPT_BYTES),
    completed_at: input.completed_at,
  };
}

export interface SubagentSummaryRow {
  parent_task_id: string;
  payload: SubagentSummary;
  recorded_at: string;
  /**
   * an earlier revision §4 — v1→v2 `summary_id` bridge. Surfaces the underlying
   * `event_log.id` (DO substrate primary key) so future migration off
   * of `summary_id == subagent task_id` semantics has an addressable
   * stable key. Optional because not every read site goes through the
   * DO @callable (the in-DO emit path still constructs the row before
   * SQL assigns the id).
   */
  event_id?: number;
}

export interface SubagentSummaryFilter {
  parent_task_id?: string;
  source_agent_id?: string;
  limit?: number;
}

/**
 * an earlier revision §4 — permission boundary applied at the reader side.
 *
 * Only rows where `source_agent_id === callingAgentId` survive. Then
 * `parent_task_id` / `source_agent_id` are applied as optional
 * filters. `limit` is clamped to [1, MAX_SUMMARIES_LIMIT] and defaults
 * to DEFAULT_SUMMARIES_LIMIT.
 *
 * Returns the bounded list in input order (callers pass rows already
 * sorted by `recorded_at DESC` — most recent first).
 */
export function filterSubagentSummariesForReader(
  rows: readonly SubagentSummaryRow[],
  callingAgentId: string,
  opts: SubagentSummaryFilter = {},
): SubagentSummary[] {
  const requestedLimit = typeof opts.limit === "number" && Number.isFinite(opts.limit)
    ? Math.floor(opts.limit)
    : DEFAULT_SUMMARIES_LIMIT;
  const limit = Math.max(1, Math.min(MAX_SUMMARIES_LIMIT, requestedLimit));
  const out: SubagentSummary[] = [];
  for (const row of rows) {
    const summary = row.payload;
    if (summary.source_agent_id !== callingAgentId) continue;
    if (
      typeof opts.parent_task_id === "string" &&
      opts.parent_task_id.length > 0 &&
      summary.parent_task_id !== opts.parent_task_id
    ) {
      continue;
    }
    if (
      typeof opts.source_agent_id === "string" &&
      opts.source_agent_id.length > 0 &&
      summary.source_agent_id !== opts.source_agent_id
    ) {
      continue;
    }
    out.push(summary);
    if (out.length >= limit) break;
  }
  return out;
}
