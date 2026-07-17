/**
 * User-uploaded documents (2026-06-23). We persist ONLY the agent-readable
 * markdown — the raw file is converted via `env.AI.toMarkdown` and discarded
 * (the operator). The markdown body lives in R2 (DOCS_BUCKET, owner-keyed); these pure
 * SQL helpers own the OWNER-SCOPED metadata row on the registry DO.
 *
 * `scopeOwnerId`: undefined = admin/operator (whole pool); a string = that owner
 * only. The `document.*` agent tool always passes the dispatching agent's owner
 * and fails CLOSED on an unresolved owner, so an agent only ever sees its own
 * owner's documents.
 */
export type DocSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface DocOpsHost {
  sql: DocSqlTag;
}

export interface UploadedDocRow {
  doc_id: string;
  owner_user_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  char_count: number;
  sha256: string;
  r2_key: string;
  preview: string;
  // 2026-06-25 async upload: 'done' (markdown in R2) | 'processing' (localdoc queue,
  // markdown not yet fetched) | 'failed'. `pending_ref` is the localdoc poll URL while
  // processing; null otherwise. Existing rows back-fill to 'done' (column DEFAULT).
  status: string;
  pending_ref: string | null;
  created_at: string;
}

/** Listing/search shape exposed to the tool + UI (no owner id, no r2 key, no localdoc url). */
export interface UploadedDocMeta {
  doc_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  char_count: number;
  created_at: string;
  preview: string;
  status: string;
}

export function insertDocument(host: DocOpsHost, row: UploadedDocRow): void {
  host.sql`
    INSERT INTO uploaded_document
      (doc_id, owner_user_id, filename, mime, size_bytes, char_count, sha256, r2_key, preview, status, pending_ref, created_at)
    VALUES
      (${row.doc_id}, ${row.owner_user_id}, ${row.filename}, ${row.mime}, ${row.size_bytes},
       ${row.char_count}, ${row.sha256}, ${row.r2_key}, ${row.preview}, ${row.status}, ${row.pending_ref}, ${row.created_at})
  `;
}

export function listDocuments(host: DocOpsHost, scopeOwnerId?: string): UploadedDocMeta[] {
  return scopeOwnerId === undefined
    ? host.sql<UploadedDocMeta>`
        SELECT doc_id, filename, mime, size_bytes, char_count, created_at, preview, status
        FROM uploaded_document ORDER BY created_at DESC
      `
    : host.sql<UploadedDocMeta>`
        SELECT doc_id, filename, mime, size_bytes, char_count, created_at, preview, status
        FROM uploaded_document WHERE owner_user_id = ${scopeOwnerId} ORDER BY created_at DESC
      `;
}

/** Processing rows (localdoc queue not yet drained) for one owner — the resolve loop's input. */
export function listPendingDocuments(host: DocOpsHost, scopeOwnerId?: string): UploadedDocRow[] {
  return scopeOwnerId === undefined
    ? host.sql<UploadedDocRow>`SELECT * FROM uploaded_document WHERE status = 'processing'`
    : host.sql<UploadedDocRow>`SELECT * FROM uploaded_document WHERE status = 'processing' AND owner_user_id = ${scopeOwnerId}`;
}

/** Flip a processing row to done once its markdown has been fetched + stored in R2. */
export function markDocumentResolved(host: DocOpsHost, docId: string, charCount: number, preview: string): void {
  host.sql`UPDATE uploaded_document SET status = 'done', char_count = ${charCount}, preview = ${preview}, pending_ref = NULL WHERE doc_id = ${docId} AND status = 'processing'`;
}

/** Mark a processing row failed (localdoc error / TTL expiry) so it stops spinning. */
export function markDocumentFailed(host: DocOpsHost, docId: string): void {
  host.sql`UPDATE uploaded_document SET status = 'failed', pending_ref = NULL WHERE doc_id = ${docId} AND status = 'processing'`;
}

export function getDocumentRow(host: DocOpsHost, docId: string, scopeOwnerId?: string): UploadedDocRow | null {
  const rows =
    scopeOwnerId === undefined
      ? host.sql<UploadedDocRow>`SELECT * FROM uploaded_document WHERE doc_id = ${docId} LIMIT 1`
      : host.sql<UploadedDocRow>`
          SELECT * FROM uploaded_document WHERE doc_id = ${docId} AND owner_user_id = ${scopeOwnerId} LIMIT 1
        `;
  return rows.length === 0 ? null : rows[0];
}

export function deleteDocumentRow(host: DocOpsHost, docId: string, scopeOwnerId?: string): UploadedDocRow | null {
  const existing = getDocumentRow(host, docId, scopeOwnerId);
  if (!existing) return null;
  host.sql`DELETE FROM uploaded_document WHERE doc_id = ${docId}`;
  return existing;
}
