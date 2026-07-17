import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  defaultAgentRuntimeModel,
  isRunnableAgentRuntimeModel,
  listAgentRuntimeModelEntries,
  listAgentRuntimeModelOptions,
  resolveAgentRuntimeModel,
} from "./agentModelRuntime";
import { MODEL_CONTEXT_REGISTRY } from "../contextWindowRegistry";

describe("agentModelRuntime — resolver", () => {
  it("kimi-k2.6 resolves to workers-ai @cf/moonshotai/kimi-k2.6 as the available default", () => {
    const entry = resolveAgentRuntimeModel("kimi-k2.6");
    assert.ok(entry, "kimi-k2.6 must resolve");
    assert.equal(entry?.provider, "workers-ai");
    assert.equal(entry?.runtimeStatus, "available");
    assert.equal(entry?.target, "@cf/moonshotai/kimi-k2.6");
  });

  it("glm-4.7-flash resolves to workers-ai @cf/zai-org/glm-4.7-flash as available", () => {
    const entry = resolveAgentRuntimeModel("glm-4.7-flash");
    assert.ok(entry, "glm-4.7-flash must resolve");
    assert.equal(entry?.provider, "workers-ai");
    assert.equal(entry?.runtimeStatus, "available");
    assert.equal(entry?.target, "@cf/zai-org/glm-4.7-flash");
    assert.equal(isRunnableAgentRuntimeModel("glm-4.7-flash"), true);
  });

  it("at least two runtime entries are available — the model selector is no longer a one-item switch", () => {
    const availableIds = listAgentRuntimeModelEntries()
      .filter(e => e.runtimeStatus === "available" && e.target !== null)
      .map(e => e.id);
    assert.ok(
      availableIds.length >= 2,
      `expected >= 2 available entries, got ${availableIds.length}: ${availableIds.join(", ")}`,
    );
    assert.ok(availableIds.includes("kimi-k2.6"));
    assert.ok(availableIds.includes("glm-4.7-flash"));
  });

  it("defaultAgentRuntimeModel() returns the kimi-k2.6 workers-ai entry", () => {
    const def = defaultAgentRuntimeModel();
    assert.equal(def.id, "kimi-k2.6");
    assert.equal(def.provider, "workers-ai");
    assert.equal(def.runtimeStatus, "available");
    assert.equal(def.target, "@cf/moonshotai/kimi-k2.6");
  });

  it("unknown model id resolves to null (caller decides fallback policy)", () => {
    assert.equal(resolveAgentRuntimeModel("does-not-exist-9"), null);
    assert.equal(resolveAgentRuntimeModel(""), null);
    assert.equal(resolveAgentRuntimeModel(null as unknown as string), null);
    assert.equal(resolveAgentRuntimeModel(undefined), null);
  });

  it("openai/google have no static entries (discover→enable only)", () => {
    // 2026-06-22 — openai/google (like deepseek) have NO static entries: their
    // models reach the picker via discover→enable, dispatched by their @ai-sdk
    // provider. An unresolved static lookup is null (not a not_configured stub
    // that would shadow the discovered id).
    for (const id of ["gpt-4.1", "gpt-4o", "gemini-2.5-pro", "gemini-2.5-flash"]) {
      assert.equal(resolveAgentRuntimeModel(id), null, `${id} should have no static entry`);
      assert.equal(isRunnableAgentRuntimeModel(id, { anthropicKeyPresent: true }), false, `${id} not runnable without discovery`);
    }
  });

  it("anthropic models are key-gated, not statically runnable", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      assert.equal(isRunnableAgentRuntimeModel(id), false, `${id} not runnable without key`);
      assert.equal(isRunnableAgentRuntimeModel(id, { anthropicKeyPresent: true }), true, `${id} runnable with key`);
    }
  });

  it("isRunnableAgentRuntimeModel('kimi-k2.6') is true", () => {
    assert.equal(isRunnableAgentRuntimeModel("kimi-k2.6"), true);
  });

  it("isRunnableAgentRuntimeModel for unknown id is false", () => {
    assert.equal(isRunnableAgentRuntimeModel("nope"), false);
  });

  it("listAgentRuntimeModelOptions strips the executable target", () => {
    const opts = listAgentRuntimeModelOptions();
    assert.ok(opts.length >= 1);
    for (const o of opts) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(o, "target"),
        false,
        `${o.id}: target must not appear in the public option shape`,
      );
      assert.ok(typeof o.id === "string");
      assert.ok(typeof o.label === "string");
      assert.ok(["workers-ai", "anthropic", "deepseek", "openai", "google"].includes(o.provider));
      assert.ok(o.runtimeStatus === "available" || o.runtimeStatus === "not_configured");
    }
  });

  it("every runtime entry id is present in MODEL_CONTEXT_REGISTRY", () => {
    // Mirrors the module's load-time check; this assertion exists so
    // the gap fires from `npm test` even if the load-time check ever
    // regresses to a soft warning.
    for (const e of listAgentRuntimeModelEntries()) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_REGISTRY, e.id),
        `${e.id} missing from MODEL_CONTEXT_REGISTRY`,
      );
    }
  });

  it("at least one entry is `available` (otherwise no agent can run)", () => {
    const anyAvailable = listAgentRuntimeModelEntries().some(
      e => e.runtimeStatus === "available" && e.target !== null,
    );
    assert.equal(anyAvailable, true);
  });
});
