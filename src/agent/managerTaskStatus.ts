/**
 *  — pure status-derivation helper for the manager async
 * task/status API.
 *
 * Lives in its own module (NOT inside `managerOps.ts`) so the test
 * suite can `node --import tsx --test` it without triggering the
 * `agents` → `partyserver` → `cloudflare:workers` import chain that
 * `managerOps.ts` carries via `getAgentByName`.
 *
 * Status rules per ADR §4.3:
 *   - no manager.task.* events                       -> "unknown"
 *   - only manager.task.received                     -> "received"
 *   - received + started, no terminal                -> "in_progress"
 *   - manager.task.waiting (latest, no terminal)     -> "waiting"
 *   - manager.task.replied                           -> "replied"
 *   - manager.task.failed                            -> "failed"
 *   - started but no terminal and > threshold        -> "timed_out"
 *
 *  — additive `terminal_conflict` evidence field. The derived
 * `status` enum is NOT changed (existing UI keeps working). When a
 * later event contradicts the first terminal, the helper exposes
 * evidence so operators don't only see the first terminal's truth.
 *
 * Conflict rules:
 *   - first terminal = `failed`, later `replied` or `merged` ⇒ conflict.
 *   - first terminal = `replied`, later `failed` ⇒ conflict.
 *   - first terminal = `replied`, later `merged` ⇒ NOT conflict
 *     ( §4.5 — audit-grade merge is the by-design follow-up
 *     to a successful replied terminal).
 *
 * Per-terminal payloads (reply/envelope_id/submit_task_id/error) are
 * captured on the FIRST terminal and never overwritten by later
 * events. Operators inspecting the status read the truth of the
 * first terminal AND the conflict evidence; they never see a fused
 * payload that mixes two terminals.
 *
 * `events` MUST be pre-sorted ascending by `ts` (matching the
 * `created_at ASC` SQL order used by the readManagerTaskEvents
 * callable). The helper does not re-sort.
 */

export const MANAGER_TASK_EVENT_NAMES = {
  received: "manager.task.received",
  started: "manager.task.started",
  waiting: "manager.task.waiting",
  replied: "manager.task.replied",
  failed: "manager.task.failed",
  //  — audit-grade merge marker. Coexists with `replied`;
  // does NOT participate in terminal status derivation (ADR §4.5:
  // presence of merged event is the audit discriminator, not the
  // lifecycle terminal). Derivation switch below has an explicit
  // no-op case so this is intentional, not a missed type.
  merged: "manager.task.merged",
  //  — manager completion report event. Report/archive
  // evidence ONLY; does NOT participate in terminal status
  // derivation (replied / failed remain the terminal classes). Unlike
  // `merged` (which IS treated as conflict evidence when it follows
  // a `failed` terminal), `completed` is a pure post-hoc record and
  // is NEVER pushed to `terminal_conflict.later_events`. Switch case
  // below is explicitly empty for the same reason.
  completed: "manager.task.completed",
} as const;

export type ManagerTaskEventType =
  (typeof MANAGER_TASK_EVENT_NAMES)[keyof typeof MANAGER_TASK_EVENT_NAMES];

export type ManagerTaskStatus =
  | "unknown"
  | "received"
  | "in_progress"
  | "waiting"
  | "replied"
  | "failed"
  | "timed_out";

export interface ManagerTaskEventRow {
  type: string;
  ts: string;
  payload?: Record<string, unknown> | null;
}

//  — terminal conflict evidence. Always present in the
// `DerivedManagerTaskStatus` shape so consumers see a stable contract;
// `has_conflict: false` is the no-conflict case (other fields omitted).
export interface TerminalConflictEvidence {
  has_conflict: boolean;
  terminal_status?: "replied" | "failed";
  later_events?: string[];
  message?: string;
}

//  — stale warning evidence. Additive, always present.
// A started-without-terminal task that has run past the SOFT timeout
// (`MANAGER_TASK_TIMEOUT_MS`) keeps a non-terminal primary status
// (`in_progress`) but carries `stale: true` so operators/UI see "this
// has been running a while" WITHOUT it reading as a final `timed_out`.
// Only the HARD ceiling (`MANAGER_TASK_HARD_TIMEOUT_MS`) flips primary
// status to `timed_out`. This stops a legitimate long gate (
// observed ~21 min) from being shown as terminal-timed-out at 10 min,
// while still surfacing genuinely dead runs at the hard ceiling.
export interface StaleWarningEvidence {
  stale: boolean;
  elapsed_ms?: number;
  message?: string;
}

export interface DerivedManagerTaskStatus {
  status: ManagerTaskStatus;
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  reply: string | null;
  envelope_id: string | null;
  //  — inner per-agent task id surfaced from the
  // `manager.task.replied` payload so operators / UI can correlate
  // the outer manager_task_id to the inner submitTask id without
  // grepping event payloads. `null` for unknown / non-terminal /
  // failed tasks.
  submit_task_id: string | null;
  error: { reason: string; message: string; failure_class?: string } | null;
  //  — additive. Status enum is unchanged; this surfaces the
  // existence of a later event that contradicts the first terminal.
  terminal_conflict: TerminalConflictEvidence;
  //  — additive. `stale: true` when started-without-terminal
  // has passed the SOFT timeout but not the HARD ceiling (primary
  // status stays `in_progress`). `stale: false` otherwise.
  stale_warning: StaleWarningEvidence;
}

//  — SOFT warning threshold. Started-without-terminal past this
// keeps primary status `in_progress` but raises `stale_warning.stale`.
// 10 min — the prior `timed_out` threshold; now demoted to a warning so
// a long-but-legitimate gate is not prematurely shown as terminal.
export const MANAGER_TASK_TIMEOUT_MS = 10 * 60 * 1000;

//  — HARD timeout ceiling. Only past this does primary status
// become `timed_out`. Sized from observed durations:  saw a
// legitimate software-dev run reach ~21 min (dominated by the full-repo
// typecheck timeout that 's scoped fast path removes). Even a
// src-change run that still hits the `root` phase plus a full
// `gate.build` is ~18-21 min worst case; 30 min gives headroom over
// that while still catching genuinely dead runs (no terminal + no
// further progress) at the ceiling. Not unbounded — see  /
// 193d for why bumping past a qualitative "low tens of minutes" budget
// would instead call for gate-progress heartbeats (the named follow-up).
export const MANAGER_TASK_HARD_TIMEOUT_MS = 30 * 60 * 1000;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asErrorPayload(
  payload: Record<string, unknown> | null | undefined,
): DerivedManagerTaskStatus["error"] {
  if (payload === null || payload === undefined) return null;
  const reason = asString(payload.reason) ?? "internal";
  const message = asString(payload.message) ?? "";
  const failure_class = asString(payload.failure_class);
  return failure_class !== null
    ? { reason, message, failure_class }
    : { reason, message };
}

export function deriveManagerTaskStatus(
  events: ManagerTaskEventRow[],
  now: Date,
): DerivedManagerTaskStatus {
  const result: DerivedManagerTaskStatus = {
    status: "unknown",
    accepted_at: null,
    started_at: null,
    completed_at: null,
    reply: null,
    envelope_id: null,
    submit_task_id: null,
    error: null,
    terminal_conflict: { has_conflict: false },
    stale_warning: { stale: false },
  };
  if (events.length === 0) return result;

  let received = false;
  let started = false;
  let lastWaitingAfterStart = false;
  //  — track first terminal + any later contradicting events
  // without short-circuiting on the first terminal. The first
  // terminal's payload is captured ONCE and never overwritten.
  let firstTerminal: "replied" | "failed" | null = null;
  const laterEvents: string[] = [];

  for (const e of events) {
    switch (e.type) {
      case MANAGER_TASK_EVENT_NAMES.received:
        received = true;
        if (result.accepted_at === null) result.accepted_at = e.ts;
        break;
      case MANAGER_TASK_EVENT_NAMES.started:
        started = true;
        if (result.started_at === null) result.started_at = e.ts;
        lastWaitingAfterStart = false;
        break;
      case MANAGER_TASK_EVENT_NAMES.waiting:
        lastWaitingAfterStart = started;
        break;
      case MANAGER_TASK_EVENT_NAMES.replied: {
        if (firstTerminal === null) {
          firstTerminal = "replied";
          result.status = "replied";
          result.completed_at = e.ts;
          const payload = e.payload ?? null;
          if (payload !== null) {
            result.reply = asString(payload.reply);
            result.envelope_id = asString(payload.envelope_id);
            result.submit_task_id = asString(payload.submit_task_id);
          }
        } else {
          //  — later replied is a terminal-flip conflict
          // when the first terminal was `failed`. (A second replied
          // after the first replied is also tracked — duplicated
          // terminals are still evidence of an inconsistent state.)
          laterEvents.push(e.type);
        }
        break;
      }
      case MANAGER_TASK_EVENT_NAMES.failed: {
        if (firstTerminal === null) {
          firstTerminal = "failed";
          result.status = "failed";
          result.completed_at = e.ts;
          result.error = asErrorPayload(e.payload ?? null);
        } else {
          //  — later failed after a replied terminal is the
          // canonical replied→failed conflict shape.
          laterEvents.push(e.type);
        }
        break;
      }
      case MANAGER_TASK_EVENT_NAMES.merged:
        // : audit-grade merge event. Non-terminal by design.
        // : counts as conflict-evidence ONLY when it follows
        // a `failed` terminal. After a `replied` terminal the merged
        // event is the by-design audit follow-up and is NOT flagged.
        if (firstTerminal === "failed") {
          laterEvents.push(e.type);
        }
        break;
      case MANAGER_TASK_EVENT_NAMES.completed:
        // : manager completion report. Pure report/archive
        // evidence — NEVER pushed to `laterEvents` even after a
        // `failed` terminal (unlike `merged`). A completion record
        // that disagrees with the terminal is operator-visible via
        // the additive `completion` side field on the status
        // endpoint; it is intentionally NOT flagged as a terminal
        // conflict.  spec §"Completion event 与
        // manager.task.replied 并存；它是 report/归档 evidence,
        // 不是 lifecycle terminal".
        break;
      default:
        break;
    }
  }

  //  — emit conflict evidence when a terminal had later events.
  if (firstTerminal !== null && laterEvents.length > 0) {
    result.terminal_conflict = {
      has_conflict: true,
      terminal_status: firstTerminal,
      later_events: laterEvents,
      message: `task has terminal ${firstTerminal} event followed by ${laterEvents.join(", ")} evidence`,
    };
  }

  if (firstTerminal !== null) return result;

  if (lastWaitingAfterStart) {
    result.status = "waiting";
    return result;
  }
  if (started) {
    if (result.started_at !== null) {
      const startedMs = Date.parse(result.started_at);
      if (Number.isFinite(startedMs)) {
        const elapsed = now.getTime() - startedMs;
        //  — HARD ceiling: genuinely stuck (no terminal, no
        // progress, past the ceiling) → terminal `timed_out`. Preserves
        // dead-run observability.
        if (elapsed > MANAGER_TASK_HARD_TIMEOUT_MS) {
          result.status = "timed_out";
          result.stale_warning = {
            stale: true,
            elapsed_ms: elapsed,
            message: `no terminal event ${Math.round(elapsed / 60000)} min after start (past hard ceiling)`,
          };
          return result;
        }
        //  — SOFT window: past the old 10-min threshold but not
        // the hard ceiling. Keep primary status `in_progress` (a long
        // gate may still be legitimately running) and only raise a
        // stale warning so operators/UI don't read it as terminal.
        if (elapsed > MANAGER_TASK_TIMEOUT_MS) {
          result.status = "in_progress";
          result.stale_warning = {
            stale: true,
            elapsed_ms: elapsed,
            message: `running ${Math.round(elapsed / 60000)} min with no terminal event yet (may be in a long gate)`,
          };
          return result;
        }
      }
    }
    result.status = "in_progress";
    return result;
  }
  if (received) {
    result.status = "received";
    return result;
  }
  return result;
}
