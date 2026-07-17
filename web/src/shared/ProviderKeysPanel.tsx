import { useEffect, useState } from "react";
import { authHeaders } from "../auth/secret";

/**
 * BYO-key provider credentials + live model discovery.
 * Extracted from ModelsRoute by the UX renovation (W1, an earlier revision) so it
 * can live on /settings. Keys are write-only: the list shows only the
 * last-4 hint, never the raw key.
 */
interface CredentialRow {
  provider: string;
  base_url: string | null;
  key_hint: string;
  label: string | null;
  updated_at: string;
}

const CREDENTIAL_PROVIDERS = ["deepseek", "anthropic"];

export function ProviderKeysPanel() {
  const [creds, setCreds] = useState<CredentialRow[]>([]);
  const [formProvider, setFormProvider] = useState("deepseek");
  const [formKey, setFormKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<Record<string, { id: string; label?: string }[]>>({});
  const [listing, setListing] = useState<string | null>(null);

  function loadCreds() {
    fetch("/api/models/credentials", { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: { credentials?: CredentialRow[] }) => setCreds(d.credentials ?? []))
      .catch(() => {});
  }
  useEffect(loadCreds, []);

  async function saveCredential(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setCredError(null);
    try {
      const res = await fetch("/api/models/credentials", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          provider: formProvider,
          api_key: formKey,
          ...(formBaseUrl ? { base_url: formBaseUrl } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.message ?? `HTTP ${res.status}`);
      setFormKey("");
      setFormBaseUrl("");
      loadCreds();
    } catch (err) {
      setCredError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteCredential(provider: string) {
    await fetch(`/api/models/credentials/${encodeURIComponent(provider)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => {});
    loadCreds();
  }

  async function listModels(provider: string) {
    setListing(provider);
    try {
      const res = await fetch(
        `/api/models/providers/${encodeURIComponent(provider)}/models`,
        { headers: authHeaders() },
      );
      const d = await res.json();
      if (d.ok && Array.isArray(d.models)) {
        setLiveModels((prev) => ({ ...prev, [provider]: d.models }));
      } else {
        setCredError(d.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setCredError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(null);
    }
  }

  return (
    <section className="mb-6 max-w-3xl rounded border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200">Provider keys</h2>
      <p className="mt-1 text-xs text-slate-500">
        Add an API key to enable an external provider's models — no redeploy needed.
        Keys are stored on the registry and never shown again (only the last 4 digits).
      </p>
      <form onSubmit={saveCredential} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400">
          provider
          <select
            value={formProvider}
            onChange={(e) => setFormProvider(e.target.value)}
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
          >
            {CREDENTIAL_PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 flex-1 min-w-[12rem]">
          API key
          <input
            type="password"
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
            placeholder="sk-…"
            className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200 font-mono"
          />
        </label>
        <label className="text-xs text-slate-400">
          base URL (optional)
          <input
            type="text"
            value={formBaseUrl}
            onChange={(e) => setFormBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com"
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
          />
        </label>
        <button
          type="submit"
          disabled={saving || formKey.length === 0}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm text-sky-50 hover:bg-sky-600 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add key"}
        </button>
      </form>
      {credError !== null && <p className="mt-2 text-xs text-rose-400">{credError}</p>}
      {creds.length > 0 && (
        <ul className="mt-3 space-y-1">
          {creds.map((c) => (
            <li key={c.provider} className="text-xs">
              <div className="flex items-center gap-3">
                <span className="font-mono text-slate-300 w-24">{c.provider}</span>
                <span className="font-mono text-slate-500">{c.key_hint}</span>
                {c.base_url && <span className="text-slate-600 truncate">{c.base_url}</span>}
                <button
                  type="button"
                  onClick={() => listModels(c.provider)}
                  disabled={listing === c.provider}
                  className="ml-auto text-sky-400 hover:underline disabled:opacity-50"
                >
                  {listing === c.provider ? "listing…" : "list models"}
                </button>
                <button
                  type="button"
                  onClick={() => deleteCredential(c.provider)}
                  className="text-rose-400 hover:underline"
                >
                  remove
                </button>
              </div>
              {liveModels[c.provider] && (
                <ul className="mt-1 ml-24 flex flex-wrap gap-1.5">
                  {liveModels[c.provider].map((m) => (
                    <li
                      key={m.id}
                      title={m.label ?? m.id}
                      className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                    >
                      {m.id}
                    </li>
                  ))}
                  {liveModels[c.provider].length === 0 && (
                    <li className="text-slate-600">no models returned</li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
