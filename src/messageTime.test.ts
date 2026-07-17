/**
 * message timestamp formatting tests (pure; the web file has
 * no DOM deps so it imports fine under the node test runner via tsx).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { formatMessageTime } from "../web/src/shell/messageTime";

describe("formatMessageTime ", () => {
  const now = new Date("2026-06-11T14:30:00").getTime();

  it("shows HH:MM for same-day messages", () => {
    assert.equal(formatMessageTime(new Date("2026-06-11T09:05:00").getTime(), now), "09:05");
  });

  it("prefixes MM-DD for a different day", () => {
    assert.equal(formatMessageTime(new Date("2026-06-10T23:59:00").getTime(), now), "06-10 23:59");
  });

  it("pads single digits", () => {
    assert.equal(formatMessageTime(new Date("2026-06-11T03:07:00").getTime(), now), "03:07");
  });
});
