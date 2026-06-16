/**
 *  —  AgentProfile storage helpers.
 *
 * Pure helpers (no `this`, no `env`, no `ctx`) backing the three
 * AgentProfile create/list/read @callable methods on `AgentThursdayAgent`.
 * Storage substrate: D1 SQLite on the DEMO_INSTANCE registry DO
 * (AgentProfile is global config, not per-context — must survive
 * context resets and be visible to every channel/context that
 * spawns a per-context DO).
 *
 * Shape contract: `AgentProfile` as defined in
 * `` §4.
 *
 * Validation policy: business rules (name length, model whitelist,
 * skillset registry membership, persona cap, status enum) are
 * enforced at the route boundary via Zod / closed-list checks
 * before reaching these helpers. Helpers handle the UNIQUE(name)
 * constraint by catching the SQL error and returning a
 * discriminant — the route layer maps that to HTTP 409.
 */
import type { AgentProfile } from "../schema";

export type AgentProfileSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface AgentProfileHost {
  sql: AgentProfileSqlTag;
}

export type CreateAgentProfileInput = {
  id: string;
  name: string;
  model: string;
  channel: string;
  skillset: string;
  persona: string;
  status: "initialized" | "archived" | "deleted_marker";
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentProfileResult =
  | { ok: true; profile: AgentProfile }
  | { ok: false; error: { code: "name_conflict" | "internal"; message: string } };

type AgentProfileRow = {
  id: string;
  name: string;
  model: string;
  channel: string;
  skillset: string;
  persona: string;
  status: string;
  created_at: string;
  updated_at: string;
};

/**
 *  — enum-value defense for `rowToProfile`.
 *
 *  added new policy/origin columns and changed the status enum
 * from `draft|ready|disabled|archived` to `initialized|archived|deleted_marker`.
 * DB rows can be in any of three states:
 *   - **v1 row** (current): old columns only (`status`, no new cols). Status
 *     is already on the new enum because writers were upgraded together with
 *     the schema in . Missing columns → safe defaults.
 *   - **legacy row** (pre-migration, if any): old status enum value
 *     (`draft|ready|disabled`). Mapped per ADR §6.3 to new enum +
 *     `accepts_tasks` value. `ready` and `archived` round-trip cleanly;
 *     `draft`/`disabled` map to `initialized` with `accepts_tasks=false`.
 *   - **garbage row** (data corruption / hand-edit): status not in any
 *     known enum, or origin/retention_policy not a valid string value.
 *     Garbage status falls back to `archived` (conservative — hides the
 *     row from the default `/agents` list rather than presenting it as
 *     Active and risking dispatch). Garbage origin → `user_created`;
 *     garbage retention_policy → `durable` (both also conservative).
 */
const LEGACY_STATUS_TO_NEW: Record<
  string,
  { status: AgentProfile["status"]; accepts_tasks: boolean }
> = {
  draft: { status: "initialized", accepts_tasks: false },
  ready: { status: "initialized", accepts_tasks: true },
  disabled: { status: "initialized", accepts_tasks: false },
};

const VALID_STATUS = new Set<AgentProfile["status"]>([
  "initialized",
  "archived",
  "deleted_marker",
]);
const VALID_ORIGIN = new Set<AgentProfile["origin"]>([
  "user_created",
  "spawned",
]);
const VALID_RETENTION = new Set<AgentProfile["retention_policy"]>([
  "durable",
  "task_scoped",
  "ephemeral",
]);

function normalizeStatus(
  rawStatus: string,
  rawAcceptsTasks: unknown,
): { status: AgentProfile["status"]; accepts_tasks: boolean } {
  if (VALID_STATUS.has(rawStatus as AgentProfile["status"])) {
    const acceptsTasks =
      typeof rawAcceptsTasks === "number" ? rawAcceptsTasks !== 0 : true;
    return { status: rawStatus as AgentProfile["status"], accepts_tasks: acceptsTasks };
  }
  const legacy = LEGACY_STATUS_TO_NEW[rawStatus];
  if (legacy) return legacy;
  // Unknown garbage — fail closed to `archived` so the row drops out of
  // the default list and cannot be dispatched.
  return { status: "archived", accepts_tasks: false };
}

function normalizeOrigin(raw: unknown): AgentProfile["origin"] {
  if (typeof raw === "string" && VALID_ORIGIN.has(raw as AgentProfile["origin"])) {
    return raw as AgentProfile["origin"];
  }
  return "user_created";
}

function normalizeRetention(raw: unknown): AgentProfile["retention_policy"] {
  if (
    typeof raw === "string" &&
    VALID_RETENTION.has(raw as AgentProfile["retention_policy"])
  ) {
    return raw as AgentProfile["retention_policy"];
  }
  return "durable";
}

function rowToProfile(r: AgentProfileRow): AgentProfile {
  // /368f — new columns may not exist in old DB rows; default
  // safely. Status / origin / retention_policy go through enum-value
  // validators so unknown strings can't smuggle past the `as` cast.
  const raw = r as Record<string, unknown>;
  const { status, accepts_tasks } = normalizeStatus(r.status, raw.accepts_tasks);
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    channel: r.channel,
    skillset: r.skillset,
    persona: r.persona,
    status,
    origin: normalizeOrigin(raw.origin),
    parent_agent_id: typeof raw.parent_agent_id === "string" ? raw.parent_agent_id : null,
    parent_task_id: typeof raw.parent_task_id === "string" ? raw.parent_task_id : null,
    accepts_tasks,
    retention_policy: normalizeRetention(raw.retention_policy),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createAgentProfile(
  host: AgentProfileHost,
  input: CreateAgentProfileInput,
): CreateAgentProfileResult {
  // Pre-check by name keeps the conflict path cheap; the INSERT is
  // also guarded by UNIQUE(name), so a race between pre-check and
  // INSERT still surfaces as a SQL error caught below.
  const existing = host.sql<{ id: string }>`
    SELECT id FROM agent_profile WHERE name = ${input.name} LIMIT 1
  `;
  if (existing.length > 0) {
    return { ok: false, error: { code: "name_conflict", message: `agent name already exists: ${input.name}` } };
  }
  try {
    host.sql`
      INSERT INTO agent_profile
        (id, name, model, channel, skillset, persona, status, created_at, updated_at)
      VALUES
        (${input.id}, ${input.name}, ${input.model}, ${input.channel},
         ${input.skillset}, ${input.persona}, ${input.status},
         ${input.createdAt}, ${input.updatedAt})
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) {
      return { ok: false, error: { code: "name_conflict", message: `agent name already exists: ${input.name}` } };
    }
    return { ok: false, error: { code: "internal", message: msg } };
  }
  return {
    ok: true,
    profile: {
      id: input.id,
      name: input.name,
      model: input.model,
      channel: input.channel,
      skillset: input.skillset,
      persona: input.persona,
      status: input.status,
      origin: "user_created" as const,
      parent_agent_id: null,
      parent_task_id: null,
      accepts_tasks: true,
      retention_policy: "durable" as const,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    },
  };
}

export type ListAgentProfilesOptions = {
  /** Include `status = 'archived'` rows. Default false. */
  includeArchived?: boolean;
};

//  — v1 SELECT does NOT yet pull lifecycle v2 columns
// (`origin`, `parent_agent_id`, `parent_task_id`, `accepts_tasks`,
// `retention_policy`). The columns aren't persisted by `createAgentProfile`
// either, so `rowToProfile` falls through to back-compat defaults for
// every read. When a future card adds the columns + a backfill,
// **update the SELECT statement below and `updateAgentProfile`'s SET
// list**, otherwise reads/writes will silently drop the new fields.
//
// /368g — the visibility filter applies on the normalised
// `AgentProfile.status` (after `rowToProfile`), not on the raw column
// value. Otherwise legacy/garbage rows that `rowToProfile` reclassifies
// would still slip into the default list.
//
// Default list = "active roster": excludes both `archived`
// (reversible soft-delete) AND `deleted_marker` (audit tombstone)
// per ADR §2.1. `includeArchived=true` is the inspect/admin escape
// hatch and returns both states for operator review.
export function listAgentProfiles(
  host: AgentProfileHost,
  opts: ListAgentProfilesOptions = {},
): AgentProfile[] {
  const rows = host.sql<AgentProfileRow>`
    SELECT id, name, model, channel, skillset, persona, status, created_at, updated_at
    FROM agent_profile
    ORDER BY created_at DESC
  `;
  const profiles = rows.map(rowToProfile);
  if (opts.includeArchived) return profiles;
  return profiles.filter(
    p => p.status !== "archived" && p.status !== "deleted_marker",
  );
}

export function readAgentProfile(host: AgentProfileHost, id: string): AgentProfile | null {
  const rows = host.sql<AgentProfileRow>`
    SELECT id, name, model, channel, skillset, persona, status, created_at, updated_at
    FROM agent_profile
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToProfile(rows[0]);
}

//  — PATCH /api/manager/agents/:agent_id backing helper.
// Partial update of an existing AgentProfile row. Validation of
// model whitelist / skillset registry / status enum / name length
// is the route layer's job (same as createAgentProfile); this
// helper only enforces row-existence + UNIQUE(name).
export type UpdateAgentProfileInput = {
  id: string;
  name?: string;
  model?: string;
  skillset?: string;
  persona?: string;
  status?: "initialized" | "archived" | "deleted_marker";
  updatedAt: string;
};

export type UpdateAgentProfileResult =
  | { ok: true; profile: AgentProfile }
  | {
      ok: false;
      error: {
        code: "not_found" | "name_conflict" | "no_changes" | "internal";
        message: string;
      };
    };

export function updateAgentProfile(
  host: AgentProfileHost,
  input: UpdateAgentProfileInput,
): UpdateAgentProfileResult {
  const existing = host.sql<AgentProfileRow>`
    SELECT id, name, model, channel, skillset, persona, status, created_at, updated_at
    FROM agent_profile
    WHERE id = ${input.id}
    LIMIT 1
  `;
  if (existing.length === 0) {
    return { ok: false, error: { code: "not_found", message: `agent not found: ${input.id}` } };
  }
  const row = existing[0];

  const fields: Array<"name" | "model" | "skillset" | "persona" | "status"> = [
    "name",
    "model",
    "skillset",
    "persona",
    "status",
  ];
  const changed = fields.some(f => input[f] !== undefined && input[f] !== row[f]);
  if (!changed) {
    return { ok: false, error: { code: "no_changes", message: "no fields changed" } };
  }

  if (input.name !== undefined && input.name !== row.name) {
    const conflict = host.sql<{ id: string }>`
      SELECT id FROM agent_profile WHERE name = ${input.name} AND id != ${input.id} LIMIT 1
    `;
    if (conflict.length > 0) {
      return {
        ok: false,
        error: { code: "name_conflict", message: `agent name already exists: ${input.name}` },
      };
    }
  }

  const next: AgentProfileRow = {
    id: row.id,
    name: input.name ?? row.name,
    model: input.model ?? row.model,
    channel: row.channel,
    skillset: input.skillset ?? row.skillset,
    persona: input.persona ?? row.persona,
    status: input.status ?? row.status,
    created_at: row.created_at,
    updated_at: input.updatedAt,
  };

  try {
    //  — v1 UPDATE does NOT mutate lifecycle v2 columns
    // (`accepts_tasks`, `retention_policy`, `origin`, `parent_*`).
    // The columns aren't created or backfilled today, so writes would
    // be no-ops at best and rejected by SQLite at worst. When the
    // backfill card lands, extend this SET list along with the SELECT
    // list in `listAgentProfiles` / `readAgentProfile`.
    host.sql`
      UPDATE agent_profile
      SET name = ${next.name},
          model = ${next.model},
          skillset = ${next.skillset},
          persona = ${next.persona},
          status = ${next.status},
          updated_at = ${next.updated_at}
      WHERE id = ${next.id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) {
      return {
        ok: false,
        error: { code: "name_conflict", message: `agent name already exists: ${next.name}` },
      };
    }
    return { ok: false, error: { code: "internal", message: msg } };
  }
  return { ok: true, profile: rowToProfile(next) };
}
