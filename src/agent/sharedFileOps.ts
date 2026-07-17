/**
 * Workspace file share — pure ops (2026-06-19, replaces fyimd external-publishing).
 *
 * A global agent capability: snapshot a single workspace file into the
 * registry-DO `shared_file` table so other agents of the SAME owner and the
 * owner user can read it. There is no public path — every read is filtered by
 * `owner_user_id` (the security boundary). Content is snapshotted because
 * per-agent workspaces are isolated.
 *
 * This module is pure (validation + SQL helpers, no DO/env), so the suite can
 * unit-test the owner-scope filters and the secret/size guards directly. The
 * secret-scan / filename validators are REUSED from `artifactShare.ts` so the
 * share path has the same leak protection as artifact delivery.
 */
import { scanSecrets, validateFilename, sha256Hex } from "../artifactShare";

// Single cap (UTF-8 bytes, not JS string length — multi-byte chars must not
// slip past). 1 MB matches the artifact `smoke_json` cap and is plenty for a
// text document; binary/huge files are out of scope for v1.
export const SHARED_FILE_SIZE_CAP_BYTES = 1024 * 1024;
export const SHARED_FILE_NOTE_MAX = 200;

export interface SharedFileRow {
  file_id: string;
  owner_user_id: string;
  source_agent_id: string;
  source_agent_name: string | null;
  filename: string;
  content: string;
  sha256: string;
  size_bytes: number;
  mime: string;
  note: string | null;
  created_at: string;
}

/** List/metadata view — never carries the file body. */
export type SharedFileMeta = Omit<SharedFileRow, "content">;

export interface SharedFileSqlHost {
  sql: <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];
}

export type ShareValidation =
  | {
      ok: true;
      filename: string;
      sizeBytes: number;
      sha256Promise: Promise<string>;
      mime: string;
      note: string | null;
    }
  | {
      ok: false;
      code: "invalid_filename" | "empty_content" | "oversize" | "secret_pattern";
      message: string;
    };

/** Infer a conservative text MIME from the filename extension. */
export function inferShareMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  return "text/plain";
}

/**
 * Validate a share request. Reuses the artifact filename + secret-scan guards
 * so a shared file can never leak a credential to another agent or the user,
 * and caps size by UTF-8 byte length.
 */
export function validateShareFileInput(input: {
  filename: unknown;
  content: unknown;
  note?: unknown;
}): ShareValidation {
  const fn = validateFilename(input.filename);
  if (!("ok" in fn)) {
    return { ok: false, code: "invalid_filename", message: fn.message };
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    return { ok: false, code: "empty_content", message: "content is empty or not a string" };
  }
  const sizeBytes = new TextEncoder().encode(input.content).length;
  if (sizeBytes > SHARED_FILE_SIZE_CAP_BYTES) {
    return {
      ok: false,
      code: "oversize",
      message: `file size ${sizeBytes} bytes exceeds cap ${SHARED_FILE_SIZE_CAP_BYTES}`,
    };
  }
  const secret = scanSecrets(input.content);
  if (!("ok" in secret)) {
    return { ok: false, code: "secret_pattern", message: secret.message };
  }
  const note =
    typeof input.note === "string" && input.note.length > 0
      ? input.note.slice(0, SHARED_FILE_NOTE_MAX)
      : null;
  return {
    ok: true,
    filename: fn.filename,
    sizeBytes,
    sha256Promise: sha256Hex(input.content),
    mime: inferShareMime(fn.filename),
    note,
  };
}

export function insertSharedFileRow(host: SharedFileSqlHost, row: SharedFileRow): void {
  host.sql`
    INSERT INTO shared_file
      (file_id, owner_user_id, source_agent_id, source_agent_name, filename,
       content, sha256, size_bytes, mime, note, created_at)
    VALUES
      (${row.file_id}, ${row.owner_user_id}, ${row.source_agent_id}, ${row.source_agent_name},
       ${row.filename}, ${row.content}, ${row.sha256}, ${row.size_bytes}, ${row.mime},
       ${row.note}, ${row.created_at})
  `;
}

/**
 * Owner-scoped metadata list (newest first). `scopeOwnerId === undefined`
 * (admin/operator) sees every tenant's shares; a scoped user sees only its own
 * owner. Never returns the file body.
 */
export function listSharedFileRows(
  host: SharedFileSqlHost,
  scopeOwnerId?: string,
  limit = 100,
): SharedFileMeta[] {
  const lim = Math.max(1, Math.min(500, limit));
  const rows =
    scopeOwnerId === undefined
      ? host.sql<SharedFileMeta>`
          SELECT file_id, owner_user_id, source_agent_id, source_agent_name, filename,
                 sha256, size_bytes, mime, note, created_at
            FROM shared_file ORDER BY created_at DESC LIMIT ${lim}`
      : host.sql<SharedFileMeta>`
          SELECT file_id, owner_user_id, source_agent_id, source_agent_name, filename,
                 sha256, size_bytes, mime, note, created_at
            FROM shared_file WHERE owner_user_id = ${scopeOwnerId}
           ORDER BY created_at DESC LIMIT ${lim}`;
  return rows;
}

/**
 * Owner-scoped single read (body included). Strict-own: a scoped caller whose
 * owner doesn't match gets `null` (not_found, no existence leak). Admin
 * (`scopeOwnerId === undefined`) reads any row.
 */
export function readSharedFileRow(
  host: SharedFileSqlHost,
  fileId: string,
  scopeOwnerId?: string,
): SharedFileRow | null {
  const rows = host.sql<SharedFileRow>`
    SELECT * FROM shared_file WHERE file_id = ${fileId} LIMIT 1`;
  if (rows.length === 0) return null;
  if (scopeOwnerId !== undefined && rows[0].owner_user_id !== scopeOwnerId) return null;
  return rows[0];
}
