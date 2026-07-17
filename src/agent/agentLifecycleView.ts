/**
 * M9.0 agent lifecycle consensus rewrite v2.
 *
 * Four-layer resolver that turns
 *
 *   { profile + per-agent manager-task evidence }
 *
 * into the lifecycle view consumed by dashboard, /agents, /api/inspect,
 * and workspace. Replaces an earlier revision's nine-state model.
 *
 * Layers (ADR §2):
 *   1. Lifecycle (persisted)     — initialized | archived | deleted_marker
 *   2. Runtime health (derived)  — healthy | running | stale
 *   3. Dispatch policy           — accepts_tasks, dispatch_priority, retention_policy
 *   4. Origin                    — user_created | spawned
 *
 * Aggregation rules (ADR §3.3):
 *   - Any task in `received` / `in_progress` / `waiting` → `running`
 *   - Otherwise, if stale signals present → `stale`
 *   - Otherwise → `healthy`
 *
 * Stale triggers (ADR §2.2):
 *   - Active task over expected window without terminal event
 *   - Consecutive poll/RPC failures
 *   - Model/skillset/runtime config drift (no post-change success yet)
 *   - Approval token expired with pending record still open
 *
 * stale recovery: automatic on next successful poll or task completion.
 */

import type {
  DerivedManagerTaskStatus,
  ManagerTaskStatus,
} from "./managerTaskStatus";

export type AgentLifecyclePersisted = "initialized" | "archived" | "deleted_marker";
export type AgentLifecycleDerived = "healthy" | "running" | "stale" | null;
export type AgentOrigin = "user_created" | "spawned";
export type RetentionPolicy = "durable" | "task_scoped" | "ephemeral";

export interface LifecycleTaskEvidence {
  task_id: string;
  status: ManagerTaskStatus;
  received_at: string | null;
  last_event_at: string | null;
  summary: string | null;
  error: DerivedManagerTaskStatus["error"];
}

export interface ResolveAgentLifecycleInput {
  profile: {
    id: string;
    status: AgentLifecyclePersisted;
    // New fields from an earlier revision; optional with defaults for back-compat
    // with callers that haven't been updated to the four-layer model yet.
    origin?: AgentOrigin;
    parent_agent_id?: string | null;
    parent_task_id?: string | null;
    accepts_tasks?: boolean;
    retention_policy?: RetentionPolicy;
    updated_at: string;
  };
  tasks: LifecycleTaskEvidence[];
  /** Whether the agent has been unreachable (poll/RPC failure streak). */
  hasRecentPollFailure?: boolean;
  /** Whether model/skillset/runtime config has drifted without a post-change success. */
  hasConfigDrift?: boolean;
  /** Whether a pending approval token has expired. */
  hasExpiredApproval?: boolean;
  now: Date;
}

export interface AgentLifecycleView {
  /** Persisted lifecycle state. */
  persisted: AgentLifecyclePersisted;
  /** Derived runtime health. null when persisted ≠ initialized. */
  derived: AgentLifecycleDerived;
  /** Human-readable reason for `stale` state. */
  reason: string | null;
  /** Current active task id, if running. */
  current_task_id: string | null;
  /** Current task summary (first 80 chars of objective/title). */
  current_activity_summary: string | null;
  /** ISO timestamp of last observable activity. */
  last_activity_at: string | null;

  // Policy flags (pass-through from profile).
  accepts_tasks: boolean;
  dispatch_priority: number;
  retention_policy: RetentionPolicy;
  origin: AgentOrigin;

  // Spawn linkage.
  parent_agent_id: string | null;
  parent_task_id: string | null;

  /** M9.0 v1: always false. Reserved for future migration plane. */
  migrating: boolean;
}

function pickLatest<T extends LifecycleTaskEvidence>(items: T[]): T | null {
  if (items.length === 0) return null;
  let best = items[0];
  let bestKey = best.received_at ?? best.last_event_at ?? "";
  for (let i = 1; i < items.length; i += 1) {
    const t = items[i];
    const key = t.received_at ?? t.last_event_at ?? "";
    if (key > bestKey) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

function maxIsoOrNull(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * central stale thresholds shared with
 * `docs/adr/2026-05-26-agent-lifecycle-product-contract.md` §2.2.
 *
 * - `STALE_TASK_WINDOW_MS`: an active task in `received`/`in_progress`/
 *   `waiting` longer than this window without a terminal event flags
 *   the agent as stale (reason `task_overdue`).
 * - `STALE_POLL_FAILURE_THRESHOLD`: callers (inspect / workspace
 *   pollers) must observe at least this many consecutive poll/RPC
 *   failures before passing `hasRecentPollFailure=true`. The resolver
 *   only sees the boolean; the threshold lives here so the ADR and
 *   every caller agree on the same N.
 */
export const STALE_TASK_WINDOW_MS = 30 * 60 * 1000;
export const STALE_POLL_FAILURE_THRESHOLD = 3;

function buildBase(
  profile: ResolveAgentLifecycleInput["profile"],
  tasks: LifecycleTaskEvidence[],
): Pick<
  AgentLifecycleView,
  | "persisted"
  | "accepts_tasks"
  | "dispatch_priority"
  | "retention_policy"
  | "origin"
  | "parent_agent_id"
  | "parent_task_id"
  | "migrating"
  | "last_activity_at"
> {
  let lastActivityAt: string | null = profile.updated_at;
  for (const t of tasks) {
    lastActivityAt = maxIsoOrNull(lastActivityAt, t.last_event_at);
  }

  // Back-compat defaults: old DB rows don't have new an earlier revision columns.
  const origin = profile.origin ?? "user_created";
  const accepts_tasks = profile.accepts_tasks ?? true;
  const retention_policy = profile.retention_policy ?? "durable";

  return {
    persisted: profile.status,
    accepts_tasks,
    dispatch_priority: 0,
    retention_policy,
    origin,
    parent_agent_id: profile.parent_agent_id ?? null,
    parent_task_id: profile.parent_task_id ?? null,
    migrating: false,
    last_activity_at: lastActivityAt,
  };
}

export function resolveAgentLifecycle(
  input: ResolveAgentLifecycleInput,
): AgentLifecycleView {
  const { profile, tasks } = input;
  const base = buildBase(profile, tasks);

  // Non-initialized agents have no derived state.
  if (profile.status !== "initialized") {
    return {
      ...base,
      derived: null,
      reason: null,
      current_task_id: null,
      current_activity_summary: null,
    };
  }

  // Priority: running beats everything
  const activeTasks = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "received" || t.status === "waiting",
  );
  if (activeTasks.length > 0) {
    const pick = pickLatest(activeTasks);
    const staleReason = detectStale(activeTasks, input);
    return {
      ...base,
      derived: "running",
      reason: staleReason,
      current_task_id: pick?.task_id ?? null,
      current_activity_summary: pick?.summary ?? null,
    };
  }

  // Check stale signals
  const staleReason = detectStale([], input);
  if (staleReason !== null) {
    return {
      ...base,
      derived: "stale",
      reason: staleReason,
      current_task_id: null,
      current_activity_summary: null,
    };
  }

  // Default: healthy
  return {
    ...base,
    derived: "healthy",
    reason: null,
    current_task_id: null,
    current_activity_summary: null,
  };
}

function detectStale(
  activeTasks: LifecycleTaskEvidence[],
  input: ResolveAgentLifecycleInput,
): string | null {
  const reasons: string[] = [];

  // 1. Active task overdue: received/started > STALE_TASK_WINDOW_MS without terminal
  for (const t of activeTasks) {
    if (t.status === "received" || t.status === "in_progress" || t.status === "waiting") {
      const startedAt = t.last_event_at ?? t.received_at;
      if (startedAt) {
        const elapsed = input.now.getTime() - new Date(startedAt).getTime();
        if (elapsed > STALE_TASK_WINDOW_MS) {
          reasons.push("task_overdue");
        }
      }
    }
  }

  // 2. Poll failure streak
  if (input.hasRecentPollFailure) {
    reasons.push("poll_failure");
  }

  // 3. Config drift (model/skillset changed, no post-change success)
  if (input.hasConfigDrift) {
    reasons.push("config_drift");
  }

  // 4. Expired approval with pending record
  if (input.hasExpiredApproval) {
    reasons.push("expired_approval");
  }

  if (reasons.length === 0) return null;
  return reasons.join(",");
}
