/**
 * manager-authored custom skillset storage.
 *
 * Pure helpers backing the four CRUD @callable methods on the
 * registry DO (DEMO_INSTANCE), mirroring the shape of
 * `agentProfileOps.ts`. Storage substrate: SQLite on the registry
 * DO so custom skillset rows survive per-context DO resets and are
 * visible to every channel/context resolving an agent's effective
 * skillset.
 *
 * Validation policy: id-shape, manifest-shape, embedded-id
 * collision, unknown tool ids are all enforced at the route layer
 * (`customSkillsetValidation.ts`) before reaching these helpers.
 * Helpers handle PRIMARY KEY conflict on create and row-existence
 * on read/update.
 */
import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "../skillset/manifests";
import { SYSTEM_SKILLSET_OWNER } from "./requestIdentity";

export type CustomSkillsetSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface CustomSkillsetHost {
  sql: CustomSkillsetSqlTag;
}

export type CustomSkillsetRecord = {
  id: string;
  name: string;
  description: string;
  version: string;
  source_yaml: string;
  manifest: EmbeddedManifest["manifest"];
  created_at: string;
  updated_at: string;
};

/**
 * RPC-boundary projection. `SkillsetManifest` contains
 * `unknown`-typed fields (evidence_protocol, observability) that fail
 * CF's `Rpc.Serializable<T>` constraint, narrowing any @callable
 * returning `CustomSkillsetRecord` to `never` at the stub site. The
 * wire shape carries the manifest as the same JSON string we already
 * store in SQLite; the caller parses with `manifestFromWire`.
 */
export type CustomSkillsetWireRecord = {
  id: string;
  name: string;
  description: string;
  version: string;
  source_yaml: string;
  manifest_json: string;
  created_at: string;
  updated_at: string;
};

export function manifestFromWire(w: CustomSkillsetWireRecord): EmbeddedManifest["manifest"] {
  return JSON.parse(w.manifest_json) as EmbeddedManifest["manifest"];
}

function recordToWire(r: CustomSkillsetRecord): CustomSkillsetWireRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: r.version,
    source_yaml: r.source_yaml,
    manifest_json: JSON.stringify(r.manifest),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

type CustomSkillsetRow = {
  id: string;
  name: string;
  description: string;
  version: string;
  source_yaml: string;
  manifest_json: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
};

function rowToRecord(r: CustomSkillsetRow): CustomSkillsetRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: r.version,
    source_yaml: r.source_yaml,
    manifest: JSON.parse(r.manifest_json) as EmbeddedManifest["manifest"],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export type CreateCustomSkillsetInput = {
  id: string;
  name: string;
  description: string;
  version: string;
  sourceYaml: string;
  manifest: EmbeddedManifest["manifest"];
  createdAt: string;
  updatedAt: string;
  // Owner of this custom skillset (the creating agent's tenant). Custom
  // skillsets are owner-scoped; pass `ADMIN_USER_ID` for an admin-authored one.
  ownerUserId: string;
};

export type CreateCustomSkillsetResult =
  | { ok: true; record: CustomSkillsetRecord }
  | { ok: false; error: { code: "id_conflict" | "internal"; message: string } };

export type CreateCustomSkillsetWireResult =
  | { ok: true; record: CustomSkillsetWireRecord }
  | { ok: false; error: { code: "id_conflict" | "internal"; message: string } };

export function createCustomSkillset(
  host: CustomSkillsetHost,
  input: CreateCustomSkillsetInput,
): CreateCustomSkillsetResult {
  const existing = host.sql<{ id: string }>`
    SELECT id FROM custom_skillset WHERE id = ${input.id} LIMIT 1
  `;
  if (existing.length > 0) {
    return {
      ok: false,
      error: { code: "id_conflict", message: `custom skillset id already exists: ${input.id}` },
    };
  }
  const manifestJson = JSON.stringify(input.manifest);
  try {
    host.sql`
      INSERT INTO custom_skillset
        (id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id)
      VALUES
        (${input.id}, ${input.name}, ${input.description}, ${input.version},
         ${input.sourceYaml}, ${manifestJson}, ${input.createdAt}, ${input.updatedAt}, ${input.ownerUserId})
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|PRIMARY|constraint/i.test(msg)) {
      return {
        ok: false,
        error: { code: "id_conflict", message: `custom skillset id already exists: ${input.id}` },
      };
    }
    return { ok: false, error: { code: "internal", message: msg } };
  }
  return {
    ok: true,
    record: {
      id: input.id,
      name: input.name,
      description: input.description,
      version: input.version,
      source_yaml: input.sourceYaml,
      manifest: input.manifest,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    },
  };
}

// Custom skillsets are owner-scoped. `scopeOwnerId` undefined = admin (all
// rows); a string = a scoped tenant (only that owner's rows). Same isolation
// shape as the 426-series owner-scoped reads.
export function listCustomSkillsets(
  host: CustomSkillsetHost,
  scopeOwnerId?: string,
): CustomSkillsetRecord[] {
  // A scoped tenant sees their OWN custom skillsets PLUS the global SYSTEM
  // skillsets (seeded baseline). Admin (undefined) sees all.
  const rows = scopeOwnerId !== undefined
    ? host.sql<CustomSkillsetRow>`
        SELECT id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id
        FROM custom_skillset WHERE owner_user_id = ${scopeOwnerId} OR owner_user_id = ${SYSTEM_SKILLSET_OWNER} ORDER BY created_at DESC`
    : host.sql<CustomSkillsetRow>`
        SELECT id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id
        FROM custom_skillset ORDER BY created_at DESC`;
  return rows.map(rowToRecord);
}

export function readCustomSkillset(
  host: CustomSkillsetHost,
  id: string,
  scopeOwnerId?: string,
): CustomSkillsetRecord | null {
  const rows = host.sql<CustomSkillsetRow>`
    SELECT id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id
    FROM custom_skillset
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  // Owner isolation: a scoped caller that doesn't own it gets `null` — exactly
  // like nonexistent, no existence leak.
  if (scopeOwnerId !== undefined && rows[0].owner_user_id !== scopeOwnerId) return null;
  return rowToRecord(rows[0]);
}

export type UpdateCustomSkillsetInput = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  sourceYaml?: string;
  manifest?: EmbeddedManifest["manifest"];
  updatedAt: string;
};

export type UpdateCustomSkillsetResult =
  | { ok: true; record: CustomSkillsetRecord }
  | {
      ok: false;
      error: { code: "not_found" | "no_changes" | "internal"; message: string };
    };

export type UpdateCustomSkillsetWireResult =
  | { ok: true; record: CustomSkillsetWireRecord }
  | {
      ok: false;
      error: { code: "not_found" | "no_changes" | "internal"; message: string };
    };

// ── wire-shape callable wrappers ──────────────────────────
// Same data, JSON-string manifest. These are what the @callable
// decorators on `AgentThursdayAgent` return so the route layer can actually
// reach them through `DurableObjectStub<AgentThursdayAgent>`.

export function createCustomSkillsetWire(
  host: CustomSkillsetHost,
  input: CreateCustomSkillsetInput,
): CreateCustomSkillsetWireResult {
  const r = createCustomSkillset(host, input);
  return r.ok ? { ok: true, record: recordToWire(r.record) } : r;
}

export function listCustomSkillsetsWire(
  host: CustomSkillsetHost,
  scopeOwnerId?: string,
): CustomSkillsetWireRecord[] {
  return listCustomSkillsets(host, scopeOwnerId).map(recordToWire);
}

export function readCustomSkillsetWire(
  host: CustomSkillsetHost,
  id: string,
  scopeOwnerId?: string,
): CustomSkillsetWireRecord | null {
  const r = readCustomSkillset(host, id, scopeOwnerId);
  return r === null ? null : recordToWire(r);
}

export function updateCustomSkillsetWire(
  host: CustomSkillsetHost,
  input: UpdateCustomSkillsetInput,
  scopeOwnerId?: string,
): UpdateCustomSkillsetWireResult {
  const r = updateCustomSkillset(host, input, scopeOwnerId);
  return r.ok ? { ok: true, record: recordToWire(r.record) } : r;
}

export function updateCustomSkillset(
  host: CustomSkillsetHost,
  input: UpdateCustomSkillsetInput,
  scopeOwnerId?: string,
): UpdateCustomSkillsetResult {
  const existing = host.sql<CustomSkillsetRow>`
    SELECT id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id
    FROM custom_skillset
    WHERE id = ${input.id}
    LIMIT 1
  `;
  if (existing.length === 0) {
    return { ok: false, error: { code: "not_found", message: `custom skillset not found: ${input.id}` } };
  }
  const row = existing[0];
  // Owner isolation: a scoped caller that doesn't own it reads as not_found.
  if (scopeOwnerId !== undefined && row.owner_user_id !== scopeOwnerId) {
    return { ok: false, error: { code: "not_found", message: `custom skillset not found: ${input.id}` } };
  }

  const nextManifestJson =
    input.manifest !== undefined ? JSON.stringify(input.manifest) : row.manifest_json;

  const changed =
    (input.name !== undefined && input.name !== row.name) ||
    (input.description !== undefined && input.description !== row.description) ||
    (input.version !== undefined && input.version !== row.version) ||
    (input.sourceYaml !== undefined && input.sourceYaml !== row.source_yaml) ||
    (input.manifest !== undefined && nextManifestJson !== row.manifest_json);

  if (!changed) {
    return { ok: false, error: { code: "no_changes", message: "no fields changed" } };
  }

  const next: CustomSkillsetRow = {
    id: row.id,
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    version: input.version ?? row.version,
    source_yaml: input.sourceYaml ?? row.source_yaml,
    manifest_json: nextManifestJson,
    created_at: row.created_at,
    updated_at: input.updatedAt,
    owner_user_id: row.owner_user_id,
  };

  try {
    host.sql`
      UPDATE custom_skillset
      SET name = ${next.name},
          description = ${next.description},
          version = ${next.version},
          source_yaml = ${next.source_yaml},
          manifest_json = ${next.manifest_json},
          updated_at = ${next.updated_at}
      WHERE id = ${next.id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { code: "internal", message: msg } };
  }
  return { ok: true, record: rowToRecord(next) };
}

export type DeleteCustomSkillsetResult =
  | { ok: true; id: string }
  | { ok: false; error: { code: "not_found" | "internal"; message: string } };

/**
 * 2026-06-19 — delete a custom skillset row. Owner-isolated like update: a
 * scoped caller that doesn't own the row reads as not_found (no existence
 * leak); admin (`scopeOwnerId === undefined`) can delete any row, including a
 * seeded system row whose embedded source has been removed (the localdoc
 * external-publishing cleanup). Agents still referencing the id simply fall
 * back to their base tools — no cascade needed.
 */
export function deleteCustomSkillset(
  host: CustomSkillsetHost,
  id: string,
  scopeOwnerId?: string,
): DeleteCustomSkillsetResult {
  const existing = host.sql<{ owner_user_id: string }>`
    SELECT owner_user_id FROM custom_skillset WHERE id = ${id} LIMIT 1
  `;
  if (existing.length === 0) {
    return { ok: false, error: { code: "not_found", message: `custom skillset not found: ${id}` } };
  }
  if (scopeOwnerId !== undefined && existing[0].owner_user_id !== scopeOwnerId) {
    return { ok: false, error: { code: "not_found", message: `custom skillset not found: ${id}` } };
  }
  try {
    host.sql`DELETE FROM custom_skillset WHERE id = ${id}`;
  } catch (e) {
    return { ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
  return { ok: true, id };
}

/**
 * Stage 2 (skillsets-as-data) — seed the code `EMBEDDED_MANIFESTS` into
 * `custom_skillset` as SYSTEM rows (owner `user-system`), so the loader can
 * source baseline skillsets from the DB (data) instead of code. Idempotent:
 * `INSERT OR IGNORE` by id means an existing row — including one an operator has
 * edited via the console — is NEVER overwritten on redeploy. The repo YAML is
 * the one-time seed source, no longer the runtime source. Registry-DO only.
 *
 * Round-trip note: stores `JSON.stringify(m.manifest)`; read back via
 * `manifestFromWire` (JSON.parse) it must equal `m.manifest` — the loader's
 * usability fallback (`assembleEffectiveManifests`) covers any lossy row by
 * reverting that id to code, but the round-trip is asserted identity in tests.
 */
export function seedSystemSkillsets(host: CustomSkillsetHost): { systemRows: number } {
  const now = new Date().toISOString();
  for (const m of EMBEDDED_MANIFESTS) {
    host.sql`
      INSERT OR IGNORE INTO custom_skillset
        (id, name, description, version, source_yaml, manifest_json, created_at, updated_at, owner_user_id)
      VALUES
        (${m.id}, ${m.manifest.name}, ${m.manifest.description}, ${m.manifest.version},
         ${m.source_yaml}, ${JSON.stringify(m.manifest)}, ${now}, ${now}, ${SYSTEM_SKILLSET_OWNER})
    `;
  }
  const rows = host.sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM custom_skillset WHERE owner_user_id = ${SYSTEM_SKILLSET_OWNER}
  `;
  return { systemRows: rows[0]?.c ?? 0 };
}
