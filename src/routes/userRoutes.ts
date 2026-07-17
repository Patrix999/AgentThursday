import type { getAgentByName } from "agents";
import { json } from "../httpUtil";
import type { AgentThursdayAgent } from "../server";
import type { RequestIdentity } from "../agent/requestIdentity";

/**
 * P1 end-user account routes (registry DO `app_user`).
 *
 * ALL routes are ADMIN-ONLY (the operator: approval belongs in the secret-protected
 * console). The gateway calls `/resolve` at login holding the shared secret
 * (→ admin identity, no user header); the operator lists/approves from the
 * console UI (also admin). A scoped user is 403'd. Auth is the umbrella
 * `/api/*` requireSecret in server.ts; this only checks admin-vs-scoped.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

export interface UserRoutesDeps {
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  identity: RequestIdentity;
}

const PREFIX = "/api/app-users";

export async function handleUserRoutes(
  request: Request,
  url: URL,
  deps: UserRoutesDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(PREFIX)) return null;

  if (deps.identity.kind !== "admin") {
    return json({ code: "forbidden", message: "admin only" }, 403);
  }

  // POST /api/app-users/resolve — gateway login: get-or-create a pending user.
  if (pathname === `${PREFIX}/resolve` && request.method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ code: "invalid_json", message: "body is not valid JSON" }, 400);
    }
    const o = (raw ?? {}) as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "";
    const sub = typeof o.sub === "string" ? o.sub : "";
    const email = typeof o.email === "string" ? o.email : "";
    if (!provider || !sub) {
      return json({ code: "validation_failed", message: "provider and sub are required" }, 400);
    }
    const stub = await deps.getRegistryStub();
    const res = await stub.appUserResolve({ provider, sub, email });
    return json(res);
  }

  // GET /api/app-users/pending — admin: list pending sign-ups.
  if (pathname === `${PREFIX}/pending` && request.method === "GET") {
    const stub = await deps.getRegistryStub();
    const users = await stub.appUserListPending();
    return json({ users });
  }

  // GET /api/app-users — admin: list ALL accounts (console user management).
  if (pathname === PREFIX && request.method === "GET") {
    const stub = await deps.getRegistryStub();
    const users = await stub.appUserListAll();
    return json({ users });
  }

  // POST /api/app-users/<id>/approve — admin: approve a user.
  const approveMatch = pathname.match(/^\/api\/app-users\/([^/]+)\/approve$/);
  if (approveMatch && request.method === "POST") {
    const userId = decodeURIComponent(approveMatch[1]);
    const stub = await deps.getRegistryStub();
    const user = await stub.appUserApprove(userId);
    if (!user) return json({ code: "not_found", message: `user not found: ${userId}` }, 404);
    return json({ ok: true, user });
  }

  // POST /api/app-users/<id>/revoke — admin: revoke access (→ pending).
  const revokeMatch = pathname.match(/^\/api\/app-users\/([^/]+)\/revoke$/);
  if (revokeMatch && request.method === "POST") {
    const userId = decodeURIComponent(revokeMatch[1]);
    const stub = await deps.getRegistryStub();
    const user = await stub.appUserRevoke(userId);
    if (!user) return json({ code: "not_found", message: `user not found: ${userId}` }, 404);
    return json({ ok: true, user });
  }

  // POST /api/app-users/<id>/delete — admin: forget the account (hard delete).
  const deleteMatch = pathname.match(/^\/api\/app-users\/([^/]+)\/delete$/);
  if (deleteMatch && request.method === "POST") {
    const userId = decodeURIComponent(deleteMatch[1]);
    const stub = await deps.getRegistryStub();
    const { deleted } = await stub.appUserDelete(userId);
    if (!deleted) return json({ code: "not_found", message: `user not found: ${userId}` }, 404);
    return json({ ok: true, deleted: true });
  }

  // GET /api/app-users/<id> — admin / gateway: read a user (fresh status).
  const idMatch = pathname.match(/^\/api\/app-users\/([^/]+)$/);
  if (idMatch && request.method === "GET") {
    const userId = decodeURIComponent(idMatch[1]);
    const stub = await deps.getRegistryStub();
    const user = await stub.appUserGetById(userId);
    if (!user) return json({ code: "not_found", message: `user not found: ${userId}` }, 404);
    return json({ user });
  }

  return null;
}
