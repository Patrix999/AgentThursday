/**
 * P1 end-user account helpers (registry DO `app_user`).
 *
 * Pure helpers (host.sql only) backing the user @callables on AgentThursdayAgent.
 * End-user accounts live in the secret-protected console so the approval
 * action is admin-authenticated (the operator: "approve 放 console 更保险"). The gateway
 * resolves/reads users over the service binding at login; the operator
 * approves from the console. These are NOT tenant-scoped agent data — they
 * are admin-managed account records.
 */

export type UserOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface UserOpsHost {
  sql: UserOpsSqlTag;
}

export type AppUser = {
  user_id: string;
  provider: string;
  sub: string;
  email: string;
  status: "pending" | "approved";
  created_at: string;
  updated_at: string;
};

type Row = {
  user_id: string;
  provider: string;
  sub: string;
  email: string;
  status: string;
  created_at: string;
  updated_at: string;
};

function toUser(r: Row): AppUser {
  return {
    user_id: r.user_id,
    provider: r.provider,
    sub: r.sub,
    email: r.email,
    status: r.status === "approved" ? "approved" : "pending",
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Look up by (provider, sub); create a pending record on first sight. */
export function userResolve(
  host: UserOpsHost,
  input: { provider: string; sub: string; email: string; userId: string; now: string },
): { user: AppUser; created: boolean } {
  const existing = host.sql<Row>`
    SELECT user_id, provider, sub, email, status, created_at, updated_at
    FROM app_user WHERE provider = ${input.provider} AND sub = ${input.sub} LIMIT 1
  `;
  if (existing.length > 0) return { user: toUser(existing[0]), created: false };
  host.sql`
    INSERT INTO app_user (user_id, provider, sub, email, status, created_at, updated_at)
    VALUES (${input.userId}, ${input.provider}, ${input.sub}, ${input.email}, 'pending', ${input.now}, ${input.now})
  `;
  return {
    user: {
      user_id: input.userId,
      provider: input.provider,
      sub: input.sub,
      email: input.email,
      status: "pending",
      created_at: input.now,
      updated_at: input.now,
    },
    created: true,
  };
}

export function userGetById(host: UserOpsHost, userId: string): AppUser | null {
  const rows = host.sql<Row>`
    SELECT user_id, provider, sub, email, status, created_at, updated_at
    FROM app_user WHERE user_id = ${userId} LIMIT 1
  `;
  return rows.length === 0 ? null : toUser(rows[0]);
}

export function userListPending(host: UserOpsHost): AppUser[] {
  const rows = host.sql<Row>`
    SELECT user_id, provider, sub, email, status, created_at, updated_at
    FROM app_user WHERE status = 'pending' ORDER BY created_at ASC
  `;
  return rows.map(toUser);
}

export function userApprove(host: UserOpsHost, userId: string, now: string): AppUser | null {
  const existing = userGetById(host, userId);
  if (!existing) return null;
  if (existing.status !== "approved") {
    host.sql`UPDATE app_user SET status = 'approved', updated_at = ${now} WHERE user_id = ${userId}`;
  }
  return { ...existing, status: "approved", updated_at: now };
}

/** Console user-management read: every account, pending first, newest first. */
export function userListAll(host: UserOpsHost): AppUser[] {
  const rows = host.sql<Row>`
    SELECT user_id, provider, sub, email, status, created_at, updated_at
    FROM app_user
    ORDER BY (status = 'approved') ASC, created_at DESC
  `;
  return rows.map(toUser);
}

/**
 * Set a user's status. Revoke = set back to 'pending' (no distinct 'revoked'
 * state — `toUser` coerces any non-'approved' to 'pending', and the gateway
 * gate only cares about == 'approved'). A revoked user re-enters the pending
 * queue; re-approving re-fires the welcome email (pending→approved transition).
 */
export function userSetStatus(
  host: UserOpsHost,
  userId: string,
  status: "pending" | "approved",
  now: string,
): AppUser | null {
  const existing = userGetById(host, userId);
  if (!existing) return null;
  host.sql`UPDATE app_user SET status = ${status}, updated_at = ${now} WHERE user_id = ${userId}`;
  return { ...existing, status, updated_at: now };
}

/**
 * Hard-delete the account row (forget, not ban). The same person re-logging in
 * gets a fresh `user-<uuid>` (no (provider,sub) match) as a new pending signup.
 * Their previously-owned agents keep the old owner_user_id and become
 * inaccessible (no account can log in as that owner) — they are not cascaded.
 */
export function userDelete(host: UserOpsHost, userId: string): boolean {
  const existing = userGetById(host, userId);
  if (!existing) return false;
  host.sql`DELETE FROM app_user WHERE user_id = ${userId}`;
  return true;
}
