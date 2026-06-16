import type { AgentRunWorkflowParams } from "../workflows/AgentRunWorkflow";

/**
 *  —  `agent_run` orchestration ops.
 *
 * Two layers:
 *  1. Pure SQL helpers (`createAgentRunRow` / `readAgentRunRow` /
 *     `updateAgentRunRow`) backing the @callable methods on the
 *     AgentThursdayAgent registry DO. Mirror the AgentProfileHost shape so
 *     the `runAgentMigrations` substrate is the same.
 *  2. The composition entry `createAgentRun(host, input)` minted by
 *     `POST /api/agent-runs`: creates the workflow instance via
 *     the AGENT_RUN_WORKFLOW binding AND persists the durable
 *     `agent_run` row on the registry DO via the callable surface.
 *
 * Workflow create is called BEFORE the row insert so `run_id` and
 * `workflow_instance_id` are both known to the registry; first-write-
 * wins idempotency is enforced inside `AgentRunWorkflow.run` (Card
 * 346 §D-2).
 */

export type AgentRunSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface AgentRunHost {
  sql: AgentRunSqlTag;
}

export type AgentRunRow = {
  run_id: string;
  profile_id: string;
  workflow_instance_id: string;
  status: "started" | "awaiting_event" | "ok" | "failed" | "timeout";
  turn_id: string | null;
  envelope_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRunRawRow = {
  run_id: string;
  profile_id: string;
  workflow_instance_id: string;
  status: string;
  turn_id: string | null;
  envelope_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function rowToAgentRun(r: AgentRunRawRow): AgentRunRow {
  return {
    run_id: r.run_id,
    profile_id: r.profile_id,
    workflow_instance_id: r.workflow_instance_id,
    status: r.status as AgentRunRow["status"],
    turn_id: r.turn_id,
    envelope_id: r.envelope_id,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export type CreateAgentRunRowInput = {
  run_id: string;
  profile_id: string;
  workflow_instance_id: string;
};

export function createAgentRunRow(host: AgentRunHost, input: CreateAgentRunRowInput): AgentRunRow {
  const ts = nowIso();
  host.sql`
    INSERT INTO agent_run
      (run_id, profile_id, workflow_instance_id, status, turn_id, envelope_id, error, created_at, updated_at)
    VALUES
      (${input.run_id}, ${input.profile_id}, ${input.workflow_instance_id},
       'started', NULL, NULL, NULL, ${ts}, ${ts})
  `;
  return {
    run_id: input.run_id,
    profile_id: input.profile_id,
    workflow_instance_id: input.workflow_instance_id,
    status: "started",
    turn_id: null,
    envelope_id: null,
    error: null,
    created_at: ts,
    updated_at: ts,
  };
}

export function readAgentRunRow(host: AgentRunHost, runId: string): AgentRunRow | null {
  const rows = host.sql<AgentRunRawRow>`
    SELECT run_id, profile_id, workflow_instance_id, status, turn_id, envelope_id, error, created_at, updated_at
    FROM agent_run
    WHERE run_id = ${runId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToAgentRun(rows[0]);
}

//  — list endpoint backing `GET /api/agent-runs`.
// JOIN against `agent_profile` so the list can show a cheap human
// name without a second round-trip; same DO, same SQLite, no
// cross-DO read. `profile_name` is nullable in case the profile was
// hard-deleted (current model: archive, not delete — kept defensive).
//
// `resume_turn_id` is NOT in the row ( D-3(c) — lives only in
// workflow describe output) so it does not appear here. Spec §1 lists
// it as "if present"; the honest implementation is "not present on the
// list at all". Detail page also cannot fetch it without describe.

export type AgentRunListRow = AgentRunRow & {
  profile_name: string | null;
};

type AgentRunListRawRow = AgentRunRawRow & { profile_name: string | null };

export type ListAgentRunsOptions = {
  profile_id?: string;
  /** Bounded by callers; this helper trusts the bound. */
  limit?: number;
};

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

export function listAgentRunRows(
  host: AgentRunHost,
  opts: ListAgentRunsOptions = {},
): AgentRunListRow[] {
  const requested = typeof opts.limit === "number" && Number.isFinite(opts.limit)
    ? Math.floor(opts.limit)
    : LIST_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, requested));
  const rows = opts.profile_id
    ? host.sql<AgentRunListRawRow>`
        SELECT r.run_id, r.profile_id, r.workflow_instance_id, r.status,
               r.turn_id, r.envelope_id, r.error, r.created_at, r.updated_at,
               p.name AS profile_name
        FROM agent_run r
        LEFT JOIN agent_profile p ON p.id = r.profile_id
        WHERE r.profile_id = ${opts.profile_id}
        ORDER BY r.created_at DESC
        LIMIT ${limit}
      `
    : host.sql<AgentRunListRawRow>`
        SELECT r.run_id, r.profile_id, r.workflow_instance_id, r.status,
               r.turn_id, r.envelope_id, r.error, r.created_at, r.updated_at,
               p.name AS profile_name
        FROM agent_run r
        LEFT JOIN agent_profile p ON p.id = r.profile_id
        ORDER BY r.created_at DESC
        LIMIT ${limit}
      `;
  return rows.map((r) => ({ ...rowToAgentRun(r), profile_name: r.profile_name ?? null }));
}

export type MarkAgentRunCompleteInput = {
  run_id: string;
  turn_id: string;
  envelope_id: string;
};

export function markAgentRunCompleteRow(host: AgentRunHost, input: MarkAgentRunCompleteInput): void {
  const ts = nowIso();
  host.sql`
    UPDATE agent_run
       SET status = 'ok',
           turn_id = ${input.turn_id},
           envelope_id = ${input.envelope_id},
           updated_at = ${ts}
     WHERE run_id = ${input.run_id}
  `;
}

export type MarkAgentRunFailedInput = {
  run_id: string;
  error: string;
};

export function markAgentRunFailedRow(host: AgentRunHost, input: MarkAgentRunFailedInput): void {
  const ts = nowIso();
  host.sql`
    UPDATE agent_run
       SET status = 'failed',
           error = ${input.error},
           updated_at = ${ts}
     WHERE run_id = ${input.run_id}
  `;
}

export type MarkAgentRunAwaitingEventInput = {
  run_id: string;
};

export function markAgentRunAwaitingEventRow(
  host: AgentRunHost,
  input: MarkAgentRunAwaitingEventInput,
): void {
  const ts = nowIso();
  host.sql`
    UPDATE agent_run
       SET status = 'awaiting_event',
           updated_at = ${ts}
     WHERE run_id = ${input.run_id}
  `;
}

export type MarkAgentRunTimedOutInput = {
  run_id: string;
  reason: string;
};

export function markAgentRunTimedOutRow(
  host: AgentRunHost,
  input: MarkAgentRunTimedOutInput,
): void {
  const ts = nowIso();
  host.sql`
    UPDATE agent_run
       SET status = 'timeout',
           error = ${input.reason},
           updated_at = ${ts}
     WHERE run_id = ${input.run_id}
  `;
}

// ─────────────────────────────────────────────────────────────────────
// Composition entry — POST /api/agent-runs path

type RegistryStubLike = {
  createAgentRun: (input: {
    run_id: string;
    profile_id: string;
    workflow_instance_id: string;
  }) => Promise<AgentRunRow>;
  readAgentRun: (runId: string) => Promise<AgentRunRow | null>;
  listAgentRuns: (opts: ListAgentRunsOptions) => Promise<AgentRunListRow[]>;
  markAgentRunAwaitingEvent: (input: MarkAgentRunAwaitingEventInput) => Promise<void>;
  markAgentRunTimedOut: (input: MarkAgentRunTimedOutInput) => Promise<void>;
};

export type AgentRunOpsHost = {
  workflow: Workflow<AgentRunWorkflowParams>;
  getRegistryStub: () => Promise<RegistryStubLike>;
};

export type CreateAgentRunInput = {
  profile_id: string;
  input: unknown;
};

export type CreateAgentRunResult = {
  run_id: string;
  workflow_instance_id: string;
  status: "started";
};

function mintRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

export async function createAgentRun(
  host: AgentRunOpsHost,
  input: CreateAgentRunInput,
): Promise<CreateAgentRunResult> {
  const runId = mintRunId();
  const instance = await host.workflow.create({
    id: runId,
    params: { run_id: runId, profile_id: input.profile_id, input: input.input },
  });
  const registry = await host.getRegistryStub();
  await registry.createAgentRun({
    run_id: runId,
    profile_id: input.profile_id,
    workflow_instance_id: instance.id,
  });
  return {
    run_id: runId,
    workflow_instance_id: instance.id,
    status: "started",
  };
}
