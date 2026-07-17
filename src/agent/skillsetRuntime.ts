/**
 * Skillset-runtime READ surface extracted from
 * `src/server.ts:AgentThursdayAgent`. Free functions over a HostShape so the
 * DO class body is shorter and the read path is independently
 * testable without spinning up a Durable Object.
 *
 * Read-only in this card. Mutation surface (reload / disable /
 * enable) stays on `AgentThursdayAgent` here; an earlier revision will extract it with
 * a `SkillsetRuntimeMutationHost` that extends `SkillsetRuntimeReadHost`.
 *
 * Invariants preserved (see an earlier revision preflight §3):
 * - SQL is the source of truth for the disabled set .
 *   No in-host snapshot cache.
 * - an earlier revision: agent-surface inspect routes through `AgentThursdayAgent`'s
 *   public `getSkillsetRuntimeSummary()`; this module supplies the
 *   delegate body, not a substitute path.
 * - `reload_count` is read-only here; write authority belongs to
 *   the mutation surface .
 */
import {
  buildSkillsetRuntimeSnapshot,
  summarizeSnapshot,
  type SkillsetRuntimeSnapshot,
  type SkillsetRuntimeSummary,
} from "../skillset/runtimeSnapshot";
import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "../skillset/manifests";
import { assembleEffectiveManifests } from "../skillset/loader";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";
import type { SkillsetManifest } from "../skillset/types";

export type SkillsetSqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/**
 * Capabilities the read surface needs from its host. `AgentThursdayAgent`
 * satisfies this via `{ env, sql.bind(this), () => _skillsetReloadCount }`.
 * Tests use an in-memory FakeHost.
 */
export interface SkillsetRuntimeReadHost {
  readonly env: Env;
  sql: SkillsetSqlFn;
  getReloadCount(): number;
  /**
   * optional accessor that returns custom manifests the
   * host has cached from an external authority (e.g. per-agent DO
   * caches the registry DO's custom-skillset list). Returned manifests
   * are merged into the loader input alongside local-SQL customs.
   *
   * Host implementations that don't need cross-DO sync can leave this
   * undefined; the snapshot then falls back to local-SQL-only.
   */
  getExtraCustomManifests?(): EmbeddedManifest[];
}

export function skillsetEnvLookup(
  host: SkillsetRuntimeReadHost,
  binding: string,
): string | undefined {
  const envRecord = host.env as unknown as Record<string, unknown>;
  const value = envRecord[binding];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readDisabledSkillsetsFromSQL(
  host: SkillsetRuntimeReadHost,
): Map<string, { disabled_at: string; reason: string | null }> {
  const rows = host.sql<{ skillset_id: string; disabled_at: string; reason: string | null }>`
    SELECT skillset_id, disabled_at, reason FROM skillset_disabled
  `;
  const out = new Map<string, { disabled_at: string; reason: string | null }>();
  for (const r of rows) {
    out.set(r.skillset_id, {
      disabled_at: r.disabled_at,
      reason: r.reason && r.reason.length > 0 ? r.reason : null,
    });
  }
  return out;
}

/**
 * merge any custom skillsets the host DO has authored
 * (via the manager API) into the loader input set. Read is local
 * to the calling DO: registry DO (DEMO_INSTANCE) is the data owner
 * and sees its full custom set here; per-context DOs see an empty
 * set until the test-doc-documented session-reload flow plumbs
 * cross-DO custom-manifest sync (out of scope for an earlier revision v1).
 *
 * Defensive: PRAGMA-style failure to read the table (e.g. migration
 * not yet applied during a hot-deploy window) drops to []; never
 * blocks the snapshot.
 */
export function readLocalCustomManifests(host: SkillsetRuntimeReadHost): EmbeddedManifest[] {
  try {
    const rows = host.sql<{
      id: string;
      source_yaml: string;
      manifest_json: string;
    }>`SELECT id, source_yaml, manifest_json FROM custom_skillset`;
    const out: EmbeddedManifest[] = [];
    for (const r of rows) {
      try {
        const manifest = JSON.parse(r.manifest_json) as SkillsetManifest;
        out.push({ id: r.id, source_yaml: r.source_yaml, manifest });
      } catch (err) {
        console.warn(
          `[skillsetRuntime] dropping custom skillset '${r.id}': manifest_json parse failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function buildSkillsetSnapshotNow(
  host: SkillsetRuntimeReadHost,
): SkillsetRuntimeSnapshot {
  const localCustom = readLocalCustomManifests(host);
  const extraCustom = host.getExtraCustomManifests?.() ?? [];
  // Dedupe by id (extra wins over local on collision — per-agent DO
  // mirroring the registry has authoritative data; local SQL is
  // usually empty on per-agent DOs).
  const customById = new Map<string, EmbeddedManifest>();
  for (const m of localCustom) customById.set(m.id, m);
  for (const m of extraCustom) customById.set(m.id, m);
  const customManifests = Array.from(customById.values());
  // Stage 2 — DB-sourced system skillsets (seeded embedded ids) may appear in
  // `customManifests`; assemble to one-per-id (DB wins if it loads clean, else
  // the code embedded manifest) so a seeded duplicate id never trips
  // v5_id_conflict and drops tools for every agent. Same helper + options as
  // `loadMergedManifests`, so the two paths can't drift.
  const merged: EmbeddedManifest[] = assembleEffectiveManifests(
    EMBEDDED_MANIFESTS,
    customManifests,
    { knownToolIds: STUB_KNOWN_TOOL_IDS },
  );
  return buildSkillsetRuntimeSnapshot({
    env: host.env,
    envLookup: (b) => skillsetEnvLookup(host, b),
    reload_count: host.getReloadCount(),
    embedded: merged,
    disabledSkillsets: readDisabledSkillsetsFromSQL(host),
  });
}

export function getSkillsetRuntimeSummary(
  host: SkillsetRuntimeReadHost,
): SkillsetRuntimeSummary {
  return summarizeSnapshot(buildSkillsetSnapshotNow(host));
}

// ───────────────────────────────────────────────────────────────────
// Mutation surface.
//
// Extends the read HostShape with two new capabilities: a write
// authority for `reload_count` (kept private as a field on
// `AgentThursdayAgent`, exposed via this adapter only here) and the agent's
// event log channel.
// ───────────────────────────────────────────────────────────────────

export type SkillsetLogEventFn = (
  type: string,
  payload?: unknown,
  traceId?: string | null,
) => void;

export interface SkillsetRuntimeMutationHost extends SkillsetRuntimeReadHost {
  incrementReloadCount(): void;
  logEvent: SkillsetLogEventFn;
}

/**
 * explicit reload action. Increments `reload_count`,
 * rebuilds the snapshot, emits `skillset.reload`, returns the
 * non-sensitive summary.
 */
export function runReloadSkillsetRuntime(
  host: SkillsetRuntimeMutationHost,
): SkillsetRuntimeSummary {
  host.incrementReloadCount();
  const snapshot = buildSkillsetSnapshotNow(host);
  const summary = summarizeSnapshot(snapshot);
  host.logEvent("skillset.reload", summary);
  return summary;
}

/**
 * an earlier revision/c1 — operator disable. Validates id against the current
 * loader-accepted set, writes the disable record to SQL (source of
 * truth), emits `skillset.disable`. Returns `{ ok: false, error }`
 * with literal error union for HTTP 400/404/409 mapping.
 */
export function runDisableSkillset(
  host: SkillsetRuntimeMutationHost,
  input: { skillset_id: unknown; reason?: unknown },
): {
  ok: true; summary: SkillsetRuntimeSummary;
} | {
  ok: false; error: "missing_skillset_id" | "unknown_skillset_id" | "not_loaded";
} {
  const skillsetId = typeof input.skillset_id === "string" ? input.skillset_id.trim() : "";
  if (!skillsetId) return { ok: false, error: "missing_skillset_id" };
  const current = buildSkillsetSnapshotNow(host);
  const entry = current.state.entries[skillsetId];
  if (!entry) return { ok: false, error: "unknown_skillset_id" };
  if (entry.status !== "loaded") return { ok: false, error: "not_loaded" };
  const rawReason = typeof input.reason === "string" ? input.reason.slice(0, 200) : null;
  const reason = rawReason && rawReason.length > 0 ? rawReason : null;
  const disabledAt = new Date().toISOString();
  host.sql`
    INSERT INTO skillset_disabled (skillset_id, disabled_at, reason)
    VALUES (${skillsetId}, ${disabledAt}, ${reason})
    ON CONFLICT(skillset_id) DO UPDATE SET
      disabled_at = excluded.disabled_at,
      reason = excluded.reason
  `;
  const snapshot = buildSkillsetSnapshotNow(host);
  const summary = summarizeSnapshot(snapshot);
  host.logEvent("skillset.disable", {
    skillset_id: skillsetId,
    reason,
    summary,
  });
  return { ok: true, summary };
}

/**
 * an earlier revision/c1 — operator enable. Symmetric to disable. Idempotent
 * enable on a non-disabled id returns `changed=false` and emits no
 * event.
 */
export function runEnableSkillset(
  host: SkillsetRuntimeMutationHost,
  input: { skillset_id: unknown; reason?: unknown },
): {
  ok: true; summary: SkillsetRuntimeSummary; changed: boolean;
} | {
  ok: false; error: "missing_skillset_id" | "unknown_skillset_id";
} {
  const skillsetId = typeof input.skillset_id === "string" ? input.skillset_id.trim() : "";
  if (!skillsetId) return { ok: false, error: "missing_skillset_id" };
  const current = buildSkillsetSnapshotNow(host);
  const entry = current.state.entries[skillsetId];
  if (!entry) return { ok: false, error: "unknown_skillset_id" };
  const rawReason = typeof input.reason === "string" ? input.reason.slice(0, 200) : null;
  const reason = rawReason && rawReason.length > 0 ? rawReason : null;
  const existing = host.sql<{ skillset_id: string }>`
    SELECT skillset_id FROM skillset_disabled WHERE skillset_id = ${skillsetId}
  `;
  const wasDisabled = existing.length > 0;
  if (wasDisabled) {
    host.sql`DELETE FROM skillset_disabled WHERE skillset_id = ${skillsetId}`;
  }
  const snapshot = buildSkillsetSnapshotNow(host);
  const summary = summarizeSnapshot(snapshot);
  if (wasDisabled) {
    host.logEvent("skillset.enable", {
      skillset_id: skillsetId,
      reason,
      summary,
    });
  }
  return { ok: true, summary, changed: wasDisabled };
}
