/**
 * `decideCursorAdvance` regression tests.
 *
 * Pure helper, no DO / partyserver / cloudflare:workers chain — runs
 * directly under `node --import tsx --test`.
 *
 * Coverage of the cursor-safety contract from an earlier revision §1:
 *   - all delivered → cursor advances to last id
 *   - filtered messages don't block cursor (otherwise self-echo loops)
 *   - failure mid-stream → advance to last successful id only
 *   - failure on first message → cursor stays put (advanceTo: null)
 *   - thrown exception is treated as a failure with reason captured
 *   - failedId + reason are surfaced so operator inspect can pinpoint
 *     which message bounced
 *   - empty list → no-op
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  decideCursorAdvance,
  type ForwardOutcome,
} from "./discordGatewayCursor";

type FakeMessage = { id: string };

function delivered(): ForwardOutcome {
  return { ok: true, outcome: "delivered" };
}
function filtered(): ForwardOutcome {
  return { ok: true, outcome: "filtered" };
}
function failure(reason: string, status?: number): ForwardOutcome {
  return status !== undefined
    ? { ok: false, reason, status }
    : { ok: false, reason };
}

describe("an earlier revision decideCursorAdvance", () => {
  it("advances to last id when all messages deliver", async () => {
    const messages: FakeMessage[] = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const result = await decideCursorAdvance(messages, async () => delivered());
    assert.equal(result.advanceTo, "3");
    assert.equal(result.failedId, null);
    assert.equal(result.failureReason, null);
    assert.equal(result.deliveredCount, 3);
    assert.equal(result.filteredCount, 0);
  });

  it("filtered messages don't block cursor advance", async () => {
    // Self-echo / system message — `shouldForwardEvent` returned
    // `forward: false`. Cursor must move past these or the gateway
    // would loop on every bot reply.
    const messages: FakeMessage[] = [{ id: "10" }, { id: "11" }, { id: "12" }];
    const result = await decideCursorAdvance(messages, async (m) => {
      return m.id === "11" ? filtered() : delivered();
    });
    assert.equal(result.advanceTo, "12");
    assert.equal(result.failedId, null);
    assert.equal(result.deliveredCount, 2);
    assert.equal(result.filteredCount, 1);
  });

  it("stops at first failure and advances to last successful id", async () => {
    const messages: FakeMessage[] = [
      { id: "100" }, { id: "101" }, { id: "102" }, { id: "103" },
    ];
    const result = await decideCursorAdvance(messages, async (m) => {
      if (m.id === "102") return failure("http_502: upstream", 502);
      return delivered();
    });
    assert.equal(result.advanceTo, "101");
    assert.equal(result.failedId, "102");
    assert.equal(result.failureReason, "http_502: upstream");
    assert.equal(result.failureStatus, 502);
    assert.equal(result.deliveredCount, 2);
    assert.equal(result.filteredCount, 0);
  });

  it("first-message failure leaves cursor untouched (advanceTo:null)", async () => {
    // This is the critical card-spec case: forward 5xx on the FIRST
    // message of a sweep must not advance the cursor at all, so the
    // next sweep re-fetches `after=<old>` and retries.
    const messages: FakeMessage[] = [{ id: "200" }, { id: "201" }];
    const result = await decideCursorAdvance(messages, async () =>
      failure("http_502: upstream", 502),
    );
    assert.equal(result.advanceTo, null);
    assert.equal(result.failedId, "200");
    assert.equal(result.failureStatus, 502);
    assert.equal(result.deliveredCount, 0);
    assert.equal(result.filteredCount, 0);
  });

  it("failed-after-filtered keeps the filtered-id as advance target", async () => {
    // Mixed scenario: a self-echo (filtered) at id 300, then a
    // genuine forward failure at id 301. Cursor must still advance
    // to 300 so the gateway doesn't loop on the echo.
    const messages: FakeMessage[] = [{ id: "300" }, { id: "301" }];
    const result = await decideCursorAdvance(messages, async (m) => {
      if (m.id === "300") return filtered();
      return failure("http_502: upstream", 502);
    });
    assert.equal(result.advanceTo, "300");
    assert.equal(result.failedId, "301");
    assert.equal(result.failureStatus, 502);
    assert.equal(result.deliveredCount, 0);
    assert.equal(result.filteredCount, 1);
  });

  it("thrown forward becomes a failure with reason captured", async () => {
    const messages: FakeMessage[] = [{ id: "400" }, { id: "401" }];
    const result = await decideCursorAdvance(messages, async (m) => {
      if (m.id === "401") throw new Error("network down");
      return delivered();
    });
    assert.equal(result.advanceTo, "400");
    assert.equal(result.failedId, "401");
    assert.match(result.failureReason ?? "", /throw: network down/);
    assert.equal(result.failureStatus, null);
    assert.equal(result.deliveredCount, 1);
  });

  it("empty messages → no-op", async () => {
    const result = await decideCursorAdvance<FakeMessage>([], async () => delivered());
    assert.equal(result.advanceTo, null);
    assert.equal(result.failedId, null);
    assert.equal(result.deliveredCount, 0);
    assert.equal(result.filteredCount, 0);
  });

  it("preserves order: only forwards up to first failure", async () => {
    // The 4th message would error; assert we never reach it.
    const seen: string[] = [];
    const messages: FakeMessage[] = [
      { id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" },
    ];
    const result = await decideCursorAdvance(messages, async (m) => {
      seen.push(m.id);
      if (m.id === "3") return failure("http_502", 502);
      return delivered();
    });
    assert.deepEqual(seen, ["1", "2", "3"]);
    assert.equal(result.advanceTo, "2");
    assert.equal(result.failedId, "3");
  });
});
