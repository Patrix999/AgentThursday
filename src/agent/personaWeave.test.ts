import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  PERSONA_BLOCK_HEADER,
  PERSONA_BYTE_CAP,
  composePersonaBlock,
} from "./personaWeave";

const TRUNCATION_TAIL_FRAGMENT = `[... persona truncated to ${PERSONA_BYTE_CAP} bytes]`;

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe("composePersonaBlock", () => {
  it("returns skipReason=missing when profile is null", () => {
    const r = composePersonaBlock(null);
    assert.equal(r.text, "");
    assert.equal(r.personaBytes, 0);
    assert.equal(r.skipReason, "missing");
    assert.equal(r.truncated, false);
  });

  it("returns skipReason=missing when profile is undefined", () => {
    const r = composePersonaBlock(undefined);
    assert.equal(r.skipReason, "missing");
  });

  it("returns skipReason=empty for empty persona", () => {
    const r = composePersonaBlock({ persona: "" });
    assert.equal(r.text, "");
    assert.equal(r.skipReason, "empty");
  });

  it("returns skipReason=empty for whitespace-only persona", () => {
    const r = composePersonaBlock({ persona: "   \n\t  " });
    assert.equal(r.skipReason, "empty");
  });

  it("composes a normal ASCII persona under cap", () => {
    const r = composePersonaBlock({ persona: "Reviewer-basic tone." });
    assert.equal(r.skipReason, null);
    assert.equal(r.truncated, false);
    assert.equal(r.text, `${PERSONA_BLOCK_HEADER}\n\nReviewer-basic tone.`);
    assert.equal(r.personaBytes, "Reviewer-basic tone.".length);
  });

  it("trims surrounding whitespace before composing", () => {
    const r = composePersonaBlock({ persona: "\n  Hello.  \n" });
    assert.equal(r.text, `${PERSONA_BLOCK_HEADER}\n\nHello.`);
    assert.equal(r.personaBytes, "Hello.".length);
  });

  it("handles multi-byte UTF-8 (中文) without corruption", () => {
    // "界" is 3 UTF-8 bytes; 500 chars × 3 = 1500 bytes, under 2000 cap.
    const persona = "界".repeat(500);
    const r = composePersonaBlock({ persona });
    assert.equal(r.skipReason, null);
    assert.equal(r.truncated, false);
    assert.equal(r.personaBytes, 1500);
    assert.ok(r.text.endsWith("界".repeat(500)));
  });

  it("truncates a Chinese persona that exceeds the byte cap", () => {
    // 700 × 3 = 2100 bytes > 2000 byte cap → truncated.
    const persona = "界".repeat(700);
    const r = composePersonaBlock({ persona });
    assert.equal(r.skipReason, null);
    assert.equal(r.truncated, true);
    // Truncated text must be at or under cap (and on a clean UTF-8 boundary).
    assert.ok(r.personaBytes <= PERSONA_BYTE_CAP);
    // Truncation tail must be present in the rendered text.
    assert.ok(r.text.includes(TRUNCATION_TAIL_FRAGMENT));
    // Cap-snapped: 2000 / 3 = 666.67 → expect 666 full "界" chars (1998 bytes).
    assert.equal(r.personaBytes, 1998);
  });

  it("truncates a long ASCII persona at the byte cap exactly", () => {
    const persona = "a".repeat(2500);
    const r = composePersonaBlock({ persona });
    assert.equal(r.truncated, true);
    assert.equal(r.personaBytes, PERSONA_BYTE_CAP);
    assert.ok(r.text.includes(TRUNCATION_TAIL_FRAGMENT));
  });

  it("does not corrupt UTF-8 at the truncation boundary", () => {
    // Force a multi-byte character to straddle the cap by mixing
    // ASCII + Chinese. 1998 bytes of ASCII + "界" (3 bytes) puts the
    // cap mid-char; the helper must walk back to a clean boundary
    // rather than emitting a partial code point.
    const persona = "a".repeat(1998) + "界" + "x";
    const r = composePersonaBlock({ persona });
    assert.equal(r.truncated, true);
    // The 界 starts at byte 1998 and is 3 bytes long (1998..2001).
    // Cap is 2000 — mid-界 — so truncation walks back to byte 1998
    // and the kept text is the 1998 'a's, no partial multi-byte.
    assert.ok(r.personaBytes <= PERSONA_BYTE_CAP);
    // Validate decoder didn't produce U+FFFD replacement chars.
    assert.ok(!r.text.includes("�"));
  });
});
