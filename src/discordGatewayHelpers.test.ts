import { test } from "node:test";
import assert from "node:assert/strict";

import { eventToDirectPayload, shouldForwardEvent, type DiscordMessageCreate } from "./discordGatewayHelpers";

// an earlier revision fix (2026-06-26): a BYO bot's poll must check "@mention of the bot"
// against THAT bot's user id, not the env bot's — else a user @mentioning their
// own bot reads as no-mention and is dropped by DISCORD_IGNORE_NO_MENTION.

const BYO = "100000000000000005"; // the operator's BYO bot (agentV) user id
const ENV = "100000000000000004"; // env/system bot user id

function guildMsg(over: Partial<DiscordMessageCreate> = {}): DiscordMessageCreate {
  return {
    id: "msg-1",
    channel_id: "100000000000000007",
    guild_id: "guild-1",
    author: { id: "user-alice" },
    content: `hey <@${BYO}> route this`,
    type: 0,
    mentions: [{ id: BYO }],
    ...over,
  } as DiscordMessageCreate;
}

test("mention of the BYO bot is detected when its own id is passed (the fix)", () => {
  const p = eventToDirectPayload(guildMsg(), BYO, { isDmOverride: false });
  assert.equal(p.mentionsBot, true);
});

test("the SAME message reads as no-mention against the ENV bot id (the bug)", () => {
  const p = eventToDirectPayload(guildMsg(), ENV, { isDmOverride: false });
  assert.equal(p.mentionsBot, false, "this is exactly why BYO-bot messages were dropped");
});

test("a reply to the BYO bot is detected against its id", () => {
  const ev = guildMsg({ mentions: [], referenced_message: { author: { id: BYO } } });
  assert.equal(eventToDirectPayload(ev, BYO, { isDmOverride: false }).replyToBot, true);
  assert.equal(eventToDirectPayload(ev, ENV, { isDmOverride: false }).replyToBot, false);
});

test("shouldForwardEvent self-skips messages authored by the polling bot", () => {
  // The BYO bot's own messages must be skipped (no self-processing loop)...
  assert.equal(shouldForwardEvent(guildMsg({ author: { id: BYO } }), BYO).forward, false);
  // ...but a user's message in that channel is forwarded.
  assert.equal(shouldForwardEvent(guildMsg({ author: { id: "user-alice" } }), BYO).forward, true);
});
