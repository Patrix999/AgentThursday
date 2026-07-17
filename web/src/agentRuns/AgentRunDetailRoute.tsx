import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getAgentProfile,
  type AgentProfileSkillsetRuntime,
  type AgentProfileWithRuntime,
} from "../api/agentProfiles";
import {
  getAgentRun,
  sendAgentRunUserReply,
  type AgentRunDetail,
} from "../api/agentRuns";
import { AgentRunsLayout } from "./AgentRunsLayout";
import { StatusBadge } from "./StatusBadge";
import { useRuntimeModelLookup } from "../agents/useRuntimeModelLookup";

/**
 * detail view at `/agent-runs/:id`.
 *
 * Renders run-oriented state: status, workflow_instance_id, the
 * AgentProfile snapshot (model / channel / skillset / persona
 * present-vs-empty with the session-init read note), turn refs, and
 * the active next-action.
 *
 * For `awaiting_event`, exposes a reply form that POSTs
 * `/api/agent-runs/:id/events`. The card explicitly limits the
 * vocabulary to `user-reply`.
 *
 * an earlier revision does NOT call Cloudflare Workflows describe — there is no
 * per-step timeline; the "local run timeline" is derived from the
 * row's status alone, labelled honestly.
 */
export function AgentRunDetailRoute() {
  const { id = "" } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [profile, setProfile] = useState<AgentProfileWithRuntime | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const { lookup: lookupModel } = useRuntimeModelLookup();

  const refresh = useCallback(() => setRefreshTick(n => n + 1), []);

  useEffect(() => {
    if (id.length === 0) return;
    let cancelled = false;
    setDetail(null);
    setProfile(null);
    setNotFound(false);
    setError(null);
    getAgentRun(id)
      .then(async r => {
        if (cancelled) return;
        if (r === null) {
          setNotFound(true);
          return;
        }
        setDetail(r);
        const p = await getAgentProfile(r.run.profile_id).catch(() => null);
        if (cancelled) return;
        setProfile(p);
      })
      .catch(e => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, refreshTick]);

  async function onSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (replyBusy) return;
    setReplyErr(null);
    setReplyBusy(true);
    const res = await sendAgentRunUserReply(id, { text: replyText });
    setReplyBusy(false);
    if (res.ok) {
      setReplyText("");
      refresh();
      return;
    }
    if (res.error) setReplyErr(`${res.error.code}: ${res.error.message}`);
    else setReplyErr("send failed");
  }

  return (
    <AgentRunsLayout label="Detail" backTo="/agent-runs" backLabel="← Agent runs">
      {error && <div className="text-sm text-rose-400">{error}</div>}
      {notFound && (
        <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
          Agent run not found: <span className="font-mono">{id}</span>
        </div>
      )}
      {!error && !notFound && detail === null && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {detail !== null && (
        <div className="space-y-5">
          <header className="space-y-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-lg text-slate-100 font-mono">{detail.run.run_id}</span>
              <StatusBadge status={detail.run.status} />
            </div>
            <div className="text-xs text-slate-500">
              workflow <span className="font-mono">{detail.run.workflow_instance_id}</span>
              {detail.workflow_status && (
                <>
                  {" "}
                  · workflow_status{" "}
                  <span className="font-mono">{detail.workflow_status}</span>
                </>
              )}
            </div>
          </header>

          <section>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
              Profile snapshot
            </div>
            {profile === null ? (
              <div className="text-sm text-slate-500">
                Profile <span className="font-mono">{detail.run.profile_id}</span>{" "}
                not loaded.
              </div>
            ) : (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <Row label="Profile" value={`${profile.name} (${profile.id})`} mono />
                <Row label="Model" value={profile.model} mono />
                <ModelRuntimeRow modelId={profile.model} lookup={lookupModel} />
                <Row label="Channel" value={profile.channel} mono />
                <Row label="Skillset" value={profile.skillset} mono />
                <SkillsetRuntimeRow runtime={profile.skillset_runtime} />
                <Row
                  label="Persona"
                  value={profile.persona.length > 0 ? "present" : "empty"}
                />
              </dl>
            )}
            <div className="mt-2 text-xs text-slate-500">
              Persona is read at session-init; live edits to the profile apply on
              the next session / run.
            </div>
            <div className="mt-1 text-xs text-slate-600">
              the selected skillset defines the runtime dynamic
              tool palette for the next session/run; the row above shows the
              resolver&apos;s effective ids (selection + loaded, non-disabled
              dependencies).
            </div>
          </section>

          <section>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
              Turn refs
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <Row label="First turn" value={detail.run.turn_id ?? "—"} mono />
              <Row label="Envelope" value={detail.run.envelope_id ?? "—"} mono />
            </dl>
            <div className="mt-2 text-xs text-slate-500">
              Resume-turn id (when present) lives in the workflow describe output,
              not in the run row — it is not displayed here.
            </div>
          </section>

          {detail.run.error && (
            <section>
              <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
                Error / timeout
              </div>
              <pre className="text-sm text-rose-300 bg-rose-950/30 border border-rose-900 rounded p-3 whitespace-pre-wrap break-words font-mono">
                {detail.run.error}
              </pre>
            </section>
          )}

          <section>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
              Local run timeline
            </div>
            <ul className="text-sm text-slate-300 space-y-1">
              <li>
                created <span className="text-slate-500">{detail.run.created_at}</span>
              </li>
              {detail.run.turn_id && (
                <li>
                  first-turn turn_id{" "}
                  <span className="font-mono text-slate-200">{detail.run.turn_id}</span>
                </li>
              )}
              {detail.run.status === "awaiting_event" && <li>awaiting user reply</li>}
              {detail.run.status === "ok" && <li>completed ok</li>}
              {detail.run.status === "failed" && <li>failed</li>}
              {detail.run.status === "timeout" && <li>timed out</li>}
              <li>
                updated <span className="text-slate-500">{detail.run.updated_at}</span>
              </li>
            </ul>
            <div className="mt-1 text-xs text-slate-600">
              Derived from the local row, not from Cloudflare workflow step output.
            </div>
          </section>

          <section>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
              Next action
            </div>
            {detail.run.status === "awaiting_event" && (
              <form onSubmit={onSendReply} className="space-y-2">
                <textarea
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 font-mono"
                  rows={3}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder="user-reply payload (text)"
                />
                {replyErr && <div className="text-sm text-rose-400">{replyErr}</div>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={refresh}
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                  >
                    Refresh
                  </button>
                  <button
                    type="submit"
                    disabled={replyBusy}
                    className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-sky-50"
                  >
                    {replyBusy ? "Sending…" : "Send user-reply"}
                  </button>
                </div>
              </form>
            )}
            {detail.run.status === "started" && (
              <div className="text-sm text-slate-400">
                First turn still in progress.{" "}
                <button
                  type="button"
                  onClick={refresh}
                  className="text-sky-300 hover:text-sky-200 underline"
                >
                  Refresh
                </button>
                .
              </div>
            )}
            {(detail.run.status === "ok" ||
              detail.run.status === "failed" ||
              detail.run.status === "timeout") && (
              <div className="text-sm text-slate-400">
                Run is terminal ({detail.run.status}). No further actions available
                from this page.{" "}
                <Link to="/agent-runs" className="text-sky-300 hover:text-sky-200 underline">
                  Back to list
                </Link>
                .
              </div>
            )}
          </section>
        </div>
      )}
    </AgentRunsLayout>
  );
}

function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-slate-500 pt-0.5">{props.label}</dt>
      <dd className={`text-slate-200 ${props.mono ? "font-mono" : ""}`}>{props.value}</dd>
    </>
  );
}

/**
 * mirrors the `/agents/:id` SkillsetRuntimeRow. Renders
 * the resolver's view of which skillset ids will actually contribute
 * callable dynamic tools to the next session/run:
 *   - status === "ok" + effective_ids → emerald list ("loaded: a, b, c").
 *   - status === "ok" + effective_ids === [] → amber empty (degenerate;
 *     selection is loaded but no closure remains under the disabled set).
 *   - any other status → amber with the structured reason
 *     (unknown_skillset / rejected_skillset / disabled_skillset /
 *     empty_selection).
 *   - undefined (older server / list endpoint shape) → slate placeholder.
 */
function SkillsetRuntimeRow(props: {
  runtime: AgentProfileSkillsetRuntime | undefined;
}) {
  const r = props.runtime;
  let value: string;
  let tone: string;
  if (r === undefined) {
    value = "— (resolving)";
    tone = "text-slate-500";
  } else if (r.status === "ok") {
    if (r.effective_ids.length === 0) {
      value = "(empty effective set)";
      tone = "text-amber-300";
    } else {
      value = `loaded: ${r.effective_ids.join(", ")}`;
      tone = "text-emerald-300";
    }
  } else {
    value = `${r.status} — no callable skillset tools for this profile`;
    tone = "text-amber-300";
  }
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-slate-500 pt-0.5">
        Skillset runtime
      </dt>
      <dd className={tone}>{value}</dd>
    </>
  );
}

/**
 * mirrors the `/agents/:id` ModelRuntimeRow. Shows the
 * runtime provider + availability for the profile's selected model so
 * the run detail page tells the truth about what the agent actually
 * dispatches to.
 */
function ModelRuntimeRow(props: {
  modelId: string;
  lookup: (id: string) => import("../api/agentProfiles").AgentRuntimeModelOption | null;
}) {
  const entry = props.lookup(props.modelId);
  let value: string;
  let tone: string;
  if (entry === null) {
    value = "— (resolving)";
    tone = "text-slate-500";
  } else if (entry.runtimeStatus === "available") {
    value = `${entry.provider} → ${entry.id}`;
    tone = "text-emerald-300";
  } else {
    // POST gate now rejects this state for NEW profiles,
    // but legacy / pre-flip rows may still carry a not_configured id.
    // getModel() fail-softs to the workers-ai Kimi default in that
    // case (see `_resolveWorkersAITargetWithFallback`), and emits
    // `agent.model.fallback` so the event log records the mismatch.
    // Make the user-visible page tell the same truth.
    value = `${entry.provider} (not configured) → falls back to Kimi K2.6 (workers-ai)`;
    tone = "text-amber-300";
  }
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-slate-500 pt-0.5">Model runtime</dt>
      <dd className={tone}>{value}</dd>
    </>
  );
}
