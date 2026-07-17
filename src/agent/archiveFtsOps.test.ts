/**
 * FTS5 conversation search against REAL sqlite (node:sqlite ships
 * FTS5 — probe-verified). Covers: segmentation, unit building, backfill
 * watermark walk, write-path indexing, CJK NL recall through the full
 * conversationSearchFree pipeline, ranked AND→OR merge, owner scoping on
 * the FTS path, and fail-soft fallback to LIKE when the index breaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  segmentForFts,
  buildFtsUnits,
  buildMatchExpr,
  ensureConversationFts,
  ftsIndexChunks,
  advanceFtsBackfill,
  ftsCandidateRowids,
} from "./archiveFtsOps";
import { writeArchiveFlushFree, conversationSearchFree, type ArchiveWriteHost } from "./archiveOps";

function mkSqlite() {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const params = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as Array<
      string | number | null
    >;
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)/i.test(text);
    const stmt = db.prepare(text);
    if (isQuery) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }) as ArchiveWriteHost["sql"];
  return { sql, db };
}

const ARCHIVE_DDL = `
  CREATE TABLE conversation_archive (
    chunk_id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    message_id TEXT,
    message_index INTEGER,
    role TEXT,
    speaker TEXT, surface TEXT, task_id TEXT, card_id TEXT, type TEXT, harness_class TEXT,
    text TEXT NOT NULL,
    index_text TEXT,
    redaction_flags TEXT, source_ref TEXT,
    is_synthetic_compaction INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT 'user-admin'
  );
  CREATE TABLE conversation_archive_flushes (
    flush_id TEXT PRIMARY KEY, context_id TEXT, trigger TEXT, chunk_count INTEGER,
    message_count INTEGER, status TEXT, reason TEXT, error TEXT, created_at INTEGER
  );
  CREATE TABLE conversation_retrieval_log (
    retrieval_id TEXT PRIMARY KEY, query TEXT, filters_json TEXT, returned_refs_json TEXT,
    used_refs_json TEXT, trace_id TEXT, context_id TEXT, task_id TEXT, result_count INTEGER, created_at INTEGER
  );
`;

function mkHost(): { host: ArchiveWriteHost; db: DatabaseSync } {
  const { sql, db } = mkSqlite();
  db.exec(ARCHIVE_DDL);
  const host: ArchiveWriteHost = {
    sql,
    logEvent: () => {},
    getMessages: () => [],
    ensureActiveContext: () => ({ context_id: "ctx_test", reason: null, created_at: 0 }),
  };
  return { host, db };
}

function insertChunk(
  db: DatabaseSync,
  id: string,
  text: string,
  opts: { owner?: string; contextId?: string; archivedAt?: number } = {},
): void {
  db.prepare(
    `INSERT INTO conversation_archive
     (chunk_id, context_id, text, index_text, created_at, archived_at, trigger, owner_user_id)
     VALUES (?, ?, ?, ?, 1, ?, 'test', ?)`,
  ).run(id, opts.contextId ?? "ctx_a", text, text, opts.archivedAt ?? 1000, opts.owner ?? "user-admin");
}

test("segmentForFts: CJK chars split, latin runs intact", () => {
  assert.equal(segmentForFts("修复DO的OOM问题"), "修 复 DO 的 OOM 问 题");
  assert.equal(segmentForFts("hello world"), "hello world");
  assert.equal(segmentForFts("价格表(pricing)更新!"), "价 格 表 pricing 更 新");
});

test("buildFtsUnits + buildMatchExpr: words and CJK-run phrases", () => {
  const units = buildFtsUnits("上次聊的DO OOM怎么修");
  assert.deepEqual(units, ["上次聊的", "DO", "OOM", "怎么修"]);
  assert.equal(
    buildMatchExpr(["怎么修", "DO"], "AND"),
    '"怎 么 修" AND "DO"',
  );
  assert.deepEqual(buildFtsUnits("!!!???"), []);
});

test("backfill: watermark walk → ready; idempotent with write-path indexing", async () => {
  const { host, db } = mkHost();
  for (let i = 0; i < 5; i++) insertChunk(db, `c${i}`, `历史消息第${i}条 about topic${i}`);
  assert.equal(ensureConversationFts(host), true);
  // batch=2 → three calls to catch up
  let st = advanceFtsBackfill(host, 2);
  assert.equal(st.ready, false);
  assert.equal(st.processed, 2);
  st = advanceFtsBackfill(host, 2);
  st = advanceFtsBackfill(host, 2);
  assert.equal(st.ready, true);
  // idempotent re-index of same rowids (write-path overlap)
  ftsIndexChunks(host, ["c1", "c3"]);
  const ids = ftsCandidateRowids(host, "topic3", 3);
  assert.equal(ids?.length, 1);
});

test("end-to-end: archive write → FTS-indexed → Chinese NL query hits (ranked)", async () => {
  const { host } = mkHost();
  ensureConversationFts(host);
  writeArchiveFlushFree(host, {
    contextId: "ctx_a",
    trigger: "manual",
    reason: null,
    chunks: [
      { messageId: "m1", messageIndex: 0, role: "assistant", text: "今天我们修复了DO的OOM问题，方法是截断大文件读取", indexText: null, isSyntheticCompaction: false },
      { messageId: "m2", messageIndex: 1, role: "assistant", text: "definitely unrelated content about webhooks", indexText: null, isSyntheticCompaction: false },
      { messageId: "m3", messageIndex: 2, role: "user", text: "价格表更新到了官网最新数值", indexText: null, isSyntheticCompaction: false },
    ],
  });
  advanceFtsBackfill(host); // catch watermark up (write-path already indexed; idempotent)
  const r = conversationSearchFree(host, { query: "上次DO的OOM问题是怎么修复的", topK: 3 });
  assert.equal(r.hits.length >= 1, true, "Chinese NL query should hit");
  assert.equal(r.hits[0].matchReason, "fts_match");
  assert.match(r.hits[0].snippet, /OOM/);
  // the unrelated chunks don't outrank the real hit
  assert.equal(r.hits[0].messageId, "m1");
});

test("AND-first precision, OR merge recall", async () => {
  const { host, db } = mkHost();
  ensureConversationFts(host);
  insertChunk(db, "both", "deploy 和 webhook 都在这条里");
  insertChunk(db, "only-deploy", "这条只有 deploy 一个词");
  advanceFtsBackfill(host);
  // AND query satisfied by 'both' alone; OR merge brings in 'only-deploy'
  const ids = ftsCandidateRowids(host, "deploy webhook", 3);
  assert.equal(ids?.length, 2);
  const first = db.prepare("SELECT chunk_id FROM conversation_archive WHERE rowid = ?").get(ids![0]) as { chunk_id: string };
  assert.equal(first.chunk_id, "both", "AND hit ranks first");
});

test("owner scoping holds on the FTS path", async () => {
  const { host, db } = mkHost();
  ensureConversationFts(host);
  insertChunk(db, "mine", "机密内容 alpha", { owner: "user-a" });
  insertChunk(db, "theirs", "机密内容 beta", { owner: "user-b" });
  advanceFtsBackfill(host);
  const scoped = conversationSearchFree(host, { query: "机密内容", topK: 5 }, "user-a");
  assert.deepEqual(scoped.hits.map((h) => h.chunkId), ["mine"]);
  const admin = conversationSearchFree(host, { query: "机密内容", topK: 5 });
  assert.equal(admin.hits.length, 2);
});

test("fail-soft: broken FTS index falls back to LIKE path", async () => {
  const { host, db } = mkHost();
  ensureConversationFts(host);
  insertChunk(db, "c1", "fallback target row");
  advanceFtsBackfill(host);
  // sabotage: replace the virtual table with an incompatible plain table
  db.exec("DROP TABLE conversation_archive_fts");
  db.exec("CREATE TABLE conversation_archive_fts (seg TEXT)"); // MATCH now errors
  const r = conversationSearchFree(host, { query: "fallback", topK: 3 });
  assert.equal(r.hits.length, 1);
  assert.notEqual(r.hits[0].matchReason, "fts_match");
});

test("filters (context/time) apply on the FTS path", async () => {
  const { host, db } = mkHost();
  ensureConversationFts(host);
  insertChunk(db, "old", "会议纪要 topic", { archivedAt: 100, contextId: "ctx_1" });
  insertChunk(db, "new", "会议纪要 topic", { archivedAt: 900, contextId: "ctx_2" });
  advanceFtsBackfill(host);
  const timed = conversationSearchFree(host, { query: "会议纪要", topK: 5, fromTimestamp: 500 });
  assert.deepEqual(timed.hits.map((h) => h.chunkId), ["new"]);
  const ctx = conversationSearchFree(host, { query: "会议纪要", topK: 5, contextId: "ctx_1" });
  assert.deepEqual(ctx.hits.map((h) => h.chunkId), ["old"]);
});
