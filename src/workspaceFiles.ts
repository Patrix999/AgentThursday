/**
 * read-only workspace file API helpers.
 *
 * Wraps `@cloudflare/shell` `Workspace.readDir` / `readFile` / `stat` with:
 *   - path safety (no null byte, no `..`, no `\\`, no leading `/`)
 *   - hidden-name filtering (`.dev.vars`, `.env`, `.wrangler`, `node_modules`, `.git`)
 *   - text vs binary heuristic (null-byte sniff in first 4 KB)
 *   - 256 KB read cap with `truncated` flag
 *
 * The Worker (`src/server.ts`) calls these from inside the AgentThursdayAgent DO so
 * the workspace SDK has a binding. All inputs are user-controlled query
 * params; treat as untrusted.
 */

import type { WorkspaceFileEntry, WorkspaceFileList, WorkspaceFileContent } from "./schema";

const HIDDEN_NAMES = new Set([".dev.vars", ".env", ".wrangler", "node_modules", ".git"]);
const MAX_TEXT_BYTES = 256 * 1024;
const BINARY_PROBE_BYTES = 4096;

export class PathError extends Error {
  constructor(public code: "null-byte" | "backslash" | "traversal" | "hidden" | "absolute") {
    super(`path:${code}`);
  }
}

export class FileError extends Error {
  constructor(public code: "not-found" | "is-dir" | "binary", message?: string) {
    super(message ?? `file:${code}`);
  }
}

/**
 * Normalize and validate a user-supplied path. Returns the SDK-friendly form.
 * Empty / "/" → "" (root). Any other leading "/" is an absolute path and is
 * rejected ( §A-3 forbids absolute paths; only "" and "/" denote root).
 * Throws `PathError` on any rejection.
 */
export function safePath(input: string | null | undefined): string {
  if (input === null || input === undefined || input === "" || input === "/") return "";
  if (input.includes("\0")) throw new PathError("null-byte");
  if (input.includes("\\")) throw new PathError("backslash");
  // Reject absolute paths. The bare "/" (handled above) is the only allowed
  // representation of root; "/anything" is treated as untrusted absolute input.
  if (input.startsWith("/")) throw new PathError("absolute");
  const segs = input.split("/").filter((s) => s.length > 0);
  if (segs.some((s) => s === "..")) throw new PathError("traversal");
  if (segs.some((s) => HIDDEN_NAMES.has(s))) throw new PathError("hidden");
  return segs.join("/");
}

type ReadDirCapable = {
  readDir(dir?: string, opts?: { limit?: number; offset?: number }): Promise<Array<{
    path: string;
    name: string;
    type: "file" | "directory" | "symlink";
    size: number;
    updatedAt: number;
  }>>;
};

type ReadFileCapable = {
  readFile(path: string): Promise<string | null>;
  readFileBytes?(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<{ type: "file" | "directory" | "symlink"; size: number; updatedAt: number } | null>;
};

export async function listWorkspaceDir(
  ws: ReadDirCapable,
  rawPath: string | null | undefined,
): Promise<WorkspaceFileList> {
  const path = safePath(rawPath);
  const raw = await ws.readDir(path, { limit: 500 });
  const entries: WorkspaceFileEntry[] = raw
    .filter((e) => !HIDDEN_NAMES.has(e.name))
    // Symlinks treated as files for preview purposes (text-readable in most cases)
    .map<WorkspaceFileEntry>((e) => ({
      name: e.name,
      path: e.path.replace(/^\/+/, ""),
      kind: e.type === "directory" ? "directory" : "file",
      size: typeof e.size === "number" ? e.size : null,
      updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : null,
    }))
    // Directories first, then files, both alpha
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { path, entries };
}

export async function readWorkspaceFile(
  ws: ReadFileCapable,
  rawPath: string | null | undefined,
): Promise<WorkspaceFileContent> {
  const path = safePath(rawPath);
  if (path === "") throw new PathError("traversal"); // root is not a file

  const stat = await ws.stat(path);
  if (!stat) throw new FileError("not-found");
  if (stat.type === "directory") throw new FileError("is-dir");

  // Binary sniff via byte read when available; otherwise sniff the text.
  if (ws.readFileBytes) {
    const bytes = await ws.readFileBytes(path);
    if (!bytes) throw new FileError("not-found");
    const probe = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES));
    if (probe.includes(0)) throw new FileError("binary");
    const truncated = bytes.length > MAX_TEXT_BYTES;
    const slice = truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes;
    const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(slice);
    return { path, text, size: bytes.length, truncated };
  }

  const raw = await ws.readFile(path);
  if (raw === null) throw new FileError("not-found");
  const probe = raw.slice(0, BINARY_PROBE_BYTES);
  if (probe.includes("\0")) throw new FileError("binary");
  const truncated = raw.length > MAX_TEXT_BYTES;
  const text = truncated ? raw.slice(0, MAX_TEXT_BYTES) : raw;
  return { path, text, size: raw.length, truncated };
}
