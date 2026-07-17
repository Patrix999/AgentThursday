import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deleteCustomSkillset } from "./customSkillsetOps";

// Minimal in-memory host: only the SELECT owner + DELETE the op issues.
function makeHost(seed: { id: string; owner_user_id: string }[]) {
  let rows = [...seed];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT owner_user_id FROM custom_skillset WHERE id =")) {
      return rows.filter((r) => r.id === values[0]).map((r) => ({ owner_user_id: r.owner_user_id }));
    }
    if (q.startsWith("DELETE FROM custom_skillset WHERE id =")) {
      rows = rows.filter((r) => r.id !== values[0]);
      return [];
    }
    throw new Error("unexpected query: " + q);
  };
  return { host: { sql } as never, remaining: () => rows };
}

describe("deleteCustomSkillset — owner-scoped destructive op", () => {
  it("admin (undefined scope) deletes a system/any row", () => {
    const { host, remaining } = makeHost([{ id: "external-publishing", owner_user_id: "user-system" }]);
    const r = deleteCustomSkillset(host, "external-publishing", undefined);
    assert.equal(r.ok, true);
    assert.equal(remaining().length, 0);
  });

  it("scoped user cannot delete another owner's row (not_found, no delete)", () => {
    const { host, remaining } = makeHost([{ id: "x", owner_user_id: "user-a" }]);
    const r = deleteCustomSkillset(host, "x", "user-b");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not_found");
    assert.equal(remaining().length, 1); // untouched
  });

  it("scoped user deletes its own row", () => {
    const { host, remaining } = makeHost([{ id: "x", owner_user_id: "user-a" }]);
    const r = deleteCustomSkillset(host, "x", "user-a");
    assert.equal(r.ok, true);
    assert.equal(remaining().length, 0);
  });

  it("unknown id → not_found", () => {
    const { host } = makeHost([]);
    const r = deleteCustomSkillset(host, "nope", undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not_found");
  });
});
