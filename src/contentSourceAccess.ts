/**
 * M9.2 / 2026-06-26 — tenant-isolation kernel for per-user (BYO) content sources.
 *
 * Pure + exhaustively tested because it decides WHICH content-source ids a caller
 * may name. This is ONE of two independent gates for BYO GitHub:
 *   1. canAccessSource (here)  — may THIS caller see/name this source id.
 *   2. token resolution (ContentHub, separate) — WHOSE credential reads the bytes.
 * They are independent. The token gate is the catastrophic one (a user source MUST
 * resolve its token from its OWNER's user_provider_credential, NEVER from
 * env.GITHUB_TOKEN) and lives in ContentHub — see the design doc. This kernel only
 * answers the access-list question.
 *
 * Scopes (must match `ContentSourceScopeSchema` in schema/contentHub.ts):
 *   - "project"  — operator-internal (e.g. agentthursday-github, read via env GITHUB_TOKEN). Operator only.
 *   - "fixture"  — tenant-public static docs. Everyone.
 *   - "personal" — a user-registered (BYO) source. Owner-scoped: only its owner.
 * Anything else (future/unknown scope) fails CLOSED (operator only) — a new scope
 * must be deliberately wired here before scoped users can reach it.
 *
 * NOTE: the BYO scope literal is "personal" (the existing, previously-unused enum
 * slot) — NOT "user". The literal MUST be identical at all four sites (this kernel,
 * the schema enum, the registration stamp, the ContentHub token resolver); a
 * mismatch fails CLOSED *silently* — the owner is locked out of their own repo with
 * no error, because the default branch below denies unknown scopes.
 */

export type ContentSourceScope = "project" | "fixture" | "personal";

export type CanAccessSourceInput = {
  /** The source's scope. */
  scope: string;
  /** The source's owner_user_id (user-scoped sources only); null/undefined otherwise. */
  sourceOwnerId: string | null | undefined;
  /** The CALLER's resolved owner id; null = owner couldn't be resolved (fail closed). */
  callerOwnerId: string | null;
  /** Whether the caller is the operator/admin. */
  isOperator: boolean;
};

export type CanAccessSourceResult =
  | { allow: true }
  | { allow: false; reason: "operator_only" | "not_owner" | "owner_unresolved" };

/**
 * THE CATASTROPHIC INVARIANT, made pure + testable: WHICH credential reads a
 * source's bytes. This decides the token SOURCE; the ContentHub DO method only
 * executes the plan (reads env / does the owner-credential RPC / denies).
 *
 *   - "project"  → "env"  (the worker's GITHUB_TOKEN — the ONLY scope that gets it).
 *   - "personal" → "owner-credential" for that source's owner, and ONLY when the
 *                  verified caller IS that owner; otherwise "none". NEVER "env" —
 *                  the env token has broad private-repo access, so a fallback
 *                  would let a user read someone else's repo through operator creds.
 *   - anything else → "none" (never env).
 *
 * The hard rule expressed in one place: `source: "env"` is returned for `project`
 * and NOTHING else.
 */
export type ContentTokenPlan =
  | { source: "env" }
  | { source: "owner-credential"; ownerUserId: string }
  | { source: "none"; reason: string };

export function tokenPlanForSource(input: {
  scope: string;
  sourceOwnerId: string | null | undefined;
  callerOwnerId: string | null;
}): ContentTokenPlan {
  if (input.scope === "project") return { source: "env" };
  if (input.scope === "personal") {
    const owner = input.sourceOwnerId ?? null;
    // Defense-in-depth behind canAccessSource: resolve the token for the SOURCE's
    // owner, and only when the verified caller IS that owner.
    if (owner !== null && input.callerOwnerId !== null && input.callerOwnerId === owner) {
      return { source: "owner-credential", ownerUserId: owner };
    }
    return { source: "none", reason: "owner credential unavailable" };
  }
  return { source: "none", reason: "no token for source scope" };
}

export function canAccessSource(input: CanAccessSourceInput): CanAccessSourceResult {
  // Tenant-public docs — everyone.
  if (input.scope === "fixture") return { allow: true };

  // Operator-internal (e.g. the private AgentThursday repo) — operator only.
  if (input.scope === "project") {
    return input.isOperator ? { allow: true } : { allow: false, reason: "operator_only" };
  }

  // Per-user BYO source — strictly owner-scoped. The operator does NOT auto-access
  // a user's private repo (operator's owner id ≠ the source owner ⇒ not_owner);
  // tenant privacy holds even against admin. Fail closed on an unresolved caller.
  if (input.scope === "personal") {
    if (input.callerOwnerId === null) return { allow: false, reason: "owner_unresolved" };
    const owner = input.sourceOwnerId ?? null;
    if (owner === null || owner !== input.callerOwnerId) return { allow: false, reason: "not_owner" };
    return { allow: true };
  }

  // Unknown scope → fail closed (only operator, who already sees everything wired).
  return input.isOperator ? { allow: true } : { allow: false, reason: "operator_only" };
}
