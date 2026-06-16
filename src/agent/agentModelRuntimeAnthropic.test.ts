/**
 *  — Anthropic external-model runnability (key-gated).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveAgentRuntimeModel,
  isRunnableAgentRuntimeModel,
  isEntryRunnable,
  mergeRuntimeModelOptions,
} from "./agentModelRuntime";

describe("Anthropic model runnability ()", () => {
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

  it("openai/google entries stay un-runnable (not wired)", () => {
    assert.equal(isRunnableAgentRuntimeModel("gpt-4o", { anthropicKeyPresent: true }), false);
    assert.equal(isRunnableAgentRuntimeModel("gemini-2.5-pro", { anthropicKeyPresent: true }), false);
  });

  it("isEntryRunnable: null target is never runnable", () => {
    const gpt = resolveAgentRuntimeModel("gpt-4o")!;
    assert.equal(isEntryRunnable(gpt, { anthropicKeyPresent: true }), false);
  });
});

describe("DeepSeek + credential-gated runnability ()", () => {
  it("registers deepseek-chat with provider=deepseek + bare target", () => {
    const e = resolveAgentRuntimeModel("deepseek-chat");
    assert.notEqual(e, null);
    assert.equal(e!.provider, "deepseek");
    assert.equal(e!.target, "deepseek-chat");
  });

  it("deepseek not runnable without a configured provider", () => {
    assert.equal(isRunnableAgentRuntimeModel("deepseek-chat"), false);
    assert.equal(
      isRunnableAgentRuntimeModel("deepseek-chat", { configuredProviders: ["anthropic"] }),
      false,
    );
  });

  it("deepseek runnable when its provider is configured", () => {
    assert.equal(
      isRunnableAgentRuntimeModel("deepseek-chat", { configuredProviders: ["deepseek"] }),
      true,
    );
    assert.equal(
      isRunnableAgentRuntimeModel("deepseek-reasoner", { configuredProviders: ["deepseek", "anthropic"] }),
      true,
    );
  });

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

describe("mergeRuntimeModelOptions ()", () => {
  const staticOpts = [
    { id: "kimi-k2.6", label: "Kimi", provider: "workers-ai", runtimeStatus: "available" },
    { id: "deepseek-chat", label: "DeepSeek V3", provider: "deepseek", runtimeStatus: "not_configured" },
    { id: "claude-opus-4-8", label: "Opus", provider: "anthropic", runtimeStatus: "not_configured" },
  ] as Parameters<typeof mergeRuntimeModelOptions>[0];

  it("flips credential-gated static entries to available when configured", () => {
    const out = mergeRuntimeModelOptions(staticOpts, ["deepseek"], []);
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "available");
    assert.equal(out.find((o) => o.id === "claude-opus-4-8")!.runtimeStatus, "not_configured");
    assert.equal(out.find((o) => o.id === "kimi-k2.6")!.runtimeStatus, "available");
  });

  it("appends discovered models as available, deduped against static ids", () => {
    const out = mergeRuntimeModelOptions(staticOpts, ["deepseek"], [
      { provider: "deepseek", models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-v4-pro"] },
    ]);
    const flash = out.find((o) => o.id === "deepseek-v4-flash");
    assert.notEqual(flash, undefined);
    assert.equal(flash!.runtimeStatus, "available");
    assert.equal(flash!.label, "deepseek-v4-flash (deepseek)");
    // deepseek-chat stays a single (static) entry
    assert.equal(out.filter((o) => o.id === "deepseek-chat").length, 1);
  });

  it("ignores discovered models from unconfigured providers", () => {
    const out = mergeRuntimeModelOptions(staticOpts, [], [
      { provider: "deepseek", models: ["deepseek-v4-flash"] },
    ]);
    assert.equal(out.find((o) => o.id === "deepseek-v4-flash"), undefined);
    assert.equal(out.find((o) => o.id === "deepseek-chat")!.runtimeStatus, "not_configured");
  });
});
