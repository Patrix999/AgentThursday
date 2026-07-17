import { test } from "node:test";
import assert from "node:assert/strict";

import { canBind } from "./conversationBindingScope";

const mine = new Set(["1001", "1002"]); // the caller's BYO bot channels

test("own channel + own agent + bind → allow", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: "1001", clearing: false, agentOwnedByCaller: true }),
    { allow: true },
  );
});

test("own channel + OTHER's agent + bind → deny agent_not_owned", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: "1001", clearing: false, agentOwnedByCaller: false }),
    { allow: false, reason: "agent_not_owned" },
  );
});

test("OTHER's channel + own agent + bind → deny conversation_not_owned", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: "9999", clearing: false, agentOwnedByCaller: true }),
    { allow: false, reason: "conversation_not_owned" },
  );
});

test("own channel + clear → allow (clear needs only conversation ownership)", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: "1002", clearing: true, agentOwnedByCaller: false }),
    { allow: true },
  );
});

test("OTHER's channel + clear → deny (no cross-tenant unbind)", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: "9999", clearing: true, agentOwnedByCaller: false }),
    { allow: false, reason: "conversation_not_owned" },
  );
});

test("null channel (pre-seed / env-bot / DM) → deny conversation_not_owned, even with own agent", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: null, clearing: false, agentOwnedByCaller: true }),
    { allow: false, reason: "conversation_not_owned" },
  );
});

test("null channel + clear → deny (fail closed)", () => {
  assert.deepEqual(
    canBind({ callerChannels: mine, conversationChannelId: null, clearing: true, agentOwnedByCaller: true }),
    { allow: false, reason: "conversation_not_owned" },
  );
});

test("caller with no channels owns nothing → every bind/clear denied", () => {
  const none = new Set<string>();
  assert.equal(canBind({ callerChannels: none, conversationChannelId: "1001", clearing: false, agentOwnedByCaller: true }).allow, false);
  assert.equal(canBind({ callerChannels: none, conversationChannelId: "1001", clearing: true, agentOwnedByCaller: true }).allow, false);
});

test("conversation ownership is checked BEFORE agent ownership (deny reason is channel, not agent)", () => {
  // other's channel + other's agent → the conversation check must fire first.
  const r = canBind({ callerChannels: mine, conversationChannelId: "9999", clearing: false, agentOwnedByCaller: false });
  assert.deepEqual(r, { allow: false, reason: "conversation_not_owned" });
});
