/**
 *  —  lifecycle consensus rewrite tests.
 *
 * Covers ADR v2 §2–§3: four-layer model (lifecycle, runtime health,
 * policy flags, origin), stale triggers, and stale recovery.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveAgentLifecycle,
  type LifecycleTaskEvidence,
} from "./agentLifecycleView";

const NOW = new Date("2026-05-26T12:00:00.000Z");
const PROFILE_UPDATED = "2026-05-26T10:00:00.000Z";

function profile(
  status: "initialized" | "archived" | "deleted_marker",
  overrides: Partial<ReturnType<typeof profile>> = {},
) {
  return {
    id: "agent-test",
    status,
    origin: "user_created" as const,
    parent_agent_id: null as string | null,
    parent_task_id: null as string | null,
    accepts_tasks: true,
    retention_policy: "durable" as const,
    updated_at: PROFILE_UPDATED,
    ...overrides,
  };
}

function task(
  task_id: string,
  status: LifecycleTaskEvidence["status"],
  opts: Partial<LifecycleTaskEvidence> = {},
): LifecycleTaskEvidence {
  return {
    task_id,
    status,
    received_at: opts.received_at ?? "2026-05-26T11:00:00.000Z",
    last_event_at: opts.last_event_at ?? opts.received_at ?? "2026-05-26T11:00:00.000Z",
    summary: opts.summary ?? null,
    error: opts.error ?? null,
  };
}

// ── Layer 1: persisted lifecycle pass-through ──────────────────────

describe("resolveAgentLifecycle — archived / deleted_marker", () => {
  it("archived → derived=null, policy flags still pass through", () => {
    const v = resolveAgentLifecycle({
      profile: profile("archived", { accepts_tasks: false }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.persisted, "archived");
    assert.equal(v.derived, null);
    assert.equal(v.reason, null);
    assert.equal(v.current_task_id, null);
    assert.equal(v.accepts_tasks, false);
    assert.equal(v.origin, "user_created");
  });

  it("deleted_marker → derived=null", () => {
    const v = resolveAgentLifecycle({
      profile: profile("deleted_marker"),
      tasks: [task("t-1", "in_progress")],
      now: NOW,
    });
    assert.equal(v.persisted, "deleted_marker");
    assert.equal(v.derived, null);
  });

  it("archived agent last_activity_at still surfaces", () => {
    const v = resolveAgentLifecycle({
      profile: profile("archived"),
      tasks: [task("t-1", "replied", { last_event_at: "2026-05-26T11:30:00.000Z" })],
      now: NOW,
    });
    assert.equal(v.last_activity_at, "2026-05-26T11:30:00.000Z");
  });
});

// ── Layer 2: runtime health derivation ─────────────────────────────

describe("resolveAgentLifecycle — initialized → healthy", () => {
  it("initialized + no tasks + no stale signals → healthy", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.derived, "healthy");
    assert.equal(v.reason, null);
    assert.equal(v.current_task_id, null);
  });

  it("initialized + only replied tasks → healthy", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "replied"), task("t-2", "failed")],
      now: NOW,
    });
    assert.equal(v.derived, "healthy");
    assert.equal(v.current_task_id, null);
  });
});

describe("resolveAgentLifecycle — initialized → running", () => {
  it("initialized + received task → running", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "received", { summary: "processing inbound" })],
      now: NOW,
    });
    assert.equal(v.derived, "running");
    assert.equal(v.current_task_id, "t-1");
    assert.equal(v.current_activity_summary, "processing inbound");
  });

  it("initialized + in_progress task → running", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "in_progress")],
      now: NOW,
    });
    assert.equal(v.derived, "running");
    assert.equal(v.current_task_id, "t-1");
  });

  it("initialized + waiting task → running", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "waiting")],
      now: NOW,
    });
    assert.equal(v.derived, "running");
    assert.equal(v.current_task_id, "t-1");
  });

  it("running beats stale — overdue task still shows running not stale", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [
        task("t-overdue", "in_progress", {
          received_at: "2026-05-26T10:00:00.000Z",
          last_event_at: "2026-05-26T10:00:00.000Z",
        }),
      ],
      hasRecentPollFailure: true,
      now: NOW,
    });
    assert.equal(v.derived, "running");
    assert.ok(v.reason?.includes("task_overdue"));
  });

  it("running + waiting → running, latest wins", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [
        task("t-wait", "waiting", { received_at: "2026-05-26T11:00:00.000Z" }),
        task("t-work", "in_progress", { received_at: "2026-05-26T11:30:00.000Z" }),
      ],
      now: NOW,
    });
    assert.equal(v.derived, "running");
    assert.equal(v.current_task_id, "t-work");
  });
});

// ── Layer 2: stale signals ─────────────────────────────────────────

describe("resolveAgentLifecycle — stale signals", () => {
  it("task overdue >30min → stale (when no active task, e.g. hanging received)", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [
        task("t-old", "received", {
          received_at: "2026-05-26T10:00:00.000Z",
          last_event_at: "2026-05-26T10:00:00.000Z",
        }),
      ],
      now: NOW,
    });
    // Task is "received" (active), so derived=running with stale reason
    assert.equal(v.derived, "running");
    assert.ok(v.reason?.includes("task_overdue"));
  });

  it("no active tasks + poll failure → stale", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasRecentPollFailure: true,
      now: NOW,
    });
    assert.equal(v.derived, "stale");
    assert.ok(v.reason?.includes("poll_failure"));
  });

  it("config drift → stale", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasConfigDrift: true,
      now: NOW,
    });
    assert.equal(v.derived, "stale");
    assert.ok(v.reason?.includes("config_drift"));
  });

  it("expired approval → stale", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasExpiredApproval: true,
      now: NOW,
    });
    assert.equal(v.derived, "stale");
    assert.ok(v.reason?.includes("expired_approval"));
  });

  it("multiple stale signals combined", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasRecentPollFailure: true,
      hasConfigDrift: true,
      now: NOW,
    });
    assert.equal(v.derived, "stale");
    assert.ok(v.reason?.includes("poll_failure"));
    assert.ok(v.reason?.includes("config_drift"));
  });
});

// ── Layer 3: policy flags pass-through ──────────────────────────────

describe("resolveAgentLifecycle — policy flags", () => {
  it("accepts_tasks=false passes through for initialized agent", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized", { accepts_tasks: false }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.accepts_tasks, false);
    assert.equal(v.derived, "healthy");
  });

  it("retention_policy=task_scoped passes through", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized", { retention_policy: "task_scoped" }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.retention_policy, "task_scoped");
  });

  it("retention_policy=ephemeral passes through", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized", { retention_policy: "ephemeral" }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.retention_policy, "ephemeral");
  });
});

// ── Layer 4: origin + spawn linkage ─────────────────────────────────

describe("resolveAgentLifecycle — origin and spawn linkage", () => {
  it("user_created origin", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized", { origin: "user_created" }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.origin, "user_created");
    assert.equal(v.parent_agent_id, null);
    assert.equal(v.parent_task_id, null);
  });

  it("spawned origin with parent linkage", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized", {
        origin: "spawned",
        parent_agent_id: "parent-agent-1",
        parent_task_id: "task-42",
        retention_policy: "task_scoped",
      }),
      tasks: [],
      now: NOW,
    });
    assert.equal(v.origin, "spawned");
    assert.equal(v.parent_agent_id, "parent-agent-1");
    assert.equal(v.parent_task_id, "task-42");
    assert.equal(v.retention_policy, "task_scoped");
  });
});

// ── migrating annotation ────────────────────────────────────────────

describe("resolveAgentLifecycle — migrating", () => {
  it("always false in v1", () => {
    const v = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "in_progress")],
      now: NOW,
    });
    assert.equal(v.migrating, false);
  });
});

// ──  — back-compat defaults, recovery, invalid enum, dispatch_priority ──

describe("resolveAgentLifecycle — back-compat defaults ()", () => {
  it("profile missing lifecycle v2 fields → safe defaults", () => {
    // Simulate older caller / DB row that hasn't been upgraded to
    //  fields. Only `id/status/updated_at` are required.
    const v = resolveAgentLifecycle({
      profile: {
        id: "agent-old",
        status: "initialized",
        updated_at: PROFILE_UPDATED,
      },
      tasks: [],
      now: NOW,
    });
    assert.equal(v.origin, "user_created");
    assert.equal(v.accepts_tasks, true);
    assert.equal(v.retention_policy, "durable");
    assert.equal(v.parent_agent_id, null);
    assert.equal(v.parent_task_id, null);
    assert.equal(v.derived, "healthy");
  });
});

describe("resolveAgentLifecycle — stale recovery ()", () => {
  it("stale → healthy on next clean resolve (signals dropped)", () => {
    // 1st pass: poll failure + drift → stale
    const stale = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasRecentPollFailure: true,
      hasConfigDrift: true,
      now: NOW,
    });
    assert.equal(stale.derived, "stale");
    assert.ok(stale.reason);

    // 2nd pass: ADR §2.2 "stale recovery: automatic on next successful
    // poll/snapshot or task completion." The caller drops the boolean
    // and resolver returns healthy with reason=null on the very next
    // resolve — no extra recovery step required.
    const recovered = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [],
      hasRecentPollFailure: false,
      hasConfigDrift: false,
      now: NOW,
    });
    assert.equal(recovered.derived, "healthy");
    assert.equal(recovered.reason, null);
  });

  it("running → healthy when task completes (active task evidence drops)", () => {
    const running = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "in_progress")],
      now: NOW,
    });
    assert.equal(running.derived, "running");

    const done = resolveAgentLifecycle({
      profile: profile("initialized"),
      tasks: [task("t-1", "replied")],
      now: NOW,
    });
    assert.equal(done.derived, "healthy");
    assert.equal(done.current_task_id, null);
  });
});

describe("resolveAgentLifecycle — invalid persisted enum ()", () => {
  it("unknown persisted status falls through the non-initialized branch with derived=null", () => {
    // Defensive: if some upstream path leaked a non-canonical status
    // value (e.g. mid-migration row that escaped `rowToProfile`'s
    // normaliser — see `src/agent/agentProfileOps.ts`), the resolver
    // must NOT report `derived: "healthy"`. The contract is "only
    // `initialized` gets a derived health"; any other value → null.
    const v = resolveAgentLifecycle({
      profile: {
        id: "agent-weird",
        status: "garbage" as "initialized" | "archived" | "deleted_marker",
        updated_at: PROFILE_UPDATED,
      },
      tasks: [task("t-1", "in_progress")],
      now: NOW,
    });
    assert.equal(v.derived, null);
    assert.equal(v.current_task_id, null);
  });
});

describe("resolveAgentLifecycle — dispatch_priority ()", () => {
  it("hardcoded to 0 in v1 regardless of inputs", () => {
    // ADR §2.3 lists dispatch_priority as a policy flag but v1 does
    // not yet thread it through the resolver inputs. Pin the value
    // here so a future card that wires the input through can't
    // silently regress to a default that doesn't match the schema.
    const v = resolveAgentLifecycle({
      profile: profile("initialized", { accepts_tasks: false }),
      tasks: [task("t-1", "in_progress")],
      hasConfigDrift: true,
      now: NOW,
    });
    assert.equal(v.dispatch_priority, 0);
  });
});
