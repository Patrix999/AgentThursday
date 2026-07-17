import { test } from "node:test";
import assert from "node:assert/strict";

import { conversationIdForDiscordChannel } from "./channel";

// 2026-06-26 regression: a Discord channel's conversation id must be the SAME
// regardless of guildId — the WebSocket ingest path supplies the real guild_id
// while REST polling omits it (null). When guildId fed the hash, the same channel
// got two different conversation ids across modes → duplicate conversations +
// split bindings (the operator's #agentthursday "bound the wrong one" bug).

test("channel conversation id is guildId-independent (WS real-guild == polling null == omitted)", async () => {
  const ch = "100000000000000006";
  const ws = await conversationIdForDiscordChannel({ guildId: "999888777666", channelId: ch });
  const poll = await conversationIdForDiscordChannel({ guildId: null, channelId: ch });
  const none = await conversationIdForDiscordChannel({ channelId: ch });
  assert.equal(ws, poll, "WS (real guild) and polling (null guild) must produce the SAME id");
  assert.equal(ws, none, "omitting guildId is also the same id");
});

test("different channels still get different ids", async () => {
  assert.notEqual(
    await conversationIdForDiscordChannel({ channelId: "111111111111111111" }),
    await conversationIdForDiscordChannel({ channelId: "222222222222222222" }),
  );
});

test("a thread is a distinct conversation from its channel root", async () => {
  assert.notEqual(
    await conversationIdForDiscordChannel({ channelId: "111111111111111111" }),
    await conversationIdForDiscordChannel({ channelId: "111111111111111111", threadId: "333333333333333333" }),
  );
});
