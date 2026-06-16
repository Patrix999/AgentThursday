/**
 *  — envelope read-only projections extracted from
 * `src/server.ts`. Free-helper layer mirroring `statusViews` /
 * `inspectViews` / `recoveryViews`: the `@callable()` / private
 * surface stays on `AgentThursdayAgent`; bodies live here and reach DO
 * state through a narrow `EnvelopeStatusViewsHost`.
 *
 *  preflight §2.1–2.4 records the 8-dim analysis and the
 * Host shape: only `sql` + `ensureEnvelopeStoreSync` are required.
 * No mutable per-instance refs are passed through — these helpers
 * are pure reads over the in-memory envelope store ∪
 * `envelope_snapshots` table and the `event_log` table.
 *
 * Behavior preservation invariants ():
 *   1. newest-envelope selection ordering + tie-break
 *      (`started_at DESC` ISO-8601 lex order).
 *   2. sealed-pass binding to the current-turn envelope ( /
 *      199a — no historical sibling leak).
 *   3. Handled no-tool gate-intent fail predicate () —
 *      verdict_reason literal `"envelope missing required ring(s)"`
 *      must remain a literal at the read site
 *      (`src/skillset/evidenceEnvelope.ts:320`).
 *   4. Current task final reply lookup with `${slice(0,maxLen)}
 *      …(+N chars)` truncation; `null` when no
 *      `task.reply.finalized` event exists for `taskId`.
 */

import type {
  EnvelopeStore,
  EvidenceEnvelope,
} from "../skillset/evidenceEnvelope";

export type EnvelopeStatusViewsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface EnvelopeStatusViewsHost {
  sql: EnvelopeStatusViewsSqlTag;
  ensureEnvelopeStoreSync: () => EnvelopeStore;
}

/**
 *  — pick the newest envelope for `taskId`, unioning the
 * in-memory `EnvelopeStore` and durable `envelope_snapshots`. Used
 * by the status/review-gate derivations to bind on **current/latest
 * turn** envelope instead of "any historical sealed pass envelope
 * for this task". The latter (199's first attempt) was unsafe
 * because ChannelHub resubmit reuses `task_id`, so a previous-turn
 * pass envelope leaked into the current turn and masked a
 * freshly-failed envelope.
 *
 * Tie-break: `started_at DESC`. `started_at` is an ISO-8601 string
 * captured when the draft is created, so lexicographic order
 * matches chronological order.
 */
export function getNewestEnvelopeForTaskView(
  host: EnvelopeStatusViewsHost,
  taskId: string,
): EvidenceEnvelope | null {
  const candidates: EvidenceEnvelope[] = [];
  const seen = new Set<string>();
  try {
    const store = host.ensureEnvelopeStoreSync();
    for (const env of store.list()) {
      if (env.task_id !== taskId) continue;
      candidates.push(env);
      seen.add(env.envelope_id);
    }
  } catch { /* fail-soft */ }
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots
       WHERE task_id = ${taskId}
       ORDER BY started_at DESC LIMIT 10
    `;
    for (const r of rows) {
      try {
        const env = JSON.parse(r.payload) as EvidenceEnvelope;
        if (seen.has(env.envelope_id)) continue;
        candidates.push(env);
        seen.add(env.envelope_id);
      } catch { /* skip unparseable row */ }
    }
  } catch { /* fail-soft */ }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    a.timestamps.started_at < b.timestamps.started_at ? 1 : -1,
  );
  return candidates[0];
}

/**
 *  / 199a — true iff the **newest** envelope for the
 * current task is `sealed && verdict=pass`. Used by status and
 * review-gate derivation to short-circuit "task-active" /
 * "review-gate-blocked" / "no deliverable" once the verifiable
 * deliverable (sealed pass envelope) is on record.
 *
 * 199a fix: scope is `newest envelope`, not `any sealed pass
 * envelope`. Previously, ChannelHub resubmit reused `task_id` and
 * left old pass envelopes in the same task scope; the older
 * "any-pass" check let those stale envelopes mask a freshly-failed
 * current-turn envelope. Now: if the newest envelope is draft /
 * failed / verdict!=pass, we return false regardless of historical
 * sibling envelopes for the same task.
 */
export function hasSealedPassEnvelopeForCurrentTaskView(
  host: EnvelopeStatusViewsHost,
  taskId: string | null | undefined,
): boolean {
  if (!taskId) return false;
  const newest = getNewestEnvelopeForTaskView(host, taskId);
  if (!newest) return false;
  return newest.envelope_status === "sealed" && newest.self_verify?.verdict === "pass";
}

/**
 *  — true iff the newest envelope for `taskId` is a
 * *handled* no-tool gate-intent failure:  body replacement
 * fired and the envelope sealed `failed/fail` with
 * `verdict_reason = "envelope missing required ring(s)"`. This is a
 * terminal, expected outcome — `/cli/status` and review-gate should
 * NOT keep blocking on it ( readiness contract). Strictly
 * orthogonal to `hasSealedPassEnvelopeForCurrentTaskView`: callers
 * OR the two together so a handled fail opens the gate without
 * flipping the envelope into the "accepted as pass" path
 * (failed/fail evidence stays intact).
 *
 * verdict_reason coupling: must match the exact string at
 * `src/skillset/evidenceEnvelope.ts:320`. Don't extract a constant —
 * the literal documents the dependency at the read site.
 */
export function isHandledNoToolGateIntentFailView(
  host: EnvelopeStatusViewsHost,
  taskId: string | null | undefined,
): boolean {
  if (!taskId) return false;
  const newest = getNewestEnvelopeForTaskView(host, taskId);
  if (!newest) return false;
  if (newest.envelope_status !== "failed") return false;
  if (newest.self_verify?.verdict !== "fail") return false;
  if (newest.self_verify?.verdict_reason !== "envelope missing required ring(s)") return false;
  if ((newest.execution?.length ?? 0) !== 0) return false;
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const rows = host.sql<{ n: number | bigint }>`
      SELECT COUNT(*) as n FROM event_log
       WHERE event_type = 'tool.gate_intent.no_tool_reply.replaced'
         AND payload LIKE ${taskIdLike}
    `;
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 *  — return the current task's finalized reply text (the
 * authoritative `task.reply.finalized.replyText` for `taskId`),
 * truncated to `maxLen` with a `…(+N chars)` suffix the same way
 * `getLastAssistantText` does. Returns `null` when no finalized
 * event exists for `taskId` yet (mid-round, or task hasn't reached
 * finalize) — callers MUST omit any "[last msg]"-style line in that
 * case rather than falling back to a global last-assistant lookup,
 * which can leak previous-task text (the  verifier FAIL
 * symptom: a  server-side autodispatch round produced
 * little/no fresh assistant text in the SDK message log, so
 * `getLastAssistantText` resolved to the prior 208a-no-tool round).
 *
 * Reads from `event_log` (not the in-memory message store), so it
 * is correct after DO rehydrate and is not subject to the same
 * "last message" drift that motivated this fix.
 */
export function getCurrentTaskFinalReplyView(
  host: EnvelopeStatusViewsHost,
  taskId: string | null | undefined,
  maxLen = 200,
): string | null {
  if (!taskId) return null;
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM event_log
       WHERE event_type = 'task.reply.finalized'
         AND payload LIKE ${taskIdLike}
       ORDER BY created_at DESC
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    const p = JSON.parse(r.payload) as { replyText?: unknown };
    if (typeof p.replyText !== "string") return null;
    const trimmed = p.replyText.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length <= maxLen) return trimmed;
    return `${trimmed.slice(0, maxLen)} …(+${trimmed.length - maxLen} chars)`;
  } catch {
    return null;
  }
}
