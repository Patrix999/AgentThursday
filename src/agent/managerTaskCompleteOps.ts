/**
 * `manager.task.completed` emitter v1.
 *
 * Structured completion-record emitter the manager calls AFTER its
 * normal `replied` terminal (and optionally a an earlier revision `task_merge`
 * audit-grade merge). The completion event is report/archive
 * evidence ONLY — it does NOT change the an earlier revision lifecycle terminal
 * (`replied` / `failed` are still the only terminal classes; see
 * `deriveManagerTaskStatus` `completed` case = no-op).
 *
 *
 *   1. `parent_task_id` (required) keys `event_log.trace_id` so the
 *      completion event sits in the same task-keyed stream as
 *      received/started/replied/failed/merged.
 *   2. `manager_agent_id` is DERIVED from `callingAgentId`, never from
 *      input. Prevents a manager from forging a peer's identity on
 *      the completion record.
 *   3. `completion_verdict ∈ {success, partial, failed}`.
 *   4. `summary` (required) is the human-readable completion note. To
 *      prevent leaking full transcripts / secrets through completion
 *      payloads, summary is capped at `SUMMARY_BYTE_MAX` UTF-8 bytes
 *      (TextEncoder byte length — multi-byte Chinese / emoji is
 *      counted correctly per an earlier revision hardening).
 *   5. `success` completion default-REQUIRES a prior
 *      `manager.task.merged` row for the same parent_task_id. The
 *      merge precondition is checked via the registry surface
 *      (`readManagerTaskMergedEvents`). Override path:
 *      `allow_without_merge=true` PLUS a non-empty
 *      `allow_without_merge_reason`. `partial` / `failed` complete
 *      verdicts skip the precondition entirely.
 *   6. Multiple completes are allowed (re-reports, corrections). The
 *      reader (`managerTaskCompleteReaderOps.ts`) returns the latest
 *      verdict + `completion_count`.
 *   7. `evidence`, `next_step`, `card_ref` are optional. We validate
 *      shape (numeric / string / array of string) when present; we do
 *      NOT cross-check against actual events (e.g., we accept a
 *      `merge_event_id` even if no row exists at that id — a future
 *      card can promote this to a precondition probe).
 *
 * Pure helper — no DO, no env. The orchestrator in `managerOps.ts`
 * resolves the registry stub and adapts it to
 * `ManagerTaskCompleteRegistrySurface`.
 */

export const MANAGER_TASK_COMPLETED_EVENT_NAME = "manager.task.completed";

export type CompletionVerdict = "success" | "partial" | "failed";

const VALID_COMPLETION_VERDICTS: ReadonlySet<CompletionVerdict> = new Set([
  "success",
  "partial",
  "failed",
]);

/**
 * UTF-8 byte cap for `summary`. ~2 KB is enough for a paragraph-scale
 * completion note in any language but small enough that callers cannot
 * paste an entire subagent transcript / secret-bearing prompt through
 * the field. Counted via `TextEncoder().encode().byteLength` so
 * multi-byte characters are charged correctly (an earlier revision lesson —
 * `string.length` undercounts CJK / emoji).
 */
export const SUMMARY_BYTE_MAX = 2000;
export const SUMMARY_BYTE_MIN = 1;

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
  return TEXT_ENCODER.encode(s).byteLength;
}

export interface ManagerTaskCompleteEvidenceInput {
  merge_event_id?: number;
  subagent_task_ids?: string[];
  envelope_id?: string;
}

export interface ManagerTaskCompleteCardRefInput {
  card_id: string;
  path?: string;
}

export interface ManagerTaskCompleteInput {
  parent_task_id: string;
  completion_verdict: CompletionVerdict;
  summary: string;
  evidence?: ManagerTaskCompleteEvidenceInput;
  next_step?: string;
  card_ref?: ManagerTaskCompleteCardRefInput;
  allow_without_merge?: boolean;
  allow_without_merge_reason?: string;
  completed_at?: string;
}

export interface ManagerTaskCompletedPayload {
  parent_task_id: string;
  manager_agent_id: string;
  completion_verdict: CompletionVerdict;
  summary: string;
  completed_at: string;
  evidence?: ManagerTaskCompleteEvidenceInput;
  next_step?: string;
  card_ref?: ManagerTaskCompleteCardRefInput;
  allow_without_merge?: boolean;
  allow_without_merge_reason?: string;
}

export interface ManagerTaskCompleteOk {
  ok: true;
  task_id: string;
  parent_task_id: string;
  completion_verdict: CompletionVerdict;
  completed_at: string;
  payload: ManagerTaskCompletedPayload;
}

export interface ManagerTaskCompleteErr {
  ok: false;
  error: {
    /**
     * an earlier revision spec §"语义规则": no-merge + success rejection is
     * surfaced as `validation_failed` (same code as shape errors).
     * Operators discriminate the two cases by the error message,
     * which always names `allow_without_merge` when the rejection
     * is precondition-driven.
     */
    code: "validation_failed";
    message: string;
  };
}

export type ManagerTaskCompleteResult =
  | ManagerTaskCompleteOk
  | ManagerTaskCompleteErr;

export interface ManagerTaskCompleteRegistrySurface {
  /**
   * an earlier revision reader — used here purely as a precondition probe. Empty
   * array means "no merge event for this parent" → success completes
   * are rejected unless `allow_without_merge` is set.
   */
  readManagerTaskMergedEvents(parentTaskId: string): Promise<
    Array<{ event_id: number; created_at: string; payload: unknown }>
  >;
  recordManagerTaskCompleted(
    parentTaskId: string,
    payload: ManagerTaskCompletedPayload,
  ): Promise<void> | void;
}

function errValidation(message: string): ManagerTaskCompleteErr {
  return { ok: false, error: { code: "validation_failed", message } };
}


function validateEvidence(
  ev: ManagerTaskCompleteEvidenceInput,
): ManagerTaskCompleteErr | null {
  if (
    ev.merge_event_id !== undefined &&
    (typeof ev.merge_event_id !== "number" ||
      !Number.isFinite(ev.merge_event_id) ||
      !Number.isInteger(ev.merge_event_id) ||
      ev.merge_event_id < 0)
  ) {
    return errValidation(
      "evidence.merge_event_id must be a non-negative integer when provided",
    );
  }
  if (ev.subagent_task_ids !== undefined) {
    if (!Array.isArray(ev.subagent_task_ids)) {
      return errValidation(
        "evidence.subagent_task_ids must be an array of strings when provided",
      );
    }
    for (const [i, id] of ev.subagent_task_ids.entries()) {
      if (typeof id !== "string" || id.length === 0) {
        return errValidation(
          `evidence.subagent_task_ids[${i}] must be a non-empty string`,
        );
      }
    }
  }
  if (
    ev.envelope_id !== undefined &&
    (typeof ev.envelope_id !== "string" || ev.envelope_id.length === 0)
  ) {
    return errValidation(
      "evidence.envelope_id must be a non-empty string when provided",
    );
  }
  return null;
}

function validateCardRef(
  cr: ManagerTaskCompleteCardRefInput,
): ManagerTaskCompleteErr | null {
  if (typeof cr.card_id !== "string" || cr.card_id.length === 0) {
    return errValidation(
      "card_ref.card_id must be a non-empty string when card_ref is provided",
    );
  }
  if (
    cr.path !== undefined &&
    (typeof cr.path !== "string" || cr.path.length === 0)
  ) {
    return errValidation(
      "card_ref.path must be a non-empty string when provided",
    );
  }
  return null;
}

export async function emitManagerTaskCompleted(
  registry: ManagerTaskCompleteRegistrySurface,
  input: ManagerTaskCompleteInput,
  callingAgentId: string,
  now: () => Date = () => new Date(),
): Promise<ManagerTaskCompleteResult> {
  if (typeof callingAgentId !== "string" || callingAgentId.length === 0) {
    return errValidation(
      "calling agent_id is required for manager_agent_id derivation",
    );
  }
  if (
    typeof input.parent_task_id !== "string" ||
    input.parent_task_id.length === 0
  ) {
    return errValidation("parent_task_id must be a non-empty string");
  }
  if (!VALID_COMPLETION_VERDICTS.has(input.completion_verdict)) {
    return errValidation(
      `completion_verdict must be one of: ${[
        ...VALID_COMPLETION_VERDICTS,
      ].join(", ")}`,
    );
  }
  if (typeof input.summary !== "string" || input.summary.length === 0) {
    return errValidation("summary must be a non-empty string");
  }
  const summaryBytes = utf8ByteLength(input.summary);
  if (summaryBytes < SUMMARY_BYTE_MIN || summaryBytes > SUMMARY_BYTE_MAX) {
    return errValidation(
      `summary must be between ${SUMMARY_BYTE_MIN} and ${SUMMARY_BYTE_MAX} UTF-8 bytes (got ${summaryBytes})`,
    );
  }
  if (input.evidence !== undefined) {
    if (
      input.evidence === null ||
      typeof input.evidence !== "object" ||
      Array.isArray(input.evidence)
    ) {
      return errValidation("evidence must be an object when provided");
    }
    const evErr = validateEvidence(input.evidence);
    if (evErr !== null) return evErr;
  }
  if (
    input.next_step !== undefined &&
    (typeof input.next_step !== "string" || input.next_step.length === 0)
  ) {
    return errValidation(
      "next_step must be a non-empty string when provided",
    );
  }
  if (input.card_ref !== undefined) {
    if (
      input.card_ref === null ||
      typeof input.card_ref !== "object" ||
      Array.isArray(input.card_ref)
    ) {
      return errValidation("card_ref must be an object when provided");
    }
    const crErr = validateCardRef(input.card_ref);
    if (crErr !== null) return crErr;
  }
  if (
    input.allow_without_merge !== undefined &&
    typeof input.allow_without_merge !== "boolean"
  ) {
    return errValidation(
      "allow_without_merge must be a boolean when provided",
    );
  }
  if (
    input.allow_without_merge_reason !== undefined &&
    (typeof input.allow_without_merge_reason !== "string" ||
      input.allow_without_merge_reason.length === 0)
  ) {
    return errValidation(
      "allow_without_merge_reason must be a non-empty string when provided",
    );
  }
  if (
    input.allow_without_merge === true &&
    (input.allow_without_merge_reason === undefined ||
      input.allow_without_merge_reason.length === 0)
  ) {
    return errValidation(
      "allow_without_merge=true requires a non-empty allow_without_merge_reason",
    );
  }
  if (
    input.completed_at !== undefined &&
    (typeof input.completed_at !== "string" || input.completed_at.length === 0)
  ) {
    return errValidation(
      "completed_at must be a non-empty ISO string when provided",
    );
  }

  // Merge precondition: success completes default-require a prior
  // `manager.task.merged` row for the same parent_task_id. Override
  // path is `allow_without_merge=true` + non-empty reason (already
  // gated above). Partial / failed verdicts skip the probe — they are
  // legitimate "I tried, here's what happened" reports.
  if (
    input.completion_verdict === "success" &&
    input.allow_without_merge !== true
  ) {
    const mergedRows = await registry.readManagerTaskMergedEvents(
      input.parent_task_id,
    );
    if (mergedRows.length === 0) {
      return errValidation(
        `completion_verdict=success requires a prior manager.task.merged event for parent_task_id=${input.parent_task_id}; set allow_without_merge=true with a non-empty allow_without_merge_reason to override`,
      );
    }
  }

  const completedAt =
    typeof input.completed_at === "string" && input.completed_at.length > 0
      ? input.completed_at
      : now().toISOString();
  const payload: ManagerTaskCompletedPayload = {
    parent_task_id: input.parent_task_id,
    manager_agent_id: callingAgentId,
    completion_verdict: input.completion_verdict,
    summary: input.summary,
    completed_at: completedAt,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.next_step !== undefined ? { next_step: input.next_step } : {}),
    ...(input.card_ref !== undefined ? { card_ref: input.card_ref } : {}),
    ...(input.allow_without_merge !== undefined
      ? { allow_without_merge: input.allow_without_merge }
      : {}),
    ...(input.allow_without_merge_reason !== undefined
      ? { allow_without_merge_reason: input.allow_without_merge_reason }
      : {}),
  };

  await registry.recordManagerTaskCompleted(input.parent_task_id, payload);

  return {
    ok: true,
    task_id: input.parent_task_id,
    parent_task_id: input.parent_task_id,
    completion_verdict: input.completion_verdict,
    completed_at: completedAt,
    payload,
  };
}
