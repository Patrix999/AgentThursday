import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getAgentProfile,
  type AgentProfileWithRuntime,
} from "../api/agentProfiles";
import { getActiveAgentPin, getActiveContextId } from "../auth/secret";

/**
 *  — read-only "active agent" strip shown above the skillset
 * list and detail panes. Pulls from `/api/agent-profiles/<id>` because
 * that endpoint is the only one that carries both the selected
 * skillset id and the resolver's `skillset_runtime` (effective ids,
 * disabled fallback reason) in one call — see . We never call
 * the runtime endpoint here; the list view already does that.
 *
 * Active id resolution mirrors `useWorkspace`: pin first, then the
 * cached context id. If neither is set we render a hint pointing the
 * operator at the selector, but the rest of the page still renders.
 */
export function ActiveAgentContextStrip() {
  const [agentId, setAgentId] = useState<string | null>(() =>
    getActiveAgentPin() ?? (getActiveContextId() || null),
  );
  const [profile, setProfile] = useState<AgentProfileWithRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function refresh() {
      setAgentId(getActiveAgentPin() ?? (getActiveContextId() || null));
    }
    window.addEventListener("agentthursday:active-agent:changed", refresh);
    return () => window.removeEventListener("agentthursday:active-agent:changed", refresh);
  }, []);

  useEffect(() => {
    if (!agentId) {
      setProfile(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setProfile(null);
    setError(null);
    getAgentProfile(agentId)
      .then(r => {
        if (cancelled) return;
        setProfile(r);
      })
      .catch(e => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (!agentId) {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
        No active cloud agent.{" "}
        <Link to="/agents" className="underline hover:text-slate-200">
          Pick one from the agents list
        </Link>
        {" "}to scope the runtime view.
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="uppercase tracking-wide text-slate-500">Active agent</span>
        {profile ? (
          <>
            <span className="text-slate-100">{profile.name}</span>
            <Link
              to={`/agents/${encodeURIComponent(profile.id)}`}
              className="font-mono text-slate-500 hover:text-slate-200 underline decoration-dotted"
            >
              {profile.id}
            </Link>
          </>
        ) : (
          <span className="font-mono text-slate-300">{agentId}</span>
        )}
      </div>
      {error && (
        <div className="mt-1 text-rose-400">
          Couldn't load active-agent profile: {error}
        </div>
      )}
      {profile && (
        <div className="mt-1 flex gap-3 flex-wrap text-slate-400">
          <span>
            <span className="text-slate-500">selected skillset</span>{" "}
            <span className="font-mono text-slate-200">{profile.skillset}</span>
          </span>
          <SkillsetRuntimeBadge runtime={profile.skillset_runtime} />
        </div>
      )}
      {profile && profile.skillset_runtime === undefined && (
        <div className="mt-1 text-slate-500">
          Runtime resolution not reported by this build.
        </div>
      )}
    </div>
  );
}

function SkillsetRuntimeBadge(props: {
  runtime: AgentProfileWithRuntime["skillset_runtime"];
}) {
  const r = props.runtime;
  if (!r) return null;
  if (r.status === "ok") {
    if (r.effective_ids.length === 0) {
      return (
        <span className="text-amber-300">
          <span className="text-slate-500">effective:</span> (empty set)
        </span>
      );
    }
    return (
      <span className="text-emerald-300">
        <span className="text-slate-500">effective:</span> {r.effective_ids.join(", ")}
      </span>
    );
  }
  return (
    <span className="text-amber-300">
      <span className="text-slate-500">runtime:</span> {r.status}
      {r.reason ? ` — ${r.reason}` : ""}
    </span>
  );
}
