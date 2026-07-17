/**
 * FTS5 conversation-archive search (M9.4 Phase 2).
 *
 * The LIKE search (an earlier revision, crash-fixed by 466) is substring matching with
 * no relevance ranking; long Chinese natural-language queries degrade to one
 * byte-capped fragment. This module adds a real full-text index:
 *
 *   conversation_archive_fts — FTS5 virtual table, ROWID-KEYED TO
 *   conversation_archive.rowid (no duplicated key column; the join back is
 *   `archive.rowid IN (matching fts rowids)`). One column `seg` holds the
 *   SEGMENTED text: FTS5's unicode61 tokenizer treats a CJK run as ONE
 *   token, so we split CJK into single space-separated chars at index time
 *   and query CJK runs as phrases ("怎 么 修") — adjacency-preserving
 *   unigram matching, the standard CJK-on-FTS5 approach.
 *
 * Prod support was probe-verified 2026-07-16 (/api/inspect/fts5-probe:
 * supported + CJK MATCH ok on a real agent DO).
 *
 * Lifecycle:
 *   - ensureConversationFts(): CREATE IF NOT EXISTS (virtual + state
 *     tables). Returns false where FTS5 is unavailable → every caller
 *     degrades to the LIKE path. Never throws.
 *   - Write path: after each archive chunk INSERT OR REPLACE, the chunk's
 *     CURRENT rowid is (re)indexed (INSERT OR REPLACE INTO fts(rowid, seg)).
 *     An archive REPLACE mints a new rowid and orphans the old fts row —
 *     orphans lose the join and only waste a candidate slot (we overfetch).
 *   - Backfill: watermark walk over archive rowids, BATCHED (the operator
 *     archive is 100k+ chunks; one-shot would OOM the DO — the 07-01
 *     truncate-on-persist lesson). Search/write calls each advance one
 *     batch; the FTS path activates only once the watermark catches up.
 *
 * Query strategy: units = latin words + CJK-run phrases. Try the AND query
 * first (precision); if it fills fewer than topK candidates, union in the
 * OR query (recall), bm25-ranked, deduped, AND-hits first.
 */

import type { AgentSqlTag } from "./migrations";

export interface ArchiveFtsHost {
  sql: AgentSqlTag;
  logEvent: (type: string, payload: unknown) => void;
}

/** Rows indexed per backfill step — bounds one call's memory/time. */
export const FTS_BACKFILL_BATCH = 400;
/** Candidate rowids fetched per MATCH (overfetch: outer filters prune). */
export const FTS_CANDIDATE_LIMIT = 80;
const SEG_MAX_CHARS = 8000; // segmentation doubles CJK length; cap the row

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * Space-separate every CJK char; keep latin/digit runs intact; drop other
 * punctuation to spaces (FTS5 treats it as separators anyway).
 */
export function segmentForFts(s: string): string {
  const capped = s.length > SEG_MAX_CHARS ? s.slice(0, SEG_MAX_CHARS) : s;
  let out = "";
  let prevType: "cjk" | "word" | "gap" = "gap";
  for (const ch of capped) {
    if (CJK_RE.test(ch)) {
      if (prevType !== "gap") out += " ";
      out += ch;
      prevType = "cjk";
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      if (prevType === "cjk") out += " ";
      out += ch;
      prevType = "word";
    } else {
      if (prevType !== "gap") out += " ";
      prevType = "gap";
    }
  }
  return out.trimEnd();
}

/**
 * Query units: each latin word and each CJK run is one unit. CJK runs
 * become FTS5 phrases over their segmented chars, preserving adjacency.
 */
export function buildFtsUnits(queryRaw: string): string[] {
  const units: string[] = [];
  const re = /([A-Za-z0-9_]+)|([぀-ヿ㐀-䶿一-鿿豈-﫿]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(queryRaw)) !== null && units.length < 12) {
    if (m[1]) units.push(m[1]);
    else if (m[2]) units.push(m[2]);
  }
  return units;
}

/** One unit → its quoted FTS5 term (CJK run = segmented phrase). */
function unitToTerm(unit: string): string {
  const safe = unit.replace(/"/g, "");
  if (CJK_RE.test(safe)) return `"${segmentForFts(safe)}"`;
  return `"${safe}"`;
}

export function buildMatchExpr(units: string[], op: "AND" | "OR"): string {
  return units.map(unitToTerm).join(` ${op} `);
}

/** True when FTS is usable on this DO. Never throws. */
export function ensureConversationFts(host: ArchiveFtsHost): boolean {
  try {
    host.sql`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_archive_fts USING fts5(seg)`;
    host.sql`
      CREATE TABLE IF NOT EXISTS archive_fts_state (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `;
    return true;
  } catch (e) {
    host.logEvent("archive.fts.unavailable", {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    return false;
  }
}

function readWatermark(host: ArchiveFtsHost): number {
  const rows = host.sql<{ v: string }>`SELECT v FROM archive_fts_state WHERE k = 'backfill_rowid'`;
  const n = rows.length ? Number(rows[0].v) : 0;
  return Number.isFinite(n) ? n : 0;
}

function writeWatermark(host: ArchiveFtsHost, rowid: number): void {
  host.sql`
    INSERT INTO archive_fts_state (k, v) VALUES ('backfill_rowid', ${String(rowid)})
    ON CONFLICT(k) DO UPDATE SET v = ${String(rowid)}
  `;
}

/** Index (or re-index) one archive row by its CURRENT rowid. */
function indexRow(host: ArchiveFtsHost, rowid: number, indexText: string | null, text: string): void {
  const seg = segmentForFts(indexText && indexText.length > 0 ? indexText : text);
  host.sql`INSERT OR REPLACE INTO conversation_archive_fts (rowid, seg) VALUES (${rowid}, ${seg})`;
}

/**
 * Write-path hook: index freshly written chunks by chunk_id. Fail-soft —
 * archiving must never break because of the index.
 */
export function ftsIndexChunks(host: ArchiveFtsHost, chunkIds: readonly string[]): void {
  if (chunkIds.length === 0) return;
  try {
    if (!ensureConversationFts(host)) return;
    for (const chunkId of chunkIds) {
      const rows = host.sql<{ rowid: number | bigint; index_text: string | null; text: string }>`
        SELECT rowid, index_text, text FROM conversation_archive WHERE chunk_id = ${chunkId} LIMIT 1
      `;
      if (rows.length === 0) continue;
      indexRow(host, Number(rows[0].rowid), rows[0].index_text, rows[0].text);
    }
  } catch (e) {
    host.logEvent("archive.fts.index_error", {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      chunk_count: chunkIds.length,
    });
  }
}

export interface FtsBackfillStatus {
  ready: boolean; // watermark has caught the archive's max rowid
  processed: number; // rows indexed by THIS call
  watermark: number;
  maxRowid: number;
}

/**
 * Advance the backfill by one batch. Idempotent with the write-path hook
 * (both INSERT OR REPLACE the same rowid). Fail-soft: on error reports
 * not-ready and the search caller stays on the LIKE path.
 */
export function advanceFtsBackfill(host: ArchiveFtsHost, batch = FTS_BACKFILL_BATCH): FtsBackfillStatus {
  const fail: FtsBackfillStatus = { ready: false, processed: 0, watermark: 0, maxRowid: 0 };
  try {
    if (!ensureConversationFts(host)) return fail;
    const maxRows = host.sql<{ m: number | bigint | null }>`SELECT MAX(rowid) AS m FROM conversation_archive`;
    const maxRowid = maxRows.length && maxRows[0].m !== null ? Number(maxRows[0].m) : 0;
    let watermark = readWatermark(host);
    if (watermark >= maxRowid) {
      return { ready: true, processed: 0, watermark, maxRowid };
    }
    const rows = host.sql<{ rowid: number | bigint; index_text: string | null; text: string }>`
      SELECT rowid, index_text, text FROM conversation_archive
      WHERE rowid > ${watermark}
      ORDER BY rowid
      LIMIT ${batch}
    `;
    for (const r of rows) {
      indexRow(host, Number(r.rowid), r.index_text, r.text);
      watermark = Number(r.rowid);
    }
    writeWatermark(host, watermark);
    const ready = watermark >= maxRowid;
    if (rows.length > 0) {
      host.logEvent("archive.fts.backfill", {
        processed: rows.length,
        watermark,
        max_rowid: maxRowid,
        ready,
      });
    }
    return { ready, processed: rows.length, watermark, maxRowid };
  } catch (e) {
    host.logEvent("archive.fts.backfill_error", {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    return fail;
  }
}

/**
 * Candidate archive rowids for a query, bm25-ranked. AND-first for
 * precision; if that undershoots `needed`, union the OR query for recall
 * (AND hits keep their lead positions). Returns null when the query has no
 * indexable units (caller falls back to LIKE). Throws on SQL errors —
 * the caller's try/catch owns the LIKE fallback.
 */
export function ftsCandidateRowids(
  host: ArchiveFtsHost,
  queryRaw: string,
  needed: number,
  limit = FTS_CANDIDATE_LIMIT,
): number[] | null {
  const units = buildFtsUnits(queryRaw);
  if (units.length === 0) return null;
  const run = (expr: string): number[] => {
    const rows = host.sql<{ rowid: number | bigint }>`
      SELECT rowid FROM conversation_archive_fts
      WHERE conversation_archive_fts MATCH ${expr}
      ORDER BY bm25(conversation_archive_fts)
      LIMIT ${limit}
    `;
    return rows.map((r) => Number(r.rowid));
  };
  const andIds = run(buildMatchExpr(units, "AND"));
  if (andIds.length >= needed || units.length === 1) return andIds;
  const orIds = run(buildMatchExpr(units, "OR"));
  const seen = new Set(andIds);
  const merged = [...andIds];
  for (const id of orIds) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}
