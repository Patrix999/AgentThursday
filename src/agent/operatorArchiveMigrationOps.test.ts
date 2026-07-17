import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  type ArchiveChunkRow,
  type ArchiveMigrationSqlTag,
  archiveReconcileSummaryRows,
  ingestArchiveChunkRows,
  readArchiveChunkBatchRows,
} from "./operatorArchiveMigrationOps";

function mkChunk(over: Partial<ArchiveChunkRow> = {}): ArchiveChunkRow {
  return {
    chunk_id: "chunk_a",
    context_id: "ctx-1",
    message_id: null,
    message_index: 0,
    role: "assistant",
    speaker: null,
    surface: null,
    task_id: null,
    card_id: null,
    type: null,
    harness_class: null,
    text: "hello",
    index_text: null,
    redaction_flags: null,
    source_ref: null,
    is_synthetic_compaction: 0,
    created_at: 1,
    archived_at: 2,
    trigger: "context.reset",
    owner_user_id: "user-admin",
    ...over,
  };
}

/** In-memory conversation_archive fake honoring the three statement shapes. */
function mkHost(): { sql: ArchiveMigrationSqlTag; rows: ArchiveChunkRow[] } {
  const rows: ArchiveChunkRow[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as (string | number)[];
    if (text.startsWith("INSERT INTO conversation_archive")) {
      const chunkId = v[0] as string;
      // ON CONFLICT(chunk_id) DO NOTHING
      if (rows.some(r => r.chunk_id === chunkId)) return [];
      rows.push(mkChunk({
        chunk_id: chunkId,
        context_id: v[1] as string,
        text: v[11] as string,
        owner_user_id: v[19] as string,
      }));
      return [];
    }
    if (text.startsWith("SELECT chunk_id,")) {
      let i = 0;
      const after = text.includes("WHERE chunk_id >") ? (v[i++] as string) : null;
      const limit = v[i++] as number;
      return rows
        .filter(r => after === null || r.chunk_id > after)
        .slice()
        .sort((a, b) => (a.chunk_id < b.chunk_id ? -1 : 1))
        .slice(0, limit)
        .map(r => ({ ...r }));
    }
    if (text.startsWith("SELECT owner_user_id, COUNT(*)")) {
      const byOwner = new Map<string, { n: number; text_bytes: number }>();
      for (const r of rows) {
        const e = byOwner.get(r.owner_user_id) ?? { n: 0, text_bytes: 0 };
        e.n += 1;
        e.text_bytes += r.text.length;
        byOwner.set(r.owner_user_id, e);
      }
      return [...byOwner.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([owner_user_id, e]) => ({ owner_user_id, ...e }));
    }
    if (text.startsWith("SELECT COUNT(*) AS total")) {
      const ids = rows.map(r => r.chunk_id).sort();
      return [{
        total: rows.length,
        min_chunk_id: ids[0] ?? null,
        max_chunk_id: ids[ids.length - 1] ?? null,
      }];
    }
    throw new Error(`fake sql: unrouted statement: ${text}`);
  }) as unknown as ArchiveMigrationSqlTag;
  return { sql, rows };
}

describe("readArchiveChunkBatchRows", () => {
  it("pages in chunk_id order and respects the watermark", () => {
    const src = mkHost();
    for (const id of ["c3", "c1", "c2", "c5", "c4"]) {
      src.rows.push(mkChunk({ chunk_id: id }));
    }
    const p1 = readArchiveChunkBatchRows(src, null, 2);
    assert.deepEqual(p1.map(r => r.chunk_id), ["c1", "c2"]);
    const p2 = readArchiveChunkBatchRows(src, "c2", 2);
    assert.deepEqual(p2.map(r => r.chunk_id), ["c3", "c4"]);
    const p3 = readArchiveChunkBatchRows(src, "c4", 2);
    assert.deepEqual(p3.map(r => r.chunk_id), ["c5"]);
    assert.deepEqual(readArchiveChunkBatchRows(src, "c5", 2), []);
  });

  it("caps the limit at the module max", () => {
    const src = mkHost();
    for (let i = 0; i < 3; i++) src.rows.push(mkChunk({ chunk_id: `c${i}` }));
    // limit 0 / negative clamps to 1
    assert.equal(readArchiveChunkBatchRows(src, null, 0).length, 1);
  });
});

describe("ingestArchiveChunkRows (idempotent copy)", () => {
  it("copies rows verbatim and re-ingest is a no-op (ON CONFLICT DO NOTHING)", () => {
    const dst = mkHost();
    const batch = [mkChunk({ chunk_id: "c1", owner_user_id: "user-admin" }), mkChunk({ chunk_id: "c2", owner_user_id: "user-pat" })];
    assert.deepEqual(ingestArchiveChunkRows(dst, batch), { received: 2 });
    assert.equal(dst.rows.length, 2);
    // overlapping re-send: nothing clobbered, nothing duplicated
    assert.deepEqual(ingestArchiveChunkRows(dst, batch), { received: 2 });
    assert.equal(dst.rows.length, 2);
    assert.deepEqual(dst.rows.map(r => r.owner_user_id).sort(), ["user-admin", "user-pat"]);
  });
});

describe("archiveReconcileSummaryRows", () => {
  it("reports total, per-owner counts+bytes, and chunk-id bounds", () => {
    const h = mkHost();
    h.rows.push(mkChunk({ chunk_id: "c1", text: "aaaa", owner_user_id: "user-admin" }));
    h.rows.push(mkChunk({ chunk_id: "c2", text: "bb", owner_user_id: "user-admin" }));
    h.rows.push(mkChunk({ chunk_id: "c3", text: "c", owner_user_id: "user-pat" }));
    const s = archiveReconcileSummaryRows(h);
    assert.equal(s.total, 3);
    assert.deepEqual(s.by_owner, [
      { owner_user_id: "user-admin", n: 2, text_bytes: 6 },
      { owner_user_id: "user-pat", n: 1, text_bytes: 1 },
    ]);
    assert.equal(s.min_chunk_id, "c1");
    assert.equal(s.max_chunk_id, "c3");
  });

  it("empty table → zero/null summary", () => {
    const s = archiveReconcileSummaryRows(mkHost());
    assert.deepEqual(s, { total: 0, by_owner: [], min_chunk_id: null, max_chunk_id: null });
  });
});

describe("source→destination end-to-end copy (fake hosts)", () => {
  it("full drain via watermark loop reproduces the source exactly", () => {
    const src = mkHost();
    for (let i = 0; i < 7; i++) {
      src.rows.push(mkChunk({ chunk_id: `chunk_${i}`, text: `t${i}`, owner_user_id: i % 3 === 0 ? "user-pat" : "user-admin" }));
    }
    const dst = mkHost();
    let after: string | null = null;
    for (;;) {
      const batch = readArchiveChunkBatchRows(src, after, 3);
      if (batch.length === 0) break;
      ingestArchiveChunkRows(dst, batch);
      after = batch[batch.length - 1].chunk_id;
    }
    const a = archiveReconcileSummaryRows(src);
    const b = archiveReconcileSummaryRows(dst);
    assert.deepEqual(a, b);
  });
});
