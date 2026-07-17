/**
 * dangling-intent detection tests.
 *
 * an action, zero tools dispatched, task silently completes. Detector
 * must catch the two observed prod signatures and must NOT flag
 * legitimate text-only answers.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  detectDanglingIntent,
  renderDanglingIntentNote,
} from "./submitTaskOps";

const noDirective = () => false;

function detect(replyText: string, overrides: Partial<{
  display: string;
  wrappedToolCount: number;
  hasExplicitNoToolDirective: (text: string) => boolean;
}> = {}) {
  return detectDanglingIntent({
    display: overrides.display ?? "请用浏览器访问 https://example.com 做端到端验证",
    replyText,
    wrappedToolCount: overrides.wrappedToolCount ?? 0,
    hasExplicitNoToolDirective:
      overrides.hasExplicitNoToolDirective ?? noDirective,
  });
}

describe("detectDanglingIntent", () => {
  it("flags the task-mq7rv2gt prod signature (announce + terminal colon)", () => {
    const d = detect("我来访问这个域名并进行端到端验证：");
    assert.equal(d.detected, true);
    assert.match(d.matched_pattern ?? "", /^announce_colon:/);
  });

  it("flags the byok.icu signature (retry announcement + colon)", () => {
    const d = detect("抱歉，我再试一次自动访问并获取截图：");
    assert.equal(d.detected, true);
    assert.match(d.matched_pattern ?? "", /^announce_colon:/);
  });

  it("flags English announce + colon", () => {
    const d = detect("Let me browse the site and verify the sections:");
    assert.equal(d.detected, true);
    assert.match(d.matched_pattern ?? "", /^announce_colon:/);
  });

  it("does not flag when tools were dispatched", () => {
    const d = detect("我来访问这个域名并进行端到端验证：", {
      wrappedToolCount: 2,
    });
    assert.equal(d.detected, false);
  });

  it("does not flag a normal text answer (no terminal colon)", () => {
    const d = detect(
      "页面上的四个 section 标题是 Capabilities、Architecture、How the org works 和 footer。",
    );
    assert.equal(d.detected, false);
  });

  it("does not flag a long colon-terminated reply without announce phrase", () => {
    const longBody = "分析结论如下。".repeat(40);
    const d = detect(`${longBody}要点：`);
    assert.equal(d.detected, false);
  });

  it("does not flag closing courtesy phrases (announce phrase outside first 80 chars)", () => {
    const d = detect(
      `四个 section 标题核对完毕，与部署一致，没有发现渲染问题，导航锚点全部可用，页面在窄屏下正常折行。如有其他需要请让我来跟进：`,
    );
    assert.equal(d.detected, false);
  });

  it("respects an explicit no-tool directive", () => {
    const d = detect("我来分析一下这个问题：", {
      display: "不要调用任何工具，直接回答",
      hasExplicitNoToolDirective: () => true,
    });
    assert.equal(d.detected, false);
  });

  it("does not flag an empty reply", () => {
    const d = detect("   ");
    assert.equal(d.detected, false);
  });

  it("note text is the honest system annotation", () => {
    assert.match(renderDanglingIntentNote(), /宣布了行动但未调用任何工具/);
  });
});
