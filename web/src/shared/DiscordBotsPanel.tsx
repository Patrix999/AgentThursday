import { useEffect, useState } from "react";
import { authHeaders } from "../auth/secret";

interface DiscordBotRow {
  bot_id: string;
  token_hint: string;
  username: string;
  label: string | null;
  allowed_channels: string[];
}

/**
 * BYO Discord bot panel. Token is validated server-side
 * against Discord on save (bot id + username derived automatically)
 * and is write-only afterwards (list shows the last-4 hint).
 */
export function DiscordBotsPanel() {
  const [bots, setBots] = useState<DiscordBotRow[]>([]);
  const [token, setToken] = useState("");
  const [channelsRaw, setChannelsRaw] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetch("/api/channel/discord/bots", { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: { bots?: DiscordBotRow[] }) => setBots(d.bots ?? []))
      .catch(() => {});
  }
  useEffect(load, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const channels = channelsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const res = await fetch("/api/channel/discord/bots", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          token,
          allowed_channels: channels,
          ...(label ? { label } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.message ?? d.code ?? `HTTP ${res.status}`);
      setToken("");
      setChannelsRaw("");
      setLabel("");
      load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSaving(false);
    }
  }

  async function remove(botId: string) {
    await fetch(`/api/channel/discord/bots/${encodeURIComponent(botId)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => {});
    load();
  }

  return (
    <section className="mb-6 max-w-3xl rounded border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200">Discord bots</h2>
      <p className="mt-1 text-xs text-slate-500">
        Connect an additional Discord bot at runtime — paste its token and the
        channel ids it should serve. The token is validated against Discord on
        save (bot name auto-detected), stored write-only, and never shown
        again. Each channel is served by exactly one bot.
      </p>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400 flex-1 min-w-[12rem]">
          bot token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="from Discord developer portal"
            className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200 font-mono"
          />
        </label>
        <label className="text-xs text-slate-400 flex-1 min-w-[12rem]">
          channel ids (comma-separated)
          <input
            type="text"
            value={channelsRaw}
            onChange={(e) => setChannelsRaw(e.target.value)}
            placeholder="100000000000000006, …"
            className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200 font-mono"
          />
        </label>
        <label className="text-xs text-slate-400">
          label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
          />
        </label>
        <button
          type="submit"
          disabled={saving || token.length === 0 || channelsRaw.trim().length === 0}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm text-sky-50 hover:bg-sky-600 disabled:opacity-50"
        >
          {saving ? "Validating…" : "Add bot"}
        </button>
      </form>
      {err !== null && <p className="mt-2 text-xs text-rose-400 break-all">{err}</p>}
      {bots.length > 0 && (
        <ul className="mt-3 space-y-1">
          {bots.map((b) => (
            <li key={b.bot_id} className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-slate-200">{b.username || "(bot)"}</span>
              <span className="font-mono text-slate-500">{b.bot_id}</span>
              <span className="font-mono text-slate-500">{b.token_hint}</span>
              <span className="font-mono text-slate-400">
                {b.allowed_channels.join(", ")}
              </span>
              {b.label && <span className="text-slate-600">{b.label}</span>}
              <button
                type="button"
                onClick={() => remove(b.bot_id)}
                className="ml-auto text-rose-400 hover:underline"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-slate-600">
        Inbound polls each bot's channels on the same sweep as the built-in
        bot; replies go out with the owning bot's token. The bot must be
        invited to the server with the Read/Send Messages permissions.
      </p>
    </section>
  );
}
