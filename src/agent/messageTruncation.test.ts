import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { truncateLargeToolResultParts, defaultReReadHint } from "./messageTruncation";

const big = "x".repeat(20_000);

function msg(parts: unknown[]): string {
  return JSON.stringify({ id: "m1", role: "assistant", parts });
}

describe("truncateLargeToolResultParts (Card DO-OOM fix)", () => {
  it("truncates an oversized tool-result output but PRESERVES pairing fields", () => {
    const content = msg([
      { type: "text", text: "reading the file" },
      { type: "tool-content_read", toolCallId: "tc1", toolName: "content_read", state: "output-available", input: { path: "src/server.ts" }, output: { ok: true, result: big } },
    ]);
    const r = truncateLargeToolResultParts(content, { partLimitBytes: 8 * 1024 });
    assert.equal(r.changed, true);
    assert.equal(r.truncatedParts, 1);
    const out = JSON.parse(r.content);
    const part = out.parts[1];
    // pairing fields untouched
    assert.equal(part.type, "tool-content_read");
    assert.equal(part.toolCallId, "tc1");
    assert.equal(part.toolName, "content_read");
    assert.equal(part.state, "output-available");
    assert.deepEqual(part.input, { path: "src/server.ts" });
    // only output swapped → small marker with a re-read hint naming the file
    assert.equal(part.output.truncated, true);
    assert.equal(part.output.ok, true);
    assert.equal(part.output.originalBytes > 8 * 1024, true);
    assert.match(part.output.hint, /content_read src\/server\.ts/);
    // text part untouched
    assert.equal(out.parts[0].text, "reading the file");
    // the stored row is now tiny
    assert.equal(r.content.length < 1000, true);
  });

  it("is idempotent — re-running does not change an already-truncated part", () => {
    const content = msg([
      { type: "tool-content_read", toolCallId: "tc1", toolName: "content_read", state: "output-available", input: { path: "a.ts" }, output: { ok: true, result: big } },
    ]);
    const once = truncateLargeToolResultParts(content, { partLimitBytes: 8 * 1024 });
    const twice = truncateLargeToolResultParts(once.content, { partLimitBytes: 8 * 1024 });
    assert.equal(twice.changed, false);
    assert.equal(twice.content, once.content);
  });

  it("leaves small tool-results and non-tool parts alone", () => {
    const content = msg([
      { type: "text", text: "hello" },
      { type: "tool-content_read", toolCallId: "tc1", toolName: "content_read", state: "output-available", input: { path: "a.ts" }, output: { ok: true, result: "small" } },
      { type: "reasoning", text: "x".repeat(20_000) },
    ]);
    const r = truncateLargeToolResultParts(content, { partLimitBytes: 8 * 1024 });
    assert.equal(r.changed, false, "small tool output + large reasoning (non-tool) untouched");
  });

  it("builds the hint from url / doc_id when there is no path", () => {
    assert.match(defaultReReadHint("browse", { url: "https://x.com" }), /browse https:\/\/x\.com/);
    assert.match(defaultReReadHint("document_read", { doc_id: "doc-9" }), /document_read doc-9/);
    assert.equal(defaultReReadHint("repo_read", {}), "repo_read");
  });

  it("returns unchanged on unparseable content (fail-soft)", () => {
    const r = truncateLargeToolResultParts("not json", { partLimitBytes: 8 * 1024 });
    assert.equal(r.changed, false);
    assert.equal(r.content, "not json");
  });
});
