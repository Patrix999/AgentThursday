/**
 * scheduled-task ops against a REAL sqlite DB (node:sqlite),
 * same harness as migrations.test.ts: mock SQL tags don't exercise DDL or
 * WHERE semantics, and the claim logic is exactly the kind of thing a mock
 * would vacuously pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runAgentMigrations, type AgentSqlTag } from "./migrations";
import {
  MAX_SCHEDULES_PER_OWNER,
  MAX_CONSECUTIVE_FAILURES,
  MAX_CLAIMS_PER_TICK,
  MAX_RUNS_PER_SCHEDULE,
  validateScheduleSpec,
  computeNextRunAt,
  createScheduledTask,
  listScheduledTasks,
  readScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  claimDueScheduledTasks,
  recordScheduledRunStart,
  recordScheduledRunResult,
  listScheduledTaskRuns,
  listScheduledTasksWithRuns,
} from "./scheduledTaskOps";

function mkSqlite(): { sql: AgentSqlTag; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const params = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as Array<
      string | number | null
    >;
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)/i.test(text);
    const stmt = db.prepare(text);
    if (isQuery) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }) as unknown as AgentSqlTag;
  return { sql, db };
}

async function mkHost() {
  const { sql, db } = mkSqlite();
  await runAgentMigrations({ sql });
  return { host: { sql }, db };
}

const NOW = "2026-07-15T10:00:00.000Z"; // a Wednesday (UTC day 3)

const intervalSpec = (s: number, prompt = "run the thing") => ({
  schedule_kind: "interval" as const,
  interval_s: s,
  prompt,
});

test("validateScheduleSpec: kinds, bounds, min interval", () => {
  assert.equal(validateScheduleSpec(intervalSpec(900)).ok, true);
  assert.equal(validateScheduleSpec(intervalSpec(899)).ok, false);
  assert.equal(validateScheduleSpec({ schedule_kind: "interval", interval_s: 900, prompt: "" }).ok, false);
  assert.equal(
    validateScheduleSpec({ schedule_kind: "daily", at_hour: 9, at_minute: 30, prompt: "p" }).ok,
    true,
  );
  assert.equal(
    validateScheduleSpec({ schedule_kind: "daily", at_hour: 24, at_minute: 0, prompt: "p" }).ok,
    false,
  );
  assert.equal(
    validateScheduleSpec({ schedule_kind: "weekly", at_hour: 9, at_minute: 0, at_weekday: 7, prompt: "p" }).ok,
    false,
  );
  assert.equal(
    validateScheduleSpec({ schedule_kind: "weekly", at_hour: 9, at_minute: 0, at_weekday: 1, prompt: "p" }).ok,
    true,
  );
  // @ts-expect-error runtime guard for bad kind
  assert.equal(validateScheduleSpec({ schedule_kind: "cron", prompt: "p" }).ok, false);
});

test("computeNextRunAt: interval / daily / weekly (incl. week wrap)", () => {
  const from = new Date(NOW);
  assert.equal(
    computeNextRunAt(intervalSpec(900), from),
    "2026-07-15T10:15:00.000Z",
  );
  // daily, slot later today
  assert.equal(
    computeNextRunAt({ schedule_kind: "daily", at_hour: 11, at_minute: 5, prompt: "p" }, from),
    "2026-07-15T11:05:00.000Z",
  );
  // daily, slot already passed → tomorrow
  assert.equal(
    computeNextRunAt({ schedule_kind: "daily", at_hour: 9, at_minute: 0, prompt: "p" }, from),
    "2026-07-16T09:00:00.000Z",
  );
  // weekly: 2026-07-15 is Wednesday (day 3). Monday (1) → next Monday.
  assert.equal(
    computeNextRunAt({ schedule_kind: "weekly", at_weekday: 1, at_hour: 9, at_minute: 23, prompt: "p" }, from),
    "2026-07-20T09:23:00.000Z",
  );
  // weekly same-day slot passed → +7 days
  assert.equal(
    computeNextRunAt({ schedule_kind: "weekly", at_weekday: 3, at_hour: 9, at_minute: 0, prompt: "p" }, from),
    "2026-07-22T09:00:00.000Z",
  );
  // weekly same-day slot still ahead → today
  assert.equal(
    computeNextRunAt({ schedule_kind: "weekly", at_weekday: 3, at_hour: 23, at_minute: 0, prompt: "p" }, from),
    "2026-07-15T23:00:00.000Z",
  );
});

test("create/list/read: owner scoping and per-owner cap", async () => {
  const { host } = await mkHost();
  const a = createScheduledTask(host, {
    id: "sched-1", ownerUserId: "user-a", agentId: "agent-x", spec: intervalSpec(900), nowIso: NOW,
  });
  assert.equal(a.ok, true);
  const b = createScheduledTask(host, {
    id: "sched-2", ownerUserId: "user-b", agentId: "agent-y", spec: intervalSpec(1800), nowIso: NOW,
  });
  assert.equal(b.ok, true);
  // owner filter
  assert.equal(listScheduledTasks(host, { scopeOwnerId: "user-a" }).length, 1);
  assert.equal(listScheduledTasks(host, {}).length, 2);
  assert.equal(listScheduledTasks(host, { agentId: "agent-x", scopeOwnerId: "user-b" }).length, 0);
  // scoped read of a foreign row = null (no leak)
  assert.equal(readScheduledTask(host, "sched-1", "user-b"), null);
  assert.notEqual(readScheduledTask(host, "sched-1", "user-a"), null);
  // cap
  for (let i = 0; i < MAX_SCHEDULES_PER_OWNER - 1; i++) {
    const r = createScheduledTask(host, {
      id: `sched-a${i}`, ownerUserId: "user-a", agentId: "agent-x", spec: intervalSpec(900), nowIso: NOW,
    });
    assert.equal(r.ok, true, `create ${i} under cap`);
  }
  const over = createScheduledTask(host, {
    id: "sched-over", ownerUserId: "user-a", agentId: "agent-x", spec: intervalSpec(900), nowIso: NOW,
  });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "schedule_cap_exceeded");
});

test("update: pause/resume recomputes next_run and clears failures; owner-scoped", async () => {
  const { host } = await mkHost();
  createScheduledTask(host, {
    id: "sched-1", ownerUserId: "user-a", agentId: "agent-x", spec: intervalSpec(900), nowIso: NOW,
  });
  // foreign scope can't touch it
  const foreign = updateScheduledTask(host, {
    id: "sched-1", scopeOwnerId: "user-b", nowIso: NOW, changes: { enabled: false },
  });
  assert.equal(foreign.ok, false);
  // pause
  const paused = updateScheduledTask(host, {
    id: "sched-1", scopeOwnerId: "user-a", nowIso: NOW, changes: { enabled: false },
  });
  assert.equal(paused.ok, true);
  if (paused.ok) assert.equal(paused.row.enabled, 0);
  // simulate accumulated failures while paused
  host.sql`UPDATE scheduled_task SET consecutive_failures = 3 WHERE id = ${"sched-1"}`;
  // resume much later → next_run recomputed from resume time, failures reset
  const later = "2026-07-20T00:00:00.000Z";
  const resumed = updateScheduledTask(host, {
    id: "sched-1", scopeOwnerId: "user-a", nowIso: later, changes: { enabled: true },
  });
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.row.enabled, 1);
    assert.equal(resumed.row.consecutive_failures, 0);
    assert.equal(resumed.row.next_run_at, "2026-07-20T00:15:00.000Z");
  }
  // invalid spec change rejected
  const badSpec = updateScheduledTask(host, {
    id: "sched-1", scopeOwnerId: "user-a", nowIso: later, changes: { interval_s: 10 },
  });
  assert.equal(badSpec.ok, false);
});

test("delete: owner-scoped", async () => {
  const { host } = await mkHost();
  createScheduledTask(host, {
    id: "sched-1", ownerUserId: "user-a", agentId: "agent-x", spec: intervalSpec(900), nowIso: NOW,
  });
  assert.equal(deleteScheduledTask(host, "sched-1", "user-b"), false);
  assert.equal(deleteScheduledTask(host, "sched-1", "user-a"), true);
  assert.equal(listScheduledTasks(host, {}).length, 0);
});

test("claim: due rows advance next_run in the same step; disabled/future rows untouched", async () => {
  const { host } = await mkHost();
  createScheduledTask(host, {
    id: "s-due", ownerUserId: "u", agentId: "a", spec: intervalSpec(900), nowIso: "2026-07-15T09:00:00.000Z",
  });
  createScheduledTask(host, {
    id: "s-future", ownerUserId: "u", agentId: "a", spec: intervalSpec(86400), nowIso: NOW,
  });
  createScheduledTask(host, {
    id: "s-paused", ownerUserId: "u", agentId: "a", spec: intervalSpec(900), nowIso: "2026-07-15T09:00:00.000Z",
  });
  updateScheduledTask(host, { id: "s-paused", nowIso: "2026-07-15T09:01:00.000Z", changes: { enabled: false } });

  const claimed = claimDueScheduledTasks(host, NOW);
  assert.deepEqual(claimed.map((r) => r.id), ["s-due"]);
  // claim advanced next_run past NOW → immediate re-claim returns nothing
  assert.equal(claimDueScheduledTasks(host, NOW).length, 0);
  const row = readScheduledTask(host, "s-due");
  assert.equal(row?.next_run_at, "2026-07-15T10:15:00.000Z");
  assert.equal(row?.last_run_at, NOW);
});

test("claim: interval anchors on the due slot, not the claim time (475d)", async () => {
  const { host } = await mkHost();
  // hourly created 09:00 → slot 10:00; the tick claims 21s late
  createScheduledTask(host, {
    id: "s-h", ownerUserId: "u", agentId: "a",
    spec: intervalSpec(3600), nowIso: "2026-07-15T09:00:00.000Z",
  });
  claimDueScheduledTasks(host, "2026-07-15T10:00:21.000Z");
  // next run is the exact 11:00 slot — no 21s drift
  assert.equal(readScheduledTask(host, "s-h")?.next_run_at, "2026-07-15T11:00:00.000Z");
  // long outage: slots 11:00/12:00/13:00 missed, tick returns 13:30 →
  // claims once, skips missed slots, next = 14:00 (no burst replay)
  const claimed = claimDueScheduledTasks(host, "2026-07-15T13:30:05.000Z");
  assert.equal(claimed.length, 1);
  assert.equal(readScheduledTask(host, "s-h")?.next_run_at, "2026-07-15T14:00:00.000Z");
  assert.equal(claimDueScheduledTasks(host, "2026-07-15T13:30:06.000Z").length, 0);
});

test("claim: bounded per tick", async () => {
  const { host } = await mkHost();
  // owners differ so the per-owner cap doesn't interfere
  for (let i = 0; i < MAX_CLAIMS_PER_TICK + 2; i++) {
    createScheduledTask(host, {
      id: `s-${i}`, ownerUserId: `u-${i}`, agentId: "a", spec: intervalSpec(900),
      nowIso: "2026-07-15T09:00:00.000Z",
    });
  }
  assert.equal(claimDueScheduledTasks(host, NOW).length, MAX_CLAIMS_PER_TICK);
  // remainder picked up by the next tick
  assert.equal(claimDueScheduledTasks(host, NOW).length, 2);
});

test("run history: start → settle → prune; embedded in withRuns read (475a)", async () => {
  const { host } = await mkHost();
  createScheduledTask(host, {
    id: "s-1", ownerUserId: "u", agentId: "a", spec: intervalSpec(900), nowIso: NOW,
  });
  recordScheduledRunStart(host, { scheduleId: "s-1", taskId: "t-1", agentId: "a", nowIso: NOW });
  assert.deepEqual(
    listScheduledTaskRuns(host, "s-1").map((r) => [r.task_id, r.status, r.settled_at]),
    [["t-1", "dispatched", null]],
  );
  // settle ok via the same result recorder the sweep uses
  recordScheduledRunResult(host, { id: "s-1", taskId: "t-1", ok: true, nowIso: NOW });
  assert.deepEqual(
    listScheduledTaskRuns(host, "s-1").map((r) => [r.status, r.settled_at]),
    [["ok", NOW]],
  );
  // settle failed carries detail
  recordScheduledRunStart(host, { scheduleId: "s-1", taskId: "t-2", agentId: "a", nowIso: NOW });
  recordScheduledRunResult(host, { id: "s-1", taskId: "t-2", ok: false, detail: "boom", nowIso: NOW });
  const t2 = listScheduledTaskRuns(host, "s-1").find((r) => r.task_id === "t-2");
  assert.equal(t2?.status, "failed");
  assert.equal(t2?.detail, "boom");
  // prune: cap history per schedule (distinct started_at so ordering is stable)
  for (let i = 0; i < MAX_RUNS_PER_SCHEDULE + 5; i++) {
    const ts = `2026-07-15T11:${String(i).padStart(2, "0")}:00.000Z`;
    recordScheduledRunStart(host, { scheduleId: "s-1", taskId: `t-p${i}`, agentId: "a", nowIso: ts });
  }
  assert.equal(listScheduledTaskRuns(host, "s-1", 100).length, MAX_RUNS_PER_SCHEDULE);
  // withRuns embeds owner-scoped
  const w = listScheduledTasksWithRuns(host, { scopeOwnerId: "u", runLimit: 3 });
  assert.equal(w.length, 1);
  assert.equal(w[0].recent_runs.length, 3);
  assert.equal(listScheduledTasksWithRuns(host, { scopeOwnerId: "other" }).length, 0);
});

test("recordScheduledRunResult: ok resets counter; failures auto-disable at threshold", async () => {
  const { host } = await mkHost();
  createScheduledTask(host, {
    id: "s-1", ownerUserId: "u", agentId: "a", spec: intervalSpec(900), nowIso: NOW,
  });
  for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
    const r = recordScheduledRunResult(host, { id: "s-1", taskId: `t-${i}`, ok: false, detail: "boom", nowIso: NOW });
    assert.equal(r.disabled, false, `failure ${i} below threshold`);
  }
  // success in between resets
  recordScheduledRunResult(host, { id: "s-1", taskId: "t-ok", ok: true, nowIso: NOW });
  assert.equal(readScheduledTask(host, "s-1")?.consecutive_failures, 0);
  assert.equal(readScheduledTask(host, "s-1")?.last_status, "ok");
  // now fail through the threshold
  let disabled = false;
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
    disabled = recordScheduledRunResult(host, { id: "s-1", taskId: `t-f${i}`, ok: false, nowIso: NOW }).disabled;
  }
  assert.equal(disabled, true);
  const row = readScheduledTask(host, "s-1");
  assert.equal(row?.enabled, 0);
  assert.match(row?.last_status ?? "", /auto-disabled/);
});
