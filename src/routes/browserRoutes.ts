import {
  BrowserRunRequestSchema,
  BrowserRunResultSchema,
  type BrowserRunResult,
} from "../schema";
import { runBrowser } from "../browser";
import { json } from "../httpUtil";

/**
 * `POST /api/browser/run` headless-browser smoke route
 * extracted from `src/server.ts` (was an earlier revision inline body).
 *
 * Auth: still gated by the composition-root `/api/*` umbrella
 * `requireSecret` check in `src/server.ts` above the delegate. This
 * module never re-checks. CORS headers come from `json()`.
 *
 * SSRF guard: runs *inside* `runBrowser` (URL scheme allow-list,
 * localhost / private CIDR / cloud-metadata IP refusal). Not
 * re-implemented here — preserved by the verbatim call shape
 * `runBrowser(env.BROWSER, parsed.data)`.
 *
 * Return shape: `Promise<Response | null>`. `null` means
 * path/method-mismatch so `server.ts` falls through to the next
 * route family. The original inline gate was
 * `pathname === X && method === Y`, so fall-through (not 405) is
 * the preserved semantic.
 *
 * Behavior preservation invariants :
 *   1. Status-code contract — `request.invalid-json` / `request.invalid-shape`
 *      stay 400; BrowserError mapping stays at the same codes
 *      (400 / 502 / 503 / 504 / 500).
 *   2. Schema parse boundary — `BrowserRunRequestSchema.safeParse` for
 *      input and `BrowserRunResultSchema.parse` for output preserved
 *      byte-equal.
 *   3. Auth umbrella — unchanged; the `/api/*` requireSecret gate in
 *      `server.ts` still fires before this route runs.
 */

/**
 * map `BrowserError` to stable HTTP shapes; same
 * message-prefix reasoning as `workspaceFileError` (DO RPC erases
 * JS class identity). Co-located with the route because it is the
 * route's only consumer.
 */
function browserError(e: unknown): Response {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("browser:url-invalid"))     return json({ code: "browser.url-invalid" }, 400);
  if (msg.includes("browser:url-scheme"))      return json({ code: "browser.url-scheme" }, 400);
  if (msg.includes("browser:url-localhost"))   return json({ code: "browser.url-localhost" }, 400);
  if (msg.includes("browser:url-private"))     return json({ code: "browser.url-private" }, 400);
  if (msg.includes("browser:url-metadata"))    return json({ code: "browser.url-metadata" }, 400);
  if (msg.includes("browser:binding-missing")) return json({ code: "browser.binding-missing", message: msg }, 503);
  if (msg.includes("browser:navigate-failed")) return json({ code: "browser.navigate-failed", message: msg }, 502);
  if (msg.includes("browser:evaluate-failed")) return json({ code: "browser.evaluate-failed", message: msg }, 502);
  if (msg.includes("browser:timeout"))         return json({ code: "browser.timeout" }, 504);
  return json({ code: "internal", message: msg }, 500);
}

export async function handleBrowserRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== "/api/browser/run" || request.method !== "POST") {
    return null;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ code: "request.invalid-json" }, 400);
  }
  const parsed = BrowserRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
  }
  try {
    const result: BrowserRunResult = await runBrowser(env.BROWSER, parsed.data);
    return json(BrowserRunResultSchema.parse(result));
  } catch (e) {
    return browserError(e);
  }
}
