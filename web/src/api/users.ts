/**
 * 2026-06-22 — console user-management API client (admin-only).
 *
 * Wraps the an earlier revision end-user account routes (admin-gated in `userRoutes.ts`):
 *   GET  /api/app-users              → list all accounts
 *   POST /api/app-users/<id>/approve → approve (fires welcome email)
 *   POST /api/app-users/<id>/revoke  → revoke access (→ pending)
 *   POST /api/app-users/<id>/delete  → forget (hard delete)
 *
 * These are operator surfaces reachable only from the secret-protected console;
 * they are deliberately NOT on the gateway proxy allowlist, so a scoped end-user
 * can never list/approve/revoke/delete accounts. Auth is the umbrella
 * `X-AgentThursday-Secret`; mutations reuse `postJson` (401 → clearSecret → SecretGate).
 */
import { authHeaders, clearSecret } from "../auth/secret";
import { postJson } from "./client";

export interface AppUser {
  user_id: string;
  provider: string;
  sub: string;
  email: string;
  status: "pending" | "approved";
  created_at: string;
  updated_at: string;
}

async function authedGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) {
    clearSecret();
    window.dispatchEvent(new Event("agentthursday:unauthorized"));
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function listUsers(): Promise<AppUser[] | null> {
  const data = await authedGet<{ users?: AppUser[] }>("/api/app-users");
  if (data === null) return null;
  return data.users ?? [];
}

const userAction = (userId: string, action: "approve" | "revoke" | "delete") =>
  postJson(`/api/app-users/${encodeURIComponent(userId)}/${action}`);

export const approveUser = (userId: string) => userAction(userId, "approve");
export const revokeUser = (userId: string) => userAction(userId, "revoke");
export const deleteUser = (userId: string) => userAction(userId, "delete");
