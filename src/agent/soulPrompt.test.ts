import { test } from "node:test";
import assert from "node:assert/strict";

import { SOUL, OPERATOR_SOUL, NEUTRAL_SOUL, selectBaseSoul } from "./soulPrompt";
import { UNTRUSTED_DOCUMENT_SOUL_RULE } from "./documentContent";
import { ADMIN_USER_ID } from "./requestIdentity";

test("admin / legacy owner → operator SOUL (base + untrusted-document rule)", () => {
  assert.equal(selectBaseSoul(ADMIN_USER_ID), OPERATOR_SOUL);
});

test("operator SOUL = confidential base + untrusted-document rule (Codex P1)", () => {
  // Admin agents run document tools too, so they must carry the untrusted-doc
  // rule; it lives OUTSIDE the leak-scan corpus (the guard scans `SOUL`).
  assert.ok(OPERATOR_SOUL.startsWith(SOUL), "operator SOUL must contain the confidential base");
  assert.ok(OPERATOR_SOUL.includes(UNTRUSTED_DOCUMENT_SOUL_RULE), "operator SOUL must carry the untrusted-document rule");
  assert.ok(!SOUL.includes(UNTRUSTED_DOCUMENT_SOUL_RULE), "leak-scan base SOUL must NOT include the shareable doc rule");
});

test("scoped user owner → neutral SOUL", () => {
  assert.equal(selectBaseSoul("user-0example0"), NEUTRAL_SOUL);
});

test("unknown / unresolved owner → neutral SOUL (leak-safe default)", () => {
  assert.equal(selectBaseSoul(undefined), NEUTRAL_SOUL);
  assert.equal(selectBaseSoul(null), NEUTRAL_SOUL);
  assert.equal(selectBaseSoul(""), NEUTRAL_SOUL);
});

test("the two SOULs are distinct", () => {
  assert.notEqual(SOUL, NEUTRAL_SOUL);
});

test("neutral SOUL leaks NO operator / AgentThursday / team identity", () => {
  for (const needle of ["the operator", "AgentThursday", "AgentThursday", "agentthursday", "AgentThursday", "agentC", "agentD", "agentP", "agentQ", "kanban"]) {
    assert.ok(!NEUTRAL_SOUL.includes(needle), `neutral SOUL must not contain "${needle}"`);
  }
});

test("neutral SOUL still carries the cross-cutting runtime rules", () => {
  // truthfulness, reply hygiene (<think>), confidentiality
  assert.ok(/tool/i.test(NEUTRAL_SOUL));
  assert.ok(NEUTRAL_SOUL.includes("<think>"));
  assert.ok(/confidential/i.test(NEUTRAL_SOUL));
});
