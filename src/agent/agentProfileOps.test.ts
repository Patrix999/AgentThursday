import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  type AgentProfileHost,
  type AgentProfileSqlTag,
  OPERATOR_PROFILE_NAME,
  createAgentProfile,
  listAgentProfiles,
  readAgentProfile,
  seedOperatorAgentProfile,
  updateAgentProfile,
} from "./agentProfileOps";
import type { RequestIdentity } from "./requestIdentity";
import { DEMO_INSTANCE, OPERATOR_INSTANCE } from "../demoConstants";

type Row = {
  id: string;
  name: string;
  model: string;
  channel: string;
  skillset: string;
  persona: string;
  status: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  origin?: string;
  parent_agent_id?: string | null;
  retention_policy?: string;
};

/**
 * Minimal in-memory sql-tag fake.
 *
 * an earlier revision unit-test substrate; an earlier revision extended it to be owner-aware
 * (the new `owner_user_id` column + the per-tenant WHERE variants the
 * helpers emit for a scoped identity). Routing is by canonical statement
 * shape; param positions are read off the presence of each clause so both
 * the admin (unfiltered) and user (owner-scoped) query forms resolve.
 */
function makeFakeSql(): { sql: AgentProfileSqlTag; rows: Row[] } {
  const rows: Row[] = [];
  const sql: AgentProfileSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as string[];
    // INSERT (carries owner_user_id)
    if (text.startsWith("INSERT INTO agent_profile")) {
      const [id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at, origin, parent_agent_id, retention_policy] = v;
      // 2026-06-22 — the global UNIQUE(name) was dropped (name is unique PER
      // OWNER now; the owner-scoped pre-check in createAgentProfile is the only
      // guard), so the INSERT enforces no name constraint and the same name
      // under a different owner inserts cleanly.
      rows.push({ id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at,
        ...(origin !== undefined ? { origin } : {}),
        ...(parent_agent_id !== undefined ? { parent_agent_id } : {}),
        ...(retention_policy !== undefined ? { retention_policy } : {}) } as Row);
      return [];
    }
    // SELECT id FROM agent_profile WHERE name = ? [AND owner_user_id = ?] [AND id != ?]*
    // an earlier revision Phase 0 — the real queries put the owner clause first and any
    // number of id-exclusions (input.id and/or DEMO_INSTANCE) after it.
    if (text.startsWith("SELECT id FROM agent_profile WHERE name =")) {
      let i = 0;
      const name = v[i++];
      const owner = text.includes("owner_user_id =") ? v[i++] : undefined;
      const exclIds = v.slice(i);
      const hit = rows.find(
        r =>
          r.name === name &&
          (owner === undefined || r.owner_user_id === owner) &&
          !exclIds.includes(r.id),
      );
      return hit ? [{ id: hit.id }] : [];
    }
    // SELECT <cols> FROM agent_profile WHERE id = ? [AND owner_user_id = ?] LIMIT 1
    if (text.includes("FROM agent_profile WHERE id =")) {
      const id = v[0];
      const owner = text.includes("owner_user_id =") ? v[1] : undefined;
      const hit = rows.find(r => r.id === id && (owner === undefined || r.owner_user_id === owner));
      if (!hit) return [];
      // faithfully model the M1 bug: a SELECT that OMITS a lineage
      // column must NOT return it (the real DO projects exactly the listed
      // columns). Only strip origin/parent_agent_id when unlisted — every
      // other column passes through so the rowToProfile unit harness (which
      // over-supplies physical columns like accepts_tasks) is unaffected.
      const out = { ...hit } as Record<string, unknown>;
      if (!/\borigin\b/.test(text)) delete out.origin;
      if (!/\bparent_agent_id\b/.test(text)) delete out.parent_agent_id;
      return [out];
    }
    // SELECT <cols> FROM agent_profile [WHERE owner_user_id = ?] [AND|WHERE id != ?] ORDER BY created_at DESC
    // an earlier revision Phase 0 — both list branches carry an `id != ?` registry-row
    // exclusion; owner (when present) binds before it.
    if (text.includes("FROM agent_profile") && text.includes("ORDER BY created_at DESC")) {
      let i = 0;
      const owner = text.includes("owner_user_id =") ? v[i++] : undefined;
      const exclId = text.includes("id !=") ? v[i++] : undefined;
      return rows
        .filter(
          r =>
            (owner === undefined || r.owner_user_id === owner) &&
            (exclId === undefined || r.id !== exclId),
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(r => ({ ...r }));
    }
    // re-key UPDATE: SET id = ?, updated_at = ? WHERE id = ?
    if (text.startsWith("UPDATE agent_profile SET id =")) {
      const [newId, updated_at, oldId] = v as string[];
      const row = rows.find(r => r.id === oldId);
      if (row) Object.assign(row, { id: newId, updated_at });
      return [];
    }
    // UPDATE agent_profile SET name=?, model=?, skillset=?, persona=?, status=?, updated_at=? WHERE id = ?
    if (text.startsWith("UPDATE agent_profile SET")) {
      const id = v[v.length - 1];
      const row = rows.find(r => r.id === id);
      if (row) {
        const [name, model, skillset, persona, status, updated_at] = v;
        Object.assign(row, { name, model, skillset, persona, status, updated_at });
      }
      return [];
    }
    throw new Error(`fake sql: unrouted statement: ${text}`);
  }) as unknown as AgentProfileSqlTag;
  return { sql, rows };
}

const USER_A: RequestIdentity = { kind: "user", userId: "user-a" };
const USER_B: RequestIdentity = { kind: "user", userId: "user-b" };
const ADMIN: RequestIdentity = { kind: "admin" };

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

  it("allows the SAME name under different owners (per-owner uniqueness; 2026-06-22)", () => {
    const host = mkHost();
    const rA = createAgentProfile(host, mkInput({ id: "a-thu", name: "Agent Thursday" }), USER_A);
    const rB = createAgentProfile(host, mkInput({ id: "b-thu", name: "Agent Thursday" }), USER_B);
    const rAdmin = createAgentProfile(host, mkInput({ id: "adm-thu", name: "Agent Thursday" }), ADMIN);
    assert.equal(rA.ok, true);
    assert.equal(rB.ok, true);
    assert.equal(rAdmin.ok, true);
    assert.equal(host._rows.length, 3);
  });

  it("still rejects a duplicate name under the SAME owner (per-owner pre-check)", () => {
    const host = mkHost();
    const r1 = createAgentProfile(host, mkInput({ id: "u1", name: "dup" }), USER_A);
    const r2 = createAgentProfile(host, mkInput({ id: "u2", name: "dup" }), USER_A);
    assert.equal(r1.ok, true);
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

// ── rowToProfile enum-value defense ────────────────────
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

describe("rowToProfile — legacy status migration ", () => {
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

describe("rowToProfile — garbage / unknown enum defense ", () => {
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

// ── deleted_marker tombstone default-list exclusion ───
//
// Anchored to ADR §2.1: `deleted_marker` is a manager-dispatchable=no,
// UI-visible=no audit tombstone. It must not appear in default
// `listAgentProfiles()` (which feeds dashboard / selector / manager
// fanout), but operator/inspect surfaces calling with
// `includeArchived=true` must still see it.

describe("listAgentProfiles — deleted_marker tombstone ", () => {
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

describe("rowToProfile — back-compat: missing lifecycle v2 columns ", () => {
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
    // a row without the owner column defaults to the admin
    // sentinel, so the getModel hot path fail-softs to the admin/legacy store.
    assert.equal(p!.owner_user_id, "user-admin");
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

// ── updateAgentProfile must NOT strip lineage on its return ──
describe("updateAgentProfile preserves origin/parent_agent_id", () => {
  it("a PATCH on a spawned agent returns it still spawned (M1 regression)", () => {
    const host = mkHost();
    host._rows.push(
      mkRawRow({ id: "sub", name: "Sub", origin: "spawned", parent_agent_id: "mgr", owner_user_id: "user-a" }),
    );
    const r = updateAgentProfile(host, { id: "sub", name: "Sub Renamed", updatedAt: "2026-07-10T00:00:00.000Z" }, {
      kind: "user",
      userId: "user-a",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // The bug: the existence SELECT dropped origin/parent_agent_id, so the
    // returned profile defaulted to user_created / null.
    assert.equal(r.profile.origin, "spawned");
    assert.equal(r.profile.parent_agent_id, "mgr");
    assert.equal(r.profile.name, "Sub Renamed");
  });
});

// ── cross-tenant isolation (the leak assertions) ───────────
describe("multi-tenancy isolation", () => {
  function seed(): AgentProfileHost & { _rows: Row[] } {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "a1", name: "a-one" }), USER_A);
    createAgentProfile(host, mkInput({ id: "a2", name: "a-two" }), USER_A);
    createAgentProfile(host, mkInput({ id: "b1", name: "b-one" }), USER_B);
    createAgentProfile(host, mkInput({ id: "adm", name: "admin-one" }), ADMIN);
    return host;
  }

  it("create stamps owner_user_id from the identity", () => {
    const host = seed();
    const byId = (id: string) => host._rows.find(r => r.id === id)!;
    assert.equal(byId("a1").owner_user_id, "user-a");
    assert.equal(byId("b1").owner_user_id, "user-b");
    assert.equal(byId("adm").owner_user_id, "user-admin");
  });

  it("list returns ONLY the caller's own agents", () => {
    const host = seed();
    assert.deepEqual(listAgentProfiles(host, {}, USER_A).map(p => p.id).sort(), ["a1", "a2"]);
    assert.deepEqual(listAgentProfiles(host, {}, USER_B).map(p => p.id), ["b1"]);
  });

  it("admin (and the default identity) sees every tenant", () => {
    const host = seed();
    assert.deepEqual(listAgentProfiles(host, {}, ADMIN).map(p => p.id).sort(), ["a1", "a2", "adm", "b1"]);
    assert.equal(listAgentProfiles(host).length, 4); // omitted identity == admin
  });

  it("cross-tenant read returns null (no existence leak); own + admin read succeed", () => {
    const host = seed();
    assert.equal(readAgentProfile(host, "b1", USER_A), null);
    assert.ok(readAgentProfile(host, "a1", USER_A) !== null);
    assert.ok(readAgentProfile(host, "b1", ADMIN) !== null);
  });

  it("readAgentProfile surfaces the real owner (the getModel hot-path input)", () => {
    const host = seed();
    // composePersonaContext resolves the agent's identity from this field.
    assert.equal(readAgentProfile(host, "a1", ADMIN)!.owner_user_id, "user-a");
    assert.equal(readAgentProfile(host, "b1", ADMIN)!.owner_user_id, "user-b");
    assert.equal(readAgentProfile(host, "adm", ADMIN)!.owner_user_id, "user-admin");
  });

  it("cross-tenant update is not_found and does NOT mutate the victim row", () => {
    const host = seed();
    const r = updateAgentProfile(
      host,
      { id: "b1", persona: "pwned", updatedAt: "2026-06-15T00:00:00.000Z" },
      USER_A,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, "not_found");
    assert.equal(host._rows.find(x => x.id === "b1")!.persona, "");
  });

  it("own update succeeds; admin can update any tenant", () => {
    const host = seed();
    const own = updateAgentProfile(
      host,
      { id: "a1", persona: "tuned", updatedAt: "2026-06-15T00:00:00.000Z" },
      USER_A,
    );
    assert.equal(own.ok, true);
    assert.equal(host._rows.find(x => x.id === "a1")!.persona, "tuned");
    const adm = updateAgentProfile(
      host,
      { id: "b1", persona: "admin-edit", updatedAt: "2026-06-15T00:00:00.000Z" },
      ADMIN,
    );
    assert.equal(adm.ok, true);
  });
});

// ── an earlier revision Phase 0 — operator profile seed + roster exclusion ────────
describe("an earlier revision Phase 0 — seedOperatorAgentProfile", () => {
  const NOW = "2026-07-01T00:00:00.000Z";

  it("seeds the operator row: id=OPERATOR_INSTANCE, owner=admin, status initialized (451c)", () => {
    const host = mkHost();
    const r = seedOperatorAgentProfile(host, NOW);
    assert.deepEqual(r, { seeded: true });
    assert.equal(host._rows.length, 1);
    const row = host._rows[0];
    assert.equal(row.id, OPERATOR_INSTANCE);
    assert.equal(row.name, OPERATOR_PROFILE_NAME);
    assert.equal(row.owner_user_id, "user-admin");
    assert.equal(row.status, "initialized");
    assert.equal(row.created_at, NOW);
  });

  it("451c re-key: a pre-existing DEMO_INSTANCE row is moved to OPERATOR_INSTANCE in place (fields preserved)", () => {
    const host = mkHost();
    host._rows.push({
      id: DEMO_INSTANCE, name: OPERATOR_PROFILE_NAME, model: "kimi-k2.6",
      channel: "", skillset: "", persona: "", status: "initialized",
      owner_user_id: "user-admin", created_at: "2026-07-02T04:57:34.875Z", updated_at: "2026-07-02T04:57:34.875Z",
    });
    const r = seedOperatorAgentProfile(host, NOW);
    assert.deepEqual(r, { seeded: true, rekeyed: true });
    assert.equal(host._rows.length, 1);
    const row = host._rows[0];
    assert.equal(row.id, OPERATOR_INSTANCE);
    assert.equal(row.owner_user_id, "user-admin");
    assert.equal(row.created_at, "2026-07-02T04:57:34.875Z"); // preserved
    assert.equal(row.updated_at, NOW);
    // and the whole seed is idempotent afterwards
    assert.deepEqual(seedOperatorAgentProfile(host, "2026-07-03T00:00:00.000Z"), {
      seeded: false, reason: "exists",
    });
    assert.equal(host._rows.length, 1);
  });

  it("is idempotent: second call reports exists and inserts nothing", () => {
    const host = mkHost();
    assert.deepEqual(seedOperatorAgentProfile(host, NOW), { seeded: true });
    assert.deepEqual(seedOperatorAgentProfile(host, "2026-07-02T00:00:00.000Z"), {
      seeded: false,
      reason: "exists",
    });
    assert.equal(host._rows.length, 1);
    assert.equal(host._rows[0].created_at, NOW);
  });

  it("skips (name_conflict) when admin already owns an agent named 'operator'", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "adm-op", name: OPERATOR_PROFILE_NAME }), ADMIN);
    const r = seedOperatorAgentProfile(host, NOW);
    assert.deepEqual(r, { seeded: false, reason: "name_conflict" });
    assert.equal(host._rows.length, 1);
    assert.equal(host._rows[0].id, "adm-op");
  });

  it("a scoped user's agent named 'operator' does NOT block the seed (per-owner check)", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "u-op", name: OPERATOR_PROFILE_NAME }), USER_A);
    const r = seedOperatorAgentProfile(host, NOW);
    assert.deepEqual(r, { seeded: true });
    assert.equal(host._rows.length, 2);
  });
});

describe("an earlier revision Phase 0 — roster excludes the registry/operator row", () => {
  const NOW = "2026-07-01T00:00:00.000Z";

  function seededHost() {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "a1", name: "a-one" }), USER_A);
    createAgentProfile(host, mkInput({ id: "adm", name: "admin-one" }), ADMIN);
    assert.deepEqual(seedOperatorAgentProfile(host, NOW), { seeded: true });
    return host;
  }

  it("admin default list never contains the operator row", () => {
    const host = seededHost();
    assert.deepEqual(listAgentProfiles(host, {}, ADMIN).map(p => p.id).sort(), ["a1", "adm"]);
  });

  it("admin includeArchived escape hatch also excludes the operator row", () => {
    const host = seededHost();
    const ids = listAgentProfiles(host, { includeArchived: true }, ADMIN).map(p => p.id);
    assert.ok(!ids.includes(OPERATOR_INSTANCE));
    assert.deepEqual(ids.sort(), ["a1", "adm"]);
  });

  it("scoped list branch also carries the exclusion (defensive: even an owner-matching operator row stays hidden)", () => {
    const host = mkHost();
    createAgentProfile(host, mkInput({ id: "a1", name: "a-one" }), USER_A);
    // Cannot happen via the real seed (owner is always admin) — asserts the
    // scoped SQL branch's `id !=` clause directly.
    host._rows.push({ ...host._rows[0], id: OPERATOR_INSTANCE, name: "rogue-operator" });
    assert.deepEqual(listAgentProfiles(host, {}, USER_A).map(p => p.id), ["a1"]);
  });

  it("readAgentProfile(OPERATOR_INSTANCE) still returns the row for admin; scoped user gets null", () => {
    const host = seededHost();
    const p = readAgentProfile(host, OPERATOR_INSTANCE, ADMIN);
    assert.ok(p !== null);
    assert.equal(p!.owner_user_id, "user-admin");
    assert.equal(readAgentProfile(host, OPERATOR_INSTANCE, USER_A), null);
  });
});

describe("an earlier revision Phase 0 — hidden row does not squat the admin name namespace", () => {
  const NOW = "2026-07-01T00:00:00.000Z";

  it("admin can still CREATE an agent named 'operator' after the seed (no invisible 409)", () => {
    const host = mkHost();
    assert.deepEqual(seedOperatorAgentProfile(host, NOW), { seeded: true });
    const r = createAgentProfile(host, mkInput({ id: "adm-op", name: OPERATOR_PROFILE_NAME }), ADMIN);
    assert.equal(r.ok, true);
    assert.equal(host._rows.length, 2);
    // roster shows only the visible one
    assert.deepEqual(listAgentProfiles(host, {}, ADMIN).map(p => p.id), ["adm-op"]);
  });

  it("admin can still RENAME an agent to 'operator' after the seed", () => {
    const host = mkHost();
    assert.deepEqual(seedOperatorAgentProfile(host, NOW), { seeded: true });
    createAgentProfile(host, mkInput({ id: "adm-x", name: "x" }), ADMIN);
    const r = updateAgentProfile(
      host,
      { id: "adm-x", name: OPERATOR_PROFILE_NAME, updatedAt: "2026-07-01T01:00:00.000Z" },
      ADMIN,
    );
    assert.equal(r.ok, true);
  });

  it("duplicate against a REAL visible agent still 409s after the seed (create + rename)", () => {
    const host = mkHost();
    assert.deepEqual(seedOperatorAgentProfile(host, NOW), { seeded: true });
    createAgentProfile(host, mkInput({ id: "adm-1", name: "taken" }), ADMIN);
    const c = createAgentProfile(host, mkInput({ id: "adm-2", name: "taken" }), ADMIN);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.error.code, "name_conflict");
    createAgentProfile(host, mkInput({ id: "adm-3", name: "other" }), ADMIN);
    const u = updateAgentProfile(
      host,
      { id: "adm-3", name: "taken", updatedAt: "2026-07-01T01:00:00.000Z" },
      ADMIN,
    );
    assert.equal(u.ok, false);
    if (!u.ok) assert.equal(u.error.code, "name_conflict");
  });
});

// ── retention stamping + lifecycle sweep ─────────────────────
import { sweepSpawnedAgentRows } from "./agentProfileOps";

describe("spawned-agent retention + sweep", () => {
  it("agent-spawned create stamps retention_policy=task_scoped; user create stays durable", () => {
    const host = mkHost();
    const rUser = createAgentProfile(host, mkInput({ id: "u1", name: "user-made" }), USER_A);
    const rSpawn = createAgentProfile(
      host,
      { ...mkInput({ id: "s1", name: "spawned-one" }), parentAgentId: "mgr-1" },
      USER_A,
    );
    assert.equal(rUser.ok, true);
    assert.equal(rSpawn.ok, true);
    if (!rUser.ok || !rSpawn.ok) return;
    assert.equal(rUser.profile.retention_policy, "durable");
    assert.equal(rSpawn.profile.retention_policy, "task_scoped");
    assert.equal(host._rows.find(r => r.id === "s1")!.retention_policy, "task_scoped");
  });

  it("sweep archives idle task_scoped spawned agents; legacy durable only with includeLegacy", () => {
    const host = mkHost();
    const seed = (id: string, retention: string, updated: string) =>
      host._rows.push({
        id, name: id, model: "m", channel: "c", skillset: "s", persona: "", status: "initialized",
        owner_user_id: "user-a", created_at: updated, updated_at: updated,
        origin: "spawned", parent_agent_id: "mgr", retention_policy: retention,
      });
    seed("old-scoped", "task_scoped", "2026-07-01T00:00:00.000Z");
    seed("old-durable", "durable", "2026-07-01T00:00:00.000Z");
    seed("fresh-scoped", "task_scoped", "2026-07-13T00:00:00.000Z");

    // sweep host: reuse the fake sql? it doesn't route the sweep SELECT/UPDATE.
    // Use a minimal host over the same rows instead.
    const sweepHost = {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        const v = values as string[];
        if (text.startsWith("SELECT id, name, updated_at, retention_policy")) {
          const cutoff = v[0];
          const legacy = text.includes("'durable'");
          return host._rows
            .filter(r => r.origin === "spawned" && r.status === "initialized")
            .filter(r => legacy || r.retention_policy !== "durable")
            .filter(r => (r.updated_at as string) < cutoff)
            .map(r => ({ id: r.id, name: r.name, updated_at: r.updated_at, retention_policy: r.retention_policy }));
        }
        if (text.startsWith("UPDATE agent_profile SET status = 'archived'")) {
          const [nowIso, id] = v;
          const row = host._rows.find(r => r.id === id);
          if (row) { row.status = "archived"; row.updated_at = nowIso; }
          return [];
        }
        throw new Error("unrouted sweep sql: " + text);
      }) as unknown as AgentProfileSqlTag,
    };

    // dry run: nothing archived
    const dry = sweepSpawnedAgentRows(sweepHost, { cutoffIso: "2026-07-07T00:00:00.000Z", dryRun: true, nowIso: "2026-07-14T00:00:00.000Z" });
    assert.deepEqual(dry.archived.map(a => a.id), ["old-scoped"]);
    assert.equal(host._rows.find(r => r.id === "old-scoped")!.status, "initialized");

    // real run without legacy: only old-scoped archived
    const run = sweepSpawnedAgentRows(sweepHost, { cutoffIso: "2026-07-07T00:00:00.000Z", nowIso: "2026-07-14T00:00:00.000Z" });
    assert.deepEqual(run.archived.map(a => a.id), ["old-scoped"]);
    assert.equal(host._rows.find(r => r.id === "old-scoped")!.status, "archived");
    assert.equal(host._rows.find(r => r.id === "old-durable")!.status, "initialized");

    // legacy opt-in: the pre-472 durable spawned gets archived too
    const legacyRun = sweepSpawnedAgentRows(sweepHost, { cutoffIso: "2026-07-07T00:00:00.000Z", includeLegacy: true, nowIso: "2026-07-14T00:00:00.000Z" });
    assert.deepEqual(legacyRun.archived.map(a => a.id), ["old-durable"]);
    assert.equal(host._rows.find(r => r.id === "old-durable")!.status, "archived");
    // fresh one untouched throughout
    assert.equal(host._rows.find(r => r.id === "fresh-scoped")!.status, "initialized");
  });
});
