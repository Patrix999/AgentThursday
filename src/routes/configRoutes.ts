import { json } from "../httpUtil";
import { listModelProfiles } from "../modelProfiles";

/**
 * `/api/config` route extracted from `server.ts`.
 *
 * Returns a narrow, deliberately small public-config payload so the SPA
 * can read the debug surface mode at runtime. Auth is enforced by the
 * composition root in `server.ts` (the `/api/*` umbrella gate); this
 * module only renders the response.
 *
 * Behavior preserved: same shape (`{ debugSurfaceMode }`), same
 * derivation rules (lowercased + trimmed, `"readonly" | "disable"` win,
 * otherwise `"enable"`).
 */
export function handleConfig(env: Env): Response {
  const rawMode = String(env.AGENT_THURSDAY_DEBUG_SURFACE_MODE ?? "").toLowerCase().trim();
  const debugSurfaceMode: "enable" | "readonly" | "disable" =
    rawMode === "readonly" ? "readonly"
      : rawMode === "disable" ? "disable"
      : "enable";
  return json({ debugSurfaceMode });
}

/**
 * `GET /api/models` returns the static model profile registry.
 *
 * Auth is enforced by the composition root in `server.ts` (the `/api/*`
 * umbrella gate); this module only renders the response.
 */
export function handleModels(): Response {
  return json(listModelProfiles());
}
