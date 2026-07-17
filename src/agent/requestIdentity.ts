/**
 * user-product multi-tenancy: request identity.
 *
 * The console is single-tenant today (one shared secret == the operator).
 * The user product reaches it over a private service binding and adds a
 * verified per-user identity via the `X-AgentThursday-User-Id` header. That header
 * is only ever TRUSTED after the shared-secret check has passed (the secret
 * is held only by the gateway/admin, so the public internet cannot forge an
 *
 * This module is the pure resolution of that header into an effective
 * identity. It is intentionally side-effect free and not yet wired into the
 * auth gate or route filters — enforcement lands in an earlier revision/c. Defining
 * and unit-testing it first keeps the contract stable before it is used.
 */

/**
 * Sentinel owner id for the admin/operator. Existing agents, bots, and
 * credentials are backfilled to this value (see the migration in
 * `migrations.ts`). The admin's real OAuth subject is mapped onto this
 * sentinel at login time (P1), so the admin inherits all existing data.
 *
 * MUST stay in sync with the `DEFAULT 'user-admin'` literals in the
 * an earlier revision migration (SQL DDL cannot reference this constant).
 */
export const ADMIN_USER_ID = "user-admin";

/**
 * Stage 2 (skillsets-as-data) — owner sentinel for SYSTEM skillsets: the
 * baseline skillsets seeded from `EMBEDDED_MANIFESTS` into `custom_skillset`.
 * Always visible to every tenant (system, global); only admin (undefined read
 * scope) can update them — a scoped user's read includes system rows but their
 * write scope never matches `user-system`, so they can't edit them. No real
 * user resolves to this id.
 */
export const SYSTEM_SKILLSET_OWNER = "user-system";

/** Header carrying the gateway-verified end-user id (trusted post-auth). */
export const USER_ID_HEADER = "X-AgentThursday-User-Id";

export type RequestIdentity =
  | { kind: "admin" }
  | { kind: "user"; userId: string };

/**
 * Resolve the effective identity for an already-authenticated request.
 *
 * - No header (or the admin sentinel) ⇒ admin (cross-user visibility).
 * - Any other non-empty value ⇒ that scoped user.
 *
 * Callers MUST only invoke this after the shared-secret check has passed;
 * an unauthenticated request must never reach here with a trusted header.
 */
export function resolveRequestIdentity(userIdHeader: string | null | undefined): RequestIdentity {
  const userId = (userIdHeader ?? "").trim();
  if (userId === "" || userId === ADMIN_USER_ID) {
    return { kind: "admin" };
  }
  return { kind: "user", userId };
}

/** True when the identity may see/operate across all users. */
export function isAdminIdentity(identity: RequestIdentity): boolean {
  return identity.kind === "admin";
}

/**
 * The owner id to stamp on rows this identity creates. Admin-created rows are
 * owned by the admin sentinel; a scoped user owns their own rows.
 */
export function ownerUserIdFor(identity: RequestIdentity): string {
  return identity.kind === "admin" ? ADMIN_USER_ID : identity.userId;
}

/**
 * The owner id to FILTER owner-scoped reads by: a scoped user's id, or
 * `undefined` for admin (= unfiltered, sees all). Distinct from
 * `ownerUserIdFor` (admin → `ADMIN_USER_ID`): for a read filter, admin means
 * "no filter", not "only admin-owned rows".
 */
export function scopeOwnerIdFor(identity: RequestIdentity | undefined): string | undefined {
  return identity !== undefined && identity.kind === "user" ? identity.userId : undefined;
}
