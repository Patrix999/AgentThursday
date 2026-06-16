import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { ChannelRoutePendingResultSchema } from "../schema/channel";

/**
 *  — directed test of the extended `ChannelRoutePendingResultSchema`
 * shape. The wire contract gains:
 *   - `action: "invalid-binding"` for rows whose binding points to a
 *     missing / archived / un-validatable profile;
 *   - optional `targetKind` and `targetName` per decision so verifier
 *     can prove which DO the row was routed to.
 *
 * Backward compatibility: pre- batches did not populate
 * `targetKind` / `targetName`. The schema makes those optional so old
 * payloads still parse.
 */

const baseDecision = {
  inboxId: "ib_1",
  providerMessageId: "pm_1",
  reason: "ok",
  finalStatus: "handled" as const,
  handoffTaskId: "task_1",
};

describe("ChannelRoutePendingResultSchema ()", () => {
  it("accepts old-shape decisions without targetKind/targetName", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "process",
      }],
    });
    assert.equal(r.success, true);
  });

  it("accepts new-shape decisions with targetKind=profile_binding (legacy)", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "process",
        targetKind: "profile_binding",
        targetName: "agent-abc",
      }],
    });
    assert.equal(r.success, true);
  });

  it("accepts new-shape decisions with targetKind=agent_binding ()", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "process",
        targetKind: "agent_binding",
        targetName: "agent-abc",
      }],
    });
    assert.equal(r.success, true);
  });

  it("accepts targetKind=active_context_fallback", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "process",
        targetKind: "active_context_fallback",
        targetName: "agentthursday-dev-fresh-108a-1",
      }],
    });
    assert.equal(r.success, true);
  });

  it("accepts action=invalid-binding with  structured reason and null targetName", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "invalid-binding",
        //  — `invalid_binding:agent:<agentId>:<cause>`
        reason: "invalid_binding:agent:agent-gone:missing",
        finalStatus: "deferred",
        handoffTaskId: null,
        targetKind: "invalid_binding",
        targetName: null,
      }],
    });
    assert.equal(r.success, true);
  });

  it("rejects unknown targetKind values", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "process",
        targetKind: "made-up-kind",
        targetName: "x",
      }],
    });
    assert.equal(r.success, false);
  });

  it("rejects unknown action values", () => {
    const r = ChannelRoutePendingResultSchema.safeParse({
      ok: true,
      scanned: 1,
      busySkipped: 0,
      decisions: [{
        ...baseDecision,
        action: "made-up-action",
      }],
    });
    assert.equal(r.success, false);
  });
});
