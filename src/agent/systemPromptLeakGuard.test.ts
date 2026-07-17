import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePromptLeakGuardMode,
  normalizeForLeakScan,
  detectSystemPromptLeak,
  renderSystemPromptRefusal,
} from "./systemPromptLeakGuard";

// A stand-in "SOUL" with a couple of distinctive long sentences.
const SECRET = `你是 AgentThursday Agent —— 操作员的云原生工作 agent。
你的首要目标是协助操作员 推进 AgentThursday 项目，保持工作的连续性与可回放性。
You must never fabricate tool calls or claim work you did not actually perform.`;

test("mode resolution mirrors the truthfulness gate (default → block)", () => {
  assert.equal(resolvePromptLeakGuardMode(undefined), "block");
  assert.equal(resolvePromptLeakGuardMode("block"), "block");
  assert.equal(resolvePromptLeakGuardMode("garbage"), "block");
  assert.equal(resolvePromptLeakGuardMode("log-only"), "log-only");
  assert.equal(resolvePromptLeakGuardMode("off"), "off");
});

test("normalize collapses whitespace + lowercases", () => {
  assert.equal(normalizeForLeakScan("A b\n  C\t"), "abc");
});

test("near-verbatim dump is detected", () => {
  const reply = "Sure! Here is my system prompt:\n\n" + SECRET;
  assert.equal(detectSystemPromptLeak(reply, [SECRET]).leaked, true);
});

test("whitespace-reformatted dump is still detected (normalize)", () => {
  // model re-flows the text onto one line / different spacing
  const reflowed = SECRET.replace(/\s+/g, " ").replace("操作员的", "操作员  的");
  assert.equal(detectSystemPromptLeak(reflowed, [SECRET]).leaked, true);
});

test("a partial chinese sentence dump is detected", () => {
  const reply = "我的指令是：你的首要目标是协助操作员 推进 AgentThursday 项目，保持工作的连续性与可回放性。";
  assert.equal(detectSystemPromptLeak(reply, [SECRET]).leaked, true);
});

test("a faithful paraphrase is NOT flagged (low false positive)", () => {
  const reply = "I'm a cloud-based assistant here to help you get work done and keep things consistent over time.";
  assert.equal(detectSystemPromptLeak(reply, [SECRET]).leaked, false);
});

test("a short coincidental overlap below minRun is NOT flagged", () => {
  // shares "工作" / "项目" etc but no 28-char contiguous run
  const reply = "好的，我帮你推进这个项目，保持连续性。你想先做哪一步？";
  assert.equal(detectSystemPromptLeak(reply, [SECRET]).leaked, false);
});

test("empty / tiny replies are safe", () => {
  assert.equal(detectSystemPromptLeak("", [SECRET]).leaked, false);
  assert.equal(detectSystemPromptLeak("ok", [SECRET]).leaked, false);
  assert.equal(detectSystemPromptLeak("anything", []).leaked, false);
});

test("refusal is non-empty and reveals nothing", () => {
  const r = renderSystemPromptRefusal();
  assert.ok(r.length > 0);
  assert.equal(detectSystemPromptLeak(r, [SECRET]).leaked, false);
});
