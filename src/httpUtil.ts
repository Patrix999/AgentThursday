import { CORS_HEADERS } from "./auth";

/**
 * Standard JSON response helper. Extracted from `server.ts` as part of
 * an earlier revision so the new `src/routes/*` modules can share it without
 * pulling in the rest of `server.ts`'s compilation unit.
 *
 * Behavior must stay byte-identical to the original `server.ts` `json`:
 *   - 2-space pretty-printed body via `JSON.stringify(data, null, 2)`
 *   - `Content-Type: application/json`
 *   - Merges in the global CORS headers from `./auth`
 *   - Default status 200; caller can override.
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
