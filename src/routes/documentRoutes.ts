import type { getAgentByName } from "agents";
import { json } from "../httpUtil";
import type { AgentThursdayAgent } from "../server";
import { type RequestIdentity, ownerUserIdFor, scopeOwnerIdFor } from "../agent/requestIdentity";
import { isCodeFile, isPlainTextFile, markdownForTextFile } from "../agent/documentContent";
import { convertBinaryDocument, fyimdSubmit, isPdfOrOffice, type ConverterEnv } from "../agent/documentConverter";

/**
 * Card (2026-06-23) — user document upload routes (`/api/manager/documents`).
 *
 * Owner-scoped: the user's identity comes from the signed gateway session
 * (X-AgentThursday-User-Id), never the client body. Raw files are NOT stored — text/code
 * is converted to markdown here (code → fenced block), other formats via
 * `env.AI.toMarkdown`, then only the markdown is persisted (R2) via the
 * registry @callable. 10 MB cap; executables rejected.
 */
type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

// env.AI.toMarkdown is newer than the installed workers-types Ai interface, so
// the dispatch site casts env.AI to this structural shape.
export interface AiMarkdown {
  toMarkdown: (
    docs: Array<{ name: string; blob: Blob }>,
  ) => Promise<Array<{ name?: string; mimeType?: string; format?: string; data?: string }>>;
}

export interface DocumentRoutesDeps {
  identity: RequestIdentity;
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  // 2026-06-25 — converter env: CF `toMarkdown` baseline + fyimd async queue for
  // PDF/office (gated on FYIMD_API_KEY). Replaces the single `ai.toMarkdown` call.
  convertEnv: ConverterEnv;
}

const PREFIX = "/api/manager/documents";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DENY_EXT = new Set([
  "exe", "dll", "so", "dylib", "bat", "cmd", "com", "msi", "app", "dmg", "scr", "jar", "apk", "deb", "rpm", "bin",
]);

export async function handleDocumentRoutes(
  request: Request,
  url: URL,
  deps: DocumentRoutesDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(PREFIX)) return null;
  const ownerUserId = ownerUserIdFor(deps.identity);
  const scopeOwnerId = scopeOwnerIdFor(deps.identity);

  // POST /api/manager/documents — upload (raw body; filename in X-Filename).
  if (pathname === PREFIX && request.method === "POST") {
    // The client percent-encodes the filename (header values must be Latin-1);
    // decode it back. Fail-soft to the raw value for plain-ASCII / legacy
    // clients (a literal `%` that isn't valid encoding makes decode throw).
    const rawName = request.headers.get("x-filename") || "upload";
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      /* not percent-encoded — keep the raw header value */
    }
    const filename = decodedName.slice(0, 200);
    const ext = (filename.split(".").pop() || "").toLowerCase();
    if (DENY_EXT.has(ext)) return json({ code: "rejected", message: "executable files are not allowed" }, 400);
    // Codex P2: reject oversized uploads from the Content-Length BEFORE buffering
    // the whole body into memory. The post-buffer check below stays as a backstop
    // for chunked / missing-length requests.
    const declaredLen = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
      return json({ code: "too_large", message: "file exceeds the 10 MB limit" }, 413);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return json({ code: "empty", message: "empty file" }, 400);
    if (bytes.byteLength > MAX_BYTES) return json({ code: "too_large", message: "file exceeds the 10 MB limit" }, 400);
    const mime = request.headers.get("content-type") || "application/octet-stream";

    // PDF/office uploads route to fyimd's async queue — hard PDFs take minutes,
    // too long for a synchronous request (it would blow the gateway timeout).
    // `fyimdSubmit` returns fast: a poll URL → record `processing` + return 202
    // immediately (the markdown is filled lazily on the next list/read); inline
    // markdown (a fast input fyimd finished synchronously) records like the rest.
    // Non-PDF binaries + the fyimd-unavailable fallback use the CF baseline. (the operator:
    // 改异步吧 没转换好之前给用户转圈.)
    let markdown: string | null = null;
    if (isPdfOrOffice(mime) && deps.convertEnv.FYIMD_API_KEY) {
      try {
        const submit = await fyimdSubmit(deps.convertEnv, bytes, mime);
        if ("jsonUrl" in submit) {
          const sha256 = await sha256Hex(bytes);
          const stub = await deps.getRegistryStub();
          const r = await stub.recordPendingDocument({
            ownerUserId,
            filename,
            mime,
            sizeBytes: bytes.byteLength,
            sha256,
            pendingRef: submit.jsonUrl,
          });
          if (!r.ok) return json({ code: r.code, message: r.message }, 500);
          return json({ ok: true, doc_id: r.doc_id, filename, status: "processing" }, 202);
        }
        markdown = submit.done; // fast PDF fyimd finished inline
      } catch {
        markdown = null; // fyimd unconfigured/outage → CF baseline below
      }
    }

    if (markdown === null) {
      try {
        if (isPlainTextFile(filename) || isCodeFile(filename) || mime.startsWith("text/")) {
          const text = new TextDecoder().decode(bytes);
          markdown = markdownForTextFile(filename, text);
        } else {
          // CF `toMarkdown` baseline (images + the fyimd-down fallback for PDFs).
          const conv = await convertBinaryDocument({ env: deps.convertEnv, bytes, filename, mime });
          markdown = conv.markdown;
        }
      } catch (e) {
        return json({ code: "extract_failed", message: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    if (!markdown.trim()) {
      return json({ code: "unsupported", message: "could not extract text from this file type" }, 400);
    }

    const sha256 = await sha256Hex(bytes);
    const stub = await deps.getRegistryStub();
    const r = await stub.recordDocument({ ownerUserId, filename, mime, sizeBytes: bytes.byteLength, sha256, markdown });
    if (!r.ok) return json({ code: r.code, message: r.message }, 500);
    return json({ ok: true, doc_id: r.doc_id, filename, status: "done" }, 201);
  }

  // GET /api/manager/documents — list the owner's documents (metadata only).
  if (pathname === PREFIX && request.method === "GET") {
    const stub = await deps.getRegistryStub();
    // Lazily resolve any of this owner's docs still on fyimd's queue before
    // listing — the frontend polls this endpoint to animate the upload spinner,
    // so the poll itself converges the queue (no background DO timer to lose on
    // deploy; the durable `pending_ref` re-polls until done).
    await stub.resolvePendingDocuments(scopeOwnerId);
    const documents = await stub.documentList(scopeOwnerId);
    return json({ documents });
  }

  // DELETE /api/manager/documents/<id> — forget a document.
  const idMatch = pathname.match(/^\/api\/manager\/documents\/([^/]+)$/);
  if (idMatch && request.method === "DELETE") {
    const docId = decodeURIComponent(idMatch[1]);
    const stub = await deps.getRegistryStub();
    const { deleted } = await stub.documentDelete({ doc_id: docId }, scopeOwnerId);
    if (!deleted) return json({ code: "not_found", message: `document not found: ${docId}` }, 404);
    return json({ ok: true });
  }

  return null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
