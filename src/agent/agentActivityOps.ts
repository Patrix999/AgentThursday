import type { RequestIdentity } from "./requestIdentity";
import type { AgentRunSqlTag } from "./agentRunOps";

/**
 * Owner-scoped "recent agent activity" feed (model A, the operator 2026-06-16).
 *
 * Source = the an earlier revision `workflow_agent` ledger: one row per dispatched
 * sub-task (incl. the top-level chat task the Manager itself runs). This is
 * the data the conversation page's Activity panel needs — `/api/agent-runs`
 * only ever has rows for durable `AgentRunWorkflow` runs, never for chat /
 * manager dispatches, so it is empty for normal product use.
 *
 * Isolation mirrors `listAgentRunRows` (426e): LEFT JOIN `agent_profile` by the
 * row's `agent_id`; a scoped user appends `WHERE p.owner_user_id = ?`, which
 * also drops null-agent ledger rows that cannot be attributed to a tenant
 * (correct — never leak another tenant's or an unattributable row). Admin
 * (undefined / admin identity) sees all. Pure / node-importable so it is
 * unit-testable for the leak boundary.
 */

export interface AgentActivityHost {
  sql: AgentRunSqlTag;
}

export interface AgentActivityRow {
  agent_node_id: string;
  run_id: string;
  agent_id: string | null;
  agent_name: string | null;
  task_id: string | null;
  status: string;
  prompt_preview: string | null;
  result_summary: string | null;
  failure_reason: string | null;
  created_at: string;
}

export function listAgentActivityRows(
  host: AgentActivityHost,
  opts: { limit?: number },
  identity?: RequestIdentity,
): AgentActivityRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const scopedOwner = identity !== undefined && identity.kind === "user" ? identity.userId : null;
  const rows = scopedOwner !== null
    ? host.sql<AgentActivityRow>`
        SELECT wa.agent_node_id, wa.run_id, wa.agent_id, p.name AS agent_name,
               wa.task_id, wa.status, wa.prompt_preview, wa.result_summary,
               wa.failure_reason, wa.created_at
          FROM workflow_agent wa
          LEFT JOIN agent_profile p ON p.id = wa.agent_id
         WHERE p.owner_user_id = ${scopedOwner}
         ORDER BY wa.created_at DESC
         LIMIT ${limit}
      `
    : host.sql<AgentActivityRow>`
        SELECT wa.agent_node_id, wa.run_id, wa.agent_id, p.name AS agent_name,
               wa.task_id, wa.status, wa.prompt_preview, wa.result_summary,
               wa.failure_reason, wa.created_at
          FROM workflow_agent wa
          LEFT JOIN agent_profile p ON p.id = wa.agent_id
         ORDER BY wa.created_at DESC
         LIMIT ${limit}
      `;
  return rows.map((r) => ({
    agent_node_id: r.agent_node_id,
    run_id: r.run_id,
    agent_id: r.agent_id ?? null,
    agent_name: r.agent_name ?? null,
    task_id: r.task_id ?? null,
    status: r.status,
    prompt_preview: r.prompt_preview ?? null,
    result_summary: r.result_summary ?? null,
    failure_reason: r.failure_reason ?? null,
    created_at: r.created_at,
  }));
}
