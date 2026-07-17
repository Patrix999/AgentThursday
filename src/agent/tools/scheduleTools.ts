/**
 * self-scheduling base tools (`schedule_create` / `schedule_list`
 * / `schedule_cancel`), available to EVERY agent.
 *
 * Origin: share e688f483 — a user asked an agent for a daily 3pm price
 * check and the agent, having no schedule tool, stored a memory and
 * CLAIMED it was a scheduled task. The fix is capability, not prompt
 * rules (the operator: 给了工具应该就不会假装了).
 *
 * Scope split (2026-07-16 placement decision): these base tools target the
 * agent ITSELF only — no agent_id input. Scheduling OTHER agents is an
 * orchestration power that belongs to the manager surface. Owner is
 * resolved from the agent's own profile and FAILS CLOSED (unresolved →
 * refuse), an earlier revision posture. All an earlier revision safety valves (per-owner cap,
 * 900s minimum interval, auto-disable on failures) live in the ops layer
 * the registry callables delegate to, so they apply here unchanged.
 *
 * Times: users speak in local time; storage is UTC. `utc_offset_minutes`
 * is REQUIRED for daily/weekly so the model must convert (or ask the user
 * their timezone) instead of guessing.
 */

import { tool } from "ai";
import { z } from "zod";
import { ownerUserIdFor, scopeOwnerIdFor, type RequestIdentity } from "../requestIdentity";

export interface ScheduleWireRow {
  id: string;
  agent_id: string;
  schedule_kind: string;
  interval_s: number | null;
  at_hour: number | null;
  at_minute: number | null;
  at_weekday: number | null;
  prompt: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
}

export interface ScheduleToolHost {
  selfAgentId: string;
  /** Own owner identity; null = unresolved → every tool fails CLOSED. */
  resolveOwner: () => Promise<RequestIdentity | null>;
  createSchedule: (input: {
    id: string;
    ownerUserId: string;
    agentId: string;
    spec: Record<string, unknown>;
    nowIso: string;
  }) => Promise<{ ok: true; row: ScheduleWireRow } | { ok: false; code: string; message: string }>;
  listSchedules: (opts: { agentId?: string; scopeOwnerId?: string }) => Promise<ScheduleWireRow[]>;
  deleteSchedule: (input: { id: string; scopeOwnerId?: string }) => Promise<{ deleted: boolean }>;
  logEvent: (type: string, payload: unknown) => void;
}

/**
 * Local wall-clock (hour, minute[, weekday]) + UTC offset → the UTC fields
 * the schedule row stores. Exported for tests: the day-boundary weekday
 * shift is exactly the kind of thing that silently breaks.
 */
export function localFieldsToUtc(
  hour: number,
  minute: number,
  weekday: number | null,
  utcOffsetMinutes: number,
): { at_hour: number; at_minute: number; at_weekday: number | null } {
  const totalLocal = hour * 60 + minute;
  let totalUtc = totalLocal - utcOffsetMinutes;
  let dayShift = 0;
  while (totalUtc < 0) {
    totalUtc += 24 * 60;
    dayShift -= 1;
  }
  while (totalUtc >= 24 * 60) {
    totalUtc -= 24 * 60;
    dayShift += 1;
  }
  return {
    at_hour: Math.floor(totalUtc / 60),
    at_minute: totalUtc % 60,
    at_weekday: weekday === null ? null : ((weekday + dayShift) % 7 + 7) % 7,
  };
}

/** Human-readable cadence echo (UTC) so the agent can confirm with the user. */
function describeStored(row: ScheduleWireRow): string {
  if (row.schedule_kind === "interval") {
    const s = row.interval_s ?? 0;
    return s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`;
  }
  const hm = `${String(row.at_hour).padStart(2, "0")}:${String(row.at_minute).padStart(2, "0")} UTC`;
  if (row.schedule_kind === "daily") return `daily at ${hm}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `weekly ${days[row.at_weekday ?? 0]} at ${hm}`;
}

export function buildScheduleTools(host: ScheduleToolHost) {
  const { selfAgentId, resolveOwner, createSchedule, listSchedules, deleteSchedule, logEvent } = host;
  return {
    schedule_create: tool({
      description:
        "Create a RECURRING schedule for yourself: the platform will send you `prompt` on the cadence even when nobody is online. Use this whenever the user asks for periodic/recurring work (每天/每周/定期/every day...). kind=interval needs interval_hours (min 0.25); kind=daily/weekly need at_hour/at_minute plus utc_offset_minutes for the USER'S timezone (ask if unknown; e.g. UTC+8 = 480) and weekly needs weekday (0=Sunday). Returns the stored schedule including next_run_at — echo that back so the user can verify.",
      inputSchema: z.object({
        kind: z.enum(["interval", "daily", "weekly"]),
        prompt: z.string().min(1).max(4000).describe("what you should do each time it fires"),
        interval_hours: z.number().min(0.25).max(24 * 30).optional(),
        at_hour: z.number().int().min(0).max(23).optional().describe("hour in the USER'S local time"),
        at_minute: z.number().int().min(0).max(59).optional(),
        weekday: z.number().int().min(0).max(6).optional().describe("0=Sunday, in the user's local time"),
        utc_offset_minutes: z
          .number()
          .int()
          .min(-14 * 60)
          .max(14 * 60)
          .optional()
          .describe("user's UTC offset in minutes (UTC+8 → 480); REQUIRED for daily/weekly"),
      }),
      execute: async (input) => {
        const identity = await resolveOwner();
        if (identity === null) {
          logEvent("tool.schedule.create.owner_unresolved", { agent_id: selfAgentId });
          return { ok: false, error: "owner_unresolved: cannot create schedules right now" };
        }
        const spec: Record<string, unknown> = { schedule_kind: input.kind, prompt: input.prompt };
        if (input.kind === "interval") {
          if (input.interval_hours === undefined) {
            return { ok: false, error: "interval_hours is required for kind=interval" };
          }
          spec.interval_s = Math.round(input.interval_hours * 3600);
        } else {
          if (input.at_hour === undefined || input.utc_offset_minutes === undefined) {
            return {
              ok: false,
              error: "at_hour and utc_offset_minutes are required for daily/weekly (ask the user their timezone if you don't know it)",
            };
          }
          if (input.kind === "weekly" && input.weekday === undefined) {
            return { ok: false, error: "weekday (0=Sunday) is required for kind=weekly" };
          }
          const u = localFieldsToUtc(
            input.at_hour,
            input.at_minute ?? 0,
            input.kind === "weekly" ? (input.weekday ?? 0) : null,
            input.utc_offset_minutes,
          );
          spec.at_hour = u.at_hour;
          spec.at_minute = u.at_minute;
          if (input.kind === "weekly") spec.at_weekday = u.at_weekday;
        }
        const result = await createSchedule({
          id: `sched-${crypto.randomUUID()}`,
          ownerUserId: ownerUserIdFor(identity),
          agentId: selfAgentId,
          spec,
          nowIso: new Date().toISOString(),
        });
        if (!result.ok) {
          logEvent("tool.schedule.create.rejected", { code: result.code });
          return { ok: false, error: `${result.code}: ${result.message}` };
        }
        logEvent("tool.schedule.create", {
          schedule_id: result.row.id,
          kind: result.row.schedule_kind,
          next_run_at: result.row.next_run_at,
        });
        return {
          ok: true,
          schedule_id: result.row.id,
          cadence: describeStored(result.row),
          next_run_at: result.row.next_run_at,
          note: "Confirm the next_run_at with the user (it is UTC).",
        };
      },
    }),

    schedule_list: tool({
      description:
        "List YOUR active recurring schedules (id, cadence, prompt, next run, last status). Use before creating duplicates or when the user asks what is scheduled.",
      inputSchema: z.object({}),
      execute: async () => {
        const identity = await resolveOwner();
        if (identity === null) return { ok: false, error: "owner_unresolved", schedules: [] };
        const rows = await listSchedules({
          agentId: selfAgentId,
          scopeOwnerId: scopeOwnerIdFor(identity),
        });
        logEvent("tool.schedule.list", { count: rows.length });
        return {
          ok: true,
          schedules: rows.map((r) => ({
            schedule_id: r.id,
            cadence: describeStored(r),
            prompt: r.prompt.slice(0, 200),
            enabled: r.enabled === 1,
            next_run_at: r.next_run_at,
            last_status: r.last_status,
          })),
        };
      },
    }),

    schedule_cancel: tool({
      description: "Cancel (delete) one of YOUR schedules by schedule_id (from schedule_list / schedule_create).",
      inputSchema: z.object({ schedule_id: z.string().min(1) }),
      execute: async (input) => {
        const identity = await resolveOwner();
        if (identity === null) return { ok: false, error: "owner_unresolved" };
        const r = await deleteSchedule({
          id: input.schedule_id,
          scopeOwnerId: scopeOwnerIdFor(identity),
        });
        logEvent("tool.schedule.cancel", { schedule_id: input.schedule_id, deleted: r.deleted });
        return r.deleted
          ? { ok: true, deleted: input.schedule_id }
          : { ok: false, error: `schedule not found: ${input.schedule_id}` };
      },
    }),
  };
}
