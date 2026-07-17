/**
 * native scheduled tasks v1 (owner-scoped, registry DO).
 *
 * Data model: one row per user-defined schedule. Lives on the registry DO
 * like `shared_file` (per-agent DOs keep an empty copy). The registry DO
 * runs a minute-level self-renewing tick (`scheduleEvery` — agents-SDK
 * alarm, persisted in DO storage, survives deploys) that claims due rows
 * and dispatches them through the EXISTING manager message path
 * (`runManagerTaskBackground`), so a scheduled run is a completely normal
 * task: activity / trace / task_usage all apply unchanged.
 *
 * Claim-before-dispatch: `claimDueScheduledTasks` advances `next_run_at`
 * (and stamps `last_run_at`) in the same synchronous DO step that reads
 * the due rows, so an overlapping tick can never double-fire a row.
 *
 * Safety valves (multi-tenant, enforced here not in the route):
 *   - per-owner cap (MAX_SCHEDULES_PER_OWNER)
 *   - minimum interval (MIN_INTERVAL_S) — daily/weekly satisfy trivially
 *   - auto-disable after MAX_CONSECUTIVE_FAILURES failed dispatches
 *
 * Dispatch identity is derived from the row's `owner_user_id` and is
 * fail-closed: rows with an empty owner are skipped and marked failed,
 * never dispatched as admin (an earlier revision posture).
 *
 * v1 schedule kinds (deliberately NOT full cron syntax):
 *   - interval: every `interval_s` seconds (>= MIN_INTERVAL_S)
 *   - daily:    every day at `at_hour:at_minute` UTC
 *   - weekly:   every week on `at_weekday` (0=Sun..6=Sat, UTC) at
 *               `at_hour:at_minute` UTC
 */

import type { AgentSqlTag } from "./migrations";

export const MAX_SCHEDULES_PER_OWNER = 10;
export const MIN_INTERVAL_S = 900;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const MAX_PROMPT_CHARS = 4000;
/** Rows claimed per tick — bounds one alarm's dispatch fan-out. */
export const MAX_CLAIMS_PER_TICK = 5;

export interface ScheduledTaskHost {
  sql: AgentSqlTag;
}

export type ScheduleKind = "interval" | "daily" | "weekly";

export interface ScheduledTaskRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  schedule_kind: ScheduleKind;
  interval_s: number | null;
  at_hour: number | null;
  at_minute: number | null;
  at_weekday: number | null;
  prompt: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  last_status: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleSpecInput {
  schedule_kind: ScheduleKind;
  interval_s?: number | null;
  at_hour?: number | null;
  at_minute?: number | null;
  at_weekday?: number | null;
  prompt: string;
}

export type ScheduleValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateScheduleSpec(input: ScheduleSpecInput): ScheduleValidation {
  const bad = (code: string, message: string): ScheduleValidation => ({ ok: false, code, message });
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return bad("invalid_prompt", "prompt is required and must be non-empty");
  }
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    return bad("invalid_prompt", `prompt exceeds ${MAX_PROMPT_CHARS} chars`);
  }
  const kind = input.schedule_kind;
  if (kind === "interval") {
    const s = input.interval_s;
    if (typeof s !== "number" || !Number.isFinite(s) || Math.floor(s) !== s) {
      return bad("invalid_interval", "interval_s must be an integer number of seconds");
    }
    if (s < MIN_INTERVAL_S) {
      return bad("interval_too_short", `interval_s must be >= ${MIN_INTERVAL_S}`);
    }
    return { ok: true };
  }
  if (kind === "daily" || kind === "weekly") {
    const h = input.at_hour;
    const m = input.at_minute;
    if (typeof h !== "number" || h < 0 || h > 23 || Math.floor(h) !== h) {
      return bad("invalid_time", "at_hour must be an integer 0-23 (UTC)");
    }
    if (typeof m !== "number" || m < 0 || m > 59 || Math.floor(m) !== m) {
      return bad("invalid_time", "at_minute must be an integer 0-59");
    }
    if (kind === "weekly") {
      const w = input.at_weekday;
      if (typeof w !== "number" || w < 0 || w > 6 || Math.floor(w) !== w) {
        return bad("invalid_weekday", "at_weekday must be an integer 0-6 (0=Sunday, UTC)");
      }
    }
    return { ok: true };
  }
  return bad("invalid_kind", "schedule_kind must be interval | daily | weekly");
}

/**
 * Next run strictly AFTER `from`. Interval anchors on `from` (creation or
 * the claiming tick); daily/weekly anchor on the UTC wall-clock slot.
 */
export function computeNextRunAt(spec: ScheduleSpecInput, from: Date): string {
  if (spec.schedule_kind === "interval") {
    const s = typeof spec.interval_s === "number" ? spec.interval_s : MIN_INTERVAL_S;
    return new Date(from.getTime() + s * 1000).toISOString();
  }
  const h = spec.at_hour ?? 0;
  const m = spec.at_minute ?? 0;
  const next = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h, m, 0, 0,
  ));
  if (spec.schedule_kind === "daily") {
    if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  // weekly
  const w = spec.at_weekday ?? 0;
  let delta = (w - next.getUTCDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7;
  next.setUTCDate(next.getUTCDate() + delta);
  return next.toISOString();
}

export type CreateScheduleResult =
  | { ok: true; row: ScheduledTaskRow }
  | { ok: false; code: string; message: string };

export function createScheduledTask(
  host: ScheduledTaskHost,
  input: {
    id: string;
    ownerUserId: string;
    agentId: string;
    spec: ScheduleSpecInput;
    nowIso: string;
  },
): CreateScheduleResult {
  const v = validateScheduleSpec(input.spec);
  if (!v.ok) return { ok: false, code: v.code, message: v.message };
  if (typeof input.ownerUserId !== "string" || input.ownerUserId.length === 0) {
    return { ok: false, code: "invalid_owner", message: "owner is required" };
  }
  const cnt = host.sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM scheduled_task WHERE owner_user_id = ${input.ownerUserId}
  `;
  if ((cnt[0]?.c ?? 0) >= MAX_SCHEDULES_PER_OWNER) {
    return {
      ok: false,
      code: "schedule_cap_exceeded",
      message: `per-owner schedule cap (${MAX_SCHEDULES_PER_OWNER}) reached`,
    };
  }
  const now = new Date(input.nowIso);
  const nextRun = computeNextRunAt(input.spec, now);
  host.sql`
    INSERT INTO scheduled_task
      (id, owner_user_id, agent_id, schedule_kind, interval_s, at_hour, at_minute, at_weekday,
       prompt, enabled, next_run_at, last_run_at, last_task_id, last_status,
       consecutive_failures, created_at, updated_at)
    VALUES
      (${input.id}, ${input.ownerUserId}, ${input.agentId}, ${input.spec.schedule_kind},
       ${input.spec.interval_s ?? null}, ${input.spec.at_hour ?? null},
       ${input.spec.at_minute ?? null}, ${input.spec.at_weekday ?? null},
       ${input.spec.prompt}, 1, ${nextRun}, NULL, NULL, NULL, 0,
       ${input.nowIso}, ${input.nowIso})
  `;
  const row = readScheduledTask(host, input.id, input.ownerUserId);
  if (row === null) return { ok: false, code: "internal", message: "insert readback failed" };
  return { ok: true, row };
}

/** scopeOwnerId undefined = admin (unfiltered). */
export function listScheduledTasks(
  host: ScheduledTaskHost,
  opts: { agentId?: string; scopeOwnerId?: string },
): ScheduledTaskRow[] {
  const { agentId, scopeOwnerId } = opts;
  if (agentId !== undefined && scopeOwnerId !== undefined) {
    return host.sql<ScheduledTaskRow>`
      SELECT * FROM scheduled_task
      WHERE agent_id = ${agentId} AND owner_user_id = ${scopeOwnerId}
      ORDER BY created_at
    `;
  }
  if (agentId !== undefined) {
    return host.sql<ScheduledTaskRow>`
      SELECT * FROM scheduled_task WHERE agent_id = ${agentId} ORDER BY created_at
    `;
  }
  if (scopeOwnerId !== undefined) {
    return host.sql<ScheduledTaskRow>`
      SELECT * FROM scheduled_task WHERE owner_user_id = ${scopeOwnerId} ORDER BY created_at
    `;
  }
  return host.sql<ScheduledTaskRow>`SELECT * FROM scheduled_task ORDER BY created_at`;
}

export function readScheduledTask(
  host: ScheduledTaskHost,
  id: string,
  scopeOwnerId?: string,
): ScheduledTaskRow | null {
  const rows = scopeOwnerId !== undefined
    ? host.sql<ScheduledTaskRow>`
        SELECT * FROM scheduled_task WHERE id = ${id} AND owner_user_id = ${scopeOwnerId} LIMIT 1
      `
    : host.sql<ScheduledTaskRow>`SELECT * FROM scheduled_task WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export type UpdateScheduleResult =
  | { ok: true; row: ScheduledTaskRow }
  | { ok: false; code: string; message: string };

/**
 * Partial update: `enabled` (pause/resume), `prompt`, and/or the schedule
 * spec fields. Any spec-field change revalidates the merged spec and
 * recomputes `next_run_at` from `nowIso`. Re-enabling also recomputes
 * `next_run_at` (a paused row's slot may be long past) and clears the
 * failure counter.
 */
export function updateScheduledTask(
  host: ScheduledTaskHost,
  input: {
    id: string;
    scopeOwnerId?: string;
    nowIso: string;
    changes: Partial<ScheduleSpecInput> & { enabled?: boolean };
  },
): UpdateScheduleResult {
  const existing = readScheduledTask(host, input.id, input.scopeOwnerId);
  if (existing === null) {
    return { ok: false, code: "not_found", message: `schedule not found: ${input.id}` };
  }
  const c = input.changes;
  const specTouched =
    c.schedule_kind !== undefined || c.interval_s !== undefined ||
    c.at_hour !== undefined || c.at_minute !== undefined ||
    c.at_weekday !== undefined || c.prompt !== undefined;
  const merged: ScheduleSpecInput = {
    schedule_kind: c.schedule_kind ?? existing.schedule_kind,
    interval_s: c.interval_s !== undefined ? c.interval_s : existing.interval_s,
    at_hour: c.at_hour !== undefined ? c.at_hour : existing.at_hour,
    at_minute: c.at_minute !== undefined ? c.at_minute : existing.at_minute,
    at_weekday: c.at_weekday !== undefined ? c.at_weekday : existing.at_weekday,
    prompt: c.prompt ?? existing.prompt,
  };
  if (specTouched) {
    const v = validateScheduleSpec(merged);
    if (!v.ok) return { ok: false, code: v.code, message: v.message };
  }
  const reEnabled = c.enabled === true && existing.enabled === 0;
  const enabled = c.enabled === undefined ? existing.enabled : (c.enabled ? 1 : 0);
  const nextRun = specTouched || reEnabled
    ? computeNextRunAt(merged, new Date(input.nowIso))
    : existing.next_run_at;
  const failures = reEnabled ? 0 : existing.consecutive_failures;
  host.sql`
    UPDATE scheduled_task SET
      schedule_kind = ${merged.schedule_kind},
      interval_s = ${merged.interval_s ?? null},
      at_hour = ${merged.at_hour ?? null},
      at_minute = ${merged.at_minute ?? null},
      at_weekday = ${merged.at_weekday ?? null},
      prompt = ${merged.prompt},
      enabled = ${enabled},
      next_run_at = ${nextRun},
      consecutive_failures = ${failures},
      updated_at = ${input.nowIso}
    WHERE id = ${input.id}
  `;
  const row = readScheduledTask(host, input.id, input.scopeOwnerId);
  if (row === null) return { ok: false, code: "internal", message: "update readback failed" };
  return { ok: true, row };
}

export function deleteScheduledTask(
  host: ScheduledTaskHost,
  id: string,
  scopeOwnerId?: string,
): boolean {
  const existing = readScheduledTask(host, id, scopeOwnerId);
  if (existing === null) return false;
  host.sql`DELETE FROM scheduled_task WHERE id = ${id}`;
  return true;
}

/**
 * Claim every enabled row whose slot has arrived (bounded by
 * MAX_CLAIMS_PER_TICK): advance `next_run_at`, stamp `last_run_at`, and
 * return the claimed rows for dispatch. The read+update runs inside one
 * synchronous DO step — no await between them — so overlapping ticks
 * cannot claim the same slot twice.
 */
export function claimDueScheduledTasks(
  host: ScheduledTaskHost,
  nowIso: string,
): ScheduledTaskRow[] {
  const due = host.sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_task
    WHERE enabled = 1 AND next_run_at <= ${nowIso}
    ORDER BY next_run_at
    LIMIT ${MAX_CLAIMS_PER_TICK}
  `;
  const now = new Date(nowIso);
  for (const row of due) {
    // 475d — interval schedules anchor the NEXT run on the due SLOT, not the
    // claim time: a 60s tick claims up to ~1 min late, and claim-time
    // anchoring made hourly schedules drift ~1 min per run (prod: 09:10 →
    // 10:11 → … → 14:14). Missed slots (long outage) are skipped, not
    // burst-replayed. Daily/weekly already anchor on the wall-clock slot.
    let nextRun: string;
    if (row.schedule_kind === "interval") {
      const step = (row.interval_s ?? MIN_INTERVAL_S) * 1000;
      let next = new Date(row.next_run_at).getTime() + step;
      while (next <= now.getTime()) next += step;
      nextRun = new Date(next).toISOString();
    } else {
      nextRun = computeNextRunAt(
        {
          schedule_kind: row.schedule_kind,
          interval_s: row.interval_s,
          at_hour: row.at_hour,
          at_minute: row.at_minute,
          at_weekday: row.at_weekday,
          prompt: row.prompt,
        },
        now,
      );
    }
    host.sql`
      UPDATE scheduled_task
      SET next_run_at = ${nextRun}, last_run_at = ${nowIso}, updated_at = ${nowIso}
      WHERE id = ${row.id}
    `;
  }
  return due;
}

/**
 * Record a dispatch outcome. Success resets the failure counter; failure
 * increments it and auto-disables the row at MAX_CONSECUTIVE_FAILURES so a
 * permanently-broken schedule cannot burn tokens forever. Also settles the
 * matching `scheduled_task_run` history row .
 */
export function recordScheduledRunResult(
  host: ScheduledTaskHost,
  input: { id: string; taskId: string | null; ok: boolean; detail?: string; nowIso: string },
): { disabled: boolean } {
  if (input.taskId !== null) {
    host.sql`
      UPDATE scheduled_task_run
      SET status = ${input.ok ? "ok" : "failed"},
          detail = ${input.detail ? input.detail.slice(0, 200) : null},
          settled_at = ${input.nowIso}
      WHERE task_id = ${input.taskId}
    `;
  }
  const existing = readScheduledTask(host, input.id);
  if (existing === null) return { disabled: false };
  if (input.ok) {
    host.sql`
      UPDATE scheduled_task
      SET last_task_id = ${input.taskId}, last_status = 'ok',
          consecutive_failures = 0, updated_at = ${input.nowIso}
      WHERE id = ${input.id}
    `;
    return { disabled: false };
  }
  const failures = existing.consecutive_failures + 1;
  const disable = failures >= MAX_CONSECUTIVE_FAILURES;
  const status = `failed${input.detail ? `: ${input.detail.slice(0, 200)}` : ""}${disable ? " (auto-disabled)" : ""}`;
  host.sql`
    UPDATE scheduled_task
    SET last_task_id = ${input.taskId}, last_status = ${status},
        consecutive_failures = ${failures},
        enabled = ${disable ? 0 : existing.enabled},
        updated_at = ${input.nowIso}
    WHERE id = ${input.id}
  `;
  return { disabled: disable };
}

// ── execution history ────────────────────────────────────────

/** History rows kept per schedule (older rows pruned on insert). */
export const MAX_RUNS_PER_SCHEDULE = 20;

export interface ScheduledTaskRunRow {
  task_id: string;
  schedule_id: string;
  agent_id: string;
  status: string; // dispatched | ok | failed
  detail: string | null;
  started_at: string;
  settled_at: string | null;
}

/** Insert the `dispatched` history row at claim/dispatch time, then prune. */
export function recordScheduledRunStart(
  host: ScheduledTaskHost,
  input: { scheduleId: string; taskId: string; agentId: string; nowIso: string },
): void {
  host.sql`
    INSERT INTO scheduled_task_run (task_id, schedule_id, agent_id, status, detail, started_at, settled_at)
    VALUES (${input.taskId}, ${input.scheduleId}, ${input.agentId}, 'dispatched', NULL, ${input.nowIso}, NULL)
  `;
  host.sql`
    DELETE FROM scheduled_task_run
    WHERE schedule_id = ${input.scheduleId}
      AND task_id NOT IN (
        SELECT task_id FROM scheduled_task_run
        WHERE schedule_id = ${input.scheduleId}
        ORDER BY started_at DESC
        LIMIT ${MAX_RUNS_PER_SCHEDULE}
      )
  `;
}

export function listScheduledTaskRuns(
  host: ScheduledTaskHost,
  scheduleId: string,
  limit = MAX_RUNS_PER_SCHEDULE,
): ScheduledTaskRunRow[] {
  return host.sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_run
    WHERE schedule_id = ${scheduleId}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
}

export interface ScheduledTaskWithRuns extends ScheduledTaskRow {
  recent_runs: ScheduledTaskRunRow[];
}

/** Schedules + history — optionally narrowed to one agent (475b modal). */
export function listScheduledTasksWithRuns(
  host: ScheduledTaskHost,
  opts: { agentId?: string; scopeOwnerId?: string; runLimit?: number },
): ScheduledTaskWithRuns[] {
  const rows = listScheduledTasks(host, { agentId: opts.agentId, scopeOwnerId: opts.scopeOwnerId });
  return rows.map((r) => ({
    ...r,
    recent_runs: listScheduledTaskRuns(host, r.id, opts.runLimit ?? 5),
  }));
}
