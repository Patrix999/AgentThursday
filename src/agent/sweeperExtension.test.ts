/**
 * sweeper gate-aware grace decision tests.
 *
 * 381 attempt #4: the 30-min backstop sealed the envelope while
 * gate.build was actively mid-run. The decision must extend on recent
 * tool activity, seal on quiet, and respect the extension cap.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  decideSweeperExtension,
  ENVELOPE_SWEEPER_ACTIVITY_WINDOW_MS,
  ENVELOPE_SWEEPER_MAX_EXTENSIONS,
} from "./envelopeOps";

const NOW = 1_781_088_000_000;

describe("decideSweeperExtension", () => {
  it("extends when a tool event landed inside the activity window", () => {
    const d = decideSweeperExtension({
      extensions: 0,
      lastToolEventAt: NOW - 100_000, // ~1.7 min ago (mid-gate)
      now: NOW,
    });
    assert.equal(d.extend, true);
    assert.equal(d.nextExtensions, 1);
    assert.equal(d.lastToolEventAgeMs, 100_000);
  });

  it("seals when the last tool event is older than the window (quiet turn)", () => {
    const d = decideSweeperExtension({
      extensions: 0,
      lastToolEventAt: NOW - ENVELOPE_SWEEPER_ACTIVITY_WINDOW_MS - 1,
      now: NOW,
    });
    assert.equal(d.extend, false);
  });

  it("seals at the extension cap even if still active (wedged-turn backstop)", () => {
    const d = decideSweeperExtension({
      extensions: ENVELOPE_SWEEPER_MAX_EXTENSIONS,
      lastToolEventAt: NOW - 1_000,
      now: NOW,
    });
    assert.equal(d.extend, false);
    assert.equal(d.nextExtensions, ENVELOPE_SWEEPER_MAX_EXTENSIONS);
  });

  it("seals when the DO has no tool events at all", () => {
    const d = decideSweeperExtension({
      extensions: 0,
      lastToolEventAt: null,
      now: NOW,
    });
    assert.equal(d.extend, false);
    assert.equal(d.lastToolEventAgeMs, null);
  });
});
