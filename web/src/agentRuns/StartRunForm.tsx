import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listAgentProfiles, type AgentProfileWithLifecycle } from "../api/agentProfiles";
import { createAgentRun } from "../api/agentRuns";

/**
 *  — compact start-run form used on `/agent-runs` and on the
 * list's empty state.
 *
 *  - Picks an AgentProfile from the registry.
 *  - Takes a short task text — sent as `input.text` (workflow params
 *    are `unknown`; this shape mirrors smoke-probe usage so persona /
 *    first-turn paths are exercised the same way).
 *  - On success: navigates to `/agent-runs/:id` so the user lands on
 *    the run rather than staying on the list (spec §5).
 *
 * Intentionally NOT a "full multi-agent orchestration builder" per
 * spec — one profile, one task input, one button.
 */
export function StartRunForm(props: { onCreated?: () => void }) {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<AgentProfileWithLifecycle[] | null>(null);
  const [profilesErr, setProfilesErr] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("");
  const [taskText, setTaskText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentProfiles()
      .then(rows => {
        if (cancelled || rows === null) return;
        setProfiles(rows);
        if (rows.length > 0) setProfileId(rows[0].id);
      })
      .catch(e => {
        if (cancelled) return;
        setProfilesErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (profileId.length === 0) {
      setSubmitErr("Pick an agent profile first.");
      return;
    }
    setSubmitErr(null);
    setSubmitting(true);
    const trimmed = taskText.trim();
    const res = await createAgentRun({
      profile_id: profileId,
      input: trimmed.length > 0 ? { text: trimmed } : null,
    });
    setSubmitting(false);
    if (res.ok && res.result) {
      props.onCreated?.();
      navigate(`/agent-runs/${encodeURIComponent(res.result.run_id)}`);
      return;
    }
    if (res.error) setSubmitErr(`${res.error.code}: ${res.error.message}`);
    else setSubmitErr("start failed");
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-3"
    >
      <div className="text-xs uppercase tracking-wide text-slate-400">Start run</div>
      {profilesErr && <div className="text-sm text-rose-400">{profilesErr}</div>}
      {profiles !== null && profiles.length === 0 && (
        <div className="text-sm text-slate-400">
          No agent profiles available. Create one from{" "}
          <a href="/agents/new" className="text-sky-300 hover:text-sky-200 underline">
            /agents/new
          </a>{" "}
          first.
        </div>
      )}
      {profiles !== null && profiles.length > 0 && (
        <>
          <label className="block">
            <span className="text-xs text-slate-500">Profile</span>
            <select
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100"
              value={profileId}
              onChange={e => setProfileId(e.target.value)}
            >
              {profiles.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Task (optional)</span>
            <textarea
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 font-mono"
              rows={3}
              placeholder="Short task text passed to the workflow input."
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
            />
          </label>
          {submitErr && <div className="text-sm text-rose-400">{submitErr}</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || profileId.length === 0}
              className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-sky-50"
            >
              {submitting ? "Starting…" : "Start run"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
