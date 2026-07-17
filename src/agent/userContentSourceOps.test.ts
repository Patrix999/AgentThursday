import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

import {
  type UserContentSourceHost,
  type UserContentSourceSqlTag,
  ensureUserContentSourceTable,
  insertUserContentSource,
  listUserContentSourcesByOwner,
  getUserContentSourceById,
  deleteUserContentSourceRow,
} from "./userContentSourceOps";

/**
 * Real-SQLite coverage for the BYO-GitHub per-user content-source store. This is
 * the tenant-isolation foundation: list is owner-filtered, get-by-id returns the
 * owner column (the gate key), and source_id is a real PK (no silent overwrite).
 */
function mkSqlite(): { host: UserContentSourceHost; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const params = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as Array<
      string | number | bigint | null | Uint8Array
    >;
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)/i.test(text);
    const stmt = db.prepare(text);
    if (isQuery) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }) as unknown as UserContentSourceSqlTag;
  return { host: { sql }, db };
}

const U_A = "user-aaaa";
const U_B = "user-bbbb";

describe("userContentSourceOps — owner-scoped store", () => {
  it("lists ONLY the querying owner's sources; never another tenant's", () => {
    const { host } = mkSqlite();
    ensureUserContentSourceTable(host);
    insertUserContentSource(host, { source_id: "a-repo-1", owner_user_id: U_A, provider: "github", repo: "alice/one" }, "2026-06-26T00:00:00Z");
    insertUserContentSource(host, { source_id: "a-repo-2", owner_user_id: U_A, provider: "github", repo: "alice/two", default_ref: "dev", label: "Two" }, "2026-06-26T00:00:01Z");
    insertUserContentSource(host, { source_id: "b-repo-1", owner_user_id: U_B, provider: "github", repo: "bob/one" }, "2026-06-26T00:00:02Z");

    const a = listUserContentSourcesByOwner(host, U_A);
    assert.deepEqual(a.map((r) => r.source_id), ["a-repo-1", "a-repo-2"]);
    const b = listUserContentSourcesByOwner(host, U_B);
    assert.deepEqual(b.map((r) => r.source_id), ["b-repo-1"]);
    // Defaults/labels round-trip.
    assert.equal(a[0].default_ref, null);
    assert.equal(a[1].default_ref, "dev");
    assert.equal(a[1].label, "Two");
  });

  it("get-by-id returns the owner column (the gate key) and null for unknown", () => {
    const { host } = mkSqlite();
    ensureUserContentSourceTable(host);
    insertUserContentSource(host, { source_id: "a-repo-1", owner_user_id: U_A, provider: "github", repo: "alice/one" }, "2026-06-26T00:00:00Z");

    const row = getUserContentSourceById(host, "a-repo-1");
    assert.equal(row?.owner_user_id, U_A);
    assert.equal(row?.repo, "alice/one");
    assert.equal(getUserContentSourceById(host, "does-not-exist"), null);
  });

  it("source_id is a PRIMARY KEY — duplicate insert throws (no silent overwrite)", () => {
    const { host } = mkSqlite();
    ensureUserContentSourceTable(host);
    insertUserContentSource(host, { source_id: "dup", owner_user_id: U_A, provider: "github", repo: "alice/one" }, "2026-06-26T00:00:00Z");
    assert.throws(() =>
      // Even a DIFFERENT owner cannot clobber an existing id — the insert fails,
      // it does not steal/overwrite the row.
      insertUserContentSource(host, { source_id: "dup", owner_user_id: U_B, provider: "github", repo: "bob/evil" }, "2026-06-26T00:00:01Z"),
    );
    assert.equal(getUserContentSourceById(host, "dup")?.owner_user_id, U_A);
  });

  it("delete is owner-scoped — a non-owner cannot delete another tenant's source", () => {
    const { host } = mkSqlite();
    ensureUserContentSourceTable(host);
    insertUserContentSource(host, { source_id: "a-1", owner_user_id: U_A, provider: "github", repo: "alice/one" }, "2026-06-26T00:00:00Z");

    // U_B trying to delete U_A's source → no-op, row survives.
    assert.equal(deleteUserContentSourceRow(host, "a-1", U_B), false);
    assert.equal(getUserContentSourceById(host, "a-1")?.owner_user_id, U_A);
    // Unknown id → false.
    assert.equal(deleteUserContentSourceRow(host, "nope", U_A), false);
    // The owner CAN delete it.
    assert.equal(deleteUserContentSourceRow(host, "a-1", U_A), true);
    assert.equal(getUserContentSourceById(host, "a-1"), null);
  });

  it("ensure table is idempotent (DO init runs every wake)", () => {
    const { host } = mkSqlite();
    ensureUserContentSourceTable(host);
    ensureUserContentSourceTable(host);
    insertUserContentSource(host, { source_id: "x", owner_user_id: U_A, provider: "github", repo: "alice/x" }, "2026-06-26T00:00:00Z");
    assert.equal(listUserContentSourcesByOwner(host, U_A).length, 1);
  });
});
