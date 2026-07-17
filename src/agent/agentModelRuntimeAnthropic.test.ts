/**
 * Anthropic external-model runnability (key-gated).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveAgentRuntimeModel,
  isRunnableAgentRuntimeModel,
  isEntryRunnable,
  mergeRuntimeModelOptions,
} from "./agentModelRuntime";

describe("Anthropic model runnability ", () => {
  it("registers claude-opus-4-8 with an anthropic provider + bare target", () => {
    const e = resolveAgentRuntimeModel("claude-opus-4-8");
    assert.notEqual(e, null);
    assert.equal(e!.provider, "anthropic");
    assert.equal(e!.target, "claude-opus-4-8");
  });

  it("is NOT runnable without the key", () => {
    assert.equal(isRunnableAgentRuntimeModel("claude-opus-4-8"), false);
    assert.equal(
      isRunnableAgentRuntimeModel("claude-opus-4-8", { anthropicKeyPresent: false }),
      false,
    );
  });

  it("IS runnable with the key", () => {
    assert.equal(
      isRunnableAgentRuntimeModel("claude-opus-4-8", { anthropicKeyPresent: true }),
      true,
    );
    assert.equal(
      isRunnableAgentRuntimeModel("claude-sonnet-4-6", { anthropicKeyPresent: true }),
      true,
    );
  });

  it("workers-ai models are runnable regardless of the anthropic key", () => {
    assert.equal(isRunnableAgentRuntimeModel("kimi-k2.6"), true);
    assert.equal(isRunnableAgentRuntimeModel("kimi-k2.6", { anthropicKeyPresent: false }), true);
  });

  it("an unknown (non-static) model id is not runnable without discovery", () => {
    // openai/google have no static entries — they reach the picker only via
    // discover→enable, and an unresolved id is not runnable.
    assert.equal(isRunnableAgentRuntimeModel("gpt-4o", { anthropicKeyPresent: true }), false);
    assert.equal(isRunnableAgentRuntimeModel("gemini-2.5-pro", { anthropicKeyPresent: true }), false);
  });

  it("isEntryRunnable: a null-target entry is never runnable", () => {
    const nullTarget = { id: "x", label: "X", provider: "openai" as const, runtimeStatus: "not_configured" as const, target: null };
    assert.equal(isEntryRunnable(nullTarget, { anthropicKeyPresent: true }), false);
  });
});

describe("credential-gated runnability via configuredProviders ", () => {
  // 2026-06-22 — the static DeepSeek entries were removed (DeepSeek now reaches
  // the picker via the discover→enable flow). The credential-gating logic these
  // tests covered is exercised below via anthropic; discovered-id merging is
  // covered in the mergeRuntimeModelOptions suite.
  it("configuredProviders generalizes the anthropic gate", () => {
    assert.equal(
      isRunnableAgentRuntimeModel("claude-opus-4-8", { configuredProviders: ["anthropic"] }),
      true,
    );
    // legacy anthropicKeyPresent alias still works
    assert.equal(
      isRunnableAgentRuntimeModel("claude-opus-4-8", { anthropicKeyPresent: true }),
      true,
    );
  });
});

describe("mergeRuntimeModelOptions ", () => {
  const staticOpts = [
    { id: "kimi-k2.6", label: "Kimi", provider: "workers-ai", runtimeStatus: "available" },
    { id: "deepseek-chat", label: "DeepSeek V3", provider: "deepseek", runtimeStatus: "not_configured" },
    { id: "claude-opus-4-8", label: "Opus", provider: "anthropic", runtimeStatus: "not_configured" },
  ] as Parameters<typeof mergeRuntimeModelOptions>[0];

  // 2026-06-22 — enable-authoritative: a credential-gated static entry is
  // available ONLY when its id is in the ENABLED set (the `discovered` arg),
  // not merely because the provider has a key.
  it("a credential-gated static entry stays not_configured when NOT enabled (even with a key)", () => {
    const out = mergeRuntimeModelOptions(staticOpts, ["deepseek", "anthropic"], []);
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "not_configured");
    assert.equal(out.find((o) => o.id === "claude-opus-4-8")!.runtimeStatus, "not_configured");
    assert.equal(out.find((o) => o.id === "kimi-k2.6")!.runtimeStatus, "available");
  });

  it("flips a credential-gated static entry to available when its id IS enabled", () => {
    const out = mergeRuntimeModelOptions(staticOpts, ["anthropic"], [
      { provider: "anthropic", models: ["claude-opus-4-8"] },
    ]);
    assert.equal(out.find((o) => o.id === "claude-opus-4-8")!.runtimeStatus, "available");
    // not enabled → stays disabled
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "not_configured");
  });

  it("appends enabled discovered models as available, deduped against static ids", () => {
    const out = mergeRuntimeModelOptions(staticOpts, ["deepseek"], [
      { provider: "deepseek", models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-v4-pro"] },
    ]);
    const flash = out.find((o) => o.id === "deepseek-v4-flash");
    assert.notEqual(flash, undefined);
    assert.equal(flash!.runtimeStatus, "available");
    assert.equal(flash!.label, "deepseek-v4-flash (deepseek)");
    // deepseek-chat stays a single (static) entry, flipped available by the enable
    assert.equal(out.filter((o) => o.id === "deepseek-chat").length, 1);
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "available");
  });

  it("ignores discovered models from unconfigured providers", () => {
    const out = mergeRuntimeModelOptions(staticOpts, [], [
      { provider: "deepseek", models: ["deepseek-v4-flash"] },
    ]);
    assert.equal(out.find((o) => o.id === "deepseek-v4-flash"), undefined);
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "not_configured");
  });
});
