import { z } from "zod";

// ContentHub audit events surfaced via /api/inspect. Field shape
// is intentionally permissive (`payload: z.unknown()`) because the producer
// (ContentHubAgent.logAudit) already capped/redacted before persisting; the
// inspect surface just relays. `type` is one of `content.sources`,
// `content.list`, `content.read`, `content.search`.
export const ContentAuditEventSchema = z.object({
  type: z.string(),
  at: z.number().int(),
  payload: z.unknown(),
  traceId: z.string().nullable().optional(),
});
export type ContentAuditEvent = z.infer<typeof ContentAuditEventSchema>;

// ContentHub evidence pack (aggregated audit summary). Sits next
// to an earlier revision's raw `contentAudit` rows, NOT replacing them. Three pivot
// views answer the reviewer's recurring questions:
//   - byTraceId: in this agent round, what did it touch?
//   - bySourceId: what's the cumulative usage of this source?
//   - byOperation: which operation paths fired and at what cost/error rate?
// All counters derive from already-redacted audit row metadata; no raw
// content / hits / tokens are aggregated.
export const ContentAuditOperationCountsSchema = z.object({
  sources: z.number().int().nonnegative(),
  list: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  search: z.number().int().nonnegative(),
});
export type ContentAuditOperationCounts = z.infer<typeof ContentAuditOperationCountsSchema>;

export const ContentAuditByTraceSchema = z.object({
  traceId: z.string(),
  opCounts: ContentAuditOperationCountsSchema,
  sourceIds: z.array(z.string()),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type ContentAuditByTrace = z.infer<typeof ContentAuditByTraceSchema>;

export const ContentAuditBySourceSchema = z.object({
  sourceId: z.string(),
  opCounts: ContentAuditOperationCountsSchema,
  // Distinct LLM-driven traces touching this source (traceId-non-null rows).
  // Direct API rows (traceId null) are tallied separately so reviewers can
  // distinguish agent activity from operator/curl smoke against this source.
  traceIdCount: z.number().int().nonnegative(),
  directApiCount: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type ContentAuditBySource = z.infer<typeof ContentAuditBySourceSchema>;

export const ContentAuditByOperationSchema = z.object({
  operation: z.enum(["sources", "list", "read", "search"]),
  count: z.number().int().nonnegative(),
  sourceIdCount: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  latencyMsTotal: z.number().int().nonnegative(),
});
export type ContentAuditByOperation = z.infer<typeof ContentAuditByOperationSchema>;

export const ContentAuditSummarySchema = z.object({
  totalRows: z.number().int().nonnegative(),
  windowStart: z.number().int().nullable(),
  windowEnd: z.number().int().nullable(),
  byTraceId: z.array(ContentAuditByTraceSchema),
  bySourceId: z.array(ContentAuditBySourceSchema),
  byOperation: z.array(ContentAuditByOperationSchema),
});
export type ContentAuditSummary = z.infer<typeof ContentAuditSummarySchema>;

// ============================================================================
// ContentHub: provider-agnostic content source layer.
//
// an earlier revision ships schemas + a hardcoded `agentthursday-github` registry entry only.
// an earlier revision fill in real GitHub network reads/list/search.
//
// Design constraints (ADR §3, §4):
//   - `ContentRevision` is a discriminated union from day 1, never a bare
//     string — cache key uses JSON.stringify(revision).
//   - `ContentRef` provenance is mandatory on every future read/list/search
//     result (ADR §3.2: "agent 可信引用外部资料"的能力).
//   - Connector contract stays MCP-tool-shape compatible so v2+ can split
//     OAuth/multi-tenant connectors into independent MCP server Workers
//     without changing the agent-facing tool model.
// ============================================================================

export const ContentProviderSchema = z.enum([
  "github", "artifact", "onedrive", "dropbox", "gdrive",
  "notion", "confluence", "email", "web", "local-fs", "other",
]);
export type ContentProvider = z.infer<typeof ContentProviderSchema>;

export const ContentRevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git-sha"), sha: z.string(), ref: z.string().optional() }),
  z.object({ kind: z.literal("etag"), etag: z.string() }),
  z.object({ kind: z.literal("provider-version"), versionId: z.string() }),
  z.object({ kind: z.literal("updated-at"), updatedAt: z.number().int(), weak: z.literal(true) }),
  z.object({ kind: z.literal("snapshot"), snapshotId: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type ContentRevision = z.infer<typeof ContentRevisionSchema>;

export const ContentPermissionScopeSchema = z.enum(["read", "write-request", "write"]);
export type ContentPermissionScope = z.infer<typeof ContentPermissionScopeSchema>;

export const ContentCacheStatusSchema = z.enum(["hit", "miss", "fresh"]);
export type ContentCacheStatus = z.infer<typeof ContentCacheStatusSchema>;

export const ContentRefSchema = z.object({
  sourceId: z.string(),
  provider: ContentProviderSchema,
  pathOrId: z.string(),
  title: z.string().optional(),
  revision: ContentRevisionSchema,
  revisionLabel: z.string().optional(),
  fetchedAt: z.number().int(),
  permissionScope: ContentPermissionScopeSchema,
  cacheStatus: ContentCacheStatusSchema.optional(),
});
export type ContentRef = z.infer<typeof ContentRefSchema>;

export const ContentSourceScopeSchema = z.enum(["project", "personal", "team", "channel", "public", "fixture"]);
export type ContentSourceScope = z.infer<typeof ContentSourceScopeSchema>;

// BYO GitHub (2026-06-26): the resolved owner identity of a content_* caller,
// threaded from the dispatching agent through to the ContentHub DO. Replaces the
// older `callerIsOperator: boolean` — owner-scoping personal sources needs the
// owner id, not just the operator bit. `ownerUserId: null` = unresolved → fail
// closed (no access beyond tenant-public fixtures).
export type ContentCaller = { ownerUserId: string | null; isOperator: boolean };

export const ContentSourceAuthModeSchema = z.enum(["public", "secret", "oauth", "mcp", "browser", "none"]);
export type ContentSourceAuthMode = z.infer<typeof ContentSourceAuthModeSchema>;

// v2 explicit per-source capability declaration. Forward
// compatible: undefined `capabilities` on existing v1 sources is permitted
// and treated as "all true" by callers that haven't adopted the field yet.
// an earlier revision fan-out search will filter sources by `capabilities.search:true`
// instead of provider-name matching, so honest declarations matter.
export const ContentSourceCapabilitiesSchema = z.object({
  read: z.boolean(),
  list: z.boolean(),
  search: z.boolean(),
  health: z.boolean(),
});
export type ContentSourceCapabilities = z.infer<typeof ContentSourceCapabilitiesSchema>;

export const ContentSourceSchema = z.object({
  id: z.string(),
  provider: ContentProviderSchema,
  label: z.string(),
  scope: ContentSourceScopeSchema,
  access: ContentPermissionScopeSchema,
  authMode: ContentSourceAuthModeSchema,
  defaultRef: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  maxFileBytes: z.number().int().positive().optional(),
  capabilities: ContentSourceCapabilitiesSchema.optional(),
  // BYO GitHub (2026-06-26): the owning user for a `scope:"personal"` source.
  // Present ONLY on personal sources; undefined on project/fixture. This is the
  // tenant-isolation key — `canAccessSource` requires caller owner === this, and
  // the ContentHub token resolver reads ONLY this owner's github credential
  // (never env.GITHUB_TOKEN). Server-stamped at registration, never client-set.
  owner_user_id: z.string().optional(),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const ContentSourceHealthSchema = z.object({
  ok: z.boolean(),
  // v1 = "registry-only" (no network probe). an earlier revision will add "live"
  // (real GitHub probe) and "degraded" (rate-limited / partial).
  mode: z.enum(["registry-only", "live", "degraded"]),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  checkedAt: z.number().int(),
});
export type ContentSourceHealth = z.infer<typeof ContentSourceHealthSchema>;

export const ContentSourceWithHealthSchema = z.object({
  source: ContentSourceSchema,
  health: ContentSourceHealthSchema.optional(),
});
export type ContentSourceWithHealth = z.infer<typeof ContentSourceWithHealthSchema>;

export const ContentSourcesResponseSchema = z.object({
  sources: z.array(ContentSourceWithHealthSchema),
});
export type ContentSourcesResponse = z.infer<typeof ContentSourcesResponseSchema>;

// File entry for list results — used by an earlier revision+.
export const ContentFileEntrySchema = z.object({
  name: z.string(),
  pathOrId: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().optional(),
});
export type ContentFileEntry = z.infer<typeof ContentFileEntrySchema>;

export const ContentRedactionSchema = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  kind: z.enum(["api-key", "oauth-token", "pem-block", "other"]),
});
export type ContentRedaction = z.infer<typeof ContentRedactionSchema>;

export const ContentReadResultSchema = z.object({
  ref: ContentRefSchema,
  content: z.string(),                    // v1 utf-8 text only; binary path is v1.5+ 
  contentType: z.string(),
  size: z.number().int().nonnegative(),   // TRUE total file size in bytes (not just this window)
  truncated: z.boolean().optional(),
  truncatedBytes: z.number().int().nonnegative().optional(),
  redactions: z.array(ContentRedactionSchema).optional(),
  // 2026-06-29 — windowed/paginated read. `content` is bytes [offset, offset+bytesReturned).
  // When `hasMore`, call content_read again with `offset = nextOffset` to continue.
  offset: z.number().int().nonnegative().optional(),
  bytesReturned: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  remainingBytes: z.number().int().nonnegative().optional(),
  remainingLines: z.number().int().nonnegative().optional(), // APPROXIMATE (byte-ratio estimate)
  hasMore: z.boolean().optional(),
});
export type ContentReadResult = z.infer<typeof ContentReadResultSchema>;

export const ContentListResultSchema = z.object({
  ref: ContentRefSchema,
  entries: z.array(ContentFileEntrySchema),
  truncated: z.boolean().optional(),
});
export type ContentListResult = z.infer<typeof ContentListResultSchema>;

export const ContentSearchHitSchema = z.object({
  ref: ContentRefSchema,
  line: z.number().int().positive().optional(),
  preview: z.string(),
});
export type ContentSearchHit = z.infer<typeof ContentSearchHitSchema>;

// Search modes per ADR §7.1: default `api-search` is fail-loud on quota
// exhaustion; `degraded-grep` is opt-in via `strategy: "bounded-local"` and
// always carries `searchCoverage: "partial"`.
export const ContentSearchModeSchema = z.enum(["api-search", "degraded-grep"]);
export type ContentSearchMode = z.infer<typeof ContentSearchModeSchema>;

export const ContentSearchCoverageSchema = z.enum(["full", "partial"]);
export type ContentSearchCoverage = z.infer<typeof ContentSearchCoverageSchema>;

// request/response envelopes for content_list and content_read.
// Discriminated `{ ok: true, result } | { ok: false, error }` shape so both
// the API endpoint and the LLM tool wrapper can forward without exception
// machinery. `error.code` enumerates the structured failure modes an earlier revision
// produces; the list grows in an earlier revision+.

export const ContentErrorCodeSchema = z.enum([
  // Path policy
  "path-traversal",
  "absolute-path",
  "backslash",
  "null-byte",
  "denied",
  "not-allowed",
  // Source / config
  "source-not-found",
  "no-repo-mapping",
  "token-missing",
  // GitHub
  "ref-not-found",
  "unauthorized",
  "forbidden-or-rate-limited",
  "ref-resolve-failed",
  "not-found",
  "fetch-failed",
  "list-failed",
  "not-a-directory",
  "no-body",
  // search
  "quota-exhausted",
  "code-search-failed",
  "search-failed",
  // multi-source fan-out
  "capability-not-supported",
  // operator-internal source refused for a scoped (user-owned) caller
  "forbidden-source",
  // Generic fallback
  "internal",
]);
export type ContentErrorCode = z.infer<typeof ContentErrorCodeSchema>;

// per-source result/error state for multi-source fan-out.
// Each entry carries provenance even on failure so the agent can tell which
// source succeeded and which didn't, without a single source's failure
// silently swallowing another source's hits. `ok:true` populates `hits` (+
// the optional searchMode/coverage fields); `ok:false` populates errorCode
// + reason and leaves hits absent (NOT empty array — absence is the signal).
export const ContentSearchPerSourceStateSchema = z.object({
  sourceId: z.string(),
  provider: ContentProviderSchema.optional(),
  ok: z.boolean(),
  hits: z.array(ContentSearchHitSchema).optional(),
  searchMode: ContentSearchModeSchema.optional(),
  searchCoverage: ContentSearchCoverageSchema.optional(),
  searchedPaths: z.array(z.string()).optional(),
  omittedReason: z.string().optional(),
  errorCode: ContentErrorCodeSchema.optional(),
  reason: z.string().optional(),
  httpStatus: z.number().int().nullable().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type ContentSearchPerSourceState = z.infer<typeof ContentSearchPerSourceStateSchema>;

export const ContentSearchResultSchema = z.object({
  hits: z.array(ContentSearchHitSchema),
  searchMode: ContentSearchModeSchema.optional(),
  searchCoverage: ContentSearchCoverageSchema.optional(),
  searchedPaths: z.array(z.string()).optional(),
  omittedReason: z.string().optional(),
  // multi-source fan-out result. Present iff the request used
  // `sourceIds`. In that mode top-level `hits` is an empty array and the
  // agent MUST consume `perSource[]` for grouped results — flat aggregation
  // would lose source-level provenance, which the audit and ContentRef
  // contract both depend on.
  perSource: z.array(ContentSearchPerSourceStateSchema).optional(),
});
export type ContentSearchResult = z.infer<typeof ContentSearchResultSchema>;

export const ContentErrorSchema = z.object({
  code: ContentErrorCodeSchema,
  reason: z.string(),
  sourceId: z.string().optional(),
  path: z.string().optional(),
  status: z.number().int().nullable().optional(),
  // an earlier revision §7.1 — quota / upstream-failure errors carry an explicit
  // fallback hint so the caller can opt in to `strategy: "bounded-local"`.
  // Only set on search errors; other endpoints leave these undefined.
  fallbackAvailable: z.boolean().optional(),
  fallbackHint: z.string().optional(),
});
export type ContentError = z.infer<typeof ContentErrorSchema>;

export const ContentReadResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentReadResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentReadResponse = z.infer<typeof ContentReadResponseSchema>;

export const ContentListResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentListResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentListResponse = z.infer<typeof ContentListResponseSchema>;

export const ContentReadRequestSchema = z.object({
  sourceId: z.string().min(1),
  path: z.string().min(1).max(1024),
  ref: z.string().min(1).max(200).optional(),
  maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
  // 2026-06-29 — byte offset for windowed/paginated reads (default 0).
  offset: z.number().int().nonnegative().optional(),
});
export type ContentReadRequest = z.infer<typeof ContentReadRequestSchema>;

export const ContentListRequestSchema = z.object({
  sourceId: z.string().min(1),
  path: z.string().max(1024),                 // "" or "/" allowed for top-level
  ref: z.string().min(1).max(200).optional(),
});
export type ContentListRequest = z.infer<typeof ContentListRequestSchema>;

// request/response envelopes for content_search. Mirrors the
// an earlier revision read/list discriminated-union pattern so clients forward errors
// without exception machinery. Default strategy is `api-search` (fail-loud
// on quota); `bounded-local` is opt-in degraded grep over the connector's
// list+read path, always carries `searchCoverage:"partial"`.
export const ContentSearchRequestSchema = z.object({
  // `sourceId` and `sourceIds` are mutually exclusive, fail-loud:
  //  - exactly one must be provided
  //  - presenting both, or neither, is a 400 at the request boundary
  // Single-source mode (`sourceId`) keeps an earlier revision behavior unchanged.
  // Multi-source mode (`sourceIds`) returns a `perSource` array; top-level
  // `hits` is empty stub to preserve schema shape.
  sourceId: z.string().min(1).optional(),
  sourceIds: z.array(z.string().min(1)).min(1).max(10).optional(),
  query: z.string().min(1).max(500),
  path: z.string().max(1024).optional(),
  ref: z.string().min(1).max(200).optional(),
  strategy: z.enum(["api-search", "bounded-local"]).optional(),
  maxResults: z.number().int().positive().max(100).optional(),
}).refine(
  d => (d.sourceId !== undefined) !== (d.sourceIds !== undefined),
  { message: "must provide exactly one of `sourceId` or `sourceIds`, not both and not neither" },
);
export type ContentSearchRequest = z.infer<typeof ContentSearchRequestSchema>;

export const ContentSearchResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: ContentSearchResultSchema }),
  z.object({ ok: z.literal(false), error: ContentErrorSchema }),
]);
export type ContentSearchResponse = z.infer<typeof ContentSearchResponseSchema>;

// Connector contract — TS interface, not zod (it's an internal shape, not
// API-surface JSON). an earlier revision adds the GitHub implementation.
export interface ContentSourceConnector {
  readonly meta: ContentSource;

  readonly capabilities: {
    read: boolean;
    list: boolean;
    search: boolean;
    write: boolean;       // v2+
    watch: boolean;       // v2+
  };

  read(params: { path: string; ref?: string; maxBytes?: number }): Promise<ContentReadResult>;

  list(params: { path: string; ref?: string; recursive?: boolean }): Promise<ContentListResult>;

  search(params: {
    pattern: string;
    path?: string;
    ref?: string;
    maxResults?: number;
    strategy?: "api-search" | "bounded-local";
  }): Promise<ContentSearchResult>;

  health(): Promise<ContentSourceHealth>;
}
