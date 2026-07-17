/**
 * Workspace file share — agent-facing tools (2026-06-19, replaces localdoc).
 *
 * Global capability (returned unconditionally from `getTools()`, so every
 * agent — operator or user-owned — has it). An agent shares a single file from
 * its OWN workspace into the owner-scoped registry pool; same-owner agents and
 * the owner user can then read it. `share_file` returns a user-facing URL the
 * agent is expected to paste into its reply so the user can open the file —
 * there is no separate UI panel (the operator 2026-06-19: "把链接输出在对话里").
 *
 * No public sharing: the registry callables filter every read by owner, and
 * the user-facing route is owner-gated through the gateway.
 */
import { tool } from "ai";
import { z } from "zod";
import type { SharedFileRow, SharedFileMeta } from "../sharedFileOps";

export interface ShareFileToolHost {
  /** This agent's own id (`this.name`) — the share's source. */
  selfAgentId: string;
  /** Read a file from THIS agent's workspace; null if absent. */
  readWorkspaceFile: (path: string) => Promise<string | null>;
  /** Registry chokepoint: validates + owner-stamps + persists. */
  recordSharedFile: (input: {
    source_agent_id: string;
    filename: string;
    content: string;
    note?: string;
  }) => Promise<{ ok: true; file_id: string } | { ok: false; code: string; message: string }>;
  /**
   * Resolve THIS agent's read scope. `ok:false` → owner unresolved → the read
   * tools fail CLOSED (empty), never fall open to all tenants. `scopeOwnerId`
   * undefined = operator/admin (sees the whole pool).
   */
  resolveOwnScope: () => Promise<{ ok: true; scopeOwnerId?: string } | { ok: false }>;
  listSharedFiles: (scopeOwnerId?: string) => Promise<SharedFileMeta[]>;
  readSharedFile: (fileId: string, scopeOwnerId?: string) => Promise<SharedFileRow | null>;
  /** Build the user-facing URL for a shared file id (gateway, owner-gated). */
  shareLinkFor: (fileId: string) => string;
  logEvent: (type: string, payload: unknown) => void;
}

function basename(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function buildShareFileTools(host: ShareFileToolHost) {
  return {
    share_file: tool({
      description:
        "Share a single file from your workspace so the owner user and other agents of the same owner can open it. Returns a relative `url`. In your reply you MUST present it as a clickable Markdown link — `[<filename>](<url>)` — NOT as a bare URL string, so the user can click to open it. Owner-scoped: it is NEVER public, and another owner cannot open it. Rejects files containing secrets/credentials and files over 1MB. Use this to deliver a finished document/report to the user instead of pasting the whole file into chat.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024).describe("Path of the file in your workspace to share"),
        note: z.string().max(200).optional().describe("Optional short note shown with the file"),
      }),
      execute: async (input) => {
        host.logEvent("tool.share_file.dispatch", { path: input.path });
        const content = await host.readWorkspaceFile(input.path);
        if (content === null) {
          host.logEvent("tool.share_file.error", { reason: "not_found", path: input.path });
          return { ok: false as const, error: "file_not_found", message: `no file at workspace path: ${input.path}` };
        }
        const filename = basename(input.path);
        const res = await host.recordSharedFile({
          source_agent_id: host.selfAgentId,
          filename,
          content,
          ...(input.note !== undefined ? { note: input.note } : {}),
        });
        if (!res.ok) {
          host.logEvent("tool.share_file.error", { reason: res.code, path: input.path });
          return { ok: false as const, error: res.code, message: res.message };
        }
        const url = host.shareLinkFor(res.file_id);
        host.logEvent("tool.share_file.result", { file_id: res.file_id, filename });
        return {
          ok: true as const,
          file_id: res.file_id,
          filename,
          url,
          markdown_link: `[${filename}](${url})`,
          shared_with: "the owner user and same-owner agents (not public)",
          instruction:
            `Include this clickable link in your reply (use the Markdown form, not a bare URL): [${filename}](${url})`,
        };
      },
    }),

    list_shared_files: tool({
      description:
        "List files shared within your owner (by you or other same-owner agents). Returns metadata only (filename, source agent, size, note, id) — use read_shared_file to fetch content.",
      inputSchema: z.object({}),
      execute: async () => {
        host.logEvent("tool.list_shared_files.dispatch", {});
        const scope = await host.resolveOwnScope();
        if (!scope.ok) {
          host.logEvent("tool.list_shared_files.error", { reason: "owner_unresolved" });
          return { ok: false as const, error: "owner_unresolved", files: [] };
        }
        const files = await host.listSharedFiles(scope.scopeOwnerId);
        host.logEvent("tool.list_shared_files.result", { count: files.length });
        return { ok: true as const, files };
      },
    }),

    read_shared_file: tool({
      description:
        "Read the content of a file shared within your owner, by its file_id (from list_shared_files or a share URL). Owner-scoped: returns not_found for a file you don't own.",
      inputSchema: z.object({
        file_id: z.string().min(1).max(64).describe("The shared file id (e.g. sf-xxxxxxxxxxxx)"),
      }),
      execute: async (input) => {
        host.logEvent("tool.read_shared_file.dispatch", { file_id: input.file_id });
        const scope = await host.resolveOwnScope();
        if (!scope.ok) {
          host.logEvent("tool.read_shared_file.error", { reason: "owner_unresolved" });
          return { ok: false as const, error: "owner_unresolved" };
        }
        const row = await host.readSharedFile(input.file_id, scope.scopeOwnerId);
        if (row === null) {
          host.logEvent("tool.read_shared_file.error", { reason: "not_found", file_id: input.file_id });
          return { ok: false as const, error: "not_found" };
        }
        host.logEvent("tool.read_shared_file.result", { file_id: input.file_id, size_bytes: row.size_bytes });
        return {
          ok: true as const,
          file_id: row.file_id,
          filename: row.filename,
          source_agent_id: row.source_agent_id,
          source_agent_name: row.source_agent_name,
          mime: row.mime,
          size_bytes: row.size_bytes,
          note: row.note,
          content: row.content,
        };
      },
    }),
  };
}
