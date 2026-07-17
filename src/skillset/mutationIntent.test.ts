import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { detectMutationIntent, hasReviewFraming } from "./mutationIntent";

/**
 * an earlier revision follow-up (2026-07-01) — review-framing suppression.
 *
 * A code-review prompt is packed with mutation verb+path phrases (it describes
 * the diff under review), but the reviewer calls no mutating tool → the gate
 * emitted `mutation_intent_no_execution` on every agentD review reply and even
 * truncated the output. Fix: suppress mutation-intent when strong review
 * framing is present, WITHOUT blinding the gate for real mutation requests.
 */

describe("detectMutationIntent — real mutation requests still fire (preserved protection)", () => {
  it("an earlier revision motivating case (create+delete a file, no review framing) → detected", () => {
    // Runs through the actual suppression branch: review framing ABSENT → not suppressed.
    const r = detectMutationIntent("在 `docs/qa/` 下创建一个临时文件 `probe.md` 然后删掉它");
    assert.equal(r.detected, true);
    assert.equal(r.matchedPatterns.includes("suppressed_review_framing"), false);
  });

  it("English write request → detected", () => {
    const r = detectMutationIntent("please create src/newModule.ts with a hello export");
    assert.equal(r.detected, true);
  });

  it("bare mutation verb without a path → not detected (unchanged)", () => {
    assert.equal(detectMutationIntent("I'd write a doc about this someday").detected, false);
    assert.equal(detectMutationIntent("what does delete do?").detected, false);
  });
});

describe("detectMutationIntent — code-review prompts are suppressed (false-positive fix)", () => {
  it("style review dispatch (mutation verbs + paths + review framing) → suppressed", () => {
    const reviewPrompt =
      "请 code-review an earlier revision：写 drain-to-self `src/agent/contextOps.ts` 的归档写；" +
      "删了死 `archiveChunksRemote`。给 PASS/FAIL + 真实代码行。";
    const r = detectMutationIntent(reviewPrompt);
    assert.equal(r.detected, false);
    // fired verb keys are still recorded for observability, plus the suppression marker
    assert.equal(r.matchedPatterns.includes("suppressed_review_framing"), true);
    assert.ok(r.matchedPatterns.some((p) => p.endsWith("_zh") || p.endsWith("_en")));
  });

  it("Chinese 复核 / 评审 framing suppresses", () => {
    assert.equal(detectMutationIntent("请复核这个改动：修改 `src/server.ts` 的 onChatResponse").detected, false);
    assert.equal(detectMutationIntent("代码评审：新增 `src/foo.ts`，删除 `src/bar.ts`").detected, false);
  });

  it("a review prompt with NO mutation verbs → not detected (nothing to suppress)", () => {
    const r = detectMutationIntent("code review: does src/auth.ts look correct?");
    assert.equal(r.detected, false);
    assert.equal(r.matchedPatterns.includes("suppressed_review_framing"), false);
  });
});

describe("hasReviewFraming", () => {
  it("true for strong review markers", () => {
    for (const s of ["code review", "code-review", "请复核一下", "代码评审", "给 PASS/FAIL", "final verdict", "review the diff"]) {
      assert.equal(hasReviewFraming(s), true, s);
    }
  });
  it("false for a plain mutation request (no review markers)", () => {
    assert.equal(hasReviewFraming("在 docs/ 创建 X.md 然后删掉"), false);
    assert.equal(hasReviewFraming("fix the failing test in src/x.test.ts"), false);
  });
});
