import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  isPauseEnabled,
  shouldPauseForNeedsHuman,
  isResumeIntent,
  renderAwaitingResumeMessage,
  renderPauseMessage,
} from "./pauseDecision";
import type { TaskDegradationSummary } from "./degradationSummary";

function mkSummary(overrides: Partial<TaskDegradationSummary> = {}): TaskDegradationSummary {
  return {
    taskId: "task-A",
    state: "needs_human",
    reasons: ["truthfulness_violation"],
    evidenceRefs: ["tool.truthfulness.violation"],
    modelProfile: {
      modelId: "kimi-k2.6",
      provider: "moonshot",
      adapter: "openai-compat",
      profileKnown: true,
      toolCalls: "reliable",
      streamingToolCalls: "reliable",
    },
    recommendedAction: "pause",
    createdAt: 0,
    ...overrides,
  };
}

describe("isPauseEnabled", () => {
  it("treats canonical truthy strings as enabled (case-insensitive, trimmed)", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes", "YES", "enabled", "Enabled"]) {
      assert.equal(isPauseEnabled({ AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN: v }), true, `expected "${v}" → true`);
    }
  });

  it("treats other strings, empty, and undefined as disabled", () => {
    for (const v of ["false", "0", "no", "disabled", "on", "", "  "]) {
      assert.equal(isPauseEnabled({ AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN: v }), false, `expected "${v}" → false`);
    }
    assert.equal(isPauseEnabled({}), false);
    assert.equal(isPauseEnabled({ AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN: undefined }), false);
  });
});

describe("shouldPauseForNeedsHuman", () => {
  it("returns true only when config enabled AND task matches AND state needs_human", () => {
    assert.equal(shouldPauseForNeedsHuman(true, mkSummary(), "task-A"), true);
  });

  it("returns false when config is disabled (regardless of state/task match)", () => {
    assert.equal(shouldPauseForNeedsHuman(false, mkSummary(), "task-A"), false);
  });

  it("returns false on stale task-id (task-local scope invariant — )", () => {
    assert.equal(shouldPauseForNeedsHuman(true, mkSummary({ taskId: "task-B" }), "task-A"), false);
  });

  it("returns false on any state other than needs_human", () => {
    for (const state of ["normal", "degraded", "blocked"] as const) {
      assert.equal(
        shouldPauseForNeedsHuman(true, mkSummary({ state }), "task-A"),
        false,
        `state="${state}" must not trigger pause`,
      );
    }
  });
});

describe("isResumeIntent", () => {
  it("accepts mechanical Chinese resume phrases", () => {
    for (const v of ["继续", "确认继续", "我确认继续", "同意继续", "确认", "继续。", "  继续  "]) {
      assert.equal(isResumeIntent(v), true, `expected "${v}" → true`);
    }
  });

  it("accepts mechanical English resume phrases (case-insensitive)", () => {
    for (const v of ["proceed", "Proceed", "PROCEED", "resume", "continue", "go", "go ahead", "ok proceed", "OK continue"]) {
      assert.equal(isResumeIntent(v), true, `expected "${v}" → true`);
    }
  });

  it("rejects casual / ambiguous text so chatty replies do not auto-resume", () => {
    for (const v of [
      "继续吧，但是先改一下 X",
      "proceed but check Y first",
      "继续！！！哈哈",
      "yes",
      "ok",
      "i think we should continue tomorrow",
      "",
      "   ",
    ]) {
      assert.equal(isResumeIntent(v), false, `expected "${v}" → false`);
    }
    assert.equal(isResumeIntent(null), false);
    assert.equal(isResumeIntent(undefined), false);
  });
});

describe("renderAwaitingResumeMessage", () => {
  it("includes task-id line when taskId is provided", () => {
    const out = renderAwaitingResumeMessage("task-XYZ");
    assert.match(out, /Task: task-XYZ/);
    assert.match(out, /当前任务仍处于暂停状态/);
    assert.match(out, /「继续」/);
  });

  it("omits the task-id line when taskId is null or empty", () => {
    for (const v of [null, undefined, ""]) {
      const out = renderAwaitingResumeMessage(v);
      assert.equal(/Task:/.test(out), false, `taskId=${JSON.stringify(v)} should not include Task: line`);
    }
  });
});

describe("renderPauseMessage", () => {
  it("includes core diagnostic fields and resume hint", () => {
    const out = renderPauseMessage(mkSummary());
    assert.match(out, /⏸ 我暂停了当前任务/);
    assert.match(out, /Task: task-A/);
    assert.match(out, /Reasons: truthfulness_violation/);
    assert.match(out, /Evidence: tool\.truthfulness\.violation/);
    assert.match(out, /Model: kimi-k2\.6/);
    assert.match(out, /toolCalls=reliable/);
    assert.match(out, /Action: pause/);
    assert.match(out, /「继续」|「proceed」|proceed/);
  });

  it("renders '—' placeholders when reason/evidence/action are absent", () => {
    const out = renderPauseMessage(mkSummary({ reasons: [], evidenceRefs: [], recommendedAction: null }));
    assert.match(out, /Reasons: —/);
    assert.match(out, /Evidence: —/);
    assert.match(out, /Action: —/);
  });

  it("flags unknown model profile distinctly from known profile", () => {
    const out = renderPauseMessage(mkSummary({
      modelProfile: {
        modelId: "weird-model-x",
        provider: null,
        adapter: null,
        profileKnown: false,
      },
    }));
    assert.match(out, /Model: weird-model-x \(profile unknown\)/);
  });
});
