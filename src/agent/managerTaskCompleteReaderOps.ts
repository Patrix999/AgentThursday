/**
 * pure reader/status helpers for `manager.task.completed`.
 *
 * Mirrors an earlier revision's merge reader pattern. No DO, no env, no SQL. The
 * `@callable readManagerTaskCompletedEvents` in `src/server.ts` reads
 * raw event_log rows; this module derives the bounded `completion`
 * side field consumed by GET /api/manager/tasks/:task_id.
 *
 * Fail-soft: malformed legacy payloads must not crash the endpoint.
 * `deriveCompletionSideField` reads each payload field defensively
 * (typeof guards) so a row with garbage `completion_verdict` still
 * yields a stable shape — `latest_verdict: null` — rather than
 * throwing.
 *
 * Empty-rows case returns a "completed: false" placeholder rather
 * than `null` so the consumer always sees a stable shape (same
 * precedent as an earlier revision `merge` side field).
 */
import type {
  CompletionVerdict,
  ManagerTaskCompletedPayload,
} from "./managerTaskCompleteOps";

export interface ManagerTaskCompletedRow {
  event_id: number;
  created_at: string;
  payload: ManagerTaskCompletedPayload | null;
}

/**
 * `latest_summary` is bounded by the emitter to ~2 KB UTF-8; we
 * surface it as-is so the GET /api/manager/tasks/:task_id consumer
 * doesn't need a second round-trip to the reader to see the
 * completion note.
 */
export interface CompletionStatusSideField {
  completed: boolean;
  completion_count: number;
  latest_verdict: CompletionVerdict | null;
  latest_completed_at: string | null;
  latest_summary: string | null;
}

function readVerdict(
  payload: ManagerTaskCompletedPayload | null,
): CompletionVerdict | null {
  if (payload === null) return null;
  const v = payload.completion_verdict;
  if (v === "success" || v === "partial" || v === "failed") return v;
  return null;
}

function readCompletedAt(
  payload: ManagerTaskCompletedPayload | null,
  fallback: string,
): string | null {
  if (
    payload !== null &&
    typeof payload.completed_at === "string" &&
    payload.completed_at.length > 0
  ) {
    return payload.completed_at;
  }
  // Fallback to row.created_at when payload.completed_at is missing
  // (legacy / garbled row) so the UI still has a timestamp.
  return fallback.length > 0 ? fallback : null;
}

function readSummary(
  payload: ManagerTaskCompletedPayload | null,
): string | null {
  if (payload === null) return null;
  return typeof payload.summary === "string" && payload.summary.length > 0
    ? payload.summary
    : null;
}

function pickLatestRow(
  rows: readonly ManagerTaskCompletedRow[],
): ManagerTaskCompletedRow | null {
  if (rows.length === 0) return null;
  // Rows arrive ASC (oldest first) from the SQL ORDER BY created_at
  // ASC. Latest = last element. Do NOT re-sort here so equal-
  // timestamp rows preserve insertion order (same invariant as
  // `deriveMergeSideField` — an earlier revision §5).
  return rows[rows.length - 1] ?? null;
}

export function deriveCompletionSideField(
  rows: readonly ManagerTaskCompletedRow[],
): CompletionStatusSideField {
  if (rows.length === 0) {
    return {
      completed: false,
      completion_count: 0,
      latest_verdict: null,
      latest_completed_at: null,
      latest_summary: null,
    };
  }
  const latest = pickLatestRow(rows);
  return {
    completed: true,
    completion_count: rows.length,
    latest_verdict: readVerdict(latest?.payload ?? null),
    latest_completed_at:
      latest !== null ? readCompletedAt(latest.payload, latest.created_at) : null,
    latest_summary: readSummary(latest?.payload ?? null),
  };
}

/**
 * JSON-parse one raw row into the reader shape. Exposed for tests
 * that simulate raw payload strings.
 */
export function parseManagerTaskCompletedRow(input: {
  event_id: number;
  payload: string;
  created_at: string;
}): ManagerTaskCompletedRow {
  let parsed: ManagerTaskCompletedPayload | null = null;
  try {
    const obj = JSON.parse(input.payload);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      parsed = obj as ManagerTaskCompletedPayload;
    }
  } catch {
    parsed = null;
  }
  return {
    event_id: input.event_id,
    created_at: input.created_at,
    payload: parsed,
  };
}
