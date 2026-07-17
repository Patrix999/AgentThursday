/**
 * multi-tenancy: provider-credential store, owner-scoped.
 *
 * Extracted from the inline `AgentThursdayAgent` @callables (an earlier revision) so the
 * tenant-isolation SQL routing is unit-testable with a fake sql host (server.ts
 * imports `cloudflare:workers` and cannot be imported by a node test — every
 * testable DO-SQL helper in this repo is extracted for the same reason).
 *
 * Two stores:
 *   · `provider_credential` — the admin/operator's global keys (legacy, PK
 *     `provider`). This is the OPERATOR'S PERSONAL key, NOT a platform default.
 *   · `user_provider_credential` — per-(owner,provider) keys (an earlier revision, PK
 *     `(owner_user_id, provider)`). A scoped user reads/writes ONLY their own.
 *
 * Key-bytes boundary (`getProviderCredentialSecret`): a scoped agent reads ONLY
 * its owner's key — there is deliberately NO fall-through to the admin's legacy
 * key. When a scoped user has configured no key, the secret read returns null
 * and the caller's env fallback (the genuine platform default) applies. The
 * admin/undefined branch is byte-identical to pre-426c (the getModel hot path
 * is 4-28-saga-sensitive — admin behavior must not change).
 */
import type { RequestIdentity } from "./requestIdentity";

/** Tagged-template sql, same shape as `AgentThursdayAgent`'s `this.sql`. */
export type CredentialSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

export interface CredentialHost {
  sql: CredentialSqlTag;
}

/** The scoped user's id, or null when the identity is admin/absent. */
function scopedUserId(identity?: RequestIdentity): string | null {
  return identity !== undefined && identity.kind === "user" ? identity.userId : null;
}

export function maskKeyHint(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

export type SaveCredentialInput = {
  provider: string;
  /** Value to STORE — may be an encrypted envelope (see credentialCrypto). */
  api_key: string;
  base_url?: string | null;
  label?: string | null;
  /**
   * Precomputed masked hint of the PLAINTEXT key. When `api_key` is an encrypted
   * envelope, the caller must pass this (masking the envelope would be useless);
   * omitted → computed from `api_key` (legacy plaintext callers).
   */
  key_hint?: string;
};

/** Returns the masked key_hint of the saved row. */
export function saveProviderCredentialRow(
  host: CredentialHost,
  input: SaveCredentialInput,
  nowIso: string,
  identity?: RequestIdentity,
): string {
  const key = input.api_key;
  const hint = input.key_hint ?? maskKeyHint(key);
  const owner = scopedUserId(identity);
  if (owner !== null) {
    // Scoped: write ONLY this user's row; the admin's global key is untouchable.
    host.sql`
      INSERT INTO user_provider_credential (owner_user_id, provider, base_url, api_key, key_hint, label, created_at, updated_at)
      VALUES (${owner}, ${input.provider}, ${input.base_url ?? null}, ${key}, ${hint}, ${input.label ?? null}, ${nowIso}, ${nowIso})
      ON CONFLICT(owner_user_id, provider) DO UPDATE SET
        base_url = ${input.base_url ?? null},
        api_key = ${key},
        key_hint = ${hint},
        label = ${input.label ?? null},
        updated_at = ${nowIso}
    `;
    return hint;
  }
  // Admin/undefined — byte-identical to the pre-426c legacy SQL.
  host.sql`
    INSERT INTO provider_credential (provider, base_url, api_key, key_hint, label, created_at, updated_at)
    VALUES (${input.provider}, ${input.base_url ?? null}, ${key}, ${hint}, ${input.label ?? null}, ${nowIso}, ${nowIso})
    ON CONFLICT(provider) DO UPDATE SET
      base_url = ${input.base_url ?? null},
      api_key = ${key},
      key_hint = ${hint},
      label = ${input.label ?? null},
      updated_at = ${nowIso}
  `;
  return hint;
}

export type CredentialListRow = {
  provider: string;
  base_url: string | null;
  key_hint: string;
  label: string | null;
  updated_at: string;
  /** 1 when the stored key is an encrypted envelope (`v1:` prefix), else 0.
   * SQL-derived so the api_key value never enters JS — operational visibility
   * into at-rest encryption coverage without exposing the key/ciphertext. */
  encrypted: number;
};

/** key_hint only — never the api_key (write-only secret). */
export function listProviderCredentialRows(
  host: CredentialHost,
  identity?: RequestIdentity,
): CredentialListRow[] {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    return host.sql<CredentialListRow>`
      SELECT provider, base_url, key_hint, label, updated_at,
             (CASE WHEN api_key LIKE 'v1:%' THEN 1 ELSE 0 END) AS encrypted
      FROM user_provider_credential WHERE owner_user_id = ${owner} ORDER BY provider ASC
    `;
  }
  return host.sql<CredentialListRow>`
    SELECT provider, base_url, key_hint, label, updated_at,
           (CASE WHEN api_key LIKE 'v1:%' THEN 1 ELSE 0 END) AS encrypted
    FROM provider_credential ORDER BY provider ASC
  `;
}

export function deleteProviderCredentialRow(
  host: CredentialHost,
  provider: string,
  identity?: RequestIdentity,
): void {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    host.sql`DELETE FROM user_provider_credential WHERE owner_user_id = ${owner} AND provider = ${provider}`;
    return;
  }
  host.sql`DELETE FROM provider_credential WHERE provider = ${provider}`;
}

/**
 * KEY-BYTES BOUNDARY. A scoped agent reads ONLY its owner's key (no fall-
 * through to the admin's legacy key). Admin/undefined → legacy table, exactly
 * as pre-426c.
 */
export function getProviderCredentialSecretRow(
  host: CredentialHost,
  provider: string,
  identity?: RequestIdentity,
): { api_key: string; base_url: string | null } | null {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    const rows = host.sql<{ api_key: string; base_url: string | null }>`
      SELECT api_key, base_url FROM user_provider_credential WHERE owner_user_id = ${owner} AND provider = ${provider} LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  }
  const rows = host.sql<{ api_key: string; base_url: string | null }>`
    SELECT api_key, base_url FROM provider_credential WHERE provider = ${provider} LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 2026-06-22 — overwrite just the stored `api_key` value for the caller's own
 * row (used for lazy re-encryption: a legacy plaintext row is re-stored as an
 * encrypted envelope on first read). Owner-scoped like every other write here.
 */
export function updateCredentialApiKey(
  host: CredentialHost,
  provider: string,
  apiKey: string,
  identity?: RequestIdentity,
): void {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    host.sql`UPDATE user_provider_credential SET api_key = ${apiKey} WHERE owner_user_id = ${owner} AND provider = ${provider}`;
    return;
  }
  host.sql`UPDATE provider_credential SET api_key = ${apiKey} WHERE provider = ${provider}`;
}

export function listConfiguredProviderRows(
  host: CredentialHost,
  identity?: RequestIdentity,
): string[] {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    return host.sql<{ provider: string }>`
      SELECT provider FROM user_provider_credential WHERE owner_user_id = ${owner}
    `.map((r) => r.provider);
  }
  return host.sql<{ provider: string }>`
    SELECT provider FROM provider_credential
  `.map((r) => r.provider);
}

/** Raw (provider, models_json) rows for the caller's own credentials. */
export function listProviderModelsJsonRows(
  host: CredentialHost,
  identity?: RequestIdentity,
): Array<{ provider: string; models_json: string | null }> {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    return host.sql<{ provider: string; models_json: string | null }>`
      SELECT provider, models_json FROM user_provider_credential WHERE owner_user_id = ${owner}
    `;
  }
  return host.sql<{ provider: string; models_json: string | null }>`
    SELECT provider, models_json FROM provider_credential
  `;
}

/** Cache the discovered model-id list onto the caller's own credential row. */
export function cacheDiscoveredModels(
  host: CredentialHost,
  provider: string,
  idsJson: string,
  identity?: RequestIdentity,
): void {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    host.sql`UPDATE user_provider_credential SET models_json = ${idsJson} WHERE owner_user_id = ${owner} AND provider = ${provider}`;
    return;
  }
  host.sql`UPDATE provider_credential SET models_json = ${idsJson} WHERE provider = ${provider}`;
}

/**
 * 2026-06-22 — raw (provider, enabled_models_json) rows for the caller's own
 * credentials. `enabled_models_json` is the user-curated picker subset; distinct
 * from `models_json` (the full discovered set + runtime gate).
 */
export function listEnabledModelsJsonRows(
  host: CredentialHost,
  identity?: RequestIdentity,
): Array<{ provider: string; enabled_models_json: string | null }> {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    return host.sql<{ provider: string; enabled_models_json: string | null }>`
      SELECT provider, enabled_models_json FROM user_provider_credential WHERE owner_user_id = ${owner}
    `;
  }
  return host.sql<{ provider: string; enabled_models_json: string | null }>`
    SELECT provider, enabled_models_json FROM provider_credential
  `;
}

/** Write the user-enabled model-id subset onto the caller's own credential row. */
export function setEnabledModels(
  host: CredentialHost,
  provider: string,
  idsJson: string,
  identity?: RequestIdentity,
): void {
  const owner = scopedUserId(identity);
  if (owner !== null) {
    host.sql`UPDATE user_provider_credential SET enabled_models_json = ${idsJson} WHERE owner_user_id = ${owner} AND provider = ${provider}`;
    return;
  }
  host.sql`UPDATE provider_credential SET enabled_models_json = ${idsJson} WHERE provider = ${provider}`;
}
