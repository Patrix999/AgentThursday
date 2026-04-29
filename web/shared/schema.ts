/**
 * re-export of the unified schema for the web workspace.
 *
 * `web/` is created by ; this file is a stable import path so 78 can
 * wire `import { WorkspaceSnapshotSchema, type WorkspaceSnapshot } from "../shared/schema"`
 * (or wherever 78's vite config places it) without reaching into worker code paths.
 *
 * The schema lives in `src/schema.ts` and pulls only `zod` at runtime — no
 * Cloudflare Worker bindings — so it is safe to consume from the browser.
 */
export * from "../../src/schema";
