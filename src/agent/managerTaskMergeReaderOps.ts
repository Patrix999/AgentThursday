/**
 * pure reader/status helpers for `manager.task.merged`.
 *
 * No DO, no env, no SQL. The `@callable readManagerTaskMergedEvents`
 * in `src/server.ts` reads raw event_log rows; this module derives
 * the bounded shapes consumed by:
 *   - GET /api/manager/tasks/:task_id/merge        (full reader)
 *   - GET /api/manager/tasks/:task_id  .merge      (status side field)
 *
 * an earlier revision keyed `manager.task.merged` rows by `event_log.trace_id =
 * parent_task_id` and wrote a structured `ManagerTaskMergedPayload`
 * into `event_log.payload`. The reader uses `event_log.id` as the
 * stable `event_id` so future migration off of `summary_id == task_id`
 * (an earlier revision §4 v1→v2 bridge) has an addressable surface.
 *
 * Fail-soft: malformed legacy payloads must not crash the endpoint.
 * `parseManagerTaskMergedRow` JSON-parses opportunistically and
 * deriveMergeSideField / buildMergeReaderResponse read each field
 * defensively (typeof guards + array guards) so a row with garbage in
 * `subagent_task_refs` still yields a numeric `subagent_count: 0`
 * rather than throwing.
 */
import type { ManagerTaskMergedPayload } from "./managerTaskMergeOps";

export interface ManagerTaskMergedRow {
  /** event_log.id — stable primary key, addressable post v1→v2 migration. */
  event_id: number;
  /** ISO-8601 timestamp from event_log.created_at. */
  created_at: string;
  /** Best-effort parsed payload; null when JSON parse fails. */
  payload: ManagerTaskMergedPayload | null;
}

export interface MergeReaderEntry {
  event_id: number;
  created_at: string;
  payload: ManagerTaskMergedPayload | null;
}

export interface MergeReaderLatest {
  event_id: number;
  created_at: string;
  merge_verdict: ManagerTaskMergedPayload["merge_verdict"] | null;
  merged_at: string | null;
  subagent_count: number;
}

export interface MergeReaderResponse {
  ok: true;
  task_id: string;
  merged: boolean;
  merge_count: number;
  latest: MergeReaderLatest | null;
  merges: MergeReaderEntry[];
}

/**
 * an earlier revision §3 — bounded `merge` side field for the status endpoint.
 *
 * When `rows` is empty: returns `{merged: false, merge_count: 0,
 * latest_verdict: null, latest_merged_at: null, subagent_count: 0}`
 * (chosen over `null` so the consumer always sees a stable shape —
 * documented in `docs/tests/2026-05-26-card372-...`).
 */
export interface MergeStatusSideField {
  merged: boolean;
  merge_count: number;
  latest_verdict: ManagerTaskMergedPayload["merge_verdict"] | null;
  latest_merged_at: string | null;
  subagent_count: number;
}

function readVerdict(
  payload: ManagerTaskMergedPayload | null,
): ManagerTaskMergedPayload["merge_verdict"] | null {
  if (payload === null) return null;
  const v = payload.merge_verdict;
  if (v === "success" || v === "partial" || v === "failed") return v;
  return null;
}

function readMergedAt(
  payload: ManagerTaskMergedPayload | null,
  fallback: string,
): string | null {
  if (payload !== null && typeof payload.merged_at === "string" && payload.merged_at.length > 0) {
    return payload.merged_at;
  }
  // Fallback to row.created_at when payload.merged_at is missing or
  // malformed — preferred over `null` so a legacy/garbled row still
  // surfaces a timestamp the UI can render.
  return fallback.length > 0 ? fallback : null;
}

function readSubagentCount(payload: ManagerTaskMergedPayload | null): number {
  if (payload === null) return 0;
  const refs = payload.subagent_task_refs;
  return Array.isArray(refs) ? refs.length : 0;
}

function pickLatestRow(rows: readonly ManagerTaskMergedRow[]): ManagerTaskMergedRow | null {
  if (rows.length === 0) return null;
  // Rows arrive sorted ASC (oldest first) from the SQL ORDER BY
  // created_at ASC. Latest = last element. an earlier revision §5 requires
  // "stable ASC ordering and latest derived from the newest row" —
  // do NOT re-sort here; let the SQL ordering be the source of truth
  // so equal-timestamp rows preserve insertion order.
  return rows[rows.length - 1] ?? null;
}

export function deriveMergeSideField(
  rows: readonly ManagerTaskMergedRow[],
): MergeStatusSideField {
  if (rows.length === 0) {
    return {
      merged: false,
      merge_count: 0,
      latest_verdict: null,
      latest_merged_at: null,
      subagent_count: 0,
    };
  }
  const latest = pickLatestRow(rows);
  return {
    merged: true,
    merge_count: rows.length,
    latest_verdict: readVerdict(latest?.payload ?? null),
    latest_merged_at: latest !== null ? readMergedAt(latest.payload, latest.created_at) : null,
    subagent_count: readSubagentCount(latest?.payload ?? null),
  };
}

export function buildMergeReaderResponse(
  taskId: string,
  rows: readonly ManagerTaskMergedRow[],
): MergeReaderResponse {
  const latestRow = pickLatestRow(rows);
  const latest: MergeReaderLatest | null = latestRow !== null
    ? {
        event_id: latestRow.event_id,
        created_at: latestRow.created_at,
        merge_verdict: readVerdict(latestRow.payload),
        merged_at: readMergedAt(latestRow.payload, latestRow.created_at),
        subagent_count: readSubagentCount(latestRow.payload),
      }
    : null;
  return {
    ok: true,
    task_id: taskId,
    merged: rows.length > 0,
    merge_count: rows.length,
    latest,
    merges: rows.map((r) => ({
      event_id: r.event_id,
      created_at: r.created_at,
      payload: r.payload,
    })),
  };
}

/**
 * JSON-parse one raw row into the reader shape. Used by the
 * `@callable` SQL wrapper. Exposed for tests that simulate raw
 * payload strings.
 */
export function parseManagerTaskMergedRow(input: {
  event_id: number;
  payload: string;
  created_at: string;
}): ManagerTaskMergedRow {
  let parsed: ManagerTaskMergedPayload | null = null;
  try {
    const obj = JSON.parse(input.payload);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      parsed = obj as ManagerTaskMergedPayload;
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
