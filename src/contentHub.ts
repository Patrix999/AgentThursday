/**
 * M7.4 ContentHub — `ContentHubAgent` Durable Object.
 *
 * an earlier revision added: registry skeleton, types, hardcoded `agentthursday-github`,
 *                 static `getSources` callable.
 * an earlier revision adds:  GitHub-backed `read` + `list` callables, revision-pinned
 *                 DO SQLite cache, secret redaction on read results.
 *
 * an earlier revision still does NOT implement (per ADR + an earlier revision §Out of scope):
 *   - `content_search` / GitHub Code Search 
 *   - R2 large-blob storage 
 *   - OAuth / `CredentialProvider` abstraction (ADR §14 Q4)
 *   - Audit / inspect surface 
 *   - External writes / push / commit / PR
 *   - LLM tool registration — done in `AgentThursdayAgent.getTools()` in server.ts
 *
 * Boundary rationale (M7.4 ADR §1, §4): kept as its own DO so external
 * Content Source state (registry, cache, audit) does not leak into
 * AgentThursdayAgent.event_log or Tier 0 workspace storage.
 */

import { Agent, unstable_callable as callable, getAgentByName, type AgentNamespace } from "agents";
import type {
  ContentRef,
  ContentRevision,
  ContentReadResponse,
  ContentListResponse,
  ContentSourcesResponse,
  ContentSearchResponse,
  ContentSearchHit,
  ContentSearchPerSourceState,
  ContentReadResult,
  ContentListResult,
  ContentError,
  ContentSource,
  ContentSourceWithHealth,
  ContentCaller,
  ContentAuditSummary,
  ContentAuditByTrace,
  ContentAuditBySource,
  ContentAuditByOperation,
  ContentAuditOperationCounts,
} from "./schema";
import { HARDCODED_REGISTRY, listSources, staticHealth, type ListSourcesInput } from "./contentRegistry";
import {
  checkPath,
  redactSecrets,
  resolveRefToSha,
  fetchRawFile,
  fetchContentsList,
  runGithubCodeSearch,
  getRepoForSource,
  synthesizeTopLevelEntries,
  GithubContentError,
  DEFAULT_READ_MAX_BYTES,
  HARD_READ_MAX_BYTES,
  type GithubRepo,
} from "./githubContentConnector";
import {
  localFsList,
  localFsRead,
  LocalFsContentError,
} from "./localFsContentConnector";
import { canAccessSource, tokenPlanForSource } from "./contentSourceAccess";
import {
  ensureUserContentSourceTable,
  insertUserContentSource,
  getUserContentSourceById,
  listUserContentSourcesByOwner,
  deleteUserContentSourceRow,
  type UserContentSourceRow,
  type UserContentSourceSqlTag,
} from "./agent/userContentSourceOps";
import { DEMO_INSTANCE } from "./demoConstants";
import type { RequestIdentity } from "./agent/requestIdentity";
// Type-only — erased at build, so NO runtime import cycle (server.ts imports
// THIS module at runtime; this back-reference is purely for the RPC stub type).
import type { AgentThursdayAgent } from "./server";

// Single-tenant default; matches AgentThursdayAgent / ChannelHubAgent convention.
export const CONTENT_HUB_INSTANCE = "agentthursday-dev";

// LRU cache caps. Best-effort; eviction runs after every cache write.
const CACHE_MAX_ROWS = 100;

// audit log caps.
const AUDIT_MAX_ROWS = 500;
const AUDIT_PREVIEW_MAX = 120;

type CacheRow = {
  source_id: string;
  path: string;
  revision_key: string;
  result_kind: string;
  result_json: string;
  size: number;
  fetched_at: number;
  last_access_at: number;
};

type AuditLogRow = {
  event_type: string;
  payload: string;
  created_at: number;
  trace_id: string | null;
};

type ContentReadCallableInput = {
  sourceId: string;
  path: string;
  ref?: string;
  maxBytes?: number;
  offset?: number;
};

type ContentListCallableInput = {
  sourceId: string;
  path: string;
  ref?: string;
};

type ContentSearchCallableInput = {
  // exactly one of `sourceId` (single) or `sourceIds` (fan-out)
  // must be set. Server-side route validates via Zod refinement; the DO
  // callable trusts that contract and treats both-undefined or both-set as
  // a `bad-input` error to keep the LLM tool path equally fail-loud.
  sourceId?: string;
  sourceIds?: string[];
  query: string;
  path?: string;
  ref?: string;
  strategy?: "api-search" | "bounded-local";
  maxResults?: number;
};

// an earlier revision bounded-local caps. Conservative on purpose: the strategy is a
// degraded fallback meant to confirm coverage exists, not to power high-fan-out
// repository scans. Any caller asking for more should retry with `api-search`
// once GitHub Code Search quota refills.
const BOUNDED_LOCAL_MAX_FILES = 50;
const BOUNDED_LOCAL_MAX_DIRS = 20;
const BOUNDED_LOCAL_MAX_DEPTH = 3;
const BOUNDED_LOCAL_MAX_BYTES_PER_FILE = 32 * 1024;
const BOUNDED_LOCAL_MAX_HITS_PER_FILE = 10;
const BOUNDED_LOCAL_PREVIEW_MAX = 200;

function findSource(sourceId: string): ContentSource | null {
  return HARDCODED_REGISTRY.find(s => s.id === sourceId) ?? null;
}

// BYO source ids (2026-06-27) — short, non-secret, copy-reliable. A 36-char
// UUID is unreliable for an LLM agent to reproduce verbatim from memory: it
// intermittently flips a char or truncates the id, which then reads as
// `source-not-found` and (worse) drives a retry-loop that burns the turn's step
// budget. 40 bits of Crockford-base32 (8 chars, ambiguous I/L/O/U dropped) is
// far easier to copy correctly, still unguessable, and collision-checked at the
// call site. Tenant isolation does NOT rely on id secrecy (owner-scoped at the
// SQL layer) — this only needs enough entropy to avoid accidental collisions.
const SOURCE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function newUserSourceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5)); // 40 bits → 8 chars
  let value = 0, bits = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += SOURCE_ID_ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `usrc-${out}`;
}

// Recovery-oriented reason for an unknown source id (2026-06-27). When an agent
// names a source id that doesn't resolve, the usual cause is a mis-copied /
// truncated id (see newUserSourceId). A bare "unknown source" invites the agent
// to retry the SAME bad id, which burns the turn's step budget; this reason
// tells it to re-list via content_sources and copy the id verbatim instead.
function unknownSourceReason(sourceId: string): string {
  return `unknown source: ${sourceId} — not a registered source id. Do NOT retry this id. Call content_sources to list the exact ids you can access and copy the id verbatim (don't retype it from memory).`;
}

// BYO GitHub (2026-06-26) — content_* caller with no resolved owner: deny
// everything beyond tenant-public fixtures. The legitimate tool path always
// passes a real resolved owner; this default only guards a phantom caller (e.g.
// a @callable invoked without the arg) — it must NOT default to operator.
const FAIL_CLOSED_CALLER: ContentCaller = { ownerUserId: null, isOperator: false };

// Secrets a user must never read even out of their OWN repo (defense-in-depth on
// top of the connector's gh*-token redaction). Personal sources carry no
// allowedPaths (whole repo readable — see checkPath), only these denials.
const PERSONAL_DENIED_PATHS = [".git", ".env", ".dev.vars", ".wrangler", "node_modules"];

// A stored personal (BYO) source row → the in-memory ContentSource the rest of
// ContentHub already understands. `owner_user_id` is the tenant-isolation key.
function personalRowToContentSource(row: UserContentSourceRow): ContentSource {
  return {
    id: row.source_id,
    provider: "github",
    label: row.label ?? row.repo,
    scope: "personal",
    access: "read",
    authMode: "secret",
    owner_user_id: row.owner_user_id,
    defaultRef: row.default_ref ?? undefined,
    deniedPaths: PERSONAL_DENIED_PATHS,
    capabilities: { read: true, list: true, search: true, health: true },
  };
}

// Parse the stored "owner/repo" into the connector's GithubRepo. null on a
// malformed value → the caller surfaces `no-repo-mapping` (never a silent fetch).
function parsePersonalRepo(row: UserContentSourceRow): GithubRepo | null {
  const parts = row.repo.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  return { owner: parts[0], repo: parts[1], defaultRef: row.default_ref ?? "main" };
}

function preview(s: string | undefined | null, max = AUDIT_PREVIEW_MAX): string | null {
  if (s === undefined || s === null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function clampMaxBytes(input: number | undefined): number {
  const v = input ?? DEFAULT_READ_MAX_BYTES;
  if (v <= 0) return DEFAULT_READ_MAX_BYTES;
  if (v > HARD_READ_MAX_BYTES) return HARD_READ_MAX_BYTES;
  return v;
}

function buildRef(input: { sourceId: string; path: string; sha: string; ref: string; cacheStatus: ContentRef["cacheStatus"]; }): ContentRef {
  return {
    sourceId: input.sourceId,
    provider: "github",
    pathOrId: input.path,
    revision: { kind: "git-sha", sha: input.sha, ref: input.ref },
    revisionLabel: `${input.ref}@${input.sha.slice(0, 7)}`,
    fetchedAt: Date.now(),
    permissionScope: "read",
    cacheStatus: input.cacheStatus,
  };
}

function ghErrorToContentError(e: unknown, sourceId: string, path: string): ContentError {
  if (e instanceof GithubContentError) {
    return { code: e.code, reason: e.message, sourceId, path, status: e.status };
  }
  return {
    code: "internal",
    reason: e instanceof Error ? e.message : String(e),
    sourceId,
    path,
  };
}

export class ContentHubAgent extends Agent<Env, Record<string, never>> {
  async onStart(props?: unknown): Promise<void> {
    await super.onStart(props as Record<string, unknown> | undefined);

    // revision-pinned content cache. Key = (source_id, path,
    // revision_key, result_kind). LRU eviction by `last_access_at`. No TTL
    // (ADR §6: TTL is the偷懒 path; revision-pinned keys self-invalidate
    // when ref changes).
    this.sql`
      CREATE TABLE IF NOT EXISTS content_cache (
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        revision_key TEXT NOT NULL,
        result_kind TEXT NOT NULL,
        result_json TEXT NOT NULL,
        size INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        last_access_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, path, revision_key, result_kind)
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_content_cache_lru ON content_cache(last_access_at)`;

    // structured audit log for ContentHub access. Row shape
    // mirrors AgentThursdayAgent.event_log (event_type, payload-JSON, created_at,
    // trace_id) so reviewers can scan ContentHub access via /api/inspect
    // alongside tool/* events. `trace_id` is nullable: v1 doesn't yet thread
    // task ids across the AgentThursdayAgent → ContentHubAgent boundary, but the
    // column reservation lets us add propagation without a schema migration.
    // Bounded by AUDIT_MAX_ROWS; oldest evicted on insert.
    this.sql`
      CREATE TABLE IF NOT EXISTS audit_log (
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        trace_id TEXT
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(created_at)`;

    // BYO GitHub (2026-06-26) — owner-scoped per-user (BYO) content sources.
    ensureUserContentSourceTable(this._userContentHost());
  }

  // ── BYO GitHub — owner-scoped source resolution + token gate ─────────────

  private _userContentHost(): { sql: UserContentSourceSqlTag } {
    return { sql: this.sql.bind(this) as unknown as UserContentSourceSqlTag };
  }

  /**
   * Resolve a source id to its ContentSource + GithubRepo, from the hardcoded
   * registry (operator `project` + `fixture`) FIRST, then the owner-scoped
   * personal (BYO) store. `null` = unknown id (callers surface `source-not-found`).
   * Resolution alone grants NOTHING — `_accessDenial` (canAccessSource) is the
   * access gate and `_resolveTokenForSource` is the credential gate.
   */
  private _resolveSource(sourceId: string): { source: ContentSource; repo: GithubRepo | null } | null {
    const hard = findSource(sourceId);
    if (hard) return { source: hard, repo: getRepoForSource(hard.id) };
    const row = getUserContentSourceById(this._userContentHost(), sourceId);
    if (row) return { source: personalRowToContentSource(row), repo: parsePersonalRepo(row) };
    return null;
  }

  /**
   * Access gate (which source ids a caller may name) — shared by list/read/
   * search single-mode. Returns the denial error code, or null when allowed OR
   * when the id is unknown (deferred to `_do*` for a uniform `source-not-found`).
   * A foreign tenant's PERSONAL source is hidden as `source-not-found` (don't
   * leak that another user registered it); an operator-internal `project` source
   * stays the existing `forbidden-source`.
   */
  private _accessDenial(
    sourceId: string,
    caller: ContentCaller,
  ): { code: "forbidden-source" | "source-not-found"; reason: string } | null {
    const resolved = this._resolveSource(sourceId);
    if (resolved === null) return null;
    const access = canAccessSource({
      scope: resolved.source.scope,
      sourceOwnerId: resolved.source.owner_user_id ?? null,
      callerOwnerId: caller.ownerUserId,
      isOperator: caller.isOperator,
    });
    if (access.allow) return null;
    if (resolved.source.scope === "personal") {
      return { code: "source-not-found", reason: unknownSourceReason(sourceId) };
    }
    return { code: "forbidden-source", reason: "operator-internal content source not available to this tenant" };
  }

  /**
   * THE CATASTROPHIC GATE — whose credential reads a source's bytes. The ONLY
   * place `env.GITHUB_TOKEN` is read (the `project` branch). A `personal` (BYO)
   * source resolves its token EXCLUSIVELY from its OWNER's encrypted
   * `user_provider_credential('github')` (reuses the registry's
   * `getProviderCredentialSecret`, the same decrypt path getModel uses, owner
   * passed as an explicit RPC arg — an earlier revision proved that crosses); absent →
   * hard `token-missing`; NEVER falls back to the env token (that has broad
   * private-repo access — a fallback would let a user read someone else's repo
   * through operator creds). Any other scope → `token-missing`, never env.
   *
   * Defense-in-depth behind `canAccessSource`: the token is fetched for the
   * SOURCE's owner, and only when the verified caller IS that owner.
   */
  private async _resolveTokenForSource(
    source: ContentSource,
    callerOwnerId: string | null,
  ): Promise<{ ok: true; token: string } | { ok: false; error: ContentError }> {
    // The env-vs-owner-vs-none DECISION is the pure, unit-tested `tokenPlanForSource`
    // (never env for a personal source). This method only EXECUTES the plan.
    const plan = tokenPlanForSource({ scope: source.scope, sourceOwnerId: source.owner_user_id, callerOwnerId });
    if (plan.source === "env") {
      const token = this.env.GITHUB_TOKEN;
      if (!token) return { ok: false, error: { code: "token-missing", reason: "GITHUB_TOKEN env not set", sourceId: source.id } };
      return { ok: true, token };
    }
    if (plan.source === "owner-credential") {
      try {
        const registry = await getAgentByName<Env, AgentThursdayAgent>(
          this.env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
          DEMO_INSTANCE,
        );
        const row = await registry.getProviderCredentialSecret({ provider: "github" }, { kind: "user", userId: plan.ownerUserId });
        if (row && typeof row.api_key === "string" && row.api_key.length > 0) {
          return { ok: true, token: row.api_key };
        }
      } catch {
        /* fall through to token-missing — NEVER env fallback for a user source */
      }
      return { ok: false, error: { code: "token-missing", reason: "no github credential configured for this source's owner", sourceId: source.id } };
    }
    return { ok: false, error: { code: "token-missing", reason: plan.reason, sourceId: source.id } };
  }

  // ── BYO GitHub — owner-scoped registration (Unit 3) ──────────────────────
  /**
   * Register a personal (BYO) GitHub content source for the CALLER. The owner is
   * server-stamped from the resolved `identity` — NEVER from client input — and the
   * `source_id` is server-generated, unguessable, and never reused (so it can't
   * shadow a hardcoded source or collide across tenants). Registration is for
   * scoped users only (admin uses project sources). The PAT itself is stored
   * separately in the registry's owner-scoped `user_provider_credential('github')`.
   */
  @callable()
  registerUserContentSource(
    input: { repo: string; label?: string | null; default_ref?: string | null },
    identity?: RequestIdentity,
  ): { ok: true; source_id: string } | { ok: false; code: string; message: string } {
    const owner = identity !== undefined && identity.kind === "user" ? identity.userId : null;
    if (owner === null) {
      return { ok: false, code: "registration_requires_user", message: "content source registration requires a scoped user identity" };
    }
    const repo = typeof input.repo === "string" ? input.repo.trim() : "";
    const parts = repo.split("/");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      return { ok: false, code: "invalid_repo", message: "repo must be in 'owner/repo' form" };
    }
    const sourceId = newUserSourceId();
    if (findSource(sourceId) !== null || getUserContentSourceById(this._userContentHost(), sourceId) !== null) {
      return { ok: false, code: "id_collision", message: "generated id collided; retry" };
    }
    insertUserContentSource(this._userContentHost(), {
      source_id: sourceId,
      owner_user_id: owner,
      provider: "github",
      repo,
      default_ref: input.default_ref ?? null,
      label: input.label ?? null,
    }, new Date().toISOString());
    this.logAudit("content.source.registered", { sourceId: preview(sourceId), owner: preview(owner), repoPreview: preview(repo) });
    return { ok: true, source_id: sourceId };
  }

  /**
   * Remove one of the CALLER's own personal sources. Owner-scoped at the SQL
   * level (`deleteUserContentSourceRow` only deletes a row owned by `owner`), so a
   * user can never delete another tenant's source even by guessing its id. Also
   * purges any cached bytes for the id.
   */
  @callable()
  deleteUserContentSource(input: { source_id: string }, identity?: RequestIdentity): { ok: boolean } {
    const owner = identity !== undefined && identity.kind === "user" ? identity.userId : null;
    if (owner === null) return { ok: false };
    const removed = deleteUserContentSourceRow(this._userContentHost(), input.source_id, owner);
    if (removed) {
      this.sql`DELETE FROM content_cache WHERE source_id = ${input.source_id}`;
      this.logAudit("content.source.deleted", { sourceId: preview(input.source_id), owner: preview(owner) });
    }
    return { ok: removed };
  }

  /**
   * append a structured audit entry. Best-effort: on serialize or
   * sql failure the operation is swallowed (per spec: audit must NOT break
   * the underlying content op). Caller is responsible for ensuring `payload`
   * already contains only safe fields — this helper does no further redaction.
   *
   * `traceId` is reserved for future cross-DO trace propagation; v1 callers
   * pass `null` (or omit) and the column stores NULL.
   */
  private logAudit(eventType: string, payload: Record<string, unknown>, traceId: string | null = null): void {
    try {
      const at = Date.now();
      const json = JSON.stringify(payload);
      this.sql`
        INSERT INTO audit_log (event_type, payload, created_at, trace_id)
        VALUES (${eventType}, ${json}, ${at}, ${traceId})
      `;
      const count = Number(
        (this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM audit_log`)[0]?.n ?? 0,
      );
      if (count > AUDIT_MAX_ROWS) {
        const toDelete = count - AUDIT_MAX_ROWS;
        this.sql`
          DELETE FROM audit_log WHERE rowid IN (
            SELECT rowid FROM audit_log ORDER BY created_at ASC LIMIT ${toDelete}
          )
        `;
      }
    } catch {
      // Swallow: audit MUST NOT break content ops.
    }
  }

  /**
   * recent ContentHub audit events for /api/inspect. Newest-first.
   * Defaults to 100 rows; capped at the table's AUDIT_MAX_ROWS.
   */
  @callable()
  async getRecentAuditEvents(input?: { limit?: number }): Promise<Array<{ type: string; at: number; payload: unknown; traceId: string | null }>> {
    const limit = Math.max(1, Math.min(AUDIT_MAX_ROWS, input?.limit ?? 100));
    const rows = this.sql<AuditLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM audit_log
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(r => {
      let payload: unknown = r.payload;
      try { payload = JSON.parse(r.payload); } catch { /* keep raw string */ }
      return { type: r.event_type, at: r.created_at, payload, traceId: r.trace_id };
    });
  }

  /**
   * aggregated evidence-pack summary over the audit_log. Three
   * pivot views (byTraceId / bySourceId / byOperation) computed from already-
   * redacted audit row metadata. NO raw content, NO hit previews, NO token —
   * the audit rows themselves are the safe-only source of truth .
   *
   * Best-effort: any individual row that fails to JSON-parse is skipped, not
   * propagated. Aggregation never throws — caller (`/api/inspect`) can rely
   * on this returning a valid (possibly empty) summary even on degraded
   * audit data.
   */
  @callable()
  async getContentEvidence(input?: { limit?: number }): Promise<ContentAuditSummary> {
    const limit = Math.max(1, Math.min(AUDIT_MAX_ROWS, input?.limit ?? AUDIT_MAX_ROWS));
    const rows = this.sql<AuditLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM audit_log
      ORDER BY created_at DESC LIMIT ${limit}
    `;

    const emptyOpCounts = (): ContentAuditOperationCounts => ({ sources: 0, list: 0, read: 0, search: 0 });
    const opOf = (eventType: string): keyof ContentAuditOperationCounts | null => {
      // event_type is `content.<op>`; only count the four known operations.
      if (eventType === "content.sources") return "sources";
      if (eventType === "content.list") return "list";
      if (eventType === "content.read") return "read";
      if (eventType === "content.search") return "search";
      return null;
    };

    type TraceAccum = ContentAuditByTrace & { _sourceIds: Set<string> };
    type SourceAccum = ContentAuditBySource & { _traceIds: Set<string> };
    const byTrace = new Map<string, TraceAccum>();
    const bySource = new Map<string, SourceAccum>();
    const byOperation = new Map<keyof ContentAuditOperationCounts, ContentAuditByOperation & { _sourceIds: Set<string> }>();
    let processedRows = 0;
    let windowStart: number | null = null;
    let windowEnd: number | null = null;

    for (const row of rows) {
      const op = opOf(row.event_type);
      if (op === null) continue; // ignore non-content.* rows defensively

      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.payload);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {
        // skip un-parsable rows; they don't contribute aggregates.
        continue;
      }

      const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : null;
      const ok = payload.ok === true;
      const latencyRaw = payload.latencyMs;
      const latency = typeof latencyRaw === "number" && latencyRaw >= 0 ? Math.floor(latencyRaw) : 0;

      processedRows++;
      if (windowStart === null || row.created_at < windowStart) windowStart = row.created_at;
      if (windowEnd === null || row.created_at > windowEnd) windowEnd = row.created_at;

      // byTraceId — only LLM-driven rows (traceId non-null) participate;
      // direct API rows skip this view but appear in bySourceId/byOperation.
      const traceId = row.trace_id;
      if (traceId !== null && traceId.length > 0) {
        let t = byTrace.get(traceId);
        if (!t) {
          t = {
            traceId,
            opCounts: emptyOpCounts(),
            sourceIds: [],
            _sourceIds: new Set<string>(),
            okCount: 0,
            errorCount: 0,
            latencyMsTotal: 0,
            firstAt: row.created_at,
            lastAt: row.created_at,
          };
          byTrace.set(traceId, t);
        }
        t.opCounts[op]++;
        if (sourceId) t._sourceIds.add(sourceId);
        if (ok) t.okCount++; else t.errorCount++;
        t.latencyMsTotal += latency;
        if (row.created_at < t.firstAt) t.firstAt = row.created_at;
        if (row.created_at > t.lastAt) t.lastAt = row.created_at;
      }

      // bySourceId — every row with a sourceId participates, including
      // direct API. directApiCount tracks the traceId-null subset so
      // reviewers can tell agent activity apart from operator smoke.
      if (sourceId) {
        let s = bySource.get(sourceId);
        if (!s) {
          s = {
            sourceId,
            opCounts: emptyOpCounts(),
            _traceIds: new Set<string>(),
            traceIdCount: 0,
            directApiCount: 0,
            okCount: 0,
            errorCount: 0,
            latencyMsTotal: 0,
            firstAt: row.created_at,
            lastAt: row.created_at,
          };
          bySource.set(sourceId, s);
        }
        s.opCounts[op]++;
        if (traceId !== null && traceId.length > 0) s._traceIds.add(traceId);
        else s.directApiCount++;
        if (ok) s.okCount++; else s.errorCount++;
        s.latencyMsTotal += latency;
        if (row.created_at < s.firstAt) s.firstAt = row.created_at;
        if (row.created_at > s.lastAt) s.lastAt = row.created_at;
      }

      // byOperation — every row participates (no sourceId requirement).
      let o = byOperation.get(op);
      if (!o) {
        o = {
          operation: op,
          count: 0,
          _sourceIds: new Set<string>(),
          sourceIdCount: 0,
          okCount: 0,
          errorCount: 0,
          latencyMsTotal: 0,
        };
        byOperation.set(op, o);
      }
      o.count++;
      if (sourceId) o._sourceIds.add(sourceId);
      if (ok) o.okCount++; else o.errorCount++;
      o.latencyMsTotal += latency;
    }

    // Materialize: turn _sourceIds / _traceIds Sets into sorted arrays /
    // counts; strip the underscore-prefixed scratch fields.
    const byTraceIdOut: ContentAuditByTrace[] = [...byTrace.values()]
      .map(t => ({
        traceId: t.traceId,
        opCounts: t.opCounts,
        sourceIds: [...t._sourceIds].sort(),
        okCount: t.okCount,
        errorCount: t.errorCount,
        latencyMsTotal: t.latencyMsTotal,
        firstAt: t.firstAt,
        lastAt: t.lastAt,
      }))
      .sort((a, b) => b.lastAt - a.lastAt);

    const bySourceIdOut: ContentAuditBySource[] = [...bySource.values()]
      .map(s => ({
        sourceId: s.sourceId,
        opCounts: s.opCounts,
        traceIdCount: s._traceIds.size,
        directApiCount: s.directApiCount,
        okCount: s.okCount,
        errorCount: s.errorCount,
        latencyMsTotal: s.latencyMsTotal,
        firstAt: s.firstAt,
        lastAt: s.lastAt,
      }))
      .sort((a, b) => b.lastAt - a.lastAt);

    const byOperationOut: ContentAuditByOperation[] = [...byOperation.values()]
      .map(o => ({
        operation: o.operation,
        count: o.count,
        sourceIdCount: o._sourceIds.size,
        okCount: o.okCount,
        errorCount: o.errorCount,
        latencyMsTotal: o.latencyMsTotal,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRows: processedRows,
      windowStart,
      windowEnd,
      byTraceId: byTraceIdOut,
      bySourceId: bySourceIdOut,
      byOperation: byOperationOut,
    };
  }

  // ─── source registry listing ────────────────────────────────
  /**
   * List registered content sources. v1 returns hardcoded `agentthursday-github`.
   * Delegates to `listSources` in `contentRegistry.ts`.
   */
  @callable()
  async getSources(input?: ListSourcesInput, traceId: string | null = null, caller: ContentCaller = FAIL_CLOSED_CALLER): Promise<ContentSourcesResponse> {
    const startedAt = Date.now();
    const includeHealth = input?.includeHealth !== false;
    const listed = listSources(input);
    // a scoped caller never even SEES operator-internal `project`
    // sources (filtered from discovery so the agent can't learn the private repo
    // exists). canAccessSource is the single source of truth for visibility.
    const hardcoded = listed.sources.filter(s =>
      canAccessSource({
        scope: s.source.scope,
        sourceOwnerId: s.source.owner_user_id ?? null,
        callerOwnerId: caller.ownerUserId,
        isOperator: caller.isOperator,
      }).allow,
    );
    // BYO GitHub — plus the caller's OWN personal (BYO) sources (owner-scoped
    // store; never another tenant's). Honors the `sourceId` filter like listSources.
    const personalRows = caller.ownerUserId !== null
      ? listUserContentSourcesByOwner(this._userContentHost(), caller.ownerUserId)
      : [];
    const personal: ContentSourceWithHealth[] = personalRows
      .filter(r => !input?.sourceId || r.source_id === input.sourceId)
      .map(r => {
        const source = personalRowToContentSource(r);
        return includeHealth ? { source, health: staticHealth(source) } : { source };
      });
    const result: ContentSourcesResponse = { sources: [...hardcoded, ...personal] };
    this.logAudit("content.sources", {
      ok: true,
      sourceIdFilter: input?.sourceId ? preview(input.sourceId) : null,
      includeHealth,
      resultCount: result.sources.length,
      personalCount: personal.length,
      isOperator: caller.isOperator,
      callerOwnerId: preview(caller.ownerUserId),
      latencyMs: Date.now() - startedAt,
    }, traceId);
    return result;
  }

  // ─── GitHub-backed list ─────────────────────────────────────
  /**
   * List a directory in a content source. For `agentthursday-github`:
   *   - empty path → synthetic top-level (registry-derived, no network)
   *   - other paths → GitHub Contents API at the resolved commit SHA
   *
   * Returns `{ ok: false, error }` for path-policy / GitHub failures so
   * the API endpoint and tool wrapper can forward without try/catch.
   *
   * public wrapper appends a `content.list` audit row to the DO
   * audit_log. The inner `_doList` keeps the original an earlier revision logic unchanged.
   */
  @callable()
  async list(input: ContentListCallableInput, traceId: string | null = null, caller: ContentCaller = FAIL_CLOSED_CALLER): Promise<ContentListResponse> {
    const startedAt = Date.now();
    const denial = this._accessDenial(input.sourceId, caller);
    if (denial) {
      this.logAudit("content.list", { ok: false, sourceId: preview(input.sourceId), errorCode: denial.code, isOperator: caller.isOperator, callerOwnerId: preview(caller.ownerUserId), latencyMs: Date.now() - startedAt }, traceId);
      return { ok: false, error: { code: denial.code, reason: denial.reason, sourceId: input.sourceId } };
    }
    const response = await this._doList(input, caller.ownerUserId);
    this.logAudit("content.list", {
      ok: response.ok,
      sourceId: preview(input.sourceId),
      pathPreview: preview(input.path),
      refPreview: preview(input.ref ?? null),
      revisionLabel: response.ok ? response.result.ref.revisionLabel : null,
      cacheStatus: response.ok ? response.result.ref.cacheStatus : null,
      resultCount: response.ok ? response.result.entries.length : null,
      errorCode: response.ok ? null : response.error.code,
      httpStatus: response.ok ? null : (response.error.status ?? null),
      latencyMs: Date.now() - startedAt,
    }, traceId);
    return response;
  }

  private async _doList(input: ContentListCallableInput, callerOwnerId: string | null): Promise<ContentListResponse> {
    const resolved = this._resolveSource(input.sourceId);
    if (!resolved) {
      return { ok: false, error: { code: "source-not-found", reason: unknownSourceReason(input.sourceId), sourceId: input.sourceId } };
    }
    const { source, repo } = resolved;
    // M7.4 v2 Local-fs provider branch. No network, no token,
    // content-hash revision; everything else (path safety, audit shape,
    // ContentRef provenance) stays uniform with GitHub via the shared
    // ContentSourceConnector contract.
    if (source.provider === "local-fs") {
      try {
        const result = localFsList(source, input.path);
        return { ok: true, result };
      } catch (e) {
        if (e instanceof LocalFsContentError) {
          return { ok: false, error: { code: e.code, reason: e.message, sourceId: source.id, path: input.path, status: e.status } };
        }
        return { ok: false, error: { code: "internal", reason: e instanceof Error ? e.message : String(e), sourceId: source.id, path: input.path } };
      }
    }
    if (source.provider !== "github") {
      return { ok: false, error: { code: "no-repo-mapping", reason: `provider not implemented: ${source.provider}`, sourceId: source.id } };
    }
    if (!repo) {
      return { ok: false, error: { code: "no-repo-mapping", reason: `no repo binding for source`, sourceId: source.id } };
    }

    // Top-level listing. For the operator repo this is a synthetic,
    // registry-derived listing (no network); a personal (BYO) source has no
    // registry allow-list, so its top-level is a REAL root fetch (path "").
    const isTopLevel = input.path === "" || input.path === "/";
    if (isTopLevel && source.scope !== "personal") {
      return {
        ok: true,
        result: {
          ref: {
            sourceId: source.id,
            provider: "github",
            pathOrId: "",
            revision: { kind: "none" },
            revisionLabel: "registry-synthetic",
            fetchedAt: Date.now(),
            permissionScope: "read",
            cacheStatus: "fresh",
          },
          entries: synthesizeTopLevelEntries(source),
        },
      };
    }

    // Path policy. Personal top-level ("" or "/") fetches the repo root.
    const pathForPolicy = isTopLevel ? "" : input.path;
    const policy = checkPath(source, pathForPolicy);
    if (!policy.ok) {
      return { ok: false, error: { code: policy.code, reason: policy.reason, sourceId: source.id, path: input.path } };
    }
    const normalized = policy.normalized;

    // Token (chokepoint): project → env; personal → owner's own github cred.
    const tok = await this._resolveTokenForSource(source, callerOwnerId);
    if (!tok.ok) return { ok: false, error: tok.error };
    const token = tok.token;

    const ref = input.ref ?? source.defaultRef ?? repo.defaultRef;

    let sha: string;
    try {
      sha = await resolveRefToSha(repo, ref, token);
    } catch (e) {
      return { ok: false, error: ghErrorToContentError(e, source.id, normalized) };
    }

    const revision: ContentRevision = { kind: "git-sha", sha, ref };
    const revisionKey = JSON.stringify(revision);

    // Cache lookup.
    const cached = this.sql<CacheRow>`
      SELECT * FROM content_cache
      WHERE source_id = ${source.id}
        AND path = ${normalized}
        AND revision_key = ${revisionKey}
        AND result_kind = 'list'
    `;
    if (cached.length > 0) {
      const now = Date.now();
      this.sql`
        UPDATE content_cache SET last_access_at = ${now}
        WHERE source_id = ${source.id}
          AND path = ${normalized}
          AND revision_key = ${revisionKey}
          AND result_kind = 'list'
      `;
      const stored = JSON.parse(cached[0].result_json) as ContentListResult;
      return {
        ok: true,
        result: {
          ...stored,
          ref: { ...stored.ref, fetchedAt: now, cacheStatus: "hit" },
        },
      };
    }

    // Network fetch.
    let entries;
    try {
      entries = await fetchContentsList(repo, sha, normalized, token);
    } catch (e) {
      return { ok: false, error: ghErrorToContentError(e, source.id, normalized) };
    }

    const result: ContentListResult = {
      ref: buildRef({ sourceId: source.id, path: normalized, sha, ref, cacheStatus: "miss" }),
      entries,
    };
    this.cachePut(source.id, normalized, revisionKey, "list", result, entries.length);
    return { ok: true, result };
  }

  // ─── GitHub-backed read ─────────────────────────────────────
  /**
   * Read a single file in a content source. Always:
   *   - rejects denied/unsafe paths before any network call
   *   - resolves ref → commit SHA (so cache key is revision-pinned)
   *   - caps bytes at maxBytes (default 256KB; hard cap 1MB)
   *   - applies high-confidence secret redaction (PEM = whole-file refusal)
   *   - returns `cacheStatus: "hit" | "miss"` and provenance
   *
   * public wrapper appends a `content.read` audit row. The inner
   * `_doRead` keeps the original an earlier revision logic unchanged. Audit payload
   * deliberately excludes content; only metadata fields are recorded.
   */
  @callable()
  async read(input: ContentReadCallableInput, traceId: string | null = null, caller: ContentCaller = FAIL_CLOSED_CALLER): Promise<ContentReadResponse> {
    const startedAt = Date.now();
    const denial = this._accessDenial(input.sourceId, caller);
    if (denial) {
      this.logAudit("content.read", { ok: false, sourceId: preview(input.sourceId), errorCode: denial.code, isOperator: caller.isOperator, callerOwnerId: preview(caller.ownerUserId), latencyMs: Date.now() - startedAt }, traceId);
      return { ok: false, error: { code: denial.code, reason: denial.reason, sourceId: input.sourceId } };
    }
    const response = await this._doRead(input, caller.ownerUserId);
    this.logAudit("content.read", {
      ok: response.ok,
      sourceId: preview(input.sourceId),
      pathPreview: preview(input.path),
      refPreview: preview(input.ref ?? null),
      maxBytes: input.maxBytes ?? null,
      revisionLabel: response.ok ? response.result.ref.revisionLabel : null,
      cacheStatus: response.ok ? response.result.ref.cacheStatus : null,
      size: response.ok ? response.result.size : null,
      truncated: response.ok ? !!response.result.truncated : null,
      redactionsCount: response.ok ? (response.result.redactions?.length ?? 0) : null,
      errorCode: response.ok ? null : response.error.code,
      httpStatus: response.ok ? null : (response.error.status ?? null),
      latencyMs: Date.now() - startedAt,
    }, traceId);
    return response;
  }

  private async _doRead(input: ContentReadCallableInput, callerOwnerId: string | null): Promise<ContentReadResponse> {
    const resolved = this._resolveSource(input.sourceId);
    if (!resolved) {
      return { ok: false, error: { code: "source-not-found", reason: unknownSourceReason(input.sourceId), sourceId: input.sourceId } };
    }
    const { source, repo } = resolved;
    // M7.4 v2 Local-fs provider branch. Synchronous in-process
    // fixture lookup; no network, no token, content-hash revision. Honors
    // the shared ContentReadResponse contract so audit shape stays uniform.
    if (source.provider === "local-fs") {
      try {
        const result = localFsRead(source, input.path);
        return { ok: true, result };
      } catch (e) {
        if (e instanceof LocalFsContentError) {
          return { ok: false, error: { code: e.code, reason: e.message, sourceId: source.id, path: input.path, status: e.status } };
        }
        return { ok: false, error: { code: "internal", reason: e instanceof Error ? e.message : String(e), sourceId: source.id, path: input.path } };
      }
    }
    if (source.provider !== "github") {
      return { ok: false, error: { code: "no-repo-mapping", reason: `provider not implemented: ${source.provider}`, sourceId: source.id } };
    }
    if (!repo) {
      return { ok: false, error: { code: "no-repo-mapping", reason: `no repo binding for source`, sourceId: source.id } };
    }

    const policy = checkPath(source, input.path);
    if (!policy.ok) {
      return { ok: false, error: { code: policy.code, reason: policy.reason, sourceId: source.id, path: input.path } };
    }
    const normalized = policy.normalized;

    // Token (chokepoint): project → env; personal → owner's own github cred.
    const tok = await this._resolveTokenForSource(source, callerOwnerId);
    if (!tok.ok) return { ok: false, error: tok.error };
    const token = tok.token;

    const maxBytes = clampMaxBytes(input.maxBytes);
    // 2026-06-29 — windowed/paginated read. offset>0 reads bytes [offset, offset+maxBytes)
    // and bypasses the (offset-agnostic) cache so windows aren't conflated.
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const ref = input.ref ?? source.defaultRef ?? repo.defaultRef;

    let sha: string;
    try {
      sha = await resolveRefToSha(repo, ref, token);
    } catch (e) {
      return { ok: false, error: ghErrorToContentError(e, source.id, normalized) };
    }

    const revision: ContentRevision = { kind: "git-sha", sha, ref };
    const revisionKey = JSON.stringify(revision);

    // Cache lookup. Cache key intentionally does not include maxBytes — a
    // smaller maxBytes hit on a cached larger payload is acceptable since
    // we re-truncate after read; a larger maxBytes after a smaller
    // truncated cached entry should re-fetch (handled below).
    const cached = offset === 0 ? this.sql<CacheRow>`
      SELECT * FROM content_cache
      WHERE source_id = ${source.id}
        AND path = ${normalized}
        AND revision_key = ${revisionKey}
        AND result_kind = 'read'
    ` : [];
    if (cached.length > 0) {
      const stored = JSON.parse(cached[0].result_json) as ContentReadResult;
      // If the cached payload was truncated and the caller is asking for
      // more bytes than we have, re-fetch. Otherwise return the cache hit.
      const cachedBytes = stored.truncatedBytes ?? stored.size;
      // Refetch if the cache holds fewer bytes than the caller now wants (was
      // truncated + bigger ask) OR MORE bytes than the requested window (a
      // smaller windowed read must not be served a larger cached payload —
      // 2026-06-29 pagination; also self-heals pre-pagination whole-file caches).
      const needsRefetch = (!!stored.truncated && maxBytes > cachedBytes) || cachedBytes > maxBytes;
      if (!needsRefetch) {
        const now = Date.now();
        this.sql`
          UPDATE content_cache SET last_access_at = ${now}
          WHERE source_id = ${source.id}
            AND path = ${normalized}
            AND revision_key = ${revisionKey}
            AND result_kind = 'read'
        `;
        return {
          ok: true,
          result: {
            ...stored,
            ref: { ...stored.ref, fetchedAt: now, cacheStatus: "hit" },
          },
        };
      }
    }

    // Network fetch (windowed: bytes [offset, offset+maxBytes)).
    let raw;
    try {
      raw = await fetchRawFile(repo, sha, normalized, token, maxBytes, offset);
    } catch (e) {
      return { ok: false, error: ghErrorToContentError(e, source.id, normalized) };
    }

    // Secret redaction. PEM private keys cause whole-file refusal; other
    // patterns are inline-replaced with offset metadata.
    const { content, redactions, refusedWholeFile } = redactSecrets(raw.content);

    // 2026-06-29 — pagination continuation hints so a model can page a large
    // file without loading it whole. remainingLines is APPROXIMATE (estimated
    // from this window's bytes-per-line).
    const bytesReturned = raw.bytesReturned;
    const nextOffset = offset + bytesReturned;
    const remainingBytes = Math.max(0, raw.size - nextOffset);
    const hasMore = raw.truncated === true && remainingBytes > 0;
    const windowLines = content.length === 0 ? 0 : content.split("\n").length;
    const remainingLines = hasMore && bytesReturned > 0
      ? Math.round(remainingBytes / (bytesReturned / Math.max(1, windowLines)))
      : 0;

    const result: ContentReadResult = {
      ref: buildRef({ sourceId: source.id, path: normalized, sha, ref, cacheStatus: "miss" }),
      content,
      contentType: "text/plain; charset=utf-8",
      size: raw.size,
      ...(raw.truncated ? { truncated: true } : {}),
      ...(raw.truncatedBytes !== undefined ? { truncatedBytes: raw.truncatedBytes } : {}),
      ...(redactions.length > 0 ? { redactions } : {}),
      offset,
      bytesReturned,
      ...(hasMore ? { hasMore: true, nextOffset, remainingBytes, remainingLines } : { hasMore: false }),
    };

    // Cache-as-stored should be the redacted form so future reads never
    // serve raw secrets. PEM-refused content is also cached as the refusal
    // marker; if upstream rotates the file, the next ref change invalidates
    // this entry naturally. Only the offset=0 window is cached (the cache key
    // is offset-agnostic; caching a non-zero window would mis-serve offset=0).
    if (offset === 0) this.cachePut(source.id, normalized, revisionKey, "read", result, raw.size);

    // Audit-relevant marker (for an earlier revision): emit a noop log line so it's
    // grep-able in production logs without surfacing secret offsets.
    if (refusedWholeFile) {
      console.warn(`[contenthub] PEM-refusal: source=${source.id} path=${normalized.slice(0, 80)}`);
    }

    return { ok: true, result };
  }

  // ─── search (api-search default, bounded-local opt-in) ──────
  /**
   * Literal search over an external Content Source.
   *
   * Strategies:
   *   - `api-search` (default): GitHub Code Search REST. Fail-loud — quota
   *     exhaustion or auth/5xx returns `{ok:false, error:{code, fallbackAvailable, fallbackHint}}`.
   *     Caller chooses whether to retry with `bounded-local`. Per ADR §7.1
   *     the framework MUST NOT auto-degrade.
   *   - `bounded-local`: walk listings via `this.list` (path policy + cache),
   *     fetch each file via `this.read` (cap 32KB), grep literal `query`.
   *     Always returns `searchMode:"degraded-grep"`, `searchCoverage:"partial"`,
   *     `searchedPaths`, and `omittedReason` — even on zero hits.
   *
   * Out of scope (per an earlier revision): semantic / vector / multi-source / regex.
   *
   * public wrapper appends a `content.search` audit row. The inner
   * `_doSearch` keeps the original an earlier revision logic unchanged. The audit payload
   * intentionally excludes hit previews to avoid duplicating result content;
   * only counts and metadata are recorded.
   */
  @callable()
  async search(input: ContentSearchCallableInput, traceId: string | null = null, caller: ContentCaller = FAIL_CLOSED_CALLER): Promise<ContentSearchResponse> {
    const startedAt = Date.now();

    // `sourceId` ⊕ `sourceIds` mutual exclusion. The HTTP route's
    // Zod refinement enforces this at request boundary; the DO callable also
    // enforces it so cross-DO callers (LLM tool wrapper) can't bypass.
    const hasSingle = typeof input.sourceId === "string" && input.sourceId.length > 0;
    const hasMulti = Array.isArray(input.sourceIds) && input.sourceIds.length > 0;
    if (hasSingle === hasMulti) {
      const response: ContentSearchResponse = {
        ok: false,
        error: {
          code: "search-failed",
          reason: "must provide exactly one of `sourceId` or `sourceIds`, not both and not neither",
        },
      };
      this.logAudit("content.search", {
        ok: false,
        mode: hasSingle && hasMulti ? "both-set" : "neither-set",
        queryPreview: preview(input.query),
        errorCode: "search-failed",
        latencyMs: Date.now() - startedAt,
      }, traceId);
      return response;
    }

    // an earlier revision + BYO — gate by source access. Single mode is denied outright;
    // multi mode drops inaccessible sources from the fan-out below.
    if (hasSingle) {
      const denial = this._accessDenial(input.sourceId!, caller);
      if (denial) {
        this.logAudit("content.search", { ok: false, mode: "single", sourceId: preview(input.sourceId!), queryPreview: preview(input.query), errorCode: denial.code, isOperator: caller.isOperator, callerOwnerId: preview(caller.ownerUserId), latencyMs: Date.now() - startedAt }, traceId);
        return { ok: false, error: { code: denial.code, reason: denial.reason, sourceId: input.sourceId } };
      }
    }

    if (hasSingle) {
      // Single-source mode — an earlier revision behavior preserved verbatim.
      const response = await this._doSearch({
        sourceId: input.sourceId!,
        query: input.query,
        path: input.path,
        ref: input.ref,
        strategy: input.strategy,
        maxResults: input.maxResults,
      }, caller.ownerUserId);
      this.logAudit("content.search", {
        ok: response.ok,
        mode: "single",
        sourceId: preview(input.sourceId!),
        queryPreview: preview(input.query),
        pathPreview: preview(input.path ?? null),
        refPreview: preview(input.ref ?? null),
        strategy: input.strategy ?? "api-search",
        maxResults: input.maxResults ?? null,
        searchMode: response.ok ? (response.result.searchMode ?? null) : null,
        searchCoverage: response.ok ? (response.result.searchCoverage ?? null) : null,
        hitsCount: response.ok ? response.result.hits.length : null,
        searchedPathsCount: response.ok ? (response.result.searchedPaths?.length ?? null) : null,
        errorCode: response.ok ? null : response.error.code,
        httpStatus: response.ok ? null : (response.error.status ?? null),
        fallbackAvailable: response.ok ? null : (response.error.fallbackAvailable ?? null),
        latencyMs: Date.now() - startedAt,
      }, traceId);
      return response;
    }

    // multi-source fan-out mode.
    // an earlier revision + BYO — drop sources this caller may not access (operator-internal
    // `project` for a tenant, or another tenant's `personal`); keep UNKNOWN ids so
    // the fan-out reports per-source `source-not-found`. If none remain, refuse.
    const sourceIds = input.sourceIds!.filter(id => {
      const resolved = this._resolveSource(id);
      if (resolved === null) return true;
      return canAccessSource({
        scope: resolved.source.scope,
        sourceOwnerId: resolved.source.owner_user_id ?? null,
        callerOwnerId: caller.ownerUserId,
        isOperator: caller.isOperator,
      }).allow;
    });
    if (sourceIds.length === 0) {
      this.logAudit("content.search", { ok: false, mode: "multi", queryPreview: preview(input.query), errorCode: "forbidden-source", isOperator: caller.isOperator, callerOwnerId: preview(caller.ownerUserId), latencyMs: Date.now() - startedAt }, traceId);
      return { ok: false, error: { code: "forbidden-source", reason: "content source(s) not available to this tenant", sourceId: input.sourceIds!.join(",") } };
    }
    const perSource = await this._doSearchMulti(sourceIds, input, caller.ownerUserId);

    // Aggregate audit metadata. Per spec: source 数量 / sourceId previews+counts /
    // per-source hits count / per-source error code / latency. NO raw snippets,
    // NO token, NO header, NO hit content.
    const perSourceHitsCount: Record<string, number> = {};
    const perSourceErrorCodes: Record<string, string> = {};
    let aggregatedHitsCount = 0;
    for (const s of perSource) {
      if (s.ok) {
        const n = s.hits?.length ?? 0;
        perSourceHitsCount[s.sourceId] = n;
        aggregatedHitsCount += n;
      } else if (s.errorCode) {
        perSourceErrorCodes[s.sourceId] = s.errorCode;
      }
    }
    this.logAudit("content.search", {
      ok: true,
      mode: "multi",
      queryPreview: preview(input.query),
      pathPreview: preview(input.path ?? null),
      refPreview: preview(input.ref ?? null),
      strategy: input.strategy ?? "api-search",
      maxResults: input.maxResults ?? null,
      sourceIdsCount: sourceIds.length,
      sourceIdsPreview: sourceIds.map(s => preview(s)),
      perSourceHitsCount,
      perSourceErrorCodes,
      aggregatedHitsCount,
      sourcesOkCount: perSource.filter(s => s.ok).length,
      sourcesErrCount: perSource.filter(s => !s.ok).length,
      latencyMs: Date.now() - startedAt,
    }, traceId);

    return {
      ok: true,
      result: {
        // Top-level `hits` is intentionally an empty stub in multi-source
        // mode. Agent MUST consume `perSource[]` for grouped, source-tagged
        // results; flat aggregation here would lose ContentRef provenance
        // and the audit's per-source contract.
        hits: [],
        perSource,
      },
    };
  }

  /**
   * fan-out dispatch. For each requested sourceId, in parallel:
   *   - registry lookup (source-not-found → per-source error)
   *   - capability gate (`capabilities.search === false` → per-source
   *     `capability-not-supported`; explicit, NOT silent skip)
   *   - else delegate to `_doSearch` (single-source flow, includes an earlier revision
   *     api-search/bounded-local strategies + GitHub auth/quota mapping)
   *
   * Returns an array of `ContentSearchPerSourceState` preserving caller
   * order. Each entry carries timing so reviewers can see whether one
   * source's stall blocked the dispatch (it shouldn't — Promise.all runs
   * concurrently).
   */
  private async _doSearchMulti(
    sourceIds: string[],
    input: ContentSearchCallableInput,
    callerOwnerId: string | null,
  ): Promise<ContentSearchPerSourceState[]> {
    const perSourcePromises = sourceIds.map<Promise<ContentSearchPerSourceState>>(async sourceId => {
      const startedAt = Date.now();
      const resolved = this._resolveSource(sourceId);
      if (!resolved) {
        return {
          sourceId,
          ok: false,
          errorCode: "source-not-found",
          reason: unknownSourceReason(sourceId),
          latencyMs: Date.now() - startedAt,
        };
      }
      const source = resolved.source;
      // an earlier revision capability gate. local-fs declares `search:false`; honest
      // refusal here keeps "not-supported" out of `_doSearch` where
      // capability-vs-implementation distinctions get muddled.
      if (source.capabilities && source.capabilities.search !== true) {
        return {
          sourceId,
          provider: source.provider,
          ok: false,
          errorCode: "capability-not-supported",
          reason: `source ${sourceId} (provider ${source.provider}) does not declare capabilities.search:true`,
          latencyMs: Date.now() - startedAt,
        };
      }
      const sub = await this._doSearch({
        sourceId,
        query: input.query,
        path: input.path,
        ref: input.ref,
        strategy: input.strategy,
        maxResults: input.maxResults,
      }, callerOwnerId);
      const elapsedMs = Date.now() - startedAt;
      if (sub.ok) {
        return {
          sourceId,
          provider: source.provider,
          ok: true,
          hits: sub.result.hits,
          searchMode: sub.result.searchMode,
          searchCoverage: sub.result.searchCoverage,
          searchedPaths: sub.result.searchedPaths,
          omittedReason: sub.result.omittedReason,
          latencyMs: elapsedMs,
        };
      }
      return {
        sourceId,
        provider: source.provider,
        ok: false,
        errorCode: sub.error.code,
        reason: sub.error.reason,
        httpStatus: sub.error.status ?? null,
        latencyMs: elapsedMs,
      };
    });
    return Promise.all(perSourcePromises);
  }

  // Internal narrow input: `_doSearch` always operates on a single resolved
  // sourceId (an earlier revision contract). an earlier revision fan-out (`_doSearchMulti`)
  // synthesizes one of these per source.
  private async _doSearch(input: { sourceId: string; query: string; path?: string; ref?: string; strategy?: "api-search" | "bounded-local"; maxResults?: number }, callerOwnerId: string | null): Promise<ContentSearchResponse> {
    const resolved = this._resolveSource(input.sourceId);
    if (!resolved) {
      return { ok: false, error: { code: "source-not-found", reason: unknownSourceReason(input.sourceId), sourceId: input.sourceId } };
    }
    const { source, repo } = resolved;
    if (source.provider !== "github") {
      return { ok: false, error: { code: "no-repo-mapping", reason: `search not implemented for provider: ${source.provider}`, sourceId: source.id } };
    }
    if (!repo) {
      return { ok: false, error: { code: "no-repo-mapping", reason: `no repo binding for source`, sourceId: source.id } };
    }
    // Token (chokepoint): project → env; personal → owner's own github cred.
    const tok = await this._resolveTokenForSource(source, callerOwnerId);
    if (!tok.ok) return { ok: false, error: tok.error };
    const token = tok.token;
    const ref = input.ref ?? source.defaultRef ?? repo.defaultRef;
    const maxResults = Math.max(1, Math.min(100, input.maxResults ?? 30));
    const strategy = input.strategy ?? "api-search";

    // Path policy on the optional restricting path. Empty / undefined is
    // treated as "no restriction" — the GitHub Code Search query just omits
    // the `path:` qualifier; the bounded-local walk starts at top-level.
    let normalizedPath: string | undefined;
    if (input.path && input.path.length > 0 && input.path !== "/") {
      const policy = checkPath(source, input.path);
      if (!policy.ok) {
        return { ok: false, error: { code: policy.code, reason: policy.reason, sourceId: source.id, path: input.path } };
      }
      normalizedPath = policy.normalized;
    }

    if (strategy === "bounded-local") {
      return this.searchBoundedLocal(source, normalizedPath, input.query, maxResults, ref);
    }

    // Default `api-search`. Pin the commit SHA so the returned ContentRef is
    // revision-stable even though GitHub Code Search itself only indexes the
    // default branch (caveat documented in `runGithubCodeSearch` doccomment).
    let sha: string;
    try {
      sha = await resolveRefToSha(repo, ref, token);
    } catch (e) {
      return { ok: false, error: ghErrorToContentError(e, source.id, normalizedPath ?? "") };
    }

    let raw;
    try {
      raw = await runGithubCodeSearch(repo, input.query, normalizedPath, token, maxResults);
    } catch (e) {
      if (e instanceof GithubContentError && e.code === "quota-exhausted") {
        return {
          ok: false,
          error: {
            code: "quota-exhausted",
            reason: e.message,
            sourceId: source.id,
            status: e.status,
            fallbackAvailable: true,
            fallbackHint: "retry with strategy='bounded-local' for a degraded grep over cached/listed content",
          },
        };
      }
      return { ok: false, error: ghErrorToContentError(e, source.id, normalizedPath ?? "") };
    }

    const hits: ContentSearchHit[] = raw.items.map(it => ({
      ref: buildRef({ sourceId: source.id, path: it.path, sha, ref, cacheStatus: "miss" }),
      preview: it.preview,
    }));

    return {
      ok: true,
      result: {
        hits,
        searchMode: "api-search",
        searchCoverage: raw.incompleteResults ? "partial" : "full",
        ...(raw.incompleteResults
          ? { omittedReason: `GitHub Code Search reported incomplete_results=true; total_count=${raw.totalCount}` }
          : {}),
      },
    };
  }

  /**
   * Bounded-local degraded grep. Walks via `this.list` (path policy + cache),
   * reads each file via `this.read` (capped 32KB, also cached). Hits include
   * line numbers since we have the actual content. Never raises — failures
   * are folded into `omittedReason` and the response still carries metadata.
   */
  private async searchBoundedLocal(
    source: ContentSource,
    pathFilter: string | undefined,
    query: string,
    maxResults: number,
    ref: string,
  ): Promise<ContentSearchResponse> {
    const startPath = pathFilter ?? "";
    const visitedDirs: string[] = [];
    const visitedFiles: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const hits: ContentSearchHit[] = [];

    // Simple BFS. Each frame carries (path, depth). Depth 0 = startPath.
    type Frame = { path: string; depth: number };
    const queue: Frame[] = [{ path: startPath, depth: 0 }];
    let totalHits = 0;
    let stopReason: string | null = null;

    while (queue.length > 0) {
      if (visitedDirs.length >= BOUNDED_LOCAL_MAX_DIRS) {
        stopReason = `BOUNDED_LOCAL_MAX_DIRS=${BOUNDED_LOCAL_MAX_DIRS} reached`;
        break;
      }
      if (visitedFiles.length >= BOUNDED_LOCAL_MAX_FILES) {
        stopReason = `BOUNDED_LOCAL_MAX_FILES=${BOUNDED_LOCAL_MAX_FILES} reached`;
        break;
      }
      if (totalHits >= maxResults) {
        stopReason = `maxResults=${maxResults} reached`;
        break;
      }
      const frame = queue.shift()!;
      const listed = await this.list({ sourceId: source.id, path: frame.path, ref });
      if (!listed.ok) {
        skipped.push({ path: frame.path || "/", reason: `list failed: ${listed.error.code}` });
        continue;
      }
      visitedDirs.push(frame.path || "/");

      for (const entry of listed.result.entries) {
        if (totalHits >= maxResults) break;
        if (entry.type === "directory") {
          if (frame.depth + 1 < BOUNDED_LOCAL_MAX_DEPTH && visitedDirs.length + queue.length < BOUNDED_LOCAL_MAX_DIRS) {
            queue.push({ path: entry.pathOrId, depth: frame.depth + 1 });
          }
          continue;
        }
        if (entry.type !== "file") continue;
        if (visitedFiles.length >= BOUNDED_LOCAL_MAX_FILES) {
          stopReason = `BOUNDED_LOCAL_MAX_FILES=${BOUNDED_LOCAL_MAX_FILES} reached`;
          break;
        }

        const readRes = await this.read({
          sourceId: source.id,
          path: entry.pathOrId,
          ref,
          maxBytes: BOUNDED_LOCAL_MAX_BYTES_PER_FILE,
        });
        if (!readRes.ok) {
          skipped.push({ path: entry.pathOrId, reason: `read failed: ${readRes.error.code}` });
          continue;
        }
        visitedFiles.push(entry.pathOrId);

        // Literal grep with line numbers. Bounded per-file hit count so a
        // common query in a giant file doesn't dominate the result set.
        const content = readRes.result.content;
        const lines = content.split("\n");
        let perFile = 0;
        for (let i = 0; i < lines.length && perFile < BOUNDED_LOCAL_MAX_HITS_PER_FILE; i++) {
          if (totalHits >= maxResults) break;
          if (lines[i].includes(query)) {
            const previewLine = lines[i].slice(0, BOUNDED_LOCAL_PREVIEW_MAX);
            hits.push({
              ref: { ...readRes.result.ref, cacheStatus: readRes.result.ref.cacheStatus },
              line: i + 1,
              preview: previewLine,
            });
            perFile++;
            totalHits++;
          }
        }
      }
      if (stopReason) break;
    }

    const omittedReasons: string[] = [];
    if (stopReason) omittedReasons.push(stopReason);
    omittedReasons.push(
      `walked ${visitedDirs.length}/${BOUNDED_LOCAL_MAX_DIRS} dirs, ${visitedFiles.length}/${BOUNDED_LOCAL_MAX_FILES} files (max depth ${BOUNDED_LOCAL_MAX_DEPTH}, ${BOUNDED_LOCAL_MAX_BYTES_PER_FILE} bytes/file)`,
    );
    if (skipped.length > 0) {
      const sample = skipped.slice(0, 5).map(s => `${s.path}: ${s.reason}`).join("; ");
      omittedReasons.push(`skipped ${skipped.length}: ${sample}${skipped.length > 5 ? " (…)" : ""}`);
    }

    return {
      ok: true,
      result: {
        hits,
        searchMode: "degraded-grep",
        searchCoverage: "partial",
        searchedPaths: visitedFiles,
        omittedReason: omittedReasons.join(" | "),
      },
    };
  }

  // ─── Cache write + LRU eviction ────────────────────────────────────────
  private cachePut(
    sourceId: string,
    path: string,
    revisionKey: string,
    resultKind: "read" | "list",
    result: ContentReadResult | ContentListResult,
    size: number,
  ): void {
    const now = Date.now();
    this.sql`
      INSERT OR REPLACE INTO content_cache (
        source_id, path, revision_key, result_kind,
        result_json, size, fetched_at, last_access_at
      ) VALUES (
        ${sourceId}, ${path}, ${revisionKey}, ${resultKind},
        ${JSON.stringify(result)}, ${size}, ${now}, ${now}
      )
    `;
    const count = Number(
      (this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM content_cache`)[0]?.n ?? 0,
    );
    if (count > CACHE_MAX_ROWS) {
      const toDelete = count - CACHE_MAX_ROWS;
      this.sql`
        DELETE FROM content_cache WHERE rowid IN (
          SELECT rowid FROM content_cache ORDER BY last_access_at ASC LIMIT ${toDelete}
        )
      `;
    }
  }

  // Test/inspect helper — returns the current cache row count. an earlier revision may
  // promote this to a richer inspect surface; for an earlier revision it lets the
  // smoke verify cache hits.
  @callable()
  async getCacheStats(): Promise<{ rows: number }> {
    const rows = Number(
      (this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM content_cache`)[0]?.n ?? 0,
    );
    return { rows };
  }
}
