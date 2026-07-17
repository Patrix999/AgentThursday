import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  saveWorkflowDescriptorRow,
  readWorkflowDescriptorRow,
  listWorkflowDescriptorRows,
  decideWorkflowSaveOwner,
  decideWorkflowReadScope,
  recordWorkflowDispatchRows,
  recordWorkflowRunStartRows,
  updateWorkflowAgentStatusRow,
  updateWorkflowRunStatusRow,
  type WorkflowStoreHost,
  type WorkflowStoreSqlTag,
} from "./workflowStoreOps";
import { ADMIN_USER_ID } from "./requestIdentity";

/**
 * Multi-tenancy — owner-scoped named-workflow descriptor store.
 *
 * A hand-rolled fake-sql (same pattern as agentRunOps.test.ts) that routes by
 * canonical statement shape so the save (with cross-owner clobber guard) and
 * the scoped/admin reads all resolve against an in-memory `workflow_descriptor`
 * table. Asserts: (a) scoped user sees only own rows, (b) admin sees all,
 * (c) save stamps owner, (d) fail-closed decisions on unresolved owner,
 * (e) cross-tenant row invisible to another user + cross-owner save refused.
 */
type DescRow = {
  name: string;
  version: number;
  descriptor_json: string;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
};

function makeFakeStore(initial: DescRow[] = []): { host: WorkflowStoreHost; rows: DescRow[] } {
  const rows: DescRow[] = [...initial];
  const sql: WorkflowStoreSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as Array<string | number | null>;

    // saveWorkflowDescriptorRow — existence probe (version + owner).
    if (text.startsWith("SELECT version, owner_user_id FROM workflow_descriptor WHERE name =")) {
      const name = v[0] as string;
      const hit = rows.find((r) => r.name === name);
      return hit ? [{ version: hit.version, owner_user_id: hit.owner_user_id }] : [];
    }

    // saveWorkflowDescriptorRow — upsert (INSERT ... ON CONFLICT DO UPDATE).
    if (text.startsWith("INSERT INTO workflow_descriptor")) {
      const [name, version, descriptor_json, created_by_agent_id, created_at, updated_at, owner_user_id] =
        v as [string, number, string, string | null, string, string, string];
      const existing = rows.find((r) => r.name === name);
      if (existing) {
        // ON CONFLICT(name) DO UPDATE — owner_user_id is NOT in the UPDATE set.
        existing.version = version;
        existing.descriptor_json = descriptor_json;
        existing.updated_at = updated_at;
      } else {
        rows.push({
          name, version, descriptor_json, created_by_agent_id,
          created_at, updated_at, owner_user_id,
        });
      }
      return [];
    }

    // readWorkflowDescriptorRow — single row by name.
    if (text.startsWith("SELECT name, version, descriptor_json") && text.includes("WHERE name =")) {
      const name = v[0] as string;
      const hit = rows.find((r) => r.name === name);
      return hit ? [{ ...hit }] : [];
    }

    // listWorkflowDescriptorRows — scoped (owner predicate) vs admin (no WHERE).
    if (text.startsWith("SELECT name, version, descriptor_json") && text.includes("ORDER BY updated_at DESC")) {
      const scoped = text.includes("WHERE owner_user_id =");
      const owner = scoped ? (v[0] as string) : null;
      const out = scoped ? rows.filter((r) => r.owner_user_id === owner) : rows.slice();
      return out
        .slice()
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .map((r) => ({ ...r }));
    }

    throw new Error(`unhandled sql in fake: ${text}`);
  }) as WorkflowStoreSqlTag;

  return { host: { sql, logEvent: () => {} }, rows };
}

const now = "2026-06-18T00:00:00.000Z";

describe("workflowStoreOps — owner stamp + clobber guard", () => {
  it("(c) save stamps the caller's owner on a NEW descriptor", () => {
    const { host, rows } = makeFakeStore();
    const res = saveWorkflowDescriptorRow(host, {
      name: "user-flow",
      descriptor_json: "{}",
      created_by_agent_id: "agent-1",
      owner_user_id: "user-alice",
    }, now);
    assert.equal(res.ok, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_user_id, "user-alice");
    assert.equal(rows[0].version, 1);
  });

  it("same-owner re-save bumps version, keeps owner", () => {
    const { host, rows } = makeFakeStore([
      { name: "f", version: 1, descriptor_json: "{}", created_by_agent_id: null, created_at: now, updated_at: now, owner_user_id: "user-alice" },
    ]);
    const res = saveWorkflowDescriptorRow(host, {
      name: "f", descriptor_json: "{\"v\":2}", created_by_agent_id: null, owner_user_id: "user-alice",
    }, now);
    assert.equal(res.ok, true);
    assert.equal(rows[0].version, 2);
    assert.equal(rows[0].owner_user_id, "user-alice");
  });

  it("(e) scoped user CANNOT clobber another tenant's name — refused name_taken", () => {
    const { host, rows } = makeFakeStore([
      { name: "proof-page-iteration", version: 3, descriptor_json: "{\"op\":true}", created_by_agent_id: null, created_at: now, updated_at: now, owner_user_id: ADMIN_USER_ID },
    ]);
    const res = saveWorkflowDescriptorRow(host, {
      name: "proof-page-iteration", descriptor_json: "{\"evil\":true}", created_by_agent_id: "agent-bob", owner_user_id: "user-bob",
    }, now);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.error, "name_taken");
    // The operator's row is untouched.
    assert.equal(rows[0].owner_user_id, ADMIN_USER_ID);
    assert.equal(rows[0].descriptor_json, "{\"op\":true}");
    assert.equal(rows[0].version, 3);
  });

  it("admin CAN upsert any name (operator unchanged)", () => {
    const { host, rows } = makeFakeStore([
      { name: "x", version: 1, descriptor_json: "{}", created_by_agent_id: null, created_at: now, updated_at: now, owner_user_id: "user-alice" },
    ]);
    const res = saveWorkflowDescriptorRow(host, {
      name: "x", descriptor_json: "{\"admin\":true}", created_by_agent_id: null, owner_user_id: ADMIN_USER_ID,
    }, now);
    assert.equal(res.ok, true);
    assert.equal(rows[0].descriptor_json, "{\"admin\":true}");
    // Owner is NOT overwritten by the admin upsert (UPDATE clause omits it).
    assert.equal(rows[0].owner_user_id, "user-alice");
  });
});

describe("workflowStoreOps — owner-scoped reads", () => {
  function seeded() {
    return makeFakeStore([
      { name: "alice-flow", version: 1, descriptor_json: "{}", created_by_agent_id: null, created_at: now, updated_at: "2026-06-18T03:00:00.000Z", owner_user_id: "user-alice" },
      { name: "bob-flow", version: 1, descriptor_json: "{}", created_by_agent_id: null, created_at: now, updated_at: "2026-06-18T02:00:00.000Z", owner_user_id: "user-bob" },
      { name: "op-flow", version: 1, descriptor_json: "{}", created_by_agent_id: null, created_at: now, updated_at: "2026-06-18T01:00:00.000Z", owner_user_id: ADMIN_USER_ID },
    ]);
  }

  it("(a) scoped user lists ONLY own rows", () => {
    const { host } = seeded();
    const out = listWorkflowDescriptorRows(host, "user-alice");
    assert.deepEqual(out.map((r) => r.name), ["alice-flow"]);
  });

  it("(b) admin (undefined scope) lists ALL rows", () => {
    const { host } = seeded();
    const out = listWorkflowDescriptorRows(host, undefined);
    assert.deepEqual(out.map((r) => r.name).sort(), ["alice-flow", "bob-flow", "op-flow"]);
  });

  it("(e) scoped read of another tenant's workflow → null (no existence leak)", () => {
    const { host } = seeded();
    // Bob cannot read alice's workflow nor the operator's.
    assert.equal(readWorkflowDescriptorRow(host, "alice-flow", "user-bob"), null);
    assert.equal(readWorkflowDescriptorRow(host, "op-flow", "user-bob"), null);
    // Bob reads his own.
    assert.equal(readWorkflowDescriptorRow(host, "bob-flow", "user-bob")?.name, "bob-flow");
    // Admin reads any.
    assert.equal(readWorkflowDescriptorRow(host, "alice-flow", undefined)?.name, "alice-flow");
  });
});

describe("workflowStoreOps — pure fail-closed decisions", () => {
  it("(d) save: named agent with UNRESOLVED owner → refuse (never admin)", () => {
    assert.deepEqual(decideWorkflowSaveOwner("agent-x", null), { ok: false });
  });
  it("save: no calling agent (operator path) → admin sentinel", () => {
    assert.deepEqual(decideWorkflowSaveOwner(null, null), { ok: true, ownerUserId: ADMIN_USER_ID });
  });
  it("save: scoped identity → own owner id", () => {
    assert.deepEqual(
      decideWorkflowSaveOwner("agent-x", { kind: "user", userId: "user-zoe" }),
      { ok: true, ownerUserId: "user-zoe" },
    );
  });
  it("save: admin identity → admin sentinel", () => {
    assert.deepEqual(
      decideWorkflowSaveOwner("agent-x", { kind: "admin" }),
      { ok: true, ownerUserId: ADMIN_USER_ID },
    );
  });

  it("(d) read: named agent with UNRESOLVED owner → refuse (never unscoped=all-tenants)", () => {
    assert.deepEqual(decideWorkflowReadScope("agent-x", null), { ok: false });
  });
  it("read: no calling agent (operator path) → unscoped", () => {
    assert.deepEqual(decideWorkflowReadScope(null, null), { ok: true, scopeOwnerId: undefined });
  });
  it("read: scoped identity → own owner id filter", () => {
    assert.deepEqual(
      decideWorkflowReadScope("agent-x", { kind: "user", userId: "user-zoe" }),
      { ok: true, scopeOwnerId: "user-zoe" },
    );
  });
  it("read: admin identity → unscoped (sees all)", () => {
    assert.deepEqual(
      decideWorkflowReadScope("agent-x", { kind: "admin" }),
      { ok: true, scopeOwnerId: undefined },
    );
  });
});

describe("recordWorkflowDispatchRows (M2 — extracted from inline recordWorkflowDispatch)", () => {
  it("emits run upsert + updated_at bump + phase + agent rows, owner-stamped", () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const host: WorkflowStoreHost = {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
        return [] as never;
      }) as WorkflowStoreSqlTag,
      logEvent: () => {},
    };
    recordWorkflowDispatchRows(host, {
      parent_task_id: "task-p1", source_agent_id: "agent-a", subagent_agent_id: "agent-b",
      subagent_task_id: "task-s1", prompt_preview: "hi", owner: "user-alice", now: "2026-07-01T00:00:00Z",
    });
    assert.equal(calls.length, 4);
    assert.match(calls[0].text, /INSERT OR IGNORE INTO workflow_run/);
    assert.ok(calls[0].values.map(String).includes("user-alice"), "owner stamped on run insert");
    assert.ok(calls[0].values.map(String).includes("task-p1"), "source_task_id = parent_task_id");
    assert.match(calls[1].text, /UPDATE workflow_run SET updated_at/);
    assert.match(calls[2].text, /INSERT OR IGNORE INTO workflow_phase/);
    assert.match(calls[3].text, /INSERT OR IGNORE INTO workflow_agent/);
  });
});

describe("workflow-ledger cluster ops (M2 — extracted from inline @callables)", () => {
  function capHost() {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const host: WorkflowStoreHost = {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
        return [] as never;
      }) as WorkflowStoreSqlTag,
      logEvent: () => {},
    };
    return { host, calls };
  }
  it("recordWorkflowRunStartRows: run insert (owner+caps stamped) + updated_at bump", () => {
    const { host, calls } = capHost();
    recordWorkflowRunStartRows(host, { run_id: "r1", source_task_id: "t", root_agent_id: "a", caps_json: "{}", owner: "user-x", now: "N" });
    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /INSERT OR IGNORE INTO workflow_run/);
    assert.ok(calls[0].values.map(String).includes("user-x"));
    assert.match(calls[1].text, /UPDATE workflow_run SET updated_at/);
  });
  it("updateWorkflowAgentStatusRow: COALESCE preserves omitted fields", () => {
    const { host, calls } = capHost();
    updateWorkflowAgentStatusRow(host, { agent_node_id: "n1", status: "running", now: "N" });
    assert.match(calls[0].text, /COALESCE/);
    assert.ok(calls[0].values.map(String).includes("running"));
  });
  it("updateWorkflowRunStatusRow: status update by run_id", () => {
    const { host, calls } = capHost();
    updateWorkflowRunStatusRow(host, "r1", "completed", "N");
    assert.match(calls[0].text, /UPDATE workflow_run SET status/);
    assert.deepEqual(calls[0].values, ["completed", "N", "r1"]);
  });
});
