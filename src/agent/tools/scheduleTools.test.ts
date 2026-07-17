/**
 * self-scheduling base tools. Focus: the local→UTC conversion
 * (day-boundary weekday shifts break silently) and the tool contract
 * (fail-closed owner, self-only targeting, safety-valve error passthrough).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScheduleTools, localFieldsToUtc, type ScheduleWireRow } from "./scheduleTools";

test("localFieldsToUtc: same-day, day-back, day-forward, weekday wrap", () => {
  // UTC+8 (480): 15:00 local Wed(3) → 07:00 UTC Wed
  assert.deepEqual(localFieldsToUtc(15, 0, 3, 480), { at_hour: 7, at_minute: 0, at_weekday: 3 });
  // UTC+8: 03:30 local Mon(1) → 19:30 UTC SUNDAY(0) — day shifts back
  assert.deepEqual(localFieldsToUtc(3, 30, 1, 480), { at_hour: 19, at_minute: 30, at_weekday: 0 });
  // UTC-10 (-600): 20:00 local Sat(6) → 06:00 UTC SUNDAY(0) — wraps forward past week end
  assert.deepEqual(localFieldsToUtc(20, 0, 6, -600), { at_hour: 6, at_minute: 0, at_weekday: 0 });
  // UTC+8: 03:00 local Sunday(0) → 19:00 UTC Saturday(6) — wraps back past week start
  assert.deepEqual(localFieldsToUtc(3, 0, 0, 480), { at_hour: 19, at_minute: 0, at_weekday: 6 });
  // daily (no weekday)
  assert.deepEqual(localFieldsToUtc(15, 0, null, 480), { at_hour: 7, at_minute: 0, at_weekday: null });
});

function mkHost(overrides: Partial<Parameters<typeof buildScheduleTools>[0]> = {}) {
  const calls: Record<string, unknown[]> = { create: [], list: [], del: [] };
  const row: ScheduleWireRow = {
    id: "sched-x", agent_id: "agent-self", schedule_kind: "daily", interval_s: null,
    at_hour: 7, at_minute: 0, at_weekday: null, prompt: "p", enabled: 1,
    next_run_at: "2026-07-17T07:00:00.000Z", last_run_at: null, last_status: null,
  };
  const host = {
    selfAgentId: "agent-self",
    resolveOwner: async () => ({ kind: "user", userId: "user-a" }) as const,
    createSchedule: async (input: unknown) => {
      calls.create.push(input);
      return { ok: true as const, row };
    },
    listSchedules: async (opts: unknown) => {
      calls.list.push(opts);
      return [row];
    },
    deleteSchedule: async (input: unknown) => {
      calls.del.push(input);
      return { deleted: true };
    },
    logEvent: () => {},
    ...overrides,
  };
  return { tools: buildScheduleTools(host as Parameters<typeof buildScheduleTools>[0]), calls };
}

const exec = async (t: unknown, input: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {});

test("schedule_create: daily converts local→UTC, stamps own owner + self agent", async () => {
  const { tools, calls } = mkHost();
  const r = await exec(tools.schedule_create, {
    kind: "daily", prompt: "check prices", at_hour: 15, at_minute: 0, utc_offset_minutes: 480,
  });
  assert.equal(r.ok, true);
  assert.equal(r.next_run_at, "2026-07-17T07:00:00.000Z");
  const sent = calls.create[0] as { ownerUserId: string; agentId: string; spec: Record<string, unknown> };
  assert.equal(sent.ownerUserId, "user-a");
  assert.equal(sent.agentId, "agent-self");
  assert.equal(sent.spec.at_hour, 7);
});

test("schedule_create: daily without utc_offset refuses (must ask the user)", async () => {
  const { tools, calls } = mkHost();
  const r = await exec(tools.schedule_create, { kind: "daily", prompt: "p", at_hour: 15 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /utc_offset_minutes/);
  assert.equal(calls.create.length, 0);
});

test("fail-closed: unresolved owner refuses every tool", async () => {
  const { tools, calls } = mkHost({ resolveOwner: async () => null });
  const c = await exec(tools.schedule_create, { kind: "interval", prompt: "p", interval_hours: 1 });
  assert.equal(c.ok, false);
  const l = await exec(tools.schedule_list, {});
  assert.equal(l.ok, false);
  const d = await exec(tools.schedule_cancel, { schedule_id: "sched-x" });
  assert.equal(d.ok, false);
  assert.equal(calls.create.length + calls.list.length + calls.del.length, 0);
});

test("safety-valve rejections pass through as tool errors", async () => {
  const { tools } = mkHost({
    createSchedule: async () => ({ ok: false as const, code: "schedule_cap_exceeded", message: "cap" }),
  });
  const r = await exec(tools.schedule_create, { kind: "interval", prompt: "p", interval_hours: 1 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /schedule_cap_exceeded/);
});

test("list/cancel are owner-scoped to self", async () => {
  const { tools, calls } = mkHost();
  await exec(tools.schedule_list, {});
  assert.deepEqual(calls.list[0], { agentId: "agent-self", scopeOwnerId: "user-a" });
  await exec(tools.schedule_cancel, { schedule_id: "sched-x" });
  assert.deepEqual(calls.del[0], { id: "sched-x", scopeOwnerId: "user-a" });
});
