import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../nav/PageHeader";
import {
  listUsers,
  approveUser,
  revokeUser,
  deleteUser,
  type AppUser,
} from "../api/users";

/**
 * 2026-06-22 — console user management (the operator). Admin-only CRUD over the an earlier revision
 * `app_user` accounts: list every account, approve a pending sign-up (fires the
 * welcome email), revoke access (→ pending), or forget the account (delete).
 * There is no Create — accounts are minted by Google OAuth on first login
 * (the unknowable `sub` + UNIQUE(provider,sub) make an admin-typed row dead).
 */
export function UsersRoute() {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listUsers()
      .then((r) => setUsers(r ?? []))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(u: AppUser, action: "approve" | "revoke" | "delete") {
    if (action === "delete") {
      const ok = window.confirm(
        `Remove ${u.email || u.user_id}?\n\n` +
          `This forgets the account. Any agents they own become inaccessible. ` +
          `They can sign up again later as a new, pending account.`,
      );
      if (!ok) return;
    }
    setBusy(u.user_id);
    const fn = action === "approve" ? approveUser : action === "revoke" ? revokeUser : deleteUser;
    const res = await fn(u.user_id);
    setBusy(null);
    if (!res.ok) {
      setError(res.error || `action failed (HTTP ${res.status})`);
      return;
    }
    load();
  }

  const pending = (users ?? []).filter((u) => u.status !== "approved");
  const approved = (users ?? []).filter((u) => u.status === "approved");

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      <PageHeader
        title="Users"
        subtitle="Accounts"
        backTo="/"
        backLabel="← Dashboard"
        actions={
          <button
            onClick={load}
            className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Refresh
          </button>
        }
      />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <div className="mx-auto w-full max-w-2xl">
          {error && <div className="text-sm text-rose-400 mb-3">{error}</div>}
          {users === null && !error && <div className="text-sm text-slate-500">Loading…</div>}
          {users !== null && users.length === 0 && (
            <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
              No accounts yet. Users appear here after their first Google sign-in.
            </div>
          )}
          {pending.length > 0 && (
            <Section title={`Pending approval (${pending.length})`}>
              {pending.map((u) => (
                <UserRow key={u.user_id} u={u} busy={busy === u.user_id} onAct={act} />
              ))}
            </Section>
          )}
          {approved.length > 0 && (
            <Section title={`Approved (${approved.length})`}>
              {approved.map((u) => (
                <UserRow key={u.user_id} u={u} busy={busy === u.user_id} onAct={act} />
              ))}
            </Section>
          )}
        </div>
      </main>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">{props.title}</h2>
      <ul className="space-y-2">{props.children}</ul>
    </section>
  );
}

function UserRow(props: {
  u: AppUser;
  busy: boolean;
  onAct: (u: AppUser, action: "approve" | "revoke" | "delete") => void;
}) {
  const { u, busy, onAct } = props;
  const approvedNow = u.status === "approved";
  const created = (() => {
    try {
      return new Date(u.created_at).toLocaleDateString();
    } catch {
      return u.created_at;
    }
  })();
  return (
    <li className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-slate-100 font-medium truncate">{u.email || "(no email)"}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                approvedNow ? "bg-emerald-900/60 text-emerald-300" : "bg-amber-900/60 text-amber-300"
              }`}
            >
              {approvedNow ? "approved" : "pending"}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {u.provider} · joined {created} · <span className="font-mono">{u.user_id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {approvedNow ? (
            <button
              disabled={busy}
              onClick={() => onAct(u, "revoke")}
              className="text-xs px-2.5 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-50 disabled:opacity-50"
            >
              Revoke
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => onAct(u, "approve")}
              className="text-xs px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-50 disabled:opacity-50"
            >
              Approve
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => onAct(u, "delete")}
            className="text-xs px-2.5 py-1 rounded bg-rose-900 hover:bg-rose-800 text-rose-100 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}
