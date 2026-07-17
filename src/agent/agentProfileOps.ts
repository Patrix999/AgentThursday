/**
 * AgentProfile storage helpers.
 *
 * Pure helpers (no `this`, no `env`, no `ctx`) backing the three
 * AgentProfile create/list/read @callable methods on `AgentThursdayAgent`.
 * Storage substrate: D1 SQLite on the DEMO_INSTANCE registry DO
 * (AgentProfile is global config, not per-context — must survive
 * context resets and be visible to every channel/context that
 * spawns a per-context DO).
 *
 * Shape contract: `AgentProfile` as defined in
 * `docs/design/2026-05-22-card339-m9.0-agent-creation-ui-scope.md` §4.
 *
 * Validation policy: business rules (name length, model whitelist,
 * skillset registry membership, persona cap, status enum) are
 * enforced at the route boundary via Zod / closed-list checks
 * before reaching these helpers. Helpers handle the UNIQUE(name)
 * constraint by catching the SQL error and returning a
 * discriminant — the route layer maps that to HTTP 409.
 */
import type { AgentProfile } from "../schema";
import { type RequestIdentity, ownerUserIdFor, ADMIN_USER_ID } from "./requestIdentity";
import { DEMO_INSTANCE, OPERATOR_INSTANCE } from "../demoConstants";

/**
 * multi-tenancy enforcement. Every read/write helper takes a
 * `RequestIdentity` (default admin, so internal/system callers that omit it
 * keep full access). A scoped user only ever sees/touches rows whose
 * `owner_user_id` matches; admin is unfiltered. The DDL backfills existing
 * rows to ADMIN_USER_ID, so admin == the current operator's whole estate.
 */
const ADMIN: RequestIdentity = { kind: "admin" };

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
  // set when an AGENT (not a user) creates this profile: the
  // creator's agent id. Drives origin='spawned' + the drawer lineage tree.
  parentAgentId?: string | null;
  // retention: agent-spawned profiles default task_scoped (the
  // lifecycle sweep may auto-archive them when idle); user-created durable.
  retentionPolicy?: "durable" | "task_scoped" | "ephemeral";
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
  owner_user_id?: string;
  created_at: string;
  updated_at: string;
};

/**
 * enum-value defense for `rowToProfile`.
 *
 * an earlier revision added new policy/origin columns and changed the status enum
 * from `draft|ready|disabled|archived` to `initialized|archived|deleted_marker`.
 * DB rows can be in any of three states:
 *   - **v1 row** (current): old columns only (`status`, no new cols). Status
 *     is already on the new enum because writers were upgraded together with
 *     the schema in an earlier revision. Missing columns → safe defaults.
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
  // new columns may not exist in old DB rows; default
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
    // owner from the 426a column; absent (old row / a SELECT that
    // didn't pull the column) defaults to the admin sentinel, so the getModel
    // hot path fail-softs to the admin/legacy credential store.
    owner_user_id: typeof raw.owner_user_id === "string" ? raw.owner_user_id : ADMIN_USER_ID,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createAgentProfile(
  host: AgentProfileHost,
  input: CreateAgentProfileInput,
  identity: RequestIdentity = ADMIN,
): CreateAgentProfileResult {
  const ownerUserId = ownerUserIdFor(identity);
  // 2026-06-22 — name is unique PER OWNER (the global UNIQUE(name) was dropped;
  // see migrations.ts). Both admin and scoped users pre-check only against
  // their OWN names: each tenant can hold its own default "Agent Thursday",
  // and the error can't reveal another tenant's agent names. This synchronous
  // pre-check IS the uniqueness guard — the single registry DO runs
  // createAgentProfile with no await between this check and the INSERT, so
  // there is no interleaving race to lose. The INSERT try/catch below stays as
  // a defensive fallback (e.g. an unexpected id PK collision).
  // an earlier revision Phase 0 — the hidden operator row must not occupy the admin's
  // name namespace: it is excluded from every list, so a conflict against it
  // would 409 with no visible cause. the row is keyed
  // OPERATOR_INSTANCE after the re-key.
  const existing = host.sql<{ id: string }>`
    SELECT id FROM agent_profile
    WHERE name = ${input.name} AND owner_user_id = ${ownerUserId}
      AND id != ${OPERATOR_INSTANCE} LIMIT 1
  `;
  if (existing.length > 0) {
    return { ok: false, error: { code: "name_conflict", message: `agent name already exists: ${input.name}` } };
  }
  const retention = input.retentionPolicy ?? (input.parentAgentId ? "task_scoped" : "durable");
  try {
    host.sql`
      INSERT INTO agent_profile
        (id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at,
         origin, parent_agent_id, retention_policy)
      VALUES
        (${input.id}, ${input.name}, ${input.model}, ${input.channel},
         ${input.skillset}, ${input.persona}, ${input.status}, ${ownerUserId},
         ${input.createdAt}, ${input.updatedAt},
         ${input.parentAgentId ? "spawned" : "user_created"}, ${input.parentAgentId ?? null}, ${retention})
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
      origin: (input.parentAgentId ? "spawned" : "user_created") as AgentProfile["origin"],
      parent_agent_id: input.parentAgentId ?? null,
      retention_policy: retention as AgentProfile["retention_policy"],
      parent_task_id: null,
      accepts_tasks: true,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    },
  };
}

export type ListAgentProfilesOptions = {
  /** Include `status = 'archived'` rows. Default false. */
  includeArchived?: boolean;
};

// v1 SELECT does NOT yet pull lifecycle v2 columns
// (`origin`, `parent_agent_id`, `parent_task_id`, `accepts_tasks`,
// `retention_policy`). The columns aren't persisted by `createAgentProfile`
// either, so `rowToProfile` falls through to back-compat defaults for
// every read. When a future card adds the columns + a backfill,
// **update the SELECT statement below and `updateAgentProfile`'s SET
// list**, otherwise reads/writes will silently drop the new fields.
//
// the visibility filter applies on the normalised
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
  identity: RequestIdentity = ADMIN,
): AgentProfile[] {
  // a scoped user only ever sees their own rows; admin sees all.
  // an earlier revision Phase 0 — the operator's OWN profile row (seeded by
  // `seedOperatorAgentProfile`) is infra, not roster: excluded from EVERY list
  // (admin, scoped, includeArchived alike) so the list output is identical to
  // the pre-seed era, when no such row existed. `readAgentProfile(id)` still
  // returns it — only enumeration hides it. keyed
  // OPERATOR_INSTANCE after the re-key (D1: operator stays hidden).
  const rows =
    identity.kind === "admin"
      ? host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE id != ${OPERATOR_INSTANCE}
          ORDER BY created_at DESC
        `
      : host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE owner_user_id = ${identity.userId} AND id != ${OPERATOR_INSTANCE}
          ORDER BY created_at DESC
        `;
  const profiles = rows.map(rowToProfile);
  if (opts.includeArchived) return profiles;
  return profiles.filter(
    p => p.status !== "archived" && p.status !== "deleted_marker",
  );
}

export function readAgentProfile(
  host: AgentProfileHost,
  id: string,
  identity: RequestIdentity = ADMIN,
): AgentProfile | null {
  // a scoped user can only read their own agent; a cross-tenant
  // id returns null (indistinguishable from "does not exist" — no existence
  // leak). Admin reads any.
  const rows =
    identity.kind === "admin"
      ? host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE id = ${id}
          LIMIT 1
        `
      : host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE id = ${id} AND owner_user_id = ${identity.userId}
          LIMIT 1
        `;
  if (rows.length === 0) return null;
  return rowToProfile(rows[0]);
}

// an earlier revision Phase 0 — A1 registry/operator split, additive step. Seed the
// operator's OWN agent_profile row (owner = admin) so the resolvers can
// resolve the operator's soul/owner/identity FROM ITS PROFILE like any other
// agent. the row is keyed OPERATOR_INSTANCE (the operator's own
// DO); a pre-451c row still keyed DEMO_INSTANCE is RE-KEYED in place (one
// UPDATE, every other column preserved) instead of inserting a duplicate.
export const OPERATOR_PROFILE_NAME = "operator";

export type SeedOperatorProfileResult =
  | { seeded: true; rekeyed?: boolean }
  | { seeded: false; reason: "exists" | "name_conflict" };

export function seedOperatorAgentProfile(
  host: AgentProfileHost,
  nowIso: string,
): SeedOperatorProfileResult {
  const existing = host.sql<{ id: string }>`
    SELECT id FROM agent_profile WHERE id = ${OPERATOR_INSTANCE} LIMIT 1
  `;
  if (existing.length > 0) return { seeded: false, reason: "exists" };
  // re-key the Phase-0 row (id = DEMO_INSTANCE) to the operator's
  // own DO id. Runs at most once: afterwards the check above short-circuits.
  const legacy = host.sql<{ id: string }>`
    SELECT id FROM agent_profile WHERE id = ${DEMO_INSTANCE} LIMIT 1
  `;
  if (legacy.length > 0) {
    host.sql`
      UPDATE agent_profile
      SET id = ${OPERATOR_INSTANCE}, updated_at = ${nowIso}
      WHERE id = ${DEMO_INSTANCE}
    `;
    return { seeded: true, rekeyed: true };
  }
  // Per-owner name uniqueness lives in createAgentProfile's pre-check, not
  // the DB — honor the same invariant here rather than inserting a duplicate
  // "operator" under the admin owner.
  const nameConflict = host.sql<{ id: string }>`
    SELECT id FROM agent_profile
    WHERE name = ${OPERATOR_PROFILE_NAME} AND owner_user_id = ${ADMIN_USER_ID}
    LIMIT 1
  `;
  if (nameConflict.length > 0) return { seeded: false, reason: "name_conflict" };
  // model "kimi-k2.6" mirrors what the operator DO actually runs (the
  // workers-ai default `getModel()` falls to when no profile target loads);
  // channel/skillset/persona empty — nothing consumes them for an operator
  // surface (`composePersonaContext` skips it before reading).
  host.sql`
    INSERT INTO agent_profile
      (id, name, model, channel, skillset, persona, status, owner_user_id, created_at, updated_at)
    VALUES
      (${OPERATOR_INSTANCE}, ${OPERATOR_PROFILE_NAME}, ${"kimi-k2.6"}, ${""},
       ${""}, ${""}, ${"initialized"}, ${ADMIN_USER_ID}, ${nowIso}, ${nowIso})
  `;
  return { seeded: true };
}

// PATCH /api/manager/agents/:agent_id backing helper.
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
  identity: RequestIdentity = ADMIN,
): UpdateAgentProfileResult {
  // ownership is enforced by scoping the existence SELECT: a
  // scoped user updating someone else's (or a non-existent) agent gets the
  // same `not_found` (no existence leak). The later UPDATE's `WHERE id = ?`
  // is safe because we've already confirmed this identity owns that id.
  const existing =
    identity.kind === "admin"
      ? host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, created_at, updated_at, owner_user_id, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE id = ${input.id}
          LIMIT 1
        `
      : host.sql<AgentProfileRow>`
          SELECT id, name, model, channel, skillset, persona, status, created_at, updated_at, owner_user_id, origin, parent_agent_id, retention_policy
          FROM agent_profile
          WHERE id = ${input.id} AND owner_user_id = ${identity.userId}
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
    // 2026-06-22 — per-owner name uniqueness: a rename conflicts only with the
    // SAME owner's other agents (admin included; the global UNIQUE was dropped,
    // see migrations.ts).
    const ownerUserId = ownerUserIdFor(identity);
    // an earlier revision Phase 0 — same hidden-row exclusion as createAgentProfile's
    // pre-check (owner clause first, id-exclusions after, for both queries).
    const conflict = host.sql<{ id: string }>`
      SELECT id FROM agent_profile
      WHERE name = ${input.name} AND owner_user_id = ${ownerUserId}
        AND id != ${input.id} AND id != ${OPERATOR_INSTANCE} LIMIT 1
    `;
    if (conflict.length > 0) {
      return {
        ok: false,
        error: { code: "name_conflict", message: `agent name already exists: ${input.name}` },
      };
    }
  }

  // spread `row` so EVERY selected column (incl. origin /
  // parent_agent_id / owner_user_id from the existence SELECT) survives into
  // the returned profile; a hand-listed subset silently stripped lineage (M1).
  const next = {
    ...row,
    name: input.name ?? row.name,
    model: input.model ?? row.model,
    skillset: input.skillset ?? row.skillset,
    persona: input.persona ?? row.persona,
    status: input.status ?? row.status,
    updated_at: input.updatedAt,
  } as AgentProfileRow;

  try {
    // v1 UPDATE does NOT mutate lifecycle v2 columns
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

// ── spawned-agent lifecycle sweep ────────────────────────────
// Auto-archive spawned agents that are done being useful: task_scoped (the
// default for agent-spawned since an earlier revision) and idle past the cutoff. Never
// deletes — archive only (history preserved; drawer/roster hide archived).
// `includeLegacy` extends the sweep to pre-472 spawned agents (stamped
// durable because the column didn't exist) — an explicit opt-in per run.
export interface SweepCandidate {
  id: string;
  name: string;
  updated_at: string;
  retention_policy: string;
}

export function sweepSpawnedAgentRows(
  host: AgentProfileHost,
  opts: { cutoffIso: string; includeLegacy?: boolean; dryRun?: boolean; nowIso: string; excludeIds?: string[] },
): { archived: SweepCandidate[]; dryRun: boolean } {
  const legacy = opts.includeLegacy === true;
  const excluded = new Set(opts.excludeIds ?? []);
  const rows = legacy
    ? host.sql<SweepCandidate>`
        SELECT id, name, updated_at, retention_policy FROM agent_profile
        WHERE origin = 'spawned' AND status = 'initialized'
          AND retention_policy IN ('task_scoped', 'ephemeral', 'durable')
          AND updated_at < ${opts.cutoffIso}
        ORDER BY updated_at ASC LIMIT 200
      `
    : host.sql<SweepCandidate>`
        SELECT id, name, updated_at, retention_policy FROM agent_profile
        WHERE origin = 'spawned' AND status = 'initialized'
          AND retention_policy IN ('task_scoped', 'ephemeral')
          AND updated_at < ${opts.cutoffIso}
        ORDER BY updated_at ASC LIMIT 200
      `;
  // functional agents (e.g. a share_file utility misclassified spawned by a
  // manual backfill) are protected per-run via excludeIds.
  const rowsKept = rows.filter((r) => !excluded.has(r.id));
  if (opts.dryRun !== true) {
    for (const r of rowsKept) {
      host.sql`UPDATE agent_profile SET status = 'archived', updated_at = ${opts.nowIso} WHERE id = ${r.id}`;
    }
  }
  return { archived: rowsKept, dryRun: opts.dryRun === true };
}
