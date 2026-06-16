/**
 *  — named workflow helpers (pure).
 *
 * A saved workflow descriptor can carry `{{args.key}}` placeholders in
 * its agent prompts; `substituteWorkflowArgs` resolves them at
 * run-named time. Unresolved placeholders are a structured error — a
 * prompt with a literal `{{args.topic}}` left in would silently
 * confuse the subagent, so missing args fail fast instead.
 */

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateWorkflowName(name: unknown): name is string {
  return typeof name === "string" && WORKFLOW_NAME_RE.test(name);
}

const ARG_PLACEHOLDER_RE = /\{\{\s*args\.([a-zA-Z0-9_]+)\s*\}\}/g;

export interface SubstituteArgsResult {
  ok: boolean;
  descriptor?: unknown;
  missing?: string[];
}

/**
 * Walks `phases[].agents[].prompt` strings replacing `{{args.key}}`
 * with `args[key]`. Returns `{ok:false, missing}` listing every
 * placeholder key with no corresponding arg. Non-string / absent
 * structure is passed through untouched — the  validator runs
 * AFTER substitution and owns shape errors.
 */
export function substituteWorkflowArgs(
  rawDescriptor: unknown,
  args: Record<string, string> | undefined,
): SubstituteArgsResult {
  const provided = args ?? {};
  const missing = new Set<string>();
  // Deep-clone via JSON so the stored descriptor row is never mutated.
  const descriptor = JSON.parse(JSON.stringify(rawDescriptor ?? null)) as unknown;
  const phases = (descriptor as { phases?: unknown })?.phases;
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      const agents = (phase as { agents?: unknown })?.agents;
      if (!Array.isArray(agents)) continue;
      for (const agent of agents) {
        const a = agent as { prompt?: unknown };
        if (typeof a.prompt !== "string") continue;
        a.prompt = a.prompt.replace(ARG_PLACEHOLDER_RE, (whole, key: string) => {
          if (Object.prototype.hasOwnProperty.call(provided, key)) {
            return provided[key];
          }
          missing.add(key);
          return whole;
        });
      }
    }
  }
  if (missing.size > 0) {
    return { ok: false, missing: [...missing].sort() };
  }
  return { ok: true, descriptor };
}

export interface WorkflowDescriptorRow {
  name: string;
  version: number;
  descriptor_json: string;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowDescriptorSummary {
  name: string;
  version: number;
  phase_count: number;
  agent_count: number;
  updated_at: string;
}

export function summarizeDescriptorRow(
  row: WorkflowDescriptorRow,
): WorkflowDescriptorSummary {
  let phaseCount = 0;
  let agentCount = 0;
  try {
    const d = JSON.parse(row.descriptor_json) as { phases?: Array<{ agents?: unknown[] }> };
    if (Array.isArray(d.phases)) {
      phaseCount = d.phases.length;
      for (const p of d.phases) {
        if (Array.isArray(p.agents)) agentCount += p.agents.length;
      }
    }
  } catch { /* fail-soft: counts stay 0 */ }
  return {
    name: row.name,
    version: row.version,
    phase_count: phaseCount,
    agent_count: agentCount,
    updated_at: row.updated_at,
  };
}

// ──  — executor phase-result piping ─────────────────────────
// A descriptor prompt may reference earlier phases' outputs with
// `{{<phase_id>.result}}` (observed organically in 's
// agent-ops-manual-v2 descriptor before the capability existed). The
// executor substitutes the joined full replies of that phase at
// dispatch time. Injection is byte-capped (UTF-8, not string.length —
// multi-byte lesson from ) so a verbose phase can't blow the
// downstream prompt past the known ~18KB manager-loop cliff with
// margin.

const PHASE_RESULT_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.result\s*\}\}/g;
export const PHASE_PIPE_BYTE_CAP = 24 * 1024;

export interface PhasePipeResult {
  prompt: string;
  resolved: string[];
  unresolved: string[];
}

export function substitutePhaseResults(
  prompt: string,
  phaseReplies: ReadonlyMap<string, readonly string[]>,
): PhasePipeResult {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const enc = new TextEncoder();
  let budget = PHASE_PIPE_BYTE_CAP;
  const out = prompt.replace(PHASE_RESULT_RE, (whole, phaseId: string) => {
    const replies = phaseReplies.get(phaseId);
    if (!replies || replies.length === 0) {
      unresolved.push(phaseId);
      return whole;
    }
    resolved.push(phaseId);
    let joined = replies.join("\n\n---\n\n");
    const bytes = enc.encode(joined);
    if (bytes.length > budget) {
      // Truncate on a byte budget, then decode back (lossy tail ok).
      joined = new TextDecoder().decode(bytes.slice(0, Math.max(0, budget))) + "\n…[truncated]";
    }
    budget = Math.max(0, budget - bytes.length);
    return joined;
  });
  return { prompt: out, resolved: [...new Set(resolved)], unresolved: [...new Set(unresolved)] };
}
