/**
 * archiveOps — archive write/flush + search/inspect helpers.
 *
 *  pulled the three write/flush helpers
 * (`_writeArchiveFlush`, `drainForArchive`, `archiveChunks`) out of
 * `AgentThursdayAgent` verbatim.  extends this module with the two
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
 * this module (), and compaction is NOT part of this module
 * (Cards 284–285). SQL strings, table names, column names, event
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

export type ArchiveOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

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
  },
): ArchiveFlushResult {
  const archivedAt = Date.now();
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
  for (const chunk of input.chunks) {
    try {
      const chunkId = `chunk_${flushId}_${chunk.messageIndex}`;
      host.sql`
          INSERT OR REPLACE INTO conversation_archive (
            chunk_id, context_id, message_id, message_index, role,
            speaker, surface, task_id, card_id, type, harness_class,
            text, index_text, redaction_flags, source_ref,
            is_synthetic_compaction, created_at, archived_at, trigger
          ) VALUES (
            ${chunkId}, ${input.contextId}, ${chunk.messageId}, ${chunk.messageIndex}, ${chunk.role},
            ${null}, ${null}, ${null}, ${null}, ${null}, ${null},
            ${chunk.text}, ${chunk.indexText}, ${null}, ${null},
            ${chunk.isSyntheticCompaction ? 1 : 0}, ${archivedAt}, ${archivedAt}, ${trigger}
          )
        `;
      written++;
    } catch (e) {
      if (firstError === null) {
        firstError = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      }
    }
  }

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
  });
}

export function conversationSearchFree(
  host: ArchiveSearchHost,
  input: ConversationSearchInput,
): ConversationSearchResult {
  if (!input || typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("conversationSearch: missing query");
  }
  const queryRaw = input.query.trim().slice(0, 500);
  const queryLike = `%${queryRaw.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
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

  // Build the SQL with optional filters. Each filter is gated by a
  // sentinel value test so unset filters don't restrict the query.
  // We hand-stitch the WHERE clause to keep the parameter binding
  // ordering stable across the conditional pieces.
  const rows = host.sql<{
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
      WHERE (
        (index_text IS NOT NULL AND index_text LIKE ${queryLike} ESCAPE '\\')
        OR text LIKE ${queryLike} ESCAPE '\\'
      )
      AND (${filterContextId} IS NULL OR context_id = ${filterContextId})
      AND (${filterFrom} IS NULL OR archived_at >= ${filterFrom})
      AND (${filterTo} IS NULL OR archived_at <= ${filterTo})
      AND (${filterRole} IS NULL OR role = ${filterRole})
      ORDER BY archived_at DESC, chunk_id ASC
      LIMIT ${topK}
    `;

  const hits: ConversationSearchHit[] = rows.map((r) => {
    const fullText = r.text;
    const matchIdx = fullText.toLowerCase().indexOf(queryRaw.toLowerCase());
    let snippet: string;
    if (matchIdx >= 0) {
      const halfWindow = Math.max(20, Math.floor((snippetCap - queryRaw.length) / 2));
      const start = Math.max(0, matchIdx - halfWindow);
      const end = Math.min(fullText.length, matchIdx + queryRaw.length + halfWindow);
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
      matchReason: matchIdx >= 0 ? "text_match" : "index_text_match",
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
