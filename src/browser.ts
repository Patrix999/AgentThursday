/**
 * M7.2 Card 83 — Tier 3 headless browser tool.
 *
 * Connects to the Cloudflare Browser Rendering binding (env.BROWSER) over
 * CDP via WebSocket, navigates, extracts title/text/links/screenshot, and
 * returns a typed `BrowserRunResult`.
 *
 * Safety:
 *   - Only `http:` / `https:` URLs accepted
 *   - SSRF: localhost/loopback/private/link-local/metadata IPs rejected (see `assertSafeUrl`)
 *   - Timeout cap (default 15s, max 30s)
 *   - Text capped to 50 KB; links capped to 50 entries; screenshot only when explicitly requested
 *   - No headers/cookies/secrets exchanged with the target page (no inbound auth state)
 */

import { connectBrowser } from "agents/browser";
import type { BrowserRunRequest, BrowserRunResult, BrowserLink } from "./schema";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 50_000;
const MAX_LINKS = 50;
const MAX_LINK_TEXT = 200;

export class BrowserError extends Error {
  constructor(
    public code:
      | "binding-missing"
      | "url-invalid"
      | "url-scheme"
      | "url-localhost"
      | "url-private"
      | "url-metadata"
      | "navigate-failed"
      | "evaluate-failed"
      | "timeout",
    detail?: string,
  ) {
    // Always prefix with `browser:<code>` so the message-pattern mapper in
    // server.ts (workspaceFileError-style) survives the @callable() RPC class
    // identity erasure. Detail is appended for diagnostics.
    super(detail ? `browser:${code}: ${detail}` : `browser:${code}`);
  }
}

const LOCALHOST_HOSTS = new Set(["localhost", "0.0.0.0", "::", "::1", "[::1]"]);

/**
 * Validate a user-supplied URL before any network call.
 * - http(s) only
 * - Reject hostnames in the localhost set
 * - Reject IPv4 literals in 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16
 * - Reject AWS/GCP/Azure metadata host (169.254.169.254, metadata.*)
 * - Reject bracketed IPv6 literals in loopback/link-local/unique-local
 *
 * NOTE: this is a string-level check. DNS rebinding is a known limitation;
 * documented in the card completion report.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError("url-invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError("url-scheme");
  }
  const host = url.hostname.toLowerCase();
  if (LOCALHOST_HOSTS.has(host)) throw new BrowserError("url-localhost");
  // metadata-style hostnames
  if (host === "metadata.google.internal" || host === "metadata") {
    throw new BrowserError("url-metadata");
  }
  // IPv4 literal
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map((n) => Number(n));
    for (const o of [a, b, c, d]) if (o < 0 || o > 255) throw new BrowserError("url-invalid");
    // metadata
    if (a === 169 && b === 254 && c === 169 && d === 254) throw new BrowserError("url-metadata");
    // ranges
    if (a === 0) throw new BrowserError("url-private");
    if (a === 10) throw new BrowserError("url-private");
    if (a === 127) throw new BrowserError("url-localhost");
    if (a === 169 && b === 254) throw new BrowserError("url-private"); // link-local
    if (a === 172 && b >= 16 && b <= 31) throw new BrowserError("url-private");
    if (a === 192 && b === 168) throw new BrowserError("url-private");
    if (a === 100 && b >= 64 && b <= 127) throw new BrowserError("url-private"); // CGN
  }
  // IPv6 literal in URL (host shows up bracketed in URL.host, hostname strips brackets)
  if (host.includes(":")) {
    if (host === "::1") throw new BrowserError("url-localhost");
    if (host.startsWith("fe80:") || host.startsWith("fe80::")) throw new BrowserError("url-private"); // link-local
    if (host.startsWith("fc") || host.startsWith("fd")) throw new BrowserError("url-private"); // unique-local fc00::/7
  }
  return url;
}

type PageExtract = {
  title?: string;
  text?: string;
  links?: BrowserLink[];
  textTruncated?: boolean;
};

/**
 * Run one navigate-and-extract cycle through the BROWSER binding.
 * Throws `BrowserError` on safety / connect / navigate failures.
 */
export async function runBrowser(
  binding: Fetcher | undefined,
  req: BrowserRunRequest,
): Promise<BrowserRunResult> {
  const startedAt = Date.now();
  const url = assertSafeUrl(req.url); // SSRF guard runs first; never call binding for unsafe URLs

  if (!binding) {
    throw new BrowserError(
      "binding-missing",
      "BROWSER binding not configured. Add `[browser] binding=\"BROWSER\"` to wrangler.toml and deploy.",
    );
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wantSet = new Set(req.extract ?? ["summary"]);
  // "summary" is shorthand for title+text+links
  const wantTitle = wantSet.has("summary") || wantSet.has("text") || wantSet.has("links");
  const wantText = wantSet.has("summary") || wantSet.has("text");
  const wantLinks = wantSet.has("summary") || wantSet.has("links");
  const wantScreenshot = wantSet.has("screenshot");

  let session;
  try {
    session = await connectBrowser(binding, timeoutMs);
  } catch (e) {
    // Local wrangler dev / missing binding / unrouted Browser Rendering all
    // surface here; map to a stable code so callers can distinguish from a
    // navigate failure on a working binding.
    throw new BrowserError(
      "binding-missing",
      `Failed to connect to BROWSER binding: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let finalUrl: string | null = null;
  let title: string | null = null;
  let text: string | null = null;
  let textTruncated = false;
  let links: BrowserLink[] | null = null;
  let screenshotBase64: string | null = null;

  try {
    const created = await session.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const sessionId = await session.attachToTarget(created.targetId);
    await session.send("Page.enable", {}, { sessionId });
    await session.send("Runtime.enable", {}, { sessionId });

    const navResult = await session.send(
      "Page.navigate",
      { url: url.toString() },
      { sessionId },
    ) as { errorText?: string };
    if (navResult.errorText) {
      throw new BrowserError("navigate-failed", navResult.errorText);
    }

    // Best-effort wait — we don't (yet) listen for Page.loadEventFired; a short
    // settle gives the page time to render before evaluation.
    await new Promise((r) => setTimeout(r, 1500));

    // One round-trip: evaluate an IIFE returning a typed object so we don't
    // need three separate Runtime.evaluate calls.
    const expr = `
      (() => {
        const out = {};
        ${wantTitle ? "out.title = String(document.title || '');" : ""}
        ${wantText ? `
          const raw = (document.body && document.body.innerText) || '';
          out.text = raw.slice(0, ${MAX_TEXT_CHARS});
          out.textTruncated = raw.length > ${MAX_TEXT_CHARS};
        ` : ""}
        ${wantLinks ? `
          out.links = Array.from(document.links || []).slice(0, ${MAX_LINKS}).map(a => ({
            text: ((a.textContent || '').trim()).slice(0, ${MAX_LINK_TEXT}),
            href: String(a.href || ''),
          })).filter(l => l.href);
        ` : ""}
        out.finalUrl = String(location.href || '');
        return out;
      })()
    `;
    const evalRes = await session.send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: false },
      { sessionId },
    ) as { result?: { value?: PageExtract & { finalUrl?: string } }; exceptionDetails?: unknown };
    if (evalRes.exceptionDetails) {
      throw new BrowserError("evaluate-failed", JSON.stringify(evalRes.exceptionDetails));
    }
    const v = evalRes.result?.value ?? {};
    finalUrl = v.finalUrl ?? null;
    if (wantTitle) title = v.title ?? null;
    if (wantText) {
      text = v.text ?? null;
      textTruncated = !!v.textTruncated;
    }
    if (wantLinks) links = v.links ?? null;

    if (wantScreenshot) {
      const shot = await session.send(
        "Page.captureScreenshot",
        { format: "png" },
        { sessionId },
      ) as { data?: string };
      screenshotBase64 = shot.data ?? null;
    }
  } finally {
    try {
      // Close session — `connectBrowser` registers a cleanup that DELETEs the
      // browser session when the WebSocket is closed.
      const sock = (session as unknown as { socket?: WebSocket }).socket;
      if (sock && typeof sock.close === "function") sock.close();
    } catch { /* best-effort */ }
  }

  return {
    url: req.url,
    finalUrl,
    status: null, // CDP exposes via Network domain; not subscribed in P0
    title,
    text,
    textTruncated,
    links,
    screenshotBase64,
    error: null,
    durationMs: Date.now() - startedAt,
  };
}
