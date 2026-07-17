import { useState } from "react";
import { getManagerSkillset, updateManagerSkillset } from "../api/skillsets";

/**
 * Stage 2 (skillsets-as-data) — console edit surface for a skillset's manifest.
 * Drives the owner-scoped `PATCH /api/manager/skillsets/:id` (operators edit
 * through this UI, not raw DB). Editing a SYSTEM/baseline skillset is global
 * blast-radius — every tenant's agents using it are affected — so save is
 * confirm-gated. The backend validates the manifest and (via the loader's
 * per-id usability fallback) reverts a bad row to code, so a malformed save
 * can't take down tool resolution.
 */
export function SkillsetEditPanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function startEdit() {
    setOpen(true);
    setMsg(null);
    setDraft("");
    setLoading(true);
    const r = await getManagerSkillset(id);
    setLoading(false);
    if (!r || !r.skillset) {
      setMsg({ kind: "err", text: "could not load manifest (admin secret required)" });
      return;
    }
    setDraft(JSON.stringify(r.skillset.manifest, null, 2));
  }

  async function save() {
    setConfirming(false);
    setMsg(null);
    let manifest: unknown;
    try {
      manifest = JSON.parse(draft);
    } catch (e) {
      setMsg({ kind: "err", text: `invalid JSON: ${String(e)}` });
      return;
    }
    setLoading(true);
    const r = await updateManagerSkillset(id, manifest);
    setLoading(false);
    if (r.ok) {
      setMsg({ kind: "ok", text: "saved — effective on next skillset load" });
    } else if (r.errorCode === "no_changes") {
      setMsg({ kind: "ok", text: "no changes" });
    } else {
      setMsg({ kind: "err", text: `${r.errorCode ?? "error"}${r.errorMessage ? `: ${r.errorMessage}` : ""}` });
    }
  }

  if (!open) {
    return (
      <button
        onClick={startEdit}
        className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
      >
        Edit manifest
      </button>
    );
  }

  return (
    <section className="space-y-2 rounded border border-slate-700 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-200">
          Edit manifest <span className="font-mono text-slate-500">{id}</span>
        </div>
        <button
          onClick={() => { setOpen(false); setMsg(null); setConfirming(false); }}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          close
        </button>
      </div>
      {loading && draft === "" ? (
        <div className="text-xs text-slate-500">loading…</div>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-80 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          disabled={loading || draft === ""}
          onClick={() => { setMsg(null); setConfirming(true); }}
          className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Save…
        </button>
        {msg && (
          <span className={msg.kind === "ok" ? "text-xs text-emerald-400" : "text-xs text-rose-400"}>
            {msg.text}
          </span>
        )}
      </div>
      {confirming && (
        <div className="space-y-2 rounded border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200">
          <div>
            This edits a <b>shared</b> skillset — it affects every agent (and tenant) using it. Continue?
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="rounded bg-amber-600 px-2 py-1 text-white hover:bg-amber-500">
              Save changes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded border border-slate-600 px-2 py-1 text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
