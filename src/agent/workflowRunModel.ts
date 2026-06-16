/**
 *  —  observable workflow run model: pure ID derivation +
 * row → tree assembly for the workflow ledger.
 *
 * This module is intentionally pure (no DO, no env, no SQL) so the
 * contract — stable id derivation and the `run -> phases -> agents`
 * tree shape — is unit-testable without a Durable Object. The registry
 * DO does the SQL reads/writes and calls into here.
 *
 * v1 run identity (see  / migrations.ts):
 *   - `run_id = wfr-<parent_task_id>` — the observation identity of ONE
 *     manager dispatch invocation. Stable WITHIN a run (all subagents
 *     under one manager task share `parent_task_id`); NOT a
 *     cross-conversation durable id. 's executor mints/owns its
 *     own run identity. The durable contract is this schema + tree shape
 *     + id semantics, not the derivation formula.
 */

export const WORKFLOW_RUN_ID_PREFIX = "wfr-";
export const WORKFLOW_PHASE_ID_PREFIX = "wfp-";
export const WORKFLOW_AGENT_ID_PREFIX = "wfa-";
/** The single explicit default phase a v1 dispatch writes (no inference). */
export const WORKFLOW_DEFAULT_PHASE_NAME = "subagents";
export const PROMPT_PREVIEW_MAX = 200;

export function deriveWorkflowRunId(parentTaskId: string): string {
  return `${WORKFLOW_RUN_ID_PREFIX}${parentTaskId}`;
}

export function deriveDefaultPhaseId(runId: string): string {
  return `${WORKFLOW_PHASE_ID_PREFIX}${runId}-${WORKFLOW_DEFAULT_PHASE_NAME}`;
}

export function deriveAgentNodeId(runId: string, subagentTaskId: string): string {
  return `${WORKFLOW_AGENT_ID_PREFIX}${runId}-${subagentTaskId}`;
}

/**
 * Safe, bounded preview of the USER-FACING dispatch text. Never derive
 * this from a composed system/persona prompt —  §1 forbids
 * leaking internal prompt metadata. Whitespace-collapsed and capped.
 */
export function safePromptPreview(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= PROMPT_PREVIEW_MAX
    ? collapsed
    : `${collapsed.slice(0, PROMPT_PREVIEW_MAX)}…`;
}

// ── Row shapes (mirror the workflow_* tables) ───────────────────────

export interface WorkflowRunRow {
  run_id: string;
  source_task_id: string | null;
  root_agent_id: string | null;
  status: string;
  caps: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowPhaseRow {
  phase_id: string;
  run_id: string;
  name: string;
  status: string;
  phase_order: number;
  depends_on_phase_ids: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowAgentRow {
  agent_node_id: string;
  run_id: string;
  phase_id: string;
  agent_id: string | null;
  task_id: string | null;
  status: string;
  prompt_preview: string | null;
  result_summary: string | null;
  failure_reason: string | null;
  retry_state: string | null;
  rough_token_count: number | null;
  rough_cost: number | null;
  created_at: string;
  updated_at: string;
}

// ── Tree shape (the read API / 385 contract) ────────────────────────

export interface WorkflowCaps {
  max_agents: number | null;
  max_concurrency: number | null;
}

export interface WorkflowAgentNode {
  agent_node_id: string;
  agent_id: string | null;
  task_id: string | null;
  status: string;
  prompt_preview: string | null;
  result_summary: string | null;
  failure_reason: string | null;
  retry_state: string | null;
  rough_token_count: number | null;
  rough_cost: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowPhaseNode {
  phase_id: string;
  name: string;
  status: string;
  order: number;
  depends_on_phase_ids: string[];
  agents: WorkflowAgentNode[];
}

export interface WorkflowRunTree {
  run_id: string;
  source_task_id: string | null;
  root_agent_id: string | null;
  status: string;
  caps: WorkflowCaps | null;
  created_at: string;
  updated_at: string;
  phases: WorkflowPhaseNode[];
}

function parseJsonArray(raw: string | null): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function parseCaps(raw: string | null): WorkflowCaps | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return { max_agents: num(v.max_agents), max_concurrency: num(v.max_concurrency) };
  } catch {
    return null;
  }
}

function toAgentNode(a: WorkflowAgentRow): WorkflowAgentNode {
  return {
    agent_node_id: a.agent_node_id,
    agent_id: a.agent_id,
    task_id: a.task_id,
    status: a.status,
    prompt_preview: a.prompt_preview,
    result_summary: a.result_summary,
    failure_reason: a.failure_reason,
    retry_state: a.retry_state,
    rough_token_count: a.rough_token_count,
    rough_cost: a.rough_cost,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

/**
 * Fold ledger rows into the `run -> phases -> agents` tree. Phases are
 * ordered by `phase_order`; agents within a phase by `created_at`. The
 * tree is built ONLY from the structured ledger rows passed in — never
 * inferred from flat `manager.task.*` events.
 */
export function assembleWorkflowRunTree(
  run: WorkflowRunRow,
  phases: WorkflowPhaseRow[],
  agents: WorkflowAgentRow[],
): WorkflowRunTree {
  const agentsByPhase = new Map<string, WorkflowAgentNode[]>();
  for (const a of agents) {
    const list = agentsByPhase.get(a.phase_id) ?? [];
    list.push(toAgentNode(a));
    agentsByPhase.set(a.phase_id, list);
  }
  const phaseNodes: WorkflowPhaseNode[] = [...phases]
    .sort((x, y) => x.phase_order - y.phase_order)
    .map((p) => ({
      phase_id: p.phase_id,
      name: p.name,
      status: p.status,
      order: p.phase_order,
      depends_on_phase_ids: parseJsonArray(p.depends_on_phase_ids),
      agents: (agentsByPhase.get(p.phase_id) ?? []).sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      ),
    }));
  return {
    run_id: run.run_id,
    source_task_id: run.source_task_id,
    root_agent_id: run.root_agent_id,
    status: run.status,
    caps: parseCaps(run.caps),
    created_at: run.created_at,
    updated_at: run.updated_at,
    phases: phaseNodes,
  };
}
