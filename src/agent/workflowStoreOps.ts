/**
 * Multi-tenancy (2026-06-18) — owner-scoped named-workflow descriptor store.
 *
 * Pure helpers backing the `saveWorkflowDescriptor` / `readWorkflowDescriptor`
 * / `listWorkflowDescriptors` @callable methods on the registry DO
 * (DEMO_INSTANCE), mirroring the shape of `customSkillsetOps.ts`. The SQL —
 * including the cross-tenant name-clobber guard and the owner read filter —
 * lives HERE so the DO callables hold no SQL of their own (tested path ==
 * shipped path).
 *
 * Isolation model (STRICT-OWN — unlike custom_skillset there is NO system /
 * baseline seeding for workflows, so a scoped user sees ONLY its own rows):
 *   · `name` is the sole PRIMARY KEY and is GLOBAL. A scoped user calling
 *     `workflow_save` with a name another tenant owns must NOT clobber it —
 *     `saveWorkflowDescriptorRow` refuses with `name_taken`.
 *   · reads take `scopeOwnerId`: a string = a scoped tenant (own rows only),
 *     `undefined` = admin (unfiltered, sees all — operator unchanged).
 */
import { ADMIN_USER_ID, ownerUserIdFor, scopeOwnerIdFor, type RequestIdentity } from "./requestIdentity";
import type { WorkflowDescriptorRow } from "./workflowNamed";
import { deriveWorkflowRunId, deriveDefaultPhaseId, deriveAgentNodeId, WORKFLOW_DEFAULT_PHASE_NAME } from "./workflowRunModel";

/**
 * Pure fail-closed decision for the OWNER STAMP on a workflow save. managerOps
 * does the I/O (`resolveAgentOwnerIdentity`) and feeds the result here:
 *   · no calling agent (operator path) → admin sentinel.
 *   · resolved identity → that owner's stamp id.
 *   · null (named-but-unresolvable owner) → refuse (mirrors
 *     dispatch_owner_unresolved). NEVER falls back to admin — that would be the
 *     fail-open hole.
 */
export function decideWorkflowSaveOwner(
  callingAgentId: string | null | undefined,
  identity: RequestIdentity | null,
): { ok: true; ownerUserId: string } | { ok: false } {
  if (!callingAgentId) return { ok: true, ownerUserId: ADMIN_USER_ID };
  if (identity === null) return { ok: false };
  return { ok: true, ownerUserId: ownerUserIdFor(identity) };
}

/**
 * Pure fail-closed decision for the READ SCOPE of an owner-scoped workflow
 * read. managerOps does the I/O and feeds the result here:
 *   · no calling agent (operator path) → undefined (unscoped, sees all).
 *   · resolved identity → user → own id; admin → undefined (unscoped).
 *   · null (named-but-unresolvable owner) → refuse. NEVER returns `undefined`
 *     (= unfiltered = all-tenants) on failure — that is the fail-open hole.
 */
export function decideWorkflowReadScope(
  callingAgentId: string | null | undefined,
  identity: RequestIdentity | null,
): { ok: true; scopeOwnerId: string | undefined } | { ok: false } {
  if (!callingAgentId) return { ok: true, scopeOwnerId: undefined };
  if (identity === null) return { ok: false };
  return { ok: true, scopeOwnerId: scopeOwnerIdFor(identity) };
}

export type WorkflowStoreSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface WorkflowStoreHost {
  sql: WorkflowStoreSqlTag;
  logEvent: (type: string, payload: unknown) => void;
}

/**
 * write the ledger rows for an ad-hoc manager→subagent dispatch:
 * upsert the run (owner-stamped on first INSERT), bump `updated_at`, and
 * INSERT-OR-IGNORE the default phase + the dispatched agent node. Pure SQL; the
 * @callable keeps the fail-soft try/catch + `workflow.ledger.write_error` log.
 * (M2 2026-07-01 — extracted verbatim from the inline `recordWorkflowDispatch`.)
 */
export function recordWorkflowDispatchRows(host: WorkflowStoreHost, input: {
  parent_task_id: string;
  source_agent_id: string | null;
  subagent_agent_id: string | null;
  subagent_task_id: string;
  prompt_preview: string | null;
  owner: string;
  now: string;
}): void {
  const runId = deriveWorkflowRunId(input.parent_task_id);
  const phaseId = deriveDefaultPhaseId(runId);
  const agentNodeId = deriveAgentNodeId(runId, input.subagent_task_id);
  host.sql`
    INSERT OR IGNORE INTO workflow_run (run_id, source_task_id, root_agent_id, status, caps, created_at, updated_at, owner_user_id)
    VALUES (${runId}, ${input.parent_task_id}, ${input.source_agent_id}, 'active', NULL, ${input.now}, ${input.now}, ${input.owner})
  `;
  host.sql`UPDATE workflow_run SET updated_at = ${input.now} WHERE run_id = ${runId}`;
  host.sql`
    INSERT OR IGNORE INTO workflow_phase (phase_id, run_id, name, status, phase_order, depends_on_phase_ids, created_at, updated_at)
    VALUES (${phaseId}, ${runId}, ${WORKFLOW_DEFAULT_PHASE_NAME}, 'active', 0, NULL, ${input.now}, ${input.now})
  `;
  host.sql`
    INSERT OR IGNORE INTO workflow_agent (agent_node_id, run_id, phase_id, agent_id, task_id, status, prompt_preview, result_summary, failure_reason, retry_state, rough_token_count, rough_cost, created_at, updated_at)
    VALUES (${agentNodeId}, ${runId}, ${phaseId}, ${input.subagent_agent_id}, ${input.subagent_task_id}, 'dispatched', ${input.prompt_preview}, NULL, NULL, NULL, NULL, NULL, ${input.now}, ${input.now})
  `;
}

// ── workflow-run ledger SQL (M2 2026-07-01, extracted verbatim from
// the inline `record*/update*Workflow*` @callables). Pure SQL; each @callable
// keeps its fail-soft try/catch + `_logWorkflowLedgerError` + any logEvent. ──

export function recordWorkflowRunStartRows(host: WorkflowStoreHost, input: {
  run_id: string; source_task_id: string | null; root_agent_id: string | null;
  caps_json: string | null; owner: string; now: string;
}): void {
  host.sql`
    INSERT OR IGNORE INTO workflow_run (run_id, source_task_id, root_agent_id, status, caps, created_at, updated_at, owner_user_id)
    VALUES (${input.run_id}, ${input.source_task_id}, ${input.root_agent_id}, 'running', ${input.caps_json}, ${input.now}, ${input.now}, ${input.owner})
  `;
  host.sql`UPDATE workflow_run SET updated_at = ${input.now} WHERE run_id = ${input.run_id}`;
}

export function upsertWorkflowPhaseRow(host: WorkflowStoreHost, input: {
  phase_id: string; run_id: string; name: string; phase_order: number;
  depends_on_phase_ids_json: string | null; now: string;
}): void {
  host.sql`
    INSERT OR IGNORE INTO workflow_phase (phase_id, run_id, name, status, phase_order, depends_on_phase_ids, created_at, updated_at)
    VALUES (${input.phase_id}, ${input.run_id}, ${input.name}, 'pending', ${input.phase_order}, ${input.depends_on_phase_ids_json}, ${input.now}, ${input.now})
  `;
}

export function updateWorkflowPhaseStatusRow(host: WorkflowStoreHost, phaseId: string, status: string, now: string): void {
  host.sql`UPDATE workflow_phase SET status = ${status}, updated_at = ${now} WHERE phase_id = ${phaseId}`;
}

export function recordWorkflowAgentRow(host: WorkflowStoreHost, input: {
  agent_node_id: string; run_id: string; phase_id: string; agent_id: string | null;
  prompt_preview: string | null; now: string;
}): void {
  host.sql`
    INSERT OR IGNORE INTO workflow_agent (agent_node_id, run_id, phase_id, agent_id, task_id, status, prompt_preview, result_summary, failure_reason, retry_state, rough_token_count, rough_cost, created_at, updated_at)
    VALUES (${input.agent_node_id}, ${input.run_id}, ${input.phase_id}, ${input.agent_id}, NULL, 'pending', ${input.prompt_preview}, NULL, NULL, NULL, NULL, NULL, ${input.now}, ${input.now})
  `;
}

export function updateWorkflowAgentStatusRow(host: WorkflowStoreHost, input: {
  agent_node_id: string; status: string; task_id?: string | null;
  result_summary?: string | null; failure_reason?: string | null; now: string;
}): void {
  // COALESCE keeps the existing value when the field isn't supplied.
  host.sql`
    UPDATE workflow_agent SET
      status = ${input.status},
      task_id = COALESCE(${input.task_id ?? null}, task_id),
      result_summary = COALESCE(${input.result_summary ?? null}, result_summary),
      failure_reason = COALESCE(${input.failure_reason ?? null}, failure_reason),
      updated_at = ${input.now}
    WHERE agent_node_id = ${input.agent_node_id}
  `;
}

export function updateWorkflowRunStatusRow(host: WorkflowStoreHost, runId: string, status: string, now: string): void {
  host.sql`UPDATE workflow_run SET status = ${status}, updated_at = ${now} WHERE run_id = ${runId}`;
}

export type SaveWorkflowDescriptorResult =
  | { ok: true; name: string; version: number }
  | { ok: false; name: string; version: number; error: "name_taken" };

/**
 * Upsert a named workflow descriptor, stamped with the saving agent's owner.
 *
 * Cross-tenant clobber guard: `name` is the sole PRIMARY KEY, so an
 * ON CONFLICT upsert by a scoped user would overwrite a same-named row owned
 * by the operator or another tenant. We refuse when an existing row has a
 * DIFFERENT owner and the caller is scoped (non-admin). The admin sentinel
 * keeps the original upsert (operator unchanged). `owner_user_id` is never
 * overwritten in the UPDATE clause — a same-owner re-save keeps its owner; a
 * cross-owner save was already refused.
 */
export function saveWorkflowDescriptorRow(
  host: WorkflowStoreHost,
  input: {
    name: string;
    descriptor_json: string;
    created_by_agent_id: string | null;
    owner_user_id: string;
  },
  now: string,
): SaveWorkflowDescriptorResult {
  const existing = host.sql<{ version: number; owner_user_id: string }>`
    SELECT version, owner_user_id FROM workflow_descriptor WHERE name = ${input.name} LIMIT 1
  `;
  if (
    existing.length > 0 &&
    input.owner_user_id !== ADMIN_USER_ID &&
    existing[0].owner_user_id !== input.owner_user_id
  ) {
    return { ok: false, name: input.name, version: existing[0].version, error: "name_taken" };
  }
  const version = existing.length > 0 ? existing[0].version + 1 : 1;
  host.sql`
    INSERT INTO workflow_descriptor (name, version, descriptor_json, created_by_agent_id, created_at, updated_at, owner_user_id)
    VALUES (${input.name}, ${version}, ${input.descriptor_json}, ${input.created_by_agent_id}, ${now}, ${now}, ${input.owner_user_id})
    ON CONFLICT(name) DO UPDATE SET
      version = ${version},
      descriptor_json = ${input.descriptor_json},
      updated_at = ${now}
  `;
  host.logEvent("workflow.descriptor.saved", {
    name: input.name,
    version,
    created_by_agent_id: input.created_by_agent_id,
  });
  return { ok: true, name: input.name, version };
}

/**
 * Read one descriptor by name, owner-scoped. A scoped caller that doesn't own
 * the row reads `null` — indistinguishable from nonexistent (no existence
 * leak). Admin (undefined scope) reads any row.
 */
export function readWorkflowDescriptorRow(
  host: WorkflowStoreHost,
  name: string,
  scopeOwnerId?: string,
): WorkflowDescriptorRow | null {
  const rows = host.sql<WorkflowDescriptorRow & { owner_user_id: string }>`
    SELECT name, version, descriptor_json, created_by_agent_id, created_at, updated_at, owner_user_id
    FROM workflow_descriptor WHERE name = ${name} LIMIT 1
  `;
  if (rows.length === 0) return null;
  if (scopeOwnerId !== undefined && rows[0].owner_user_id !== scopeOwnerId) return null;
  return toDescriptorRow(rows[0]);
}

/**
 * List descriptors, owner-scoped (strict-own). A scoped caller only sees its
 * OWN workflows; admin (undefined scope) sees all — byte-identical SQL to
 * pre-multitenancy for the admin path.
 */
export function listWorkflowDescriptorRows(
  host: WorkflowStoreHost,
  scopeOwnerId?: string,
): WorkflowDescriptorRow[] {
  const rows = scopeOwnerId !== undefined
    ? host.sql<WorkflowDescriptorRow & { owner_user_id: string }>`
        SELECT name, version, descriptor_json, created_by_agent_id, created_at, updated_at, owner_user_id
        FROM workflow_descriptor WHERE owner_user_id = ${scopeOwnerId}
        ORDER BY updated_at DESC LIMIT 100`
    : host.sql<WorkflowDescriptorRow & { owner_user_id: string }>`
        SELECT name, version, descriptor_json, created_by_agent_id, created_at, updated_at, owner_user_id
        FROM workflow_descriptor ORDER BY updated_at DESC LIMIT 100`;
  return rows.map(toDescriptorRow);
}

function toDescriptorRow(r: WorkflowDescriptorRow & { owner_user_id: string }): WorkflowDescriptorRow {
  return {
    name: r.name,
    version: r.version,
    descriptor_json: r.descriptor_json,
    created_by_agent_id: r.created_by_agent_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
