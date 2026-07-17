/**
 * BYO GitHub (2026-06-26) — per-user (BYO) content-source store, owner-scoped.
 *
 * Lives on the ContentHub DO (alongside `content_cache` / `audit_log`). Pure
 * sql-host module so the tenant-isolation routing is unit-testable with a real
 * node:sqlite host (server.ts / contentHub.ts import `cloudflare:workers` and
 * cannot be imported by a node test — every testable DO-SQL helper is extracted
 * for the same reason; see `providerCredentialOps.ts`).
 *
 * A row here is a `scope:"personal"` ContentSource: its `owner_user_id` is the
 * tenant-isolation key. `canAccessSource` requires caller-owner === this row's
 * owner, and the ContentHub token resolver reads ONLY this owner's github
 * credential (never env.GITHUB_TOKEN). `source_id` is the PRIMARY KEY (globally
 * unique — the id an agent names in `content_read`), so resolution stays keyed
 * by id alone (like the hardcoded registry) and the owner column is the gate.
 *
 * Unit 2 ships the table + read ops + a minimal insert (seedable in tests). The
 * registration ENDPOINT (which server-stamps `owner_user_id` + the unique
 * `source_id`, never from client input) + proxy + UI are Unit 3.
 */

/** Tagged-template sql, same shape as `ContentHubAgent`'s `this.sql`. */
export type UserContentSourceSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

export interface UserContentSourceHost {
  sql: UserContentSourceSqlTag;
}

export type UserContentSourceRow = {
  source_id: string;
  owner_user_id: string;
  provider: string;
  repo: string;
  default_ref: string | null;
  label: string | null;
  created_at: string;
};

/** Idempotent table + owner index. Called from ContentHub DO init. */
export function ensureUserContentSourceTable(host: UserContentSourceHost): void {
  host.sql`
    CREATE TABLE IF NOT EXISTS user_content_source (
      source_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      repo TEXT NOT NULL,
      default_ref TEXT,
      label TEXT,
      created_at TEXT NOT NULL
    )
  `;
  host.sql`CREATE INDEX IF NOT EXISTS idx_user_content_source_owner ON user_content_source(owner_user_id)`;
}

export type InsertUserContentSourceInput = {
  /** Globally-unique id (Unit 3 generates it server-side; never client-chosen). */
  source_id: string;
  /** Server-stamped from the resolved identity — NEVER from client input. */
  owner_user_id: string;
  provider: string;
  repo: string;
  default_ref?: string | null;
  label?: string | null;
};

/**
 * Plain INSERT — throws on `source_id` PK collision (Unit 3 generates unique ids
 * and handles the collision). No upsert: a silent overwrite keyed only by
 * source_id would let one caller clobber another's row; the owner-stamp + unique
 * id keep registration the single mutation point.
 */
export function insertUserContentSource(
  host: UserContentSourceHost,
  input: InsertUserContentSourceInput,
  nowIso: string,
): void {
  host.sql`
    INSERT INTO user_content_source (source_id, owner_user_id, provider, repo, default_ref, label, created_at)
    VALUES (${input.source_id}, ${input.owner_user_id}, ${input.provider}, ${input.repo}, ${input.default_ref ?? null}, ${input.label ?? null}, ${nowIso})
  `;
}

/** All of one owner's personal sources. Empty for an owner with none. */
export function listUserContentSourcesByOwner(
  host: UserContentSourceHost,
  ownerUserId: string,
): UserContentSourceRow[] {
  return host.sql<UserContentSourceRow>`
    SELECT source_id, owner_user_id, provider, repo, default_ref, label, created_at
    FROM user_content_source WHERE owner_user_id = ${ownerUserId} ORDER BY created_at ASC, source_id ASC
  `;
}

/**
 * Resolve a source by id (PK). Returns the row INCLUDING `owner_user_id` so the
 * caller can gate (`canAccessSource` / token resolver assert caller === owner).
 * `null` when unknown — the resolver then falls through to the hardcoded registry.
 */
export function getUserContentSourceById(
  host: UserContentSourceHost,
  sourceId: string,
): UserContentSourceRow | null {
  const rows = host.sql<UserContentSourceRow>`
    SELECT source_id, owner_user_id, provider, repo, default_ref, label, created_at
    FROM user_content_source WHERE source_id = ${sourceId} LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Owner-scoped delete: removes the row ONLY if it belongs to `ownerUserId` (the
 * `AND owner_user_id` clause is the tenant guard — a user can never delete
 * another tenant's source even by guessing its id). Returns whether a row was
 * removed. The caller (ContentHub) also purges `content_cache` for the id.
 */
export function deleteUserContentSourceRow(
  host: UserContentSourceHost,
  sourceId: string,
  ownerUserId: string,
): boolean {
  const existed = getUserContentSourceById(host, sourceId);
  if (existed === null || existed.owner_user_id !== ownerUserId) return false;
  host.sql`DELETE FROM user_content_source WHERE source_id = ${sourceId} AND owner_user_id = ${ownerUserId}`;
  return true;
}
