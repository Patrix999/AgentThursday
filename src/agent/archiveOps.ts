/**
 * archiveOps — archive write/flush + search/inspect helpers.
 *
 * an earlier revision pulled the three write/flush helpers
 * (`_writeArchiveFlush`, `drainForArchive`, `archiveChunks`) out of
 * `AgentThursdayAgent` verbatim. an earlier revision extends this module with the two
 * read/audit-side callables (`conversationSearch`,
 * `getArchiveInspectSummary`) so the archive surface has one module
 * for both write and read paths.
 *
 * Host shapes are intentionally narrow per call-pattern:
 *   - `ArchiveWriteHost` — write/flush + drain: `sql`, `logEvent`,
 *     `getMessages`, `ensureActiveContext`.
 *   - `ArchiveSearchHost` — `conversationSearch`: `sql`, `logEvent`.
 *     Subset of `ArchiveWriteHost`; agent-side `_archiveWriteHost()`
 *     also satisfies it structurally, but we surface the narrower
 *     interface to document what the function actually consumes.
 *   - `ArchiveInspectHost` — `getArchiveInspectSummary`: `sql` only.
 *
 * Wrapper retention: `_writeArchiveFlush` keeps four internal call
 * sites in `src/server.ts` (reset/new/archiveChunks/another reset
 * branch), so the agent-side private wrapper stays. `drainForArchive`,
 * `archiveChunks`, `conversationSearch`, and `getArchiveInspectSummary`
 * remain `@callable()` on `AgentThursdayAgent` to preserve the RPC surface.
 * The try/catch around `ensureActiveContext` inside `drainForArchive`
 * is copied verbatim — the "unknown" fallback is a load-bearing audit
 * affordance for DOs where the active pointer hasn't been initialised
 * yet.
 *
 * Per Step 5 preflight §6: reset/new/switch/hygiene are NOT part of
 * this module , and compaction is NOT part of this module
 * (an earlier revision–285). SQL strings, table names, column names, event
 * types, callable payloads, return shapes, and caps are byte-equivalent
 * to the original methods.
 */

import type { UIMessage } from "ai";

import { buildArchiveChunks } from "../contextLifecycle";
import type {
  ArchiveChunkInput,
  ArchiveChunksInput,
  ArchiveContextCount,
  ArchiveFlushResult,
  ArchiveFlushRow,
  ArchiveInspectSummary,
  ArchiveTrigger,
  ConversationSearchHit,
  ConversationSearchInput,
  ConversationSearchResult,
  DrainForArchiveResult,
  RetrievalLogRow,
} from "../schema";
import { newContextId } from "./contextHelpers";
import { ADMIN_USER_ID } from "./requestIdentity";

export type ArchiveOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

// FTS5 index over the archive (see archiveFtsOps.ts). The write
// path keeps it fresh; the search path is FTS-first with the LIKE flow as
// the permanent fail-soft fallback.
import {
  ftsIndexChunks,
  advanceFtsBackfill,
  ftsCandidateRowids,
  buildFtsUnits,
} from "./archiveFtsOps";

export interface ArchiveWriteHost {
  sql: ArchiveOpsSqlTag;
  logEvent: (type: string, payload: unknown) => void;
  getMessages: () => UIMessage[];
  ensureActiveContext: () => { context_id: string; reason: string | null; created_at: number };
}

export interface ArchiveSearchHost {
  sql: ArchiveOpsSqlTag;
  logEvent: (type: string, payload: unknown) => void;
}

export interface ArchiveInspectHost {
  sql: ArchiveOpsSqlTag;
}

export function writeArchiveFlushFree(
  host: ArchiveWriteHost,
  input: {
    contextId: string;
    trigger: ArchiveTrigger | string;
    chunks: readonly ArchiveChunkInput[];
    reason: string | null;
    // Multi-tenancy — owner of the archived conversation (the per-context DO's
    // resolved owner; admin sentinel for the operator). Stamped on every chunk
    // so `conversationSearch` can owner-scope reads. Best-effort: a mis-stamped
    // write at worst hides a row from its own owner (the READ filter is the
    // security boundary, not this stamp). Omitted → admin sentinel.
    ownerUserId?: string | null;
  },
): ArchiveFlushResult {
  const archivedAt = Date.now();
  const ownerUserId = input.ownerUserId ?? ADMIN_USER_ID;
  const flushId = newContextId().replace(/^ctx_/, "flush_");
  const trigger = typeof input.trigger === "string" ? input.trigger : "manual";

  if (input.chunks.length === 0) {
    host.sql`
        INSERT INTO conversation_archive_flushes (flush_id, context_id, trigger, chunk_count, message_count, status, reason, error, created_at)
        VALUES (${flushId}, ${input.contextId}, ${trigger}, ${0}, ${0}, ${"skipped"}, ${input.reason}, ${null}, ${archivedAt})
      `;
    host.logEvent("archive.flush.skipped", {
      flushId,
      contextId: input.contextId,
      trigger,
      reason: input.reason ?? "no_chunks_to_archive",
    });
    return {
      flushId,
      contextId: input.contextId,
      trigger,
      chunkCount: 0,
      messageCount: 0,
      status: "skipped",
      error: null,
      archivedAt,
    };
  }

  let written = 0;
  let firstError: string | null = null;
  const writtenChunkIds: string[] = [];
  for (const chunk of input.chunks) {
    try {
      const chunkId = `chunk_${flushId}_${chunk.messageIndex}`;
      host.sql`
          INSERT OR REPLACE INTO conversation_archive (
            chunk_id, context_id, message_id, message_index, role,
            speaker, surface, task_id, card_id, type, harness_class,
            text, index_text, redaction_flags, source_ref,
            is_synthetic_compaction, created_at, archived_at, trigger, owner_user_id
          ) VALUES (
            ${chunkId}, ${input.contextId}, ${chunk.messageId}, ${chunk.messageIndex}, ${chunk.role},
            ${null}, ${null}, ${null}, ${null}, ${null}, ${null},
            ${chunk.text}, ${chunk.indexText}, ${null}, ${null},
            ${chunk.isSyntheticCompaction ? 1 : 0}, ${archivedAt}, ${archivedAt}, ${trigger}, ${ownerUserId}
          )
        `;
      written++;
      writtenChunkIds.push(chunkId);
    } catch (e) {
      if (firstError === null) {
        firstError = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      }
    }
  }
  // keep the FTS index in step with fresh writes (fail-soft
  // inside; archiving never breaks because of the index).
  ftsIndexChunks(host, writtenChunkIds);

  const status: "ok" | "failed" = firstError === null ? "ok" : "failed";
  host.sql`
      INSERT INTO conversation_archive_flushes (flush_id, context_id, trigger, chunk_count, message_count, status, reason, error, created_at)
      VALUES (${flushId}, ${input.contextId}, ${trigger}, ${written}, ${input.chunks.length}, ${status}, ${input.reason}, ${firstError}, ${archivedAt})
    `;

  host.logEvent(status === "ok" ? "archive.flush.completed" : "archive.flush.failed", {
    flushId,
    contextId: input.contextId,
    trigger,
    chunkCount: written,
    messageCount: input.chunks.length,
    reason: input.reason,
    error: firstError,
  });

  return {
    flushId,
    contextId: input.contextId,
    trigger,
    chunkCount: written,
    messageCount: input.chunks.length,
    status,
    error: firstError,
    archivedAt,
  };
}

export function drainForArchiveFree(host: ArchiveWriteHost): DrainForArchiveResult {
  const messages = host.getMessages();
  const chunks = buildArchiveChunks(messages);
  // The contextId reported here is the row this DO's registry view
  // says is active. For the registry DO itself this matches its own
  // bootstrap row; for per-context DOs the row is whatever pointer
  // the registry set up. Since per-context DOs run their own
  // `ensureActiveContext` they may emit a fresh ctx_<uuid> id —
  // that's fine, we record that id alongside the chunks for audit.
  // Callers that care about the "official" routing key should use
  // the contextId they routed with, not the value reported here.
  let contextIdGuess: string;
  try {
    contextIdGuess = host.ensureActiveContext().context_id;
  } catch {
    contextIdGuess = "unknown";
  }
  return {
    contextId: contextIdGuess,
    snapshotAt: Date.now(),
    chunks,
    totalMessageCount: messages.length,
  };
}

export function archiveChunksFree(
  host: ArchiveWriteHost,
  input: ArchiveChunksInput,
): ArchiveFlushResult {
  if (!input || typeof input.contextId !== "string" || input.contextId.length === 0) {
    throw new Error("archiveChunks: missing contextId");
  }
  if (!Array.isArray(input.chunks)) {
    throw new Error("archiveChunks: missing chunks array");
  }
  return writeArchiveFlushFree(host, {
    contextId: input.contextId,
    trigger: input.trigger,
    chunks: input.chunks,
    reason: input.reason ?? null,
    ownerUserId: input.ownerUserId ?? null,
  });
}

/**
 * Multi-tenancy — the fail-CLOSED empty result `conversation_search` returns
 * when the caller's owner can't be resolved (so it never falls open to an
 * all-tenants search). Pure (no `agents` / SQL deps) so the tool's fail-closed
 * branch is unit-testable without importing the cf-agents runtime. Echoes the
 * caller's filters for transparency; same caps as `conversationSearchFree`.
 */
export function emptyConversationSearchResult(
  input: ConversationSearchInput,
  retrievalId = "ret_owner_unresolved",
): ConversationSearchResult {
  const topK = Math.max(1, Math.min(10, Math.floor(input.topK ?? 3)));
  const snippetCap = Math.max(50, Math.min(2000, Math.floor(input.snippetCap ?? 300)));
  return {
    ok: true,
    retrievalId,
    query: typeof input.query === "string" ? input.query : "",
    topK,
    snippetCap,
    hits: [],
    resultCount: 0,
    searchedAt: Date.now(),
    filters: {
      contextId: input.contextId ?? null,
      fromTimestamp: input.fromTimestamp ?? null,
      toTimestamp: input.toTimestamp ?? null,
      role: input.role ?? null,
    },
  };
}

// SQLite caps a LIKE pattern at ~50 bytes ("LIKE or GLOB pattern
// too complex"). A whole natural-language query as one `%…%` substring blows
// past that (fastest with CJK at 3 bytes/char, but long English does too) AND
// almost never matches archived text verbatim. Split the query into terms,
// byte-cap each, and AND them: legal patterns + better multi-keyword recall.
// A long space-less run (CJK NL) yields one byte-capped leading fragment —
// no crash, honest limited recall (FTS5 is the real fix, tracked separately).
const LIKE_TERM_MAX_BYTES = 40; // < the ~48-byte content budget under 50
const MAX_SEARCH_TERMS = 5;

function utf8ByteCap(s: string, maxBytes: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.length <= maxBytes) return s;
  // Decode a truncated slice; strip a trailing replacement char left by a
  // split multi-byte code point so we don't LIKE-match U+FFFD.
  return new TextDecoder("utf-8").decode(enc.slice(0, maxBytes)).replace(/�+$/, "");
}

export function buildSearchLikeTerms(queryRaw: string): string[] {
  const terms = queryRaw.split(/\s+/).filter((t) => t.length > 0);
  const source = terms.length > 0 ? terms : [queryRaw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of source) {
    const capped = utf8ByteCap(t, LIKE_TERM_MAX_BYTES);
    if (!capped || seen.has(capped)) continue;
    seen.add(capped);
    out.push(`%${capped.replace(/[%_\\]/g, (c) => "\\" + c)}%`);
    if (out.length >= MAX_SEARCH_TERMS) break;
  }
  return out;
}

export function conversationSearchFree(
  host: ArchiveSearchHost,
  input: ConversationSearchInput,
  // Multi-tenancy — owner-scope the archive search. `undefined` = admin
  // (unfiltered, sees ALL tenants' archives — preserves the operator's
  // cross-context search). A non-empty string = a scoped tenant: only rows
  // whose `owner_user_id` matches. The CALLER resolves this from the trusted
  // caller identity and FAILS CLOSED (unresolved owner → empty results, never
  // `undefined`); this function is the enforcement point, not the resolver.
  scopeOwnerId?: string,
): ConversationSearchResult {
  if (!input || typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("conversationSearch: missing query");
  }
  const queryRaw = input.query.trim().slice(0, 500);
  // byte-capped terms (AND-combined below); 5 fixed slots so the
  // tagged-template SQL keeps a static shape. Unused slots = null sentinel.
  const terms = buildSearchLikeTerms(queryRaw);
  const t0 = terms[0] ?? null;
  const t1 = terms[1] ?? null;
  const t2 = terms[2] ?? null;
  const t3 = terms[3] ?? null;
  const t4 = terms[4] ?? null;
  const topK = Math.max(1, Math.min(10, Math.floor(input.topK ?? 3)));
  const snippetCap = Math.max(50, Math.min(2000, Math.floor(input.snippetCap ?? 300)));
  const filterContextId = (typeof input.contextId === "string" && input.contextId.length > 0)
    ? input.contextId
    : null;
  const filterFrom = (typeof input.fromTimestamp === "number" && Number.isFinite(input.fromTimestamp))
    ? Math.floor(input.fromTimestamp)
    : null;
  const filterTo = (typeof input.toTimestamp === "number" && Number.isFinite(input.toTimestamp))
    ? Math.floor(input.toTimestamp)
    : null;
  const filterRole = (input.role === "user" || input.role === "assistant" || input.role === "system")
    ? input.role
    : null;
  // Multi-tenancy owner filter (sentinel-null = admin/unfiltered). A scoped
  // tenant only matches its own owner's rows; admin (undefined) sees all.
  const filterOwner = (typeof scopeOwnerId === "string" && scopeOwnerId.length > 0)
    ? scopeOwnerId
    : null;

  // ── FTS5 path (ranked full-text; CJK-capable) ────────────
  // Every search call advances the backfill one batch; the FTS path only
  // activates once the watermark has caught the archive (before that,
  // results would silently miss unindexed history). ANY error inside the
  // FTS branch falls back to the LIKE flow below — an earlier revision's path stays
  // as the permanent fallback.
  let rows: {
    chunk_id: string;
    context_id: string;
    message_id: string | null;
    message_index: number | bigint | null;
    role: string | null;
    trigger: string;
    archived_at: number | bigint;
    text: string;
    index_text: string | null;
    is_synthetic_compaction: number | bigint;
  }[] | null = null;
  let usedFts = false;
  try {
    const backfill = advanceFtsBackfill(host);
    if (backfill.ready) {
      const candidateIds = ftsCandidateRowids(host, queryRaw, topK);
      if (candidateIds !== null) {
        if (candidateIds.length === 0) {
          rows = [];
          usedFts = true;
        } else {
          const idsJson = JSON.stringify(candidateIds);
          const fetched = host.sql<{
            rowid: number | bigint;
            chunk_id: string;
            context_id: string;
            message_id: string | null;
            message_index: number | bigint | null;
            role: string | null;
            trigger: string;
            archived_at: number | bigint;
            text: string;
            index_text: string | null;
            is_synthetic_compaction: number | bigint;
          }>`
            SELECT rowid, chunk_id, context_id, message_id, message_index, role, trigger, archived_at, text, index_text, is_synthetic_compaction
            FROM conversation_archive
            WHERE rowid IN (SELECT value FROM json_each(${idsJson}))
            AND (${filterContextId} IS NULL OR context_id = ${filterContextId})
            AND (${filterFrom} IS NULL OR archived_at >= ${filterFrom})
            AND (${filterTo} IS NULL OR archived_at <= ${filterTo})
            AND (${filterRole} IS NULL OR role = ${filterRole})
            AND (${filterOwner} IS NULL OR owner_user_id = ${filterOwner})
          `;
          // Restore bm25 candidate order (SQL IN doesn't preserve it).
          const rankOf = new Map(candidateIds.map((id, i) => [id, i]));
          fetched.sort((a, b) => (rankOf.get(Number(a.rowid)) ?? 1e9) - (rankOf.get(Number(b.rowid)) ?? 1e9));
          rows = fetched.slice(0, topK);
          usedFts = true;
        }
      }
    }
  } catch (e) {
    host.logEvent("archive.fts.search_error", {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    rows = null;
    usedFts = false;
  }

  // ── LIKE fallback (an earlier revision path, unchanged) ────────────────────────
  // Build the SQL with optional filters. Each filter is gated by a
  // sentinel value test so unset filters don't restrict the query.
  // We hand-stitch the WHERE clause to keep the parameter binding
  // ordering stable across the conditional pieces.
  if (rows === null) {
    rows = host.sql<{
      chunk_id: string;
      context_id: string;
      message_id: string | null;
      message_index: number | bigint | null;
      role: string | null;
      trigger: string;
      archived_at: number | bigint;
      text: string;
      index_text: string | null;
      is_synthetic_compaction: number | bigint;
    }>`
      SELECT chunk_id, context_id, message_id, message_index, role, trigger, archived_at, text, index_text, is_synthetic_compaction
      FROM conversation_archive
      WHERE (${t0} IS NULL OR (index_text LIKE ${t0} ESCAPE '\\' OR text LIKE ${t0} ESCAPE '\\'))
      AND (${t1} IS NULL OR (index_text LIKE ${t1} ESCAPE '\\' OR text LIKE ${t1} ESCAPE '\\'))
      AND (${t2} IS NULL OR (index_text LIKE ${t2} ESCAPE '\\' OR text LIKE ${t2} ESCAPE '\\'))
      AND (${t3} IS NULL OR (index_text LIKE ${t3} ESCAPE '\\' OR text LIKE ${t3} ESCAPE '\\'))
      AND (${t4} IS NULL OR (index_text LIKE ${t4} ESCAPE '\\' OR text LIKE ${t4} ESCAPE '\\'))
      AND (${filterContextId} IS NULL OR context_id = ${filterContextId})
      AND (${filterFrom} IS NULL OR archived_at >= ${filterFrom})
      AND (${filterTo} IS NULL OR archived_at <= ${filterTo})
      AND (${filterRole} IS NULL OR role = ${filterRole})
      AND (${filterOwner} IS NULL OR owner_user_id = ${filterOwner})
      ORDER BY archived_at DESC, chunk_id ASC
      LIMIT ${topK}
    `;
  }

  // highlight around the FIRST term (the whole NL query is rarely
  // present verbatim; the first term is what actually matched a row).
  // for FTS hits, prefer the first query UNIT that actually
  // appears in the text (units survive CJK; the raw first "word" of a
  // space-less Chinese query is the whole query and never matches).
  const ftsUnits = usedFts ? buildFtsUnits(queryRaw) : [];
  const snippetNeedle = utf8ByteCap((queryRaw.split(/\s+/)[0] || queryRaw), LIKE_TERM_MAX_BYTES);
  const hits: ConversationSearchHit[] = rows.map((r) => {
    const fullText = r.text;
    const needle = usedFts
      ? (ftsUnits.find((u) => fullText.toLowerCase().includes(u.toLowerCase())) ?? snippetNeedle)
      : snippetNeedle;
    const matchIdx = fullText.toLowerCase().indexOf(needle.toLowerCase());
    let snippet: string;
    if (matchIdx >= 0) {
      const halfWindow = Math.max(20, Math.floor((snippetCap - needle.length) / 2));
      const start = Math.max(0, matchIdx - halfWindow);
      const end = Math.min(fullText.length, matchIdx + needle.length + halfWindow);
      const head = start > 0 ? "…" : "";
      const tail = end < fullText.length ? "…" : "";
      snippet = `${head}${fullText.slice(start, end)}${tail}`;
    } else {
      // Match was in index_text only (e.g. boilerplate-stripped
      // variant matched but `text` original has wrapper chars).
      snippet = fullText.length > snippetCap
        ? `${fullText.slice(0, snippetCap)}…`
        : fullText;
    }
    if (snippet.length > snippetCap) {
      snippet = `${snippet.slice(0, snippetCap)}…`;
    }
    return {
      chunkId: r.chunk_id,
      contextId: r.context_id,
      messageId: r.message_id,
      messageIndex: r.message_index === null ? null : Number(r.message_index),
      role: r.role,
      trigger: r.trigger,
      archivedAt: Number(r.archived_at),
      snippet,
      matchReason: usedFts
        ? "fts_match"
        : matchIdx >= 0 ? "text_match" : "index_text_match",
      isSyntheticCompaction: Number(r.is_synthetic_compaction) > 0,
    };
  });

  const retrievalId = newContextId().replace(/^ctx_/, "ret_");
  const searchedAt = Date.now();
  const filtersJson = JSON.stringify({
    contextId: filterContextId,
    fromTimestamp: filterFrom,
    toTimestamp: filterTo,
    role: filterRole,
    topK,
    snippetCap,
  });
  const returnedRefsJson = JSON.stringify(
    hits.map((h) => ({ chunkId: h.chunkId, contextId: h.contextId })),
  );
  const callerContextId = (typeof input.callerContextId === "string" && input.callerContextId.length > 0)
    ? input.callerContextId
    : null;
  const callerTaskId = (typeof input.callerTaskId === "string" && input.callerTaskId.length > 0)
    ? input.callerTaskId
    : null;
  const traceId = (typeof input.traceId === "string" && input.traceId.length > 0)
    ? input.traceId
    : null;

  host.sql`
      INSERT INTO conversation_retrieval_log (retrieval_id, query, filters_json, returned_refs_json, used_refs_json, trace_id, context_id, task_id, result_count, created_at)
      VALUES (${retrievalId}, ${queryRaw}, ${filtersJson}, ${returnedRefsJson}, ${null}, ${traceId}, ${callerContextId}, ${callerTaskId}, ${hits.length}, ${searchedAt})
    `;
  host.logEvent("conversation.search", {
    retrievalId,
    query: queryRaw.slice(0, 200),
    filters: {
      contextId: filterContextId,
      fromTimestamp: filterFrom,
      toTimestamp: filterTo,
      role: filterRole,
      topK,
      snippetCap,
    },
    returnedRefs: hits.map((h) => ({ chunkId: h.chunkId, contextId: h.contextId })),
    resultCount: hits.length,
    callerContextId,
    callerTaskId,
    traceId,
  });

  return {
    ok: true,
    retrievalId,
    query: queryRaw,
    topK,
    snippetCap,
    hits,
    resultCount: hits.length,
    searchedAt,
    filters: {
      contextId: filterContextId,
      fromTimestamp: filterFrom,
      toTimestamp: filterTo,
      role: filterRole,
    },
  };
}

export function getArchiveInspectSummaryFree(
  host: ArchiveInspectHost,
  input?: { recentLimit?: number; perContextLimit?: number },
): ArchiveInspectSummary {
  const recentLimit = Math.max(1, Math.min(50, Math.floor(input?.recentLimit ?? 10)));
  const perContextLimit = Math.max(1, Math.min(100, Math.floor(input?.perContextLimit ?? 20)));
  const generatedAt = Date.now();

  // Aggregate totals first — cheap COUNT(*) queries.
  const archiveChunkTotalRow = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM conversation_archive`[0];
  const archiveContextCountRow = host.sql<{ n: number | bigint }>`SELECT COUNT(DISTINCT context_id) as n FROM conversation_archive`[0];
  const flushTotalRow = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM conversation_archive_flushes`[0];
  const flushFailedRow = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM conversation_archive_flushes WHERE status = 'failed'`[0];
  const retrievalTotalRow = host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM conversation_retrieval_log`[0];

  const recentFlushRows = host.sql<{
    flush_id: string;
    context_id: string;
    trigger: string;
    chunk_count: number | bigint;
    message_count: number | bigint;
    status: string;
    reason: string | null;
    error: string | null;
    created_at: number | bigint;
  }>`
      SELECT flush_id, context_id, trigger, chunk_count, message_count, status, reason, error, created_at
      FROM conversation_archive_flushes
      ORDER BY created_at DESC
      LIMIT ${recentLimit}
    `;
  const recentFlushes: ArchiveFlushRow[] = recentFlushRows.map((r) => ({
    flushId: r.flush_id,
    contextId: r.context_id,
    trigger: r.trigger,
    chunkCount: Number(r.chunk_count),
    messageCount: Number(r.message_count),
    status: r.status === "ok" || r.status === "failed" || r.status === "skipped" ? r.status : "ok",
    reason: r.reason,
    // Cap error text so operators can see the gist without the full
    // stack landing in the Inspect payload.
    error: r.error === null ? null : r.error.length > 240 ? `${r.error.slice(0, 240)}…` : r.error,
    createdAt: Number(r.created_at),
  }));

  const recentRetrievalRows = host.sql<{
    retrieval_id: string;
    query: string;
    filters_json: string | null;
    returned_refs_json: string | null;
    trace_id: string | null;
    context_id: string | null;
    task_id: string | null;
    result_count: number | bigint;
    created_at: number | bigint;
  }>`
      SELECT retrieval_id, query, filters_json, returned_refs_json, trace_id, context_id, task_id, result_count, created_at
      FROM conversation_retrieval_log
      ORDER BY created_at DESC
      LIMIT ${recentLimit}
    `;
  const recentRetrievals: RetrievalLogRow[] = recentRetrievalRows.map((r) => {
    let returnedRefs: { chunkId: string; contextId: string }[] = [];
    if (r.returned_refs_json !== null) {
      try {
        const parsed = JSON.parse(r.returned_refs_json) as Array<{ chunkId?: unknown; contextId?: unknown }>;
        returnedRefs = parsed
          .filter((it) => typeof it.chunkId === "string" && typeof it.contextId === "string")
          .map((it) => ({ chunkId: String(it.chunkId), contextId: String(it.contextId) }));
      } catch {
        returnedRefs = [];
      }
    }
    // Cap query preview at 200 chars (sanity defense; the writer
    // already capped at 500 so this rarely fires).
    const queryCapped = r.query.length > 200 ? `${r.query.slice(0, 200)}…` : r.query;
    return {
      retrievalId: r.retrieval_id,
      query: queryCapped,
      filtersJson: r.filters_json,
      returnedRefs,
      callerContextId: r.context_id,
      callerTaskId: r.task_id,
      traceId: r.trace_id,
      resultCount: Number(r.result_count),
      createdAt: Number(r.created_at),
    };
  });

  const perContextRows = host.sql<{
    context_id: string;
    trigger: string;
    n: number | bigint;
    latest: number | bigint;
  }>`
      SELECT context_id, trigger, COUNT(*) as n, MAX(archived_at) as latest
      FROM conversation_archive
      GROUP BY context_id, trigger
      ORDER BY latest DESC
      LIMIT ${perContextLimit}
    `;
  const countsByContext: ArchiveContextCount[] = perContextRows.map((r) => ({
    contextId: r.context_id,
    trigger: r.trigger,
    chunkCount: Number(r.n),
    latestArchivedAt: Number(r.latest),
  }));

  return {
    totals: {
      archiveChunkTotal: Number(archiveChunkTotalRow?.n ?? 0),
      archiveContextCount: Number(archiveContextCountRow?.n ?? 0),
      flushTotal: Number(flushTotalRow?.n ?? 0),
      flushFailedTotal: Number(flushFailedRow?.n ?? 0),
      retrievalTotal: Number(retrievalTotalRow?.n ?? 0),
    },
    recentFlushes,
    recentRetrievals,
    countsByContext,
    generatedAt,
  };
}
