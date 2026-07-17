import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sweepStaleDraftEnvelopesFree,
  envelopeSweeperBackstopFree,
  type EnvelopeSweeperHost,
} from "./envelopeSweeperOps";

// Minimal host. `sql` is a tagged-template that routes by query text so the
// already-tested pure helpers (which read event_log) see controlled rows.
function makeHost(over: Partial<EnvelopeSweeperHost> & { rowsForSnapshotScan?: unknown[]; store?: Map<string, unknown> }): EnvelopeSweeperHost {
  const store = over.store ?? new Map<string, unknown>();
  const calls = (makeHost as unknown as { calls: Record<string, number> }).calls;
  const sql = ((strings: TemplateStringsArray) => {
    const q = strings.join(" ");
    if (q.includes("FROM envelope_snapshots") && q.includes("envelope_status = 'draft'")) {
      return over.rowsForSnapshotScan ?? [];
    }
    return [];
  }) as unknown as EnvelopeSweeperHost["sql"];
  return {
    sql,
    ensureEnvelopeStore: () => ({ get: (id: string) => store.get(id), adopt: () => {} }) as never,
    finalizeTaskTurn: over.finalizeTaskTurn ?? (() => ({ sealed: false, envelopeStatus: null, idempotentNoop: false })),
    finalizeTaskLifecycleIfNeeded: over.finalizeTaskLifecycleIfNeeded ?? (() => { calls.lifecycle++; }),
    enqueueChannelHubFallbackReply: over.enqueueChannelHubFallbackReply ?? (async () => { calls.enqueue++; }),
    logEvent: over.logEvent ?? (() => {}),
    schedule: over.schedule ?? (async () => { calls.schedule++; return undefined; }),
  };
}
(makeHost as unknown as { calls: Record<string, number> }).calls = { lifecycle: 0, enqueue: 0, schedule: 0 };

test("sweep with no stale drafts → empty summary, scanned 0", async () => {
  const r = await sweepStaleDraftEnvelopesFree(makeHost({ rowsForSnapshotScan: [] }));
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.finalized, []);
  assert.equal(r.source, "manual");
});

test("sweep is fail-soft when the snapshot query throws", async () => {
  const host = makeHost({});
  (host as { sql: unknown }).sql = (() => { throw new Error("db down"); }) as never;
  const r = await sweepStaleDraftEnvelopesFree(host, { source: "alarm" });
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.finalized, []);
  assert.equal(r.source, "alarm"); // input source threaded even on fail-soft
});

test("sweep finalizes an old draft and enqueues a fallback when sealed", async () => {
  let finalizeOpts: { taskId: string; source: string } | null = null;
  let enqueued = 0;
  let lifecycled = 0;
  const host = makeHost({
    rowsForSnapshotScan: [{ envelope_id: "e1", task_id: "t1", payload: "{}", started_at: "2020-01-01T00:00:00.000Z" }],
    store: new Map<string, unknown>([["e1", { execution: [], evidence: [] }]]),
    finalizeTaskTurn: (opts) => { finalizeOpts = opts; return { sealed: true, envelopeStatus: "failed", verdict: "fail", verdictReason: "missing_rings", idempotentNoop: false }; },
    finalizeTaskLifecycleIfNeeded: () => { lifecycled++; },
    enqueueChannelHubFallbackReply: async () => { enqueued++; },
  });
  const r = await sweepStaleDraftEnvelopesFree(host, { source: "manual" });
  assert.equal(r.finalized.length, 1);
  assert.equal(r.finalized[0].envelope_id, "e1");
  assert.equal(r.finalized[0].status, "failed");
  assert.equal(lifecycled, 1);
  assert.equal(enqueued, 1, "sealed (non-idempotent) seal enqueues the fallback");
  assert.equal((finalizeOpts as unknown as { source: string }).source, "sweeper.manual");
});

test("sweep does NOT enqueue on an idempotent-noop finalize", async () => {
  let enqueued = 0;
  const host = makeHost({
    rowsForSnapshotScan: [{ envelope_id: "e2", task_id: "t2", payload: "{}", started_at: "2020-01-01T00:00:00.000Z" }],
    store: new Map<string, unknown>([["e2", { execution: [], evidence: [] }]]),
    finalizeTaskTurn: () => ({ sealed: false, envelopeStatus: "sealed", idempotentNoop: true }),
    enqueueChannelHubFallbackReply: async () => { enqueued++; },
  });
  const r = await sweepStaleDraftEnvelopesFree(host);
  assert.equal(r.finalized.length, 1);
  assert.equal(enqueued, 0, "idempotent noop must not double-enqueue");
});

test("backstop is a no-op on a missing / malformed payload", async () => {
  let touched = 0;
  const host = makeHost({ finalizeTaskTurn: () => { touched++; return { sealed: false, envelopeStatus: null, idempotentNoop: false }; } });
  await envelopeSweeperBackstopFree(host, undefined, null);
  await envelopeSweeperBackstopFree(host, { envelopeId: "e", taskId: 123 as unknown as string }, null);
  assert.equal(touched, 0, "never reaches finalize without a valid {envelopeId,taskId}");
});
