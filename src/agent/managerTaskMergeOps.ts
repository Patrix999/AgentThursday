/**
 * `manager.task.merged` emitter v1.
 *
 * Pure orchestrator helper for the new audit-grade merge event. Mirrors
 * the an earlier revision read-side pattern (`managerSubagentSummaries`): the
 * adapter and the HTTP-route layer both call into this module so
 * validation, permission, and emission stay in lockstep.
 *
 * Contract anchor — `docs/adr/2026-05-26-agent-handoff-merge-contract.md`
 * §4.2 (`ManagerTaskMergedPayload`), §4.4 (audit trail), §4.5 (state
 * model: presence-of-event is the discriminator).
 *
 * Key design choices for v1 (documented for an earlier revision reader follow-up):
 *
 *   1. `summary_id` wire field — kept per ADR §4.2 — semantically
 *      equals the subagent's `task_id` in v1. ADR §10 Q3 already
 *      accepts row-id instability; an earlier revision emits exactly one
 *      `manager.subagent.summary` per subagent terminal success, so
 *      `task_id` is a stable per-summary identifier today. The wire
 *      field is preserved so 372 (reader) can promote `summary_id` to
 *      `event_log.id` later without breaking emit-side callers.
 *
 *   2. Permission boundary — sourced from an earlier revision §4: each supplied
 *      ref must map to a `manager.subagent.summary` row whose
 *      `source_agent_id === callingAgentId`. Cross-manager merges are
 *      rejected as `permission_denied` (NOT silently dropped; the
 *      manager LLM needs the signal so it doesn't believe its merge
 *      landed).
 *
 *   3. Zero-ref merges — permitted per ADR §4.2 notes for audit
 *      purposes only. v1 keeps the discriminator clean ("presence of
 *      event = audit-grade merge").
 *      an earlier revision hardening: a zero-ref merge with `merge_verdict=
 *      "success"` is REJECTED at validation. Empty refs + success
 *      papers over a broken summary-aggregation chain — the operator
 *      sees "merged success" but no subagent summaries were aggregated.
 *      Zero-ref `partial` / `failed` is still allowed (audit-only).
 *
 *   4. `manager_agent_id` — derived from `callingAgentId`, NOT taken
 *      from caller input. Prevents a manager from forging a peer's
 *      identity on the merge event.
 *
 *   5. `merged_at` — caller-supplied is allowed (verifier-friendly),
 *      but the helper auto-fills via `now()` when omitted. Auto-fill
 *      is the production path; explicit `merged_at` is for tests.
 *
 *   6. No ALS reads here — the orchestrator stays a pure function over
 *      the registry stub + caller-supplied input. ALS auto-fill of
 *      `parent_task_id` belongs at the adapter layer if 372/UI needs
 *      it; v1 requires the manager LLM to pass `parent_task_id`
 *      explicitly (it already has its own outer task id available).
 */

import {
  filterSubagentSummariesForReader,
  type SubagentSummary,
  type SubagentSummaryRow,
} from "./subagentSummaryOps";

export const MANAGER_TASK_MERGED_EVENT_NAME = "manager.task.merged";

export type SubagentRefVerdict =
  | "success"
  | "partial"
  | "failed"
  | "ignored";

export type MergeVerdict = "success" | "partial" | "failed";

export interface ManagerTaskMergeRefInput {
  task_id: string;
  agent_id: string;
  summary_id: string;
  verdict: SubagentRefVerdict;
  superseded_by?: string | null;
  reason?: string;
}

export interface ManagerTaskMergeInput {
  parent_task_id: string;
  subagent_task_refs: ManagerTaskMergeRefInput[];
  merge_verdict: MergeVerdict;
  note?: string;
  merged_at?: string;
}

export interface ManagerTaskMergedRef {
  task_id: string;
  agent_id: string;
  summary_id: string;
  verdict: SubagentRefVerdict;
  superseded_by: string | null;
  reason?: string;
}

export interface ManagerTaskMergedPayload {
  parent_task_id: string;
  manager_agent_id: string;
  subagent_task_refs: ManagerTaskMergedRef[];
  merge_verdict: MergeVerdict;
  merged_at: string;
  note?: string;
}

export interface ManagerTaskMergeOk {
  ok: true;
  task_id: string;
  parent_task_id: string;
  merge_verdict: MergeVerdict;
  subagent_count: number;
  merged_at: string;
  payload: ManagerTaskMergedPayload;
}

export interface ManagerTaskMergeErr {
  ok: false;
  error: {
    code:
      | "validation_failed"
      | "permission_denied"
      | "summary_not_found"
      | "ref_mismatch";
    message: string;
  };
}

export type ManagerTaskMergeResult = ManagerTaskMergeOk | ManagerTaskMergeErr;

export interface ManagerTaskMergeRegistrySurface {
  readSubagentSummaries(opts: {
    parent_task_id?: string;
  }): Promise<SubagentSummaryRow[]>;
  recordManagerTaskMerged(
    parentTaskId: string,
    payload: ManagerTaskMergedPayload,
  ): Promise<void> | void;
}

const VALID_REF_VERDICTS: ReadonlySet<SubagentRefVerdict> = new Set([
  "success",
  "partial",
  "failed",
  "ignored",
]);
const VALID_MERGE_VERDICTS: ReadonlySet<MergeVerdict> = new Set([
  "success",
  "partial",
  "failed",
]);

function errValidation(message: string): ManagerTaskMergeErr {
  return { ok: false, error: { code: "validation_failed", message } };
}

function errPermission(message: string): ManagerTaskMergeErr {
  return { ok: false, error: { code: "permission_denied", message } };
}

function errSummaryNotFound(message: string): ManagerTaskMergeErr {
  return { ok: false, error: { code: "summary_not_found", message } };
}

function errRefMismatch(message: string): ManagerTaskMergeErr {
  return { ok: false, error: { code: "ref_mismatch", message } };
}

/**
 * v1 invariant: `summary_id` is the subagent's `task_id`.
 * Match a single ref against the visible-to-caller summary set.
 */
function locateSummaryByRef(
  visible: readonly SubagentSummary[],
  ref: ManagerTaskMergeRefInput,
): SubagentSummary | null {
  for (const s of visible) {
    if (s.task_id === ref.summary_id) return s;
  }
  return null;
}

export async function emitManagerTaskMerged(
  registry: ManagerTaskMergeRegistrySurface,
  input: ManagerTaskMergeInput,
  callingAgentId: string,
  now: () => Date = () => new Date(),
): Promise<ManagerTaskMergeResult> {
  if (typeof callingAgentId !== "string" || callingAgentId.length === 0) {
    return errValidation(
      "calling agent_id is required for permission boundary",
    );
  }
  if (
    typeof input.parent_task_id !== "string" ||
    input.parent_task_id.length === 0
  ) {
    return errValidation("parent_task_id must be a non-empty string");
  }
  if (!Array.isArray(input.subagent_task_refs)) {
    return errValidation("subagent_task_refs must be an array");
  }
  if (!VALID_MERGE_VERDICTS.has(input.merge_verdict)) {
    return errValidation(
      `merge_verdict must be one of: ${[...VALID_MERGE_VERDICTS].join(", ")}`,
    );
  }
  // zero-ref + success is REJECTED. Empty refs paired with
  // a success verdict silently papers over a broken summary-
  // aggregation chain (an earlier revision push key missing → no rows → merge
  // can still claim success). Audit-only zero-ref merges remain legal
  // under `partial` or `failed`.
  if (
    input.subagent_task_refs.length === 0 &&
    input.merge_verdict === "success"
  ) {
    return errValidation(
      "zero-ref merge cannot be success: subagent_task_refs is empty; use merge_verdict=partial or merge_verdict=failed for audit-only zero-ref merges",
    );
  }
  for (const [i, ref] of input.subagent_task_refs.entries()) {
    if (!ref || typeof ref !== "object") {
      return errValidation(`subagent_task_refs[${i}] must be an object`);
    }
    if (typeof ref.task_id !== "string" || ref.task_id.length === 0) {
      return errValidation(
        `subagent_task_refs[${i}].task_id must be a non-empty string`,
      );
    }
    if (typeof ref.agent_id !== "string" || ref.agent_id.length === 0) {
      return errValidation(
        `subagent_task_refs[${i}].agent_id must be a non-empty string`,
      );
    }
    if (typeof ref.summary_id !== "string" || ref.summary_id.length === 0) {
      return errValidation(
        `subagent_task_refs[${i}].summary_id must be a non-empty string`,
      );
    }
    if (!VALID_REF_VERDICTS.has(ref.verdict)) {
      return errValidation(
        `subagent_task_refs[${i}].verdict must be one of: ${[
          ...VALID_REF_VERDICTS,
        ].join(", ")}`,
      );
    }
    if (
      ref.superseded_by !== undefined &&
      ref.superseded_by !== null &&
      (typeof ref.superseded_by !== "string" ||
        ref.superseded_by.length === 0)
    ) {
      return errValidation(
        `subagent_task_refs[${i}].superseded_by must be null or a non-empty string`,
      );
    }
    if (
      ref.reason !== undefined &&
      (typeof ref.reason !== "string" || ref.reason.length === 0)
    ) {
      return errValidation(
        `subagent_task_refs[${i}].reason must be a non-empty string when present`,
      );
    }
  }
  if (
    input.note !== undefined &&
    (typeof input.note !== "string" || input.note.length === 0)
  ) {
    return errValidation("note must be a non-empty string when provided");
  }
  if (
    input.merged_at !== undefined &&
    (typeof input.merged_at !== "string" || input.merged_at.length === 0)
  ) {
    return errValidation(
      "merged_at must be a non-empty ISO string when provided",
    );
  }

  // Permission + ref-matching gate. Zero-ref merges skip the registry
  // read entirely (no rows to verify) per ADR §4.2 zero-ref legality.
  const resolvedRefs: ManagerTaskMergedRef[] = [];
  if (input.subagent_task_refs.length > 0) {
    const rawRows = await registry.readSubagentSummaries({
      parent_task_id: input.parent_task_id,
    });
    const visible = filterSubagentSummariesForReader(rawRows, callingAgentId, {
      parent_task_id: input.parent_task_id,
      limit: 200,
    });
    for (const ref of input.subagent_task_refs) {
      // Reject refs whose summary is invisible to the calling manager
      // BEFORE the not-found check so cross-manager probes can't infer
      // existence from error-shape differences. We still leak the
      // verdict at "permission_denied vs summary_not_found" boundary —
      // an attacker probing for summary_ids of a peer manager learns
      // "this id exists but isn't yours" vs "this id doesn't exist for
      // your parent_task_id". v1 accepts this — the alternative is to
      // collapse both to a single opaque code, which makes operator
      // debugging worse. an earlier revision reader already exposes the same
      // identity shape (rejecting on source_agent_id mismatch returns
      // empty list, not error), so cross-manager existence is already
      // not directly inferrable through the read path.
      const inRaw = rawRows.find(
        (r) => r.parent_task_id === input.parent_task_id &&
               r.payload.task_id === ref.summary_id,
      );
      if (inRaw === undefined) {
        return errSummaryNotFound(
          `no manager.subagent.summary row found for ref.summary_id=${ref.summary_id} under parent_task_id=${input.parent_task_id}`,
        );
      }
      const summary = locateSummaryByRef(visible, ref);
      if (summary === null) {
        return errPermission(
          `summary_id=${ref.summary_id} is not visible to calling manager ${callingAgentId} (source_agent_id boundary)`,
        );
      }
      if (summary.task_id !== ref.task_id) {
        return errRefMismatch(
          `ref.task_id=${ref.task_id} does not match summary.task_id=${summary.task_id}`,
        );
      }
      if (summary.agent_id !== ref.agent_id) {
        return errRefMismatch(
          `ref.agent_id=${ref.agent_id} does not match summary.agent_id=${summary.agent_id}`,
        );
      }
      resolvedRefs.push({
        task_id: ref.task_id,
        agent_id: ref.agent_id,
        summary_id: ref.summary_id,
        verdict: ref.verdict,
        superseded_by: ref.superseded_by ?? null,
        ...(ref.reason !== undefined ? { reason: ref.reason } : {}),
      });
    }
  }

  const mergedAt =
    typeof input.merged_at === "string" && input.merged_at.length > 0
      ? input.merged_at
      : now().toISOString();
  const payload: ManagerTaskMergedPayload = {
    parent_task_id: input.parent_task_id,
    manager_agent_id: callingAgentId,
    subagent_task_refs: resolvedRefs,
    merge_verdict: input.merge_verdict,
    merged_at: mergedAt,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };

  await registry.recordManagerTaskMerged(input.parent_task_id, payload);

  return {
    ok: true,
    task_id: input.parent_task_id,
    parent_task_id: input.parent_task_id,
    merge_verdict: input.merge_verdict,
    subagent_count: resolvedRefs.length,
    merged_at: mergedAt,
    payload,
  };
}
