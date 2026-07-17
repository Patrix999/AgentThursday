/**
 * BYO Discord bot helpers.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  tokenHint,
  parseChannelList,
  findChannelConflict,
  botForChannel,
} from "./discordBotRegistry";

describe("discordBotRegistry ", () => {
  it("tokenHint masks all but the last 4", () => {
    assert.equal(tokenHint("MTIzNDU2Nzg5.abcd"), "••••abcd");
    assert.equal(tokenHint("ab"), "••••");
  });

  it("parseChannelList accepts numeric snowflakes, dedupes, rejects junk", () => {
    assert.deepEqual(
      parseChannelList(["100000000000000006", " 123456789012 ", "100000000000000006"]),
      ["100000000000000006", "123456789012"],
    );
    assert.equal(parseChannelList(["not-a-snowflake"]), null);
    assert.equal(parseChannelList("123"), null);
    assert.equal(parseChannelList([42]), null);
  });

  it("findChannelConflict flags env and other-bot ownership", () => {
    const envCh = ["111111111111"];
    const bots = [{ bot_id: "bot-a", allowed_channels: ["222222222222"] }];
    assert.deepEqual(
      findChannelConflict(["111111111111"], envCh, bots),
      { channel: "111111111111", ownedBy: "env (DISCORD_ALLOWED_CHANNELS)" },
    );
    assert.deepEqual(
      findChannelConflict(["222222222222"], envCh, bots),
      { channel: "222222222222", ownedBy: "bot-a" },
    );
    assert.equal(findChannelConflict(["333333333333"], envCh, bots), null);
  });

  it("botForChannel resolves the owning bot or null", () => {
    const bots = [
      { bot_id: "a", token: "t1", allowed_channels: ["111111111111"] },
      { bot_id: "b", token: "t2", allowed_channels: ["222222222222"] },
    ];
    assert.equal(botForChannel(bots, "222222222222")!.bot_id, "b");
    assert.equal(botForChannel(bots, "999999999999"), null);
  });
});
