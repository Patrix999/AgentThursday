import { getAgentByName } from "agents";
import type { AgentNamespace } from "agents";
import { DEMO_INSTANCE } from "../demoConstants";
import type { AgentThursdayAgent } from "../server";

/**
 *  — active-context / DO routing helpers extracted from
 * `server.ts`.
 *
 * Pure routing utilities. No active-context semantics changed — every
 * function is the verbatim body of the original `server.ts`
 * declaration (Cards 149 / 149e / 149e1 invariants preserved).
 *
 * Owners of the imports (kept in this module):
 *  - `getAgentByName` from `agents` — DO stub resolver
 *  - `DEMO_INSTANCE` from `../demoConstants` — bootstrap / registry DO
 *    identity, used both as the override-or-bootstrap fallback in
 *    `resolveContextDoName` and as the registry DO that owns the
 *    `context_active` pointer.
 *  - `AgentThursdayAgent` (type only) from `../server` — the DO class whose
 *    stub these helpers resolve. Type-only import keeps the module
 *    free of any value-level coupling with `server.ts`.
 *
 * Exports re-imported by `server.ts`:
 *  - `CONTEXT_HEADER`
 *  - `resolveHeaderContext`
 *  - `resolveContextDoName`
 *  - `getCanonicalActiveContextDoName`
 *  - `getActiveAgentThursdayAgentStub`
 *  - `getCanonicalActiveAgentThursdayAgentStub`
 *  - `resolveCanonicalActiveContextRoute`
 *
 * `cliRoutes.ts` keeps its own local `CONTEXT_HEADER` declaration (set
 * up by ) — that duplication is intentional and out of
 * scope for 242z4. The new canonical declaration here is what
 * `server.ts` reads.
 */

//   — per-context DO routing. Reads `X-AgentThursday-Context-Id`
// from the request header and uses it as the DO instance name.
//
//  — header semantics tightened for the "single active session
// per (user, agent)" model. When the header is present it acts as an
// **explicit override** (handy for debugging / pinned testing tabs).
// When it is absent, header-less user-layer requests now fall through
// to the registry's `context_active` pointer rather than to
// DEMO_INSTANCE blindly. This means Discord gateway / cron / fresh
// browsers without a localStorage cache all converge to the canonical
// active context. DEMO_INSTANCE is still the very-last fallback for
// the bootstrap case where the active pointer hasn't been written yet.
export const CONTEXT_HEADER = "X-AgentThursday-Context-Id";

export function resolveHeaderContext(request: Request): string | null {
  const headerVal = request.headers.get(CONTEXT_HEADER);
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

export function resolveContextDoName(request: Request): string {
  // Legacy synchronous accessor — header or DEMO_INSTANCE. Still used
  // by routes that intentionally want the override-or-bootstrap form
  // without paying for a registry RPC. New user-layer routes should
  // prefer `getCanonicalActiveContextDoName` below.
  return resolveHeaderContext(request) ?? DEMO_INSTANCE;
}

/**
 *  — canonical active-context resolver for user-layer routes.
 *
 * Resolution order:
 *   1. Explicit `X-AgentThursday-Context-Id` header (debug / pinned tab override).
 *   2. Registry `context_active` pointer (`getActivePointer()` via
 *      `getActiveContextId` callable on DEMO_INSTANCE). One DO RPC,
 *      avoided when the header is set.
 *   3. DEMO_INSTANCE bootstrap fallback (registry hasn't written a
 *      pointer yet — only happens on a truly fresh deployment).
 *
 * Recursion guard: this function NEVER consults the active pointer
 * when the request itself is targeting the registry (DEMO_INSTANCE)
 * directly via header — that path always uses DEMO_INSTANCE.
 *
 * Routes that reach into the registry for management work
 * (`/cli/context/{new,active,history,switch}`, archive flushes,
 * hygiene runs) keep using `DEMO_INSTANCE` directly; this helper is
 * for user-layer routes that should follow the active pointer.
 */
export async function getCanonicalActiveContextDoName(env: Env, request: Request): Promise<string> {
  const headerOverride = resolveHeaderContext(request);
  if (headerOverride) return headerOverride;
  try {
    const registry = await getAgentByName<Env, AgentThursdayAgent>(
      env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
      DEMO_INSTANCE,
    );
    const active = await registry.getActiveContextId();
    if (active.contextId && active.contextId.length > 0 && active.contextId.length <= 200) {
      return active.contextId;
    }
  } catch {
    // Registry unreachable / pointer empty — fall through to bootstrap.
  }
  return DEMO_INSTANCE;
}

// Shorthand: every context-scoped /cli/* route resolves the DO name
// from the request header (or DEMO_INSTANCE) and fetches a stub. The
// registry-only routes (/cli/context/{new,active,history,switch})
// continue to reach `DEMO_INSTANCE` directly so they always read /
// write the same context_history table.
export function getActiveAgentThursdayAgentStub(env: Env, request: Request) {
  return getAgentByName<Env, AgentThursdayAgent>(
    env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
    resolveContextDoName(request),
  );
}

/**
 *  — async stub resolver that follows the canonical active
 * pointer when no header is set. User-layer routes that want
 * "follow active context unless caller explicitly pinned a tab"
 * use this instead of `getActiveAgentThursdayAgentStub`.
 */
export async function getCanonicalActiveAgentThursdayAgentStub(env: Env, request: Request) {
  const name = await getCanonicalActiveContextDoName(env, request);
  return getAgentByName<Env, AgentThursdayAgent>(
    env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
    name,
  );
}

/**
 *  — paired `{ name, stub }` resolver. Route handlers that
 * pass a `routedContextId` to the DO (notably
 * `/cli/context/reset` per ) MUST send the same id that the
 * stub points at. With the canonical resolver in place, calling
 * `getCanonicalActiveContextDoName(...)` and
 * `getCanonicalActiveAgentThursdayAgentStub(...)` separately can race the
 * registry pointer (very unlikely on a single isolate, but the
 * possibility forced two-source-of-truth bugs in 149e1's review).
 * This helper does the lookup once.
 */
export async function resolveCanonicalActiveContextRoute(
  env: Env,
  request: Request,
): Promise<{ name: string; stub: ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>> extends Promise<infer S> ? S : never }> {
  const name = await getCanonicalActiveContextDoName(env, request);
  const stub = await getAgentByName<Env, AgentThursdayAgent>(
    env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>,
    name,
  );
  return { name, stub };
}
