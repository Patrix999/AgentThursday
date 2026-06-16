/**
 *  — Discord gateway polling cursor advance decision.
 *
 * Pure helper extracted from `DiscordGatewayAgent.pollChannel` so the
 * "don't advance past a failed forward" rule can be unit-tested
 * without the DO / partyserver / cloudflare:workers import chain.
 *
 * Contract:
 *   - Iterate messages in the order given (caller sorts ascending by
 *     snowflake).
 *   - For each message, call `forwardFn(msg)` and inspect the outcome:
 *       - `{ok: true, outcome: "delivered"}`  → counts as delivered;
 *         the cursor may advance to (and past) this id.
 *       - `{ok: true, outcome: "filtered"}`   → message was intentionally
 *         skipped (bot-self / system message). Filtered messages don't
 *         block the cursor — otherwise the gateway loops on every
 *         self-echo. The cursor may advance past this id.
 *       - `{ok: false, ...}`                  → forward failed. Stop
 *         iterating. The cursor advances to the LAST successful
 *         (delivered or filtered) id, or stays put (`advanceTo: null`)
 *         if the very first message failed.
 *
 *   - `advanceTo` is `null` only when nothing succeeded before the
 *     failure. Caller must NOT call `persistCursor` in that case so
 *     the next sweep replays the same id.
 *
 * No retry queue, no per-message scheduling: the next polling tick
 * re-fetches `after=<lastPersisted>` and re-forwards. That satisfies
 *  §1 with the smallest possible delta.
 */

export type ForwardOutcome =
  | { ok: true; outcome: "delivered" | "filtered" }
  | { ok: false; reason: string; status?: number };

export interface CursorAdvanceDecision {
  /** Snowflake id the cursor should advance to, or `null` to leave the cursor unchanged. */
  advanceTo: string | null;
  /** First failed message id, or `null` if every message succeeded. */
  failedId: string | null;
  /** Human-readable failure reason (already preview-bounded by caller's `preview()` if needed). */
  failureReason: string | null;
  /** Optional HTTP status for failure (mirrors `ForwardOutcome.status`). */
  failureStatus: number | null;
  deliveredCount: number;
  filteredCount: number;
}

export async function decideCursorAdvance<T extends { id: string }>(
  messages: readonly T[],
  forwardFn: (msg: T) => Promise<ForwardOutcome>,
): Promise<CursorAdvanceDecision> {
  let advanceTo: string | null = null;
  let failedId: string | null = null;
  let failureReason: string | null = null;
  let failureStatus: number | null = null;
  let deliveredCount = 0;
  let filteredCount = 0;

  for (const m of messages) {
    let outcome: ForwardOutcome;
    try {
      outcome = await forwardFn(m);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcome = { ok: false, reason: `throw: ${message}` };
    }
    if (outcome.ok) {
      if (outcome.outcome === "delivered") deliveredCount += 1;
      else filteredCount += 1;
      advanceTo = m.id;
      continue;
    }
    failedId = m.id;
    failureReason = outcome.reason;
    failureStatus = outcome.status ?? null;
    break;
  }

  return {
    advanceTo,
    failedId,
    failureReason,
    failureStatus,
    deliveredCount,
    filteredCount,
  };
}
