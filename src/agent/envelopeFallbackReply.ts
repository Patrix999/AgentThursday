/**
 *  — ChannelHub fallback reply helper extracted from
 * `src/server.ts`. Free-helper layer with a narrow Host: only
 * `getChannelStub` (Promise<stub-like with `enqueueFallbackReplyForTask`>)
 * and `logEvent`. The DO namespace + instance name resolution stays at
 * the composition root; this module never imports `Env`,
 * `AgentNamespace`, or `ChannelHubAgent`.
 *
 *  preflight §2.5 records the 8-dim analysis. Two thin
 * delegate call sites in `server.ts` (lazy sweeper line 2982 and
 * alarm sweeper line 3090) — both already guarded by
 * `result.sealed && !result.idempotentNoop` so dedupe ownership
 * stays on the ChannelHub side (preflight §7 invariant 4).
 *
 * Behavior preservation invariants ():
 *   1. fallback reply enqueue success event payload shape
 *      (`evidence.envelope.fallback_reply.enqueued`).
 *   2. fallback reply enqueue error event payload shape
 *      (`evidence.envelope.fallback_reply.error`).
 *   3.未配置 channel / 无需 fallback 时的 no-op 行为 — owned by the
 *      ChannelHub-side `enqueueFallbackReplyForTask` result (`ok:false`
 *      with `reason`), surfaced verbatim in the enqueued event payload.
 *   4. idempotent / dedupe 边界仍由 ChannelHub 侧承担; helper does NOT
 *      self-invent dedupe.
 *   5. lazy sweeper / alarm sweeper 两个调用点 timing 不变 — both still
 *      under the `result.sealed && !result.idempotentNoop` guard in
 *      `sweepStaleDraftEnvelopes` / `envelopeSweeperBackstop`.
 */

/**
 * Structural shape of the ChannelHubAgent RPC surface this helper
 * consumes. Kept narrow to avoid importing the full
 * `ChannelHubAgent` type — the Host is owned by `server.ts` which
 * builds the stub via `getAgentByName`.
 */
export interface ChannelHubFallbackStubLike {
  enqueueFallbackReplyForTask(input: {
    taskId: string;
    envelopeId: string;
    verdictReason?: string;
  }): Promise<{
    ok: boolean;
    outboxId?: string;
    reason?: string;
  }>;
}

export interface EnvelopeFallbackReplyHost {
  getChannelStub: () => Promise<ChannelHubFallbackStubLike>;
  logEvent: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Enqueue a fallback reply via ChannelHub for `(taskId, envelopeId)`.
 * Fail-soft: any error in the RPC path is captured into the
 * `evidence.envelope.fallback_reply.error` event; the helper itself
 * does not re-throw. The success path emits
 * `evidence.envelope.fallback_reply.enqueued` with the ChannelHub
 * return values surfaced verbatim.
 */
export async function enqueueChannelHubFallbackReplyFree(
  host: EnvelopeFallbackReplyHost,
  taskId: string,
  envelopeId: string,
  verdictReason?: string,
): Promise<void> {
  try {
    const stub = await host.getChannelStub();
    const result = await stub.enqueueFallbackReplyForTask({ taskId, envelopeId, verdictReason });
    try {
      host.logEvent("evidence.envelope.fallback_reply.enqueued", {
        task_id: taskId,
        envelope_id: envelopeId,
        verdict_reason: verdictReason,
        ok: !!result?.ok,
        outbox_id: result?.outboxId,
        reason: result?.reason,
      });
    } catch { /* fail-soft */ }
  } catch (e) {
    try {
      host.logEvent("evidence.envelope.fallback_reply.error", {
        task_id: taskId,
        envelope_id: envelopeId,
        verdict_reason: verdictReason,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    } catch { /* fail-soft */ }
  }
}
