/**
 *  — Web UI debug surface mode.
 *
 * Three-state selector that controls whether the Inspect entry,
 * context chip / ContextRail, and debug action buttons are visible
 * and executable. Source order:
 *
 *   1. Build-time `import.meta.env.VITE_AGENT_THURSDAY_DEBUG_SURFACE_MODE`
 *      (overrides everything; useful for one-off bundles that ship
 *      with a frozen surface — e.g. an embargoed demo build).
 *   2. Runtime `GET /api/config` (auth-gated; reflects the worker
 *      `AGENT_THURSDAY_DEBUG_SURFACE_MODE` var). This is the production path
 *      so the operator can flip mode with `wrangler deploy` without
 *      rebuilding web assets.
 *   3. Fallback `"enable"` — backwards-compatible with deployments
 *      that pre-date the flag.
 *
 * Auth note: this flag is a UI gate, not a security boundary. The
 * worker debug endpoints (`/api/inspect`, `/cli/context/inspect`,
 * `/cli/clear-stale-state`, `/cli/continue`) stay auth-gated under
 * `X-AgentThursday-Secret` regardless of this mode. `disable` only hides
 * the affordances; it does NOT lock the API.
 */

import { authHeaders } from "./auth/secret";

export type DebugSurfaceMode = "enable" | "readonly" | "disable";

const DEFAULT_MODE: DebugSurfaceMode = "enable";

function isDebugSurfaceMode(v: unknown): v is DebugSurfaceMode {
  return v === "enable" || v === "readonly" || v === "disable";
}

let cached: DebugSurfaceMode | null = null;
let inflight: Promise<DebugSurfaceMode> | null = null;

/**
 * Resolve the debug surface mode. Memoised — the SPA doesn't need to
 * re-fetch on every render. Reset via `clearDebugSurfaceModeCache()`
 * if the operator flipped the worker var and you want a hot reload
 * without a full page refresh.
 */
export function fetchDebugSurfaceMode(): Promise<DebugSurfaceMode> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;

  // Build-time override takes precedence so a bundle can hard-pin a mode.
  const env = (import.meta.env as Record<string, string | undefined>) ?? {};
  const buildTimeRaw = (env.VITE_AGENT_THURSDAY_DEBUG_SURFACE_MODE ?? "").toLowerCase().trim();
  if (isDebugSurfaceMode(buildTimeRaw)) {
    cached = buildTimeRaw;
    return Promise.resolve(cached);
  }

  inflight = (async () => {
    try {
      const res = await fetch("/api/config", { headers: authHeaders() });
      if (res.ok) {
        const j = await res.json().catch(() => null) as { debugSurfaceMode?: unknown } | null;
        const m = j?.debugSurfaceMode;
        if (isDebugSurfaceMode(m)) {
          cached = m;
          return cached;
        }
      }
    } catch {
      // Network error / 401 / 503 — fall through to default. The
      // SecretGate flow re-prompts on 401 separately; not our concern.
    }
    cached = DEFAULT_MODE;
    return cached;
  })().finally(() => { inflight = null; });

  return inflight;
}

export function clearDebugSurfaceModeCache(): void {
  cached = null;
  inflight = null;
}

/**
 * `false` only when mode === "disable". Use to gate the Inspect entry,
 * context chip, ContextRail, and any other debug-only affordance.
 */
export function isDebugSurfaceVisible(mode: DebugSurfaceMode): boolean {
  return mode !== "disable";
}

/**
 * `true` only when mode === "enable". Use to gate debug action button
 * onClick handlers (Clear stale state, Force continue, etc). In
 * "readonly" the button still renders so users can see what would be
 * available, but onClick should call `getDebugReadonlyNotice()` instead
 * of hitting the API.
 */
export function isDebugActionEnabled(mode: DebugSurfaceMode): boolean {
  return mode === "enable";
}

export function getDebugReadonlyNotice(): string {
  return "Debug surface is readonly; this action is disabled by deployment config.";
}

export function getDebugDisabledNotice(): string {
  return "Debug surface is disabled by deployment config.";
}
