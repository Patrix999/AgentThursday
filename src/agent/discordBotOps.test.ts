import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  safeJsonStringArray,
  findDiscordBotOwner,
  listDiscordBotRows,
  deleteDiscordBotRow,
  type DiscordBotHost,
} from "./discordBotOps";
import type { RequestIdentity } from "./requestIdentity";

function fakeHost(returnRows: unknown[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const host: DiscordBotHost = {
    sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return returnRows as never;
    }) as DiscordBotHost["sql"],
  };
  return { host, calls };
}

const alice: RequestIdentity = { kind: "user", userId: "user-alice" };

describe("discordBotOps — owner-scoped SQL routing (M2 extraction, an earlier revision isolation)", () => {
  it("listDiscordBotRows: scoped user filters by owner_user_id", () => {
    const { host, calls } = fakeHost([]);
    listDiscordBotRows(host, alice);
    assert.match(calls[0].text, /owner_user_id/);
    assert.deepEqual(calls[0].values, ["user-alice"]);
  });
  it("listDiscordBotRows: admin/undefined sees all (no owner filter)", () => {
    const { host, calls } = fakeHost([]);
    listDiscordBotRows(host, undefined);
    assert.doesNotMatch(calls[0].text, /owner_user_id/);
  });
  it("deleteDiscordBotRow: scoped user delete is owner-guarded", () => {
    const { host, calls } = fakeHost();
    deleteDiscordBotRow(host, "123", alice);
    assert.match(calls[0].text, /owner_user_id/);
    assert.deepEqual(calls[0].values, ["123", "user-alice"]);
  });
  it("deleteDiscordBotRow: admin delete is unguarded (deletes by bot_id only)", () => {
    const { host, calls } = fakeHost();
    deleteDiscordBotRow(host, "123", undefined);
    assert.doesNotMatch(calls[0].text, /owner_user_id/);
    assert.deepEqual(calls[0].values, ["123"]);
  });
  it("findDiscordBotOwner returns owner or null", () => {
    assert.equal(findDiscordBotOwner(fakeHost([{ owner_user_id: "user-x" }]).host, "1"), "user-x");
    assert.equal(findDiscordBotOwner(fakeHost([]).host, "1"), null);
  });
  it("listDiscordBotRows parses allowed_channels_json per row", () => {
    const { host } = fakeHost([{ bot_id: "1", token_hint: "••••", username: "b", label: null, allowed_channels_json: '["100","200"]', updated_at: "t" }]);
    assert.deepEqual(listDiscordBotRows(host, undefined)[0].allowed_channels, ["100", "200"]);
  });
});

describe("safeJsonStringArray", () => {
  it("parses arrays, filters non-strings, safe on bad/empty input", () => {
    assert.deepEqual(safeJsonStringArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(safeJsonStringArray('["a",1,null]'), ["a"]);
    assert.deepEqual(safeJsonStringArray(null), []);
    assert.deepEqual(safeJsonStringArray("not json"), []);
  });
});
