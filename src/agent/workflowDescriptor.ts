/**
 * orchestration-as-code executor v1: pure workflow descriptor
 * contract (schema + validator), executor-owned id derivation, and phase
 * dependency ordering. Pure (no DO/env/SQL) so the contract is
 * unit-testable; the executor (Cloudflare Workflow) consumes it.
 *
 * Executor run identity is DISTINCT from an earlier revision's ad-hoc
 * `wfr-<parent_task_id>`: the executor mints/owns `wfr-exec-<short-id>`.
 * an earlier revision's run id observes the current ad-hoc manager dispatch; the
 * executor is a new run owner and must not reuse a manager task id as a
 * long-term workflow run id.
 */

import { z } from "zod";

// ── Descriptor schema (v1 contract — declarative, not arbitrary JS) ──

export const WorkflowDescriptorAgentSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1),
  role: z.string().optional(),
});

export const WorkflowDescriptorPhaseSchema = z.object({
  phase_id: z.string().min(1),
  name: z.string().min(1),
  depends_on_phase_ids: z.array(z.string()).optional(),
  // a phase with no agents is rejected (min 1)
  agents: z.array(WorkflowDescriptorAgentSchema).min(1),
});

export const WorkflowDescriptorCapsSchema = z
  .object({
    max_agents: z.number().int().positive().optional(),
    max_concurrency: z.number().int().positive().optional(),
  })
  .optional();

export const WorkflowDescriptorSchema = z.object({
  descriptor_id: z.string().min(1),
  name: z.string().min(1),
  root_agent_id: z.string().optional(),
  caps: WorkflowDescriptorCapsSchema,
  // empty phases rejected (min 1)
  phases: z.array(WorkflowDescriptorPhaseSchema).min(1),
});

export type WorkflowDescriptorAgent = z.infer<typeof WorkflowDescriptorAgentSchema>;
export type WorkflowDescriptorPhase = z.infer<typeof WorkflowDescriptorPhaseSchema>;
export type WorkflowDescriptor = z.infer<typeof WorkflowDescriptorSchema>;

// ── Executor-owned id derivation (stable within a run) ──────────────

export function deriveExecutorRunId(shortId: string): string {
  return `wfr-exec-${shortId}`;
}

export function deriveExecutorPhaseId(runId: string, descriptorPhaseId: string): string {
  return `${runId}-p-${descriptorPhaseId}`;
}

export function deriveExecutorAgentNodeId(phaseId: string, agentIndex: number): string {
  return `${phaseId}-a-${agentIndex}`;
}

// ── Phase dependency ordering (topological sort) ────────────────────

export interface PhaseOrderOk {
  ok: true;
  order: string[];
}
export interface PhaseOrderErr {
  ok: false;
  errors: string[];
}

/**
 * Kahn topological sort over `depends_on_phase_ids`. Ties are broken by
 * descriptor order for determinism. Returns a hard error (NOT a throw
 * into the void) on a cycle — the caller surfaces it as a validation
 * failure / run failure so the executor never silently runs a bad DAG.
 * Assumes deps already validated to exist (validateWorkflowDescriptor
 * checks missing/self deps first).
 */
export function orderPhasesByDependency(
  phases: ReadonlyArray<{ phase_id: string; depends_on_phase_ids?: string[] }>,
): PhaseOrderOk | PhaseOrderErr {
  const ids = phases.map((p) => p.phase_id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const p of phases) {
    const deps = (p.depends_on_phase_ids ?? []).filter((d) => idSet.has(d) && d !== p.phase_id);
    indeg.set(p.phase_id, deps.length);
    for (const d of deps) dependents.get(d)!.push(p.phase_id);
  }
  // Seed queue in descriptor order for deterministic output.
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dep of dependents.get(id)!) {
      indeg.set(dep, indeg.get(dep)! - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    return { ok: false, errors: [`phase dependency cycle among: ${remaining.join(", ")}`] };
  }
  return { ok: true, order };
}

// ── Validator ───────────────────────────────────────────────────────

export interface DescriptorValidationOk {
  ok: true;
  descriptor: WorkflowDescriptor;
  /** descriptor phase_ids in dependency execution order. */
  order: string[];
  total_agents: number;
}
export interface DescriptorValidationErr {
  ok: false;
  errors: string[];
}

/**
 * Validate a raw descriptor. Beyond the zod shape, rejects: duplicate
 * phase_ids, deps referencing a non-existent phase, self-deps, total
 * agents exceeding `caps.max_agents` (VALIDATION — caps enforcement is
 * an earlier revision, not here), and dependency cycles. Returns the dependency
 * execution order on success.
 */
export function validateWorkflowDescriptor(
  raw: unknown,
): DescriptorValidationOk | DescriptorValidationErr {
  const parsed = WorkflowDescriptorSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.length ? i.path.join(".") : "descriptor"}: ${i.message}`,
      ),
    };
  }
  const d = parsed.data;
  const errors: string[] = [];

  // duplicate phase_ids
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const p of d.phases) {
    if (seen.has(p.phase_id)) dups.add(p.phase_id);
    seen.add(p.phase_id);
  }
  if (dups.size > 0) errors.push(`duplicate phase_id(s): ${[...dups].join(", ")}`);

  // deps reference existing phases; no self-dep
  const phaseIdSet = new Set(d.phases.map((p) => p.phase_id));
  for (const p of d.phases) {
    for (const dep of p.depends_on_phase_ids ?? []) {
      if (dep === p.phase_id) errors.push(`phase '${p.phase_id}' depends on itself`);
      else if (!phaseIdSet.has(dep)) {
        errors.push(`phase '${p.phase_id}' depends on unknown phase '${dep}'`);
      }
    }
  }

  // caps validation (NOT enforcement): total agents must not exceed max_agents
  const totalAgents = d.phases.reduce((n, p) => n + p.agents.length, 0);
  const maxAgents = d.caps?.max_agents;
  if (typeof maxAgents === "number" && totalAgents > maxAgents) {
    errors.push(`descriptor has ${totalAgents} agents, exceeds caps.max_agents=${maxAgents}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // cycle detection (only meaningful once dup/missing deps are clean)
  const ordered = orderPhasesByDependency(d.phases);
  if (!ordered.ok) return { ok: false, errors: ordered.errors };

  return { ok: true, descriptor: d, order: ordered.order, total_agents: totalAgents };
}
