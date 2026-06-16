import { z } from "zod";

import {
  SessionViewSchema,
  TaskViewSchema,
  MessageViewSchema,
  ApprovalViewSchema,
  ArtifactViewSchema,
  ReplyNeedSchema,
  InspectEntrySchema,
} from "./agent";

export const WorkspaceSnapshotSchema = z.object({
  session: SessionViewSchema,
  currentTask: TaskViewSchema.nullable(),
  summaryStream: z.array(MessageViewSchema),
  pendingApproval: ApprovalViewSchema.nullable(),
  replyNeed: ReplyNeedSchema.nullable(),
  latestResult: ArtifactViewSchema.nullable(),
  inspectEntry: InspectEntrySchema,
  //  — canonical active context identity (registry
  // `context_active` pointer). The client uses this to reconcile its
  // localStorage cache: if the value differs, the client updates
  // `agentthursday.contextId` and re-fetches under the canonical id. Carries
  // ONLY the identity string; never any system prompt / SOUL / tool
  // payload / hidden context content.
  activeContextId: z.string(),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/**
 * workspace file manager (read-only).
 * Maps `@cloudflare/shell` `Workspace.readDir` / `readFile` / `stat` outputs
 * into a stable contract the web client consumes. Hidden paths
 * (`.dev.vars`, `.env`, `.wrangler`, `node_modules`, `.git`) are filtered
 * server-side so the web never sees them — see `src/workspaceFiles.ts`.
 */

export const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

export const WorkspaceFileListSchema = z.object({
  path: z.string(),
  entries: z.array(WorkspaceFileEntrySchema),
});
export type WorkspaceFileList = z.infer<typeof WorkspaceFileListSchema>;

export const WorkspaceFileContentSchema = z.object({
  path: z.string(),
  text: z.string(),
  size: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type WorkspaceFileContent = z.infer<typeof WorkspaceFileContentSchema>;

/**
 * Tier 3 headless browser tool contract.
 *
 * The agent (and the smoke endpoint) sends `BrowserRunRequest` and gets back
 * `BrowserRunResult`. SSRF defenses + size caps live in `src/browser.ts`.
 */

export const BrowserRunRequestSchema = z.object({
  url: z.string().url().max(2048),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  extract: z.array(z.enum(["summary", "text", "links", "screenshot"])).max(4).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});
export type BrowserRunRequest = z.infer<typeof BrowserRunRequestSchema>;

export const BrowserLinkSchema = z.object({
  text: z.string(),
  href: z.string(),
});
export type BrowserLink = z.infer<typeof BrowserLinkSchema>;

export const BrowserRunResultSchema = z.object({
  url: z.string(),
  finalUrl: z.string().nullable(),
  status: z.number().int().nullable(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  links: z.array(BrowserLinkSchema).nullable(),
  screenshotBase64: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});
export type BrowserRunResult = z.infer<typeof BrowserRunResultSchema>;
