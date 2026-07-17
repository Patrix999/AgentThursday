import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  type CredentialHost,
  type CredentialSqlTag,
  saveProviderCredentialRow,
  listProviderCredentialRows,
  deleteProviderCredentialRow,
  getProviderCredentialSecretRow,
  listConfiguredProviderRows,
  listProviderModelsJsonRows,
  cacheDiscoveredModels,
} from "./providerCredentialOps";
import type { RequestIdentity } from "./requestIdentity";

/**
 * two-table owner-aware fake sql host.
 *
 * `provider_credential` is the admin/operator's global store; rows in
 * `user_provider_credential` are keyed by (owner_user_id, provider). The fake
 * routes by canonical statement shape so the admin (legacy) and scoped (user
 * table) query forms both resolve, and asserts the leak-prevention contract:
 * a scoped caller can never read/overwrite/delete the admin's credential, and
 * the KEY-BYTES boundary never returns the admin's api_key to a scoped agent.
 */
type AdminRow = {
  provider: string;
  base_url: string | null;
  api_key: string;
  key_hint: string;
  label: string | null;
  models_json: string | null;
};
type UserRow = AdminRow & { owner_user_id: string };

function makeFakeSql(): {
  sql: CredentialSqlTag;
  admin: AdminRow[];
  user: UserRow[];
} {
  const admin: AdminRow[] = [];
  const user: UserRow[] = [];
  const sql: CredentialSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as Array<string | null>;
    const isUser = text.includes("user_provider_credential");

    if (text.startsWith("INSERT INTO user_provider_credential")) {
      // VALUES (owner, provider, base_url, api_key, key_hint, label, now, now)
      const [owner, provider, base_url, api_key, key_hint, label] = v as string[];
      const existing = user.find(r => r.owner_user_id === owner && r.provider === provider);
      const next: UserRow = { owner_user_id: owner, provider, base_url, api_key, key_hint, label, models_json: existing?.models_json ?? null };
      if (existing) Object.assign(existing, next);
      else user.push(next);
      return [];
    }
    if (text.startsWith("INSERT INTO provider_credential")) {
      // VALUES (provider, base_url, api_key, key_hint, label, now, now)
      const [provider, base_url, api_key, key_hint, label] = v as string[];
      const existing = admin.find(r => r.provider === provider);
      const next: AdminRow = { provider, base_url, api_key, key_hint, label, models_json: existing?.models_json ?? null };
      if (existing) Object.assign(existing, next);
      else admin.push(next);
      return [];
    }
    if (text.startsWith("SELECT api_key, base_url FROM")) {
      if (isUser) {
        const [owner, provider] = v as string[];
        const hit = user.find(r => r.owner_user_id === owner && r.provider === provider);
        return hit ? [{ api_key: hit.api_key, base_url: hit.base_url }] : [];
      }
      const [provider] = v as string[];
      const hit = admin.find(r => r.provider === provider);
      return hit ? [{ api_key: hit.api_key, base_url: hit.base_url }] : [];
    }
    if (text.startsWith("SELECT provider, base_url, key_hint, label, updated_at")) {
      const src = isUser
        ? user.filter(r => r.owner_user_id === (v[0] as string))
        : admin;
      return src.map(r => ({ provider: r.provider, base_url: r.base_url, key_hint: r.key_hint, label: r.label, updated_at: "t", encrypted: (r.api_key ?? "").startsWith("v1:") ? 1 : 0 }));
    }
    if (text.startsWith("SELECT provider, models_json FROM")) {
      const src = isUser
        ? user.filter(r => r.owner_user_id === (v[0] as string))
        : admin;
      return src.map(r => ({ provider: r.provider, models_json: r.models_json }));
    }
    if (text.startsWith("SELECT provider FROM")) {
      const src = isUser
        ? user.filter(r => r.owner_user_id === (v[0] as string))
        : admin;
      return src.map(r => ({ provider: r.provider }));
    }
    if (text.startsWith("DELETE FROM user_provider_credential")) {
      const [owner, provider] = v as string[];
      for (let i = user.length - 1; i >= 0; i--) {
        if (user[i].owner_user_id === owner && user[i].provider === provider) user.splice(i, 1);
      }
      return [];
    }
    if (text.startsWith("DELETE FROM provider_credential")) {
      const [provider] = v as string[];
      for (let i = admin.length - 1; i >= 0; i--) {
        if (admin[i].provider === provider) admin.splice(i, 1);
      }
      return [];
    }
    if (text.startsWith("UPDATE user_provider_credential SET models_json")) {
      const [ids, owner, provider] = v as string[];
      const hit = user.find(r => r.owner_user_id === owner && r.provider === provider);
      if (hit) hit.models_json = ids;
      return [];
    }
    if (text.startsWith("UPDATE provider_credential SET models_json")) {
      const [ids, provider] = v as string[];
      const hit = admin.find(r => r.provider === provider);
      if (hit) hit.models_json = ids;
      return [];
    }
    throw new Error(`unhandled sql in fake: ${text}`);
  }) as CredentialSqlTag;
  return { sql, admin, user };
}

const ADMIN: RequestIdentity = { kind: "admin" };
const ALICE: RequestIdentity = { kind: "user", userId: "user-alice" };
const BOB: RequestIdentity = { kind: "user", userId: "user-bob" };
const NOW = "2026-06-15T00:00:00.000Z";

function host() {
  const fake = makeFakeSql();
  return { h: { sql: fake.sql } as CredentialHost, store: fake };
}

describe("providerCredentialOps — an earlier revision tenant isolation", () => {
  it("scoped save writes the user table; admin save writes the legacy table", () => {
    const { h, store } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin-AAAA" }, NOW, ADMIN);
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-alice-BBBB" }, NOW, ALICE);
    assert.equal(store.admin.length, 1);
    assert.equal(store.user.length, 1);
    assert.equal(store.admin[0].api_key, "sk-admin-AAAA");
    assert.equal(store.user[0].owner_user_id, "user-alice");
    assert.equal(store.user[0].api_key, "sk-alice-BBBB");
  });

  it("KEY-BYTES BOUNDARY: a scoped agent with no key never gets the admin's key", () => {
    const { h } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin-SECRET" }, NOW, ADMIN);
    // Alice configured nothing → must be null (NOT the admin's key); the
    // caller's env fallback (platform default) applies afterward.
    assert.equal(getProviderCredentialSecretRow(h, "anthropic", ALICE), null);
    // Admin still reads its own key.
    assert.deepEqual(getProviderCredentialSecretRow(h, "anthropic", ADMIN), {
      api_key: "sk-admin-SECRET",
      base_url: null,
    });
  });

  it("a scoped agent reads ONLY its own key, never another tenant's", () => {
    const { h } = host();
    saveProviderCredentialRow(h, { provider: "deepseek", api_key: "sk-alice-1" }, NOW, ALICE);
    saveProviderCredentialRow(h, { provider: "deepseek", api_key: "sk-bob-2" }, NOW, BOB);
    assert.equal(getProviderCredentialSecretRow(h, "deepseek", ALICE)?.api_key, "sk-alice-1");
    assert.equal(getProviderCredentialSecretRow(h, "deepseek", BOB)?.api_key, "sk-bob-2");
  });

  it("scoped save cannot overwrite the admin's global key", () => {
    const { h, store } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin-KEEP" }, NOW, ADMIN);
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-alice-EVIL" }, NOW, ALICE);
    assert.equal(store.admin[0].api_key, "sk-admin-KEEP", "admin key untouched");
    assert.equal(store.user[0].api_key, "sk-alice-EVIL", "alice's own row written");
  });

  it("scoped delete cannot remove the admin's (or another tenant's) credential", () => {
    const { h, store } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin" }, NOW, ADMIN);
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-alice" }, NOW, ALICE);
    // Alice deletes "anthropic": only her own row goes.
    deleteProviderCredentialRow(h, "anthropic", ALICE);
    assert.equal(store.admin.length, 1, "admin credential survives a scoped delete");
    assert.equal(store.user.length, 0, "alice's own row removed");
  });

  it("scoped list / listConfigured only show the caller's own rows", () => {
    const { h } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin" }, NOW, ADMIN);
    saveProviderCredentialRow(h, { provider: "deepseek", api_key: "sk-alice" }, NOW, ALICE);
    const aliceList = listProviderCredentialRows(h, ALICE);
    assert.deepEqual(aliceList.map(r => r.provider), ["deepseek"]);
    assert.deepEqual(listConfiguredProviderRows(h, ALICE), ["deepseek"]);
    // Admin sees only the legacy table (its own global providers).
    assert.deepEqual(listConfiguredProviderRows(h, ADMIN), ["anthropic"]);
    // No api_key ever appears in a list row.
    assert.equal((aliceList[0] as Record<string, unknown>).api_key, undefined);
  });

  it("discovered-model cache is owner-scoped (scoped write never touches admin row)", () => {
    const { h, store } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-admin" }, NOW, ADMIN);
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-alice" }, NOW, ALICE);
    cacheDiscoveredModels(h, "anthropic", JSON.stringify(["m-alice"]), ALICE);
    assert.equal(store.admin[0].models_json, null, "admin cache untouched");
    const aliceRows = listProviderModelsJsonRows(h, ALICE);
    assert.equal(aliceRows[0].models_json, JSON.stringify(["m-alice"]));
    // Admin's models view never sees alice's discovered models.
    assert.deepEqual(listProviderModelsJsonRows(h, ADMIN).map(r => r.models_json), [null]);
  });

  it("undefined identity is treated as admin (byte-identical legacy path)", () => {
    const { h, store } = host();
    saveProviderCredentialRow(h, { provider: "anthropic", api_key: "sk-x" }, NOW);
    assert.equal(store.admin.length, 1);
    assert.equal(store.user.length, 0);
    assert.equal(getProviderCredentialSecretRow(h, "anthropic")?.api_key, "sk-x");
  });
});
