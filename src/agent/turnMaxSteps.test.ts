/**
 * per-turn inference step cap tests.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveTurnMaxSteps } from "./submitTaskOps";

describe("resolveTurnMaxSteps", () => {
  it("defaults to 48 when env is unset", () => {
    assert.equal(resolveTurnMaxSteps(undefined), 48);
  });

  it("parses a numeric string", () => {
    assert.equal(resolveTurnMaxSteps("60"), 60);
  });

  it("clamps below 10 up to 10 (cannot restore the wall below the SDK default)", () => {
    assert.equal(resolveTurnMaxSteps("3"), 10);
  });

  it("clamps above 120 down to 120 (cannot unbound the loop)", () => {
    assert.equal(resolveTurnMaxSteps("999"), 120);
  });

  it("falls back to default on garbage", () => {
    assert.equal(resolveTurnMaxSteps("forty"), 48);
    assert.equal(resolveTurnMaxSteps(""), 48);
    assert.equal(resolveTurnMaxSteps(null), 48);
  });

  it("floors fractional values", () => {
    assert.equal(resolveTurnMaxSteps("32.9"), 32);
  });
});
