/**
 *  — provider list-models parsing.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseModelsResponse } from "./providerModelList";

describe("parseModelsResponse ()", () => {
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

  it("ignores non-object/no-id entries and caps at 100", () => {
    const many = { data: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })) };
    assert.equal(parseModelsResponse(many).length, 100);
    assert.deepEqual(parseModelsResponse({ data: [42, { foo: 1 }, { id: "ok" }] }), [{ id: "ok" }]);
  });

  it("returns [] for a non-list body", () => {
    assert.deepEqual(parseModelsResponse({}), []);
    assert.deepEqual(parseModelsResponse(null), []);
  });
});
