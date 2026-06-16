import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  type AgentProfileHost,
  type AgentProfileSqlTag,
  createAgentProfile,
  listAgentProfiles,
  readAgentProfile,
} from "./agentProfileOps";

type Row = {
  id: string;
  name: string;
  model: string;
  channel: string;
  skillset: string;
  persona: string;
  status: string;
  created_at: string;
  updated_at: string;
};

/**
 * Minimal in-memory sql-tag fake.
 *
 *  unit-test substrate. The helper module's SQL surface is
 * tiny and fixed (one INSERT, two SELECT shapes), so a small router
 * matching by canonical statement shape is robust enough to catch
 * regressions in the helper bodies without dragging in a D1 dep.
 */
function makeFakeSql(): { sql: AgentProfileSqlTag; rows: Row[] } {
  const rows: Row[] = [];
  const sql: AgentProfileSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    // INSERT
    if (text.startsWith("INSERT INTO agent_profile")) {
      const [id, name, model, channel, skillset, persona, status, created_at, updated_at] =
        values as string[];
      if (rows.some(r => r.name === name)) {
        throw new Error("UNIQUE constraint failed: agent_profile.name");
      }
      rows.push({ id, name, model, channel, skillset, persona, status, created_at, updated_at });
      return [];
    }
    // SELECT id FROM agent_profile WHERE name = ?
    if (text.startsWith("SELECT id FROM agent_profile WHERE name =")) {
      const [name] = values as string[];
      const hit = rows.find(r => r.name === name);
      return hit ? [{ id: hit.id }] : [];
    }
    // SELECT ... FROM agent_profile WHERE id = ?
    if (text.includes("FROM agent_profile WHERE id =")) {
      const [id] = values as string[];
      const hit = rows.find(r => r.id === id);
      return hit ? [{ ...hit }] : [];
    }
    // SELECT ... FROM agent_profile WHERE status != 'archived' ORDER BY created_at DESC
    if (text.includes("WHERE status != 'archived'")) {
      return rows
        .filter(r => r.status !== "archived")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(r => ({ ...r }));
    }
    // SELECT ... FROM agent_profile ORDER BY created_at DESC
    if (text.startsWith("SELECT id, name, model")) {
      return [...rows]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(r => ({ ...r }));
    }
    throw new Error(`fake sql: unrouted statement: ${text}`);
  }) as unknown as AgentProfileSqlTag;
  return { sql, rows };
}

function mkHost(): AgentProfileHost & { _rows: Row[] } {
  const { sql, rows } = makeFakeSql();
  return { sql, _rows: rows };
}

function mkInput(over: Partial<{ id: string; name: string; createdAt: string; updatedAt: string }> = {}) {
  return {
    id: over.id ?? "agent-aaa",
    name: over.name ?? "alpha",
    model: "kimi-k2.6",
    channel: "local:dogfood-1",
    skillset: "software-dev",
    persona: "",
    status: "initialized" as const,
    createdAt: over.createdAt ?? "2026-05-22T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-22T00:00:00.000Z",
  };
}

describe("createAgentProfile", () => {
  it("inserts a row and echoes the canonical AgentProfile shape", () => {
    const host = mkHost();
    const r = createAgentProfile(host, mkInput());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.profile, {
      id: "agent-aaa",
      name: "alpha",
      model: "kimi-k2.6",
      channel: "local:dogfood-1",
      skillset: "software-dev",
      persona: "",
      status: "initialized",
      origin: "user_created",
      parent_agent_id: null,
      parent_task_id: null,
      accepts_tasks: true,
      retention_policy: "durable",
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:00:00.000Z",
    });
    assert.equal(host._rows.length, 1);
  });

  it("returns name_conflict on duplicate name (pre-check path)", () => {
    const host = mkHost();
    const r1 = createAgentProfile(host, mkInput({ id: "agent-1", name: "dup" }));
    assert.equal(r1.ok, true);
    const r2 = createAgentProfile(host, mkInput({ id: "agent-2", name: "dup" }));
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.equal(r2.error.code, "name_conflict");
    assert.equal(host._rows.length, 1);
  });

  it("surfaces internal errors when the INSERT throws a non-constraint failure", () => {
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT id FROM agent_profile")) return [];
      if (text.startsWith("INSERT INTO agent_profile")) throw new Error("disk full");
      throw new Error(`unrouted: ${text}`);
    }) as unknown as AgentProfileSqlTag;
    const r = createAgentProfile({ sql }, mkInput());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, "internal");
    assert.match(r.error.message, /disk full/);
  });
});

describe("listAgentProfiles", () => {
  it("returns active roster (excludes archived + deleted_marker) by default, newest first", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "a", name: "a", createdAt: "2026-05-22T00:00:01.000Z" }));
    createAgentProfile(host, mkInput({ id: "b", name: "b", createdAt: "2026-05-22T00:00:02.000Z" }));
    createAgentProfile(host, mkInput({ id: "c", name: "c", createdAt: "2026-05-22T00:00:03.000Z" }));
    createAgentProfile(host, mkInput({ id: "d", name: "d", createdAt: "2026-05-22T00:00:04.000Z" }));
    // archive c and tombstone d by mutating the underlying rows
    host._rows[2].status = "archived";
    host._rows[3].status = "deleted_marker";
    const ps = listAgentProfiles(host);
    assert.deepEqual(ps.map(p => p.id), ["b", "a"]);
  });

  it("includes archived AND deleted_marker when includeArchived=true (inspect/admin escape hatch)", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "a", name: "a", createdAt: "2026-05-22T00:00:01.000Z" }));
    createAgentProfile(host, mkInput({ id: "b", name: "b", createdAt: "2026-05-22T00:00:02.000Z" }));
    createAgentProfile(host, mkInput({ id: "c", name: "c", createdAt: "2026-05-22T00:00:03.000Z" }));
    host._rows[1].status = "archived";
    host._rows[2].status = "deleted_marker";
    const ps = listAgentProfiles(host, { includeArchived: true });
    assert.deepEqual(ps.map(p => p.id), ["c", "b", "a"]);
    assert.deepEqual(
      ps.map(p => p.status).sort(),
      ["archived", "deleted_marker", "initialized"],
    );
  });

  it("deleted_marker tombstone is excluded from default list (ADR §2.1 — UI invisible)", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "live", name: "live", createdAt: "2026-05-22T00:00:01.000Z" }));
    createAgentProfile(host, mkInput({ id: "tomb", name: "tomb", createdAt: "2026-05-22T00:00:02.000Z" }));
    host._rows[1].status = "deleted_marker";
    const ps = listAgentProfiles(host);
    assert.deepEqual(ps.map(p => p.id), ["live"]);
  });

  it("returns [] on an empty table", () => {
    const host = mkHost();
    assert.deepEqual(listAgentProfiles(host), []);
  });
});

describe("readAgentProfile", () => {
  it("returns the row for a known id", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "agent-x", name: "x" }));
    const p = readAgentProfile(host, "agent-x");
    assert.ok(p !== null);
    assert.equal(p!.id, "agent-x");
    assert.equal(p!.name, "x");
  });

  it("returns null for an unknown id", () => {
    const host = mkHost();
    assert.equal(readAgentProfile(host, "nope"), null);
  });
});

// ──  — rowToProfile enum-value defense ────────────────────
//
// `rowToProfile` is internal; we exercise it through the public
// `readAgentProfile` reader by injecting rows of various shapes
// directly into the underlying fake-sql store.

function mkRawRow(over: Partial<Record<string, unknown>> = {}): Row & Record<string, unknown> {
  return {
    id: "agent-raw",
    name: "raw",
    model: "kimi-k2.6",
    channel: "local:dogfood-1",
    skillset: "software-dev",
    persona: "",
    status: "initialized",
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    ...over,
  } as Row & Record<string, unknown>;
}

describe("rowToProfile — legacy status migration ()", () => {
  it("legacy 'ready' → initialized + accepts_tasks=true (ADR §6.3)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "leg-ready", status: "ready" }));
    const p = readAgentProfile(host, "leg-ready");
    assert.ok(p !== null);
    assert.equal(p!.status, "initialized");
    assert.equal(p!.accepts_tasks, true);
  });

  it("legacy 'draft' → initialized + accepts_tasks=false (ADR §6.3)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "leg-draft", status: "draft" }));
    const p = readAgentProfile(host, "leg-draft");
    assert.ok(p !== null);
    assert.equal(p!.status, "initialized");
    assert.equal(p!.accepts_tasks, false);
  });

  it("legacy 'disabled' → initialized + accepts_tasks=false (ADR §6.3)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "leg-dis", status: "disabled" }));
    const p = readAgentProfile(host, "leg-dis");
    assert.ok(p !== null);
    assert.equal(p!.status, "initialized");
    assert.equal(p!.accepts_tasks, false);
  });
});

describe("rowToProfile — garbage / unknown enum defense ()", () => {
  it("unknown status string → archived (fail-closed, hides from default list)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "garbage", status: "foobar" }));
    const p = readAgentProfile(host, "garbage");
    assert.ok(p !== null);
    assert.equal(p!.status, "archived");
    assert.equal(p!.accepts_tasks, false);
  });

  it("unknown origin string → user_created fallback", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "bad-orig", origin: "wat" }));
    const p = readAgentProfile(host, "bad-orig");
    assert.ok(p !== null);
    assert.equal(p!.origin, "user_created");
  });

  it("unknown retention_policy string → durable fallback", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "bad-ret", retention_policy: "forever" }));
    const p = readAgentProfile(host, "bad-ret");
    assert.ok(p !== null);
    assert.equal(p!.retention_policy, "durable");
  });

  it("garbage row drops out of active roster (default list view)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "ok", status: "initialized" }));
    host._rows.push(mkRawRow({ id: "bad", status: "totally-broken" }));
    const list = listAgentProfiles(host);
    assert.deepEqual(list.map(p => p.id), ["ok"]);
  });

  it("garbage row surfaces when includeArchived=true", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "bad", status: "totally-broken" }));
    const list = listAgentProfiles(host, { includeArchived: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "archived");
  });
});

// ──  — deleted_marker tombstone default-list exclusion ───
//
// Anchored to ADR §2.1: `deleted_marker` is a manager-dispatchable=no,
// UI-visible=no audit tombstone. It must not appear in default
// `listAgentProfiles()` (which feeds dashboard / selector / manager
// fanout), but operator/inspect surfaces calling with
// `includeArchived=true` must still see it.

describe("listAgentProfiles — deleted_marker tombstone ()", () => {
  it("raw deleted_marker row is excluded from default list", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "alive", status: "initialized" }));
    host._rows.push(mkRawRow({ id: "tomb", status: "deleted_marker" }));
    const ps = listAgentProfiles(host);
    assert.deepEqual(ps.map(p => p.id), ["alive"]);
  });

  it("raw deleted_marker row surfaces under includeArchived=true with status preserved", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "tomb", status: "deleted_marker" }));
    const ps = listAgentProfiles(host, { includeArchived: true });
    assert.equal(ps.length, 1);
    assert.equal(ps[0].id, "tomb");
    assert.equal(ps[0].status, "deleted_marker");
  });

  it("default list excludes archived AND deleted_marker, includes initialized", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "live", status: "initialized" }));
    host._rows.push(mkRawRow({ id: "arch", status: "archived" }));
    host._rows.push(mkRawRow({ id: "tomb", status: "deleted_marker" }));
    const ps = listAgentProfiles(host);
    assert.deepEqual(ps.map(p => p.id), ["live"]);
  });
});

describe("rowToProfile — back-compat: missing lifecycle v2 columns ()", () => {
  it("row without new columns → defaults user_created/durable/accepts_tasks=true", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "bare" }));
    const p = readAgentProfile(host, "bare");
    assert.ok(p !== null);
    assert.equal(p!.origin, "user_created");
    assert.equal(p!.retention_policy, "durable");
    assert.equal(p!.accepts_tasks, true);
    assert.equal(p!.parent_agent_id, null);
    assert.equal(p!.parent_task_id, null);
  });

  it("row with accepts_tasks=0 column → accepts_tasks=false (SQLite int→bool)", () => {
    const host = mkHost();
    host._rows.push(mkRawRow({ id: "paused", accepts_tasks: 0 }));
    const p = readAgentProfile(host, "paused");
    assert.ok(p !== null);
    assert.equal(p!.accepts_tasks, false);
  });

  it("row with spawn linkage round-trips parent_*", () => {
    const host = mkHost();
    host._rows.push(
      mkRawRow({
        id: "spawn",
        origin: "spawned",
        parent_agent_id: "parent-1",
        parent_task_id: "task-9",
        retention_policy: "task_scoped",
      }),
    );
    const p = readAgentProfile(host, "spawn");
    assert.ok(p !== null);
    assert.equal(p!.origin, "spawned");
    assert.equal(p!.parent_agent_id, "parent-1");
    assert.equal(p!.parent_task_id, "task-9");
    assert.equal(p!.retention_policy, "task_scoped");
  });
});
