/**
 * pure state derivation for the manager merge UI panel.
 *
 * The frontend has no test runner; mirroring an earlier revision's pattern, all
 * non-trivial logic lives in `src/agent/` as a pure helper so it can
 * be covered by node:test, and the React component (`MergePanel.tsx`)
 * only renders the discriminated state.
 *
 * Inputs:
 *   - `taskId`           — what the panel is targeting
 *   - `loading`          — true while a fetch is in flight
 *   - `fetchError`       — non-null on transport / HTTP error
 *   - `reader`           — null when no fetch has run / 404; the
 *                          MergeReaderResponse otherwise
 *
 * Output: a discriminated union the component switches on.
 *   - `idle`       — no task_id selected (paste box empty); subtle
 *                    prompt
 *   - `loading`    — show compact skeleton; never blank
 *   - `error`      — transport / HTTP error; show fallback copy
 *   - `not_found`  — reader returned null (unknown task or 404)
 *   - `no_merge`   — reader returned merged:false; subtle no-merge
 *                    state
 *   - `merged`     — bounded merged view + refs[]
 *
 * Defensive on the reader payload: an earlier revision §5.1 documents a silent
 * `latest_merged_at` fallback when payloads are malformed. The panel
 * keeps that contract — a row with a null payload still counts toward
 * `merge_count`, refs[] is the latest row's refs (best-effort, capped
 * at MAX_REFS to bound DOM size), and missing/garbled fields surface
 * as `null` rather than crashing.
 */
import type { MergeReaderResponse } from "./managerTaskMergeReaderOps";
import type {
  ManagerTaskMergedRef,
  MergeVerdict,
} from "./managerTaskMergeOps";

/** Cap visible refs so a pathological 200-ref merge can't blow up the DOM. */
export const MAX_REFS = 20;

export interface MergePanelInput {
  taskId: string | null;
  loading: boolean;
  fetchError: string | null;
  reader: MergeReaderResponse | null;
}

export interface MergePanelMergedState {
  kind: "merged";
  taskId: string;
  latestVerdict: MergeVerdict | null;
  latestMergedAt: string | null;
  subagentCount: number;
  mergeCount: number;
  refs: ManagerTaskMergedRef[];
  /** true when the latest row's payload was null (malformed/legacy). */
  malformedLatest: boolean;
  /** true when refs were truncated by MAX_REFS. */
  truncated: boolean;
}

export type MergePanelState =
  | { kind: "idle" }
  | { kind: "loading"; taskId: string }
  | { kind: "error"; taskId: string; message: string }
  | { kind: "not_found"; taskId: string }
  | { kind: "no_merge"; taskId: string }
  | MergePanelMergedState;

function readRefs(reader: MergeReaderResponse): ManagerTaskMergedRef[] {
  // Latest = last entry in merges[] (server returns ASC by created_at).
  const lastEntry = reader.merges.length > 0
    ? reader.merges[reader.merges.length - 1]
    : null;
  if (lastEntry === null || lastEntry === undefined) return [];
  const payload = lastEntry.payload;
  if (payload === null) return [];
  const refs = payload.subagent_task_refs;
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, MAX_REFS);
}

function latestPayloadIsMalformed(reader: MergeReaderResponse): boolean {
  if (reader.merges.length === 0) return false;
  const last = reader.merges[reader.merges.length - 1];
  return last !== null && last !== undefined && last.payload === null;
}

export function deriveMergePanelState(input: MergePanelInput): MergePanelState {
  const { taskId, loading, fetchError, reader } = input;
  if (taskId === null || taskId.length === 0) return { kind: "idle" };
  if (loading) return { kind: "loading", taskId };
  if (fetchError !== null) {
    return { kind: "error", taskId, message: fetchError };
  }
  if (reader === null) return { kind: "not_found", taskId };
  if (!reader.merged || reader.merge_count === 0) {
    return { kind: "no_merge", taskId };
  }
  const latest = reader.latest;
  const refs = readRefs(reader);
  const totalRefsInLatest = (() => {
    const last = reader.merges[reader.merges.length - 1];
    if (last === null || last === undefined || last.payload === null) return 0;
    const arr = last.payload.subagent_task_refs;
    return Array.isArray(arr) ? arr.length : 0;
  })();
  return {
    kind: "merged",
    taskId,
    latestVerdict: latest?.merge_verdict ?? null,
    latestMergedAt: latest?.merged_at ?? null,
    subagentCount: latest?.subagent_count ?? 0,
    mergeCount: reader.merge_count,
    refs,
    malformedLatest: latestPayloadIsMalformed(reader),
    truncated: totalRefsInLatest > MAX_REFS,
  };
}
