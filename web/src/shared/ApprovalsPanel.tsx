import { useEffect, useState } from "react";
import { authHeaders } from "../auth/secret";

interface PendingUser {
  user_id: string;
  email: string;
  provider: string;
  status: string;
  created_at: string;
}

/**
 * operator approval of new AgentThursday sign-ups. End-user
 * accounts live on the console (registry DO `app_user`) so approval is an
 * admin-authenticated action here, not a public link (the operator: 更保险). The
 * gateway resolves users at login and notifies Discord; the operator
 * approves from this panel.
 */
export function ApprovalsPanel() {
  const [users, setUsers] = useState<PendingUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetch("/api/app-users/pending", { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: { users?: PendingUser[] }) => setUsers(d.users ?? []))
      .catch((e) => {
        setUsers([]);
        setErr(e instanceof Error ? e.message : String(e));
      });
  }

  useEffect(load, []);

  async function approve(userId: string) {
    setBusy(userId);
    setErr(null);
    try {
      const res = await fetch(`/api/app-users/${encodeURIComponent(userId)}/approve`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-6 max-w-2xl">
      <h2 className="mb-1 text-xs uppercase tracking-wide text-slate-500">Approvals</h2>
      <p className="mb-3 text-sm text-slate-400">
        New AgentThursday sign-ins wait here until you approve them.
      </p>
      {err && <p className="mb-2 text-sm text-rose-400">{err}</p>}
      {users === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : users.length === 0 ? (
        <div className="rounded border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-400">
          No sign-ups pending approval.
        </div>
      ) : (
        <ul className="space-y-2">
          {users.map((u) => (
            <li
              key={u.user_id}
              className="flex items-center gap-3 rounded border border-slate-800 bg-slate-900/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-100">{u.email || u.user_id}</div>
                <div className="truncate text-xs text-slate-500 font-mono">{u.user_id}</div>
              </div>
              <button
                type="button"
                onClick={() => approve(u.user_id)}
                disabled={busy === u.user_id}
                className="shrink-0 text-xs px-3 py-1 rounded bg-emerald-700 text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
              >
                {busy === u.user_id ? "Approving…" : "Approve"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
