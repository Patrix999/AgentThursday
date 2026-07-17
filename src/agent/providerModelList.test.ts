/**
 * provider list-models parsing.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseModelsResponse, parseGoogleModels } from "./providerModelList";

describe("parseGoogleModels (2026-06-22)", () => {
  it("strips the models/ prefix and keeps only generateContent models", () => {
    const out = parseGoogleModels({
      models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-pro" },
      ],
    });
    assert.deepEqual(out, [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro" },
    ]);
  });
  it("returns [] for a non-list / missing models body", () => {
    assert.deepEqual(parseGoogleModels({}), []);
    assert.deepEqual(parseGoogleModels(null), []);
  });
});

describe("parseModelsResponse ", () => {
  it("parses the OpenAI/Anthropic {data:[{id}]} shape", () => {
    const out = parseModelsResponse({
      data: [
        { id: "deepseek-chat" },
        { id: "deepseek-reasoner", object: "model" },
      ],
    });
    assert.deepEqual(out, [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }]);
  });

  it("carries display_name as label (anthropic)", () => {
    const out = parseModelsResponse({
      data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }],
    });
    assert.deepEqual(out, [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }]);
  });

  it("ignores non-object/no-id entries and caps at 500 (an earlier revision: raised from 100 — OpenAI exceeds 100)", () => {
    // 150 real models must ALL come through now (previously truncated to 100).
    const oneFifty = { data: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })) };
    assert.equal(parseModelsResponse(oneFifty).length, 150);
    // the bound still holds at the new ceiling.
    const tooMany = { data: Array.from({ length: 600 }, (_, i) => ({ id: `m${i}` })) };
    assert.equal(parseModelsResponse(tooMany).length, 500);
    assert.deepEqual(parseModelsResponse({ data: [42, { foo: 1 }, { id: "ok" }] }), [{ id: "ok" }]);
  });

  it("returns [] for a non-list body", () => {
    assert.deepEqual(parseModelsResponse({}), []);
    assert.deepEqual(parseModelsResponse(null), []);
  });
});
