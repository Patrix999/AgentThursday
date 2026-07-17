/**
 * A1 Phase 2 M1: operator archive migration helpers.
 *
 * Pure host-style ops (no `this`, no `env`) backing the three migration
 * @callables on `AgentThursdayAgent`: batch-read the legacy operator archive off the
 * registry DO, idempotently ingest batches into the operator DO, and produce
 * a reconcile summary both sides can be compared on (row count, per-owner
 * count + text bytes, chunk-id watermarks).
 *
 * Invariants:
 * - COPY, never move: the source rows on the registry are not touched.
 * - Idempotent ingest: `INSERT ... ON CONFLICT(chunk_id) DO NOTHING` — a
 *   re-run or overlapping batch can never clobber an already-copied chunk.
 * - Rows are copied verbatim, all 20 columns including `owner_user_id`
 *   (the 823-admin/35-the operator split observed in prod stays intact).
 * - Batches are ordered by `chunk_id`, so the destination's max chunk_id is
 *   a resume watermark.
 */

export type ArchiveMigrationSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface ArchiveMigrationHost {
  sql: ArchiveMigrationSqlTag;
}

/** All 20 `conversation_archive` columns, copied verbatim. */
export type ArchiveChunkRow = {
  chunk_id: string;
  context_id: string;
  message_id: string | null;
  message_index: number | null;
  role: string | null;
  speaker: string | null;
  surface: string | null;
  task_id: string | null;
  card_id: string | null;
  type: string | null;
  harness_class: string | null;
  text: string;
  index_text: string | null;
  redaction_flags: string | null;
  source_ref: string | null;
  is_synthetic_compaction: number;
  created_at: number;
  archived_at: number;
  trigger: string;
  owner_user_id: string;
};

export const ARCHIVE_MIGRATION_MAX_BATCH = 500;

export function readArchiveChunkBatchRows(
  host: ArchiveMigrationHost,
  afterChunkId: string | null,
  limit: number,
): ArchiveChunkRow[] {
  const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), ARCHIVE_MIGRATION_MAX_BATCH);
  if (afterChunkId === null || afterChunkId === "") {
    return host.sql<ArchiveChunkRow>`
      SELECT chunk_id, context_id, message_id, message_index, role, speaker, surface,
             task_id, card_id, type, harness_class, text, index_text, redaction_flags,
             source_ref, is_synthetic_compaction, created_at, archived_at, trigger, owner_user_id
      FROM conversation_archive
      ORDER BY chunk_id
      LIMIT ${cappedLimit}
    `;
  }
  return host.sql<ArchiveChunkRow>`
    SELECT chunk_id, context_id, message_id, message_index, role, speaker, surface,
           task_id, card_id, type, harness_class, text, index_text, redaction_flags,
           source_ref, is_synthetic_compaction, created_at, archived_at, trigger, owner_user_id
    FROM conversation_archive
    WHERE chunk_id > ${afterChunkId}
    ORDER BY chunk_id
    LIMIT ${cappedLimit}
  `;
}

export function ingestArchiveChunkRows(
  host: ArchiveMigrationHost,
  rows: readonly ArchiveChunkRow[],
): { received: number } {
  for (const r of rows) {
    host.sql`
      INSERT INTO conversation_archive
        (chunk_id, context_id, message_id, message_index, role, speaker, surface,
         task_id, card_id, type, harness_class, text, index_text, redaction_flags,
         source_ref, is_synthetic_compaction, created_at, archived_at, trigger, owner_user_id)
      VALUES
        (${r.chunk_id}, ${r.context_id}, ${r.message_id}, ${r.message_index}, ${r.role},
         ${r.speaker}, ${r.surface}, ${r.task_id}, ${r.card_id}, ${r.type},
         ${r.harness_class}, ${r.text}, ${r.index_text}, ${r.redaction_flags},
         ${r.source_ref}, ${r.is_synthetic_compaction}, ${r.created_at}, ${r.archived_at},
         ${r.trigger}, ${r.owner_user_id})
      ON CONFLICT(chunk_id) DO NOTHING
    `;
  }
  return { received: rows.length };
}

export type ArchiveReconcileSummary = {
  total: number;
  by_owner: Array<{ owner_user_id: string; n: number; text_bytes: number }>;
  min_chunk_id: string | null;
  max_chunk_id: string | null;
};

export function archiveReconcileSummaryRows(host: ArchiveMigrationHost): ArchiveReconcileSummary {
  const byOwner = host.sql<{ owner_user_id: string; n: number; text_bytes: number }>`
    SELECT owner_user_id, COUNT(*) AS n, SUM(LENGTH(text)) AS text_bytes
    FROM conversation_archive
    GROUP BY owner_user_id
    ORDER BY owner_user_id
  `;
  const bounds = host.sql<{ total: number; min_chunk_id: string | null; max_chunk_id: string | null }>`
    SELECT COUNT(*) AS total, MIN(chunk_id) AS min_chunk_id, MAX(chunk_id) AS max_chunk_id
    FROM conversation_archive
  `;
  const b = bounds[0] ?? { total: 0, min_chunk_id: null, max_chunk_id: null };
  return {
    total: b.total,
    by_owner: byOwner,
    min_chunk_id: b.min_chunk_id,
    max_chunk_id: b.max_chunk_id,
  };
}
