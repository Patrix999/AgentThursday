import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

import { runAgentMigrations, type AgentSqlTag } from "./migrations";

/**
 * Real-SQLite coverage for the 2026-06-22 agent_profile per-owner-uniqueness
 * migration (drop the global UNIQUE(name) by table recreation). The
 * agentProfileOps unit tests run against an in-memory mock sql tag and never
 * execute migrations.ts, so the riskiest code — the DROP/recreate on a live
 * registry DO — would otherwise have zero coverage. node:sqlite gives us the
 * actual DDL engine to prove: data preserved, UNIQUE gone, idempotent second
 * run, and the schema-drift guard refusing to drop an unexpected column.
 */
function mkSqlite(): { sql: AgentSqlTag; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const params = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as Array<
      string | number | bigint | null | Uint8Array
    >;
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)/i.test(text);
    const stmt = db.prepare(text);
    if (isQuery) {
      return stmt.all(...params);
    }
    stmt.run(...params);
    return [];
  }) as unknown as AgentSqlTag;
  return { sql, db };
}

// The pre-migration agent_profile as it existed after an earlier revision: global
// UNIQUE(name) + owner_user_id present.
const OLD_AGENT_PROFILE_DDL = `
  CREATE TABLE agent_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    channel TEXT NOT NULL,
    skillset TEXT NOT NULL,
    persona TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT 'user-admin'
  )
`;

function insertRow(
  db: DatabaseSync,
  cols: string,
  id: string,
  name: string,
  owner: string,
  extra?: { col: string; val: string },
) {
  const baseCols = "id,name,model,channel,skillset,persona,status,created_at,updated_at,owner_user_id";
  const allCols = extra ? `${baseCols},${extra.col}` : baseCols;
  const baseVals = [id, name, "kimi-k2.6", "none", "manager", "", "ready", "t", "t", owner];
  const vals = extra ? [...baseVals, extra.val] : baseVals;
  const ph = vals.map(() => "?").join(",");
  db.prepare(`INSERT INTO agent_profile (${allCols}) VALUES (${ph})`).run(...vals);
  void cols;
}

function tableSql(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_profile'`)
    .get() as { sql: string } | undefined;
  return row ? String(row.sql) : "";
}

describe("runAgentMigrations — agent_profile per-owner uniqueness (2026-06-22)", () => {
  it("drops the global UNIQUE(name), preserves rows, and is idempotent", async () => {
    const { sql, db } = mkSqlite();
    db.exec(OLD_AGENT_PROFILE_DDL);
    insertRow(db, "", "a-thu", "Agent Thursday", "user-a");
    insertRow(db, "", "b-help", "Helper", "user-b");
    assert.match(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i, "precondition: old schema has UNIQUE");

    await runAgentMigrations({ sql });

    // rows preserved
    const ids = (db.prepare(`SELECT id FROM agent_profile ORDER BY id`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.deepEqual(ids, ["a-thu", "b-help"]);
    // UNIQUE gone from the recreated schema
    assert.doesNotMatch(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    // per-owner duplicate name now accepted at the DB level (the whole point)
    insertRow(db, "", "b-thu", "Agent Thursday", "user-b");
    const dup = db.prepare(`SELECT COUNT(*) AS n FROM agent_profile WHERE name='Agent Thursday'`).get() as {
      n: number;
    };
    assert.equal(Number(dup.n), 2);

    // idempotent: a second run is a no-op (no throw, no row churn)
    await runAgentMigrations({ sql });
    const ids2 = (db.prepare(`SELECT id FROM agent_profile ORDER BY id`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.deepEqual(ids2, ["a-thu", "b-help", "b-thu"]);
    assert.doesNotMatch(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  });

  // an earlier revision added origin/parent_agent_id via ALTER that runs
  // BEFORE this recreate; the guard's expected-col set must include them or the
  // recreate skips forever and the legacy UNIQUE never drops. This also asserts
  // lineage survives the table rebuild (INSERT…SELECT must carry both columns).
  it("carries origin/parent_agent_id through the recreate (an earlier revision lineage preserved)", async () => {
    const { sql, db } = mkSqlite();
    db.exec(OLD_AGENT_PROFILE_DDL);
    insertRow(db, "", "parent", "Manager", "user-a");
    insertRow(db, "", "child", "Sub", "user-a");

    await runAgentMigrations({ sql });

    // legacy UNIQUE dropped (recreate ran — did NOT skip on the 12-col set)
    assert.doesNotMatch(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    // lineage + retention columns exist and the physical rows survived the rebuild
    db.prepare(`UPDATE agent_profile SET origin='spawned', parent_agent_id='parent', retention_policy='task_scoped' WHERE id='child'`).run();
    const row = db.prepare(`SELECT origin, parent_agent_id, retention_policy FROM agent_profile WHERE id='child'`).get() as {
      origin: string; parent_agent_id: string | null; retention_policy: string;
    };
    assert.equal(row.origin, "spawned");
    assert.equal(row.parent_agent_id, "parent");
    assert.equal(row.retention_policy, "task_scoped");
  });

  it("SKIPS the recreation on column-set drift (extra column) — no data loss", async () => {
    const { sql, db } = mkSqlite();
    db.exec(OLD_AGENT_PROFILE_DDL.replace(
      "owner_user_id TEXT NOT NULL DEFAULT 'user-admin'\n  )",
      "owner_user_id TEXT NOT NULL DEFAULT 'user-admin',\n    legacy_extra TEXT\n  )",
    ));
    insertRow(db, "", "x", "X", "user-a", { col: "legacy_extra", val: "keepme" });

    await runAgentMigrations({ sql });

    // migration refused to run: UNIQUE still present, extra column + data intact
    assert.match(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    const row = db.prepare(`SELECT legacy_extra FROM agent_profile WHERE id='x'`).get() as {
      legacy_extra: string;
    };
    assert.equal(row.legacy_extra, "keepme");
  });

  it("is a no-op on a fresh DO (table created without UNIQUE in the first place)", async () => {
    const { sql, db } = mkSqlite();
    // No pre-seed: runAgentMigrations creates agent_profile itself (new schema).
    await runAgentMigrations({ sql });
    assert.doesNotMatch(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    // second run still clean
    await runAgentMigrations({ sql });
    assert.doesNotMatch(tableSql(db), /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  });
});
