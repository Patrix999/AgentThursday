/**
 *  —  `getTools()` family extraction step 1: browser family F.
 *
 * Per  preflight §4, browser is the lowest-risk family — single
 * tool (`browse`), no SQL, no state mutation, no self-DO. Deps are
 * limited to `env.BROWSER` (Cloudflare Browser Rendering binding) +
 * `runBrowser` / `BrowserError` from `src/browser.ts` + agent `logEvent`.
 *
 * Tool name, description, input schema, output shape and the three
 * event names (`tool.browse`, `tool.browse.ok`, `tool.browse.error`)
 * are preserved verbatim from the original inline implementation at
 * `src/server.ts:1150-1171` (pre-).
 *
 * The narrow Host interface follows the  `{ sql }`-only
 * precedent: it exposes only what `browse` actually references, not
 * the whole `AgentThursdayAgent`. If a future browser-family tool needs more,
 * widen this Host — not all six families' Hosts at once.
 */

import { tool } from "ai";
import { z } from "zod";
import { runBrowser, BrowserError } from "../../browser";

export interface BrowserToolHost {
  env: { BROWSER: Fetcher };
  logEvent: (type: string, payload: unknown) => void;
}

export function buildBrowserTools(host: BrowserToolHost) {
  const { env, logEvent } = host;
  return {
    browse: tool({
      description: "Tier 3 — headless browser: open an http(s) URL via Cloudflare Browser Rendering and extract title / visible text / links / screenshot. Use for web/UI smoke tests, page reachability checks, DOM text extraction, and screenshot evidence. Do NOT use to fetch JSON APIs (use execute), to clone repos or run shell (use sandbox_exec), or to read local workspace files (use read). SSRF protected: only http(s); rejects localhost/private/metadata IPs.",
      inputSchema: z.object({
        url: z.string().url().max(2048).describe("Absolute http(s) URL to open"),
        extract: z.array(z.enum(["summary", "text", "links", "screenshot"])).max(4).optional()
          .describe("Which artifacts to capture; defaults to ['summary'] (title+text+links)"),
        waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
        timeoutMs: z.number().int().min(1000).max(30_000).optional(),
      }),
      execute: async (input) => {
        logEvent("tool.browse", { tier: 3, url: input.url.slice(0, 200), extract: input.extract ?? ["summary"] });
        try {
          const result = await runBrowser(env.BROWSER, input);
          logEvent("tool.browse.ok", { tier: 3, finalUrl: result.finalUrl, durationMs: result.durationMs, gotTitle: !!result.title, gotText: !!result.text, linkCount: result.links?.length ?? 0, gotScreenshot: !!result.screenshotBase64 });
          return result;
        } catch (e) {
          const code = e instanceof BrowserError ? e.code : "internal";
          logEvent("tool.browse.error", { tier: 3, code, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
          throw e;
        }
      },
    }),
  };
}
