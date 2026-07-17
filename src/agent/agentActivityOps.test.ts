import { test } from "node:test";
import assert from "node:assert/strict";

import { listAgentActivityRows, type AgentActivityHost } from "./agentActivityOps";
import type { AgentRunSqlTag } from "./agentRunOps";

// Capturing mock: records the rendered query + bound values, returns canned rows.
function makeHost(rows: Record<string, unknown>[]): { host: AgentActivityHost; last: () => { query: string; values: unknown[] } } {
  let query = "";
  let values: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    query = strings.join("?");
    values = vals;
    return rows;
  }) as unknown as AgentRunSqlTag;
  return { host: { sql }, last: () => ({ query, values }) };
}

const CANNED = [
  { agent_node_id: "n1", run_id: "wfr-t1", agent_id: "agent-a", agent_name: "Manager", task_id: "t1", status: "ok", prompt_preview: "do x", result_summary: "done", failure_reason: null, created_at: "2026-06-16T00:00:00Z" },
];

test("scoped user → owner filter is applied with the caller's id bound", () => {
  const { host, last } = makeHost(CANNED);
  listAgentActivityRows(host, { limit: 10 }, { kind: "user", userId: "user-abc" });
  const { query, values } = last();
  assert.match(query, /WHERE p\.owner_user_id =/);
  assert.ok(values.includes("user-abc"), "scoped owner id must be bound");
});

test("admin (undefined identity) → NO owner filter", () => {
  const { host, last } = makeHost(CANNED);
  listAgentActivityRows(host, { limit: 10 });
  assert.doesNotMatch(last().query, /owner_user_id/);
});

test("admin identity → NO owner filter", () => {
  const { host, last } = makeHost(CANNED);
  listAgentActivityRows(host, { limit: 10 }, { kind: "admin" });
  assert.doesNotMatch(last().query, /owner_user_id/);
});

test("limit is clamped to [1,50]; default 10", () => {
  const { host, last } = makeHost(CANNED);
  listAgentActivityRows(host, {});
  assert.ok(last().values.includes(10), "default limit 10");
  listAgentActivityRows(host, { limit: 9999 });
  assert.ok(last().values.includes(50), "clamped to 50");
  listAgentActivityRows(host, { limit: 0 });
  assert.ok(last().values.includes(1), "clamped to 1");
});

test("rows are mapped with null-safety", () => {
  const { host } = makeHost([{ agent_node_id: "n2", run_id: "wfr-t2", agent_id: null, agent_name: null, task_id: null, status: "dispatched", prompt_preview: null, result_summary: null, failure_reason: null, created_at: "2026-06-16T01:00:00Z" }]);
  const out = listAgentActivityRows(host, { limit: 10 }, { kind: "user", userId: "u" });
  assert.equal(out.length, 1);
  assert.equal(out[0].agent_id, null);
  assert.equal(out[0].status, "dispatched");
  assert.equal(out[0].run_id, "wfr-t2");
});
