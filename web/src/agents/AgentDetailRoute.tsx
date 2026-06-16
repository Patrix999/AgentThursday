import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getAgentProfile,
  updateAgentStatus,
  type AgentLifecyclePersistedStatus,
  type AgentLifecycleView,
  type AgentProfileSkillsetRuntime,
  type AgentProfileWithRuntime,
} from "../api/agentProfiles";
import { setConversationBinding } from "../api/channelBinding";
import { sendAgentMessage } from "../api/managerMessage";
import { useAgentNameMap } from "./useAgentNameMap";
import {
  listRecentConversations,
  type RecentConversation,
} from "../api/channelConversations";
import { setActiveAgentPin } from "../auth/secret";
import { MergePanel } from "../manager/MergePanel";
import { AgentsLayout } from "./AgentsLayout";
import { LifecycleBadge, relativeTime, humanizeLifecycleReason } from "./LifecycleBadge";
import { useRuntimeModelLookup } from "./useRuntimeModelLookup";

/**
 *  — detail view at `/agents/:id`.
 *  — UI copy reads "cloud agent". Read-only view of one cloud
 * agent's runtime config; backing API is still `/api/agent-profiles/:id`
 * (legacy persistence; see
 * ). No PATCH
 * controls yet ( §6 — those are later cards).
 */
export function AgentDetailRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<AgentProfileWithRuntime | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<null | AgentLifecyclePersistedStatus>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { lookup: lookupModel } = useRuntimeModelLookup();

  const fetchProfile = useCallback((agentId: string, cancelledRef: { v: boolean }) => {
    setProfile(null);
    setNotFound(false);
    setError(null);
    getAgentProfile(agentId)
      .then(r => {
        if (cancelledRef.v) return;
        if (r === null) setNotFound(true);
        else setProfile(r);
      })
      .catch(e => {
        if (cancelledRef.v) return;
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    if (id.length === 0) return;
    const ref = { v: false };
    fetchProfile(id, ref);
    return () => {
      ref.v = true;
    };
  }, [id, fetchProfile]);

  //  — state-button click handler. PATCHes via the manager
  // surface, then re-fetches the profile so the badge / active task
  // strip / button row all reflect the new persisted state.
  const onAction = useCallback(
    async (next: AgentLifecyclePersistedStatus) => {
      setActionPending(next);
      setActionError(null);
      const result = await updateAgentStatus(id, next);
      setActionPending(null);
      if (!result.ok) {
        setActionError(`${result.code}: ${result.message}`);
        return;
      }
      const ref = { v: false };
      fetchProfile(id, ref);
    },
    [id, fetchProfile],
  );

  return (
    <AgentsLayout label="Detail" backTo="/agents" backLabel="← Agents">
      {error && <div className="text-sm text-rose-400">{error}</div>}
      {notFound && (
        <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
          Cloud agent not found: <span className="font-mono">{id}</span>
        </div>
      )}
      {!error && !notFound && profile === null && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {profile !== null && (
        <div className="space-y-4">
          <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg text-slate-100">{profile.name}</span>
                <LifecycleBadge
                  lifecycle={profile.lifecycle}
                  persistedFallback={profile.status}
                  size="md"
                />
              </div>
              <div className="text-xs text-slate-500 font-mono break-all">{profile.id}</div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/*  / 368 — primary path into the workspace console
                  for this cloud agent. Pin + navigate to "/workspace" so the
                  console loads with this agent active. AgentRun
                  remains the secondary task/job UX. */}
              <button
                type="button"
                onClick={() => {
                  setActiveAgentPin(profile.id);
                  navigate(`/workspace?agent_id=${encodeURIComponent(profile.id)}`);
                }}
                className="text-xs px-2.5 py-1 rounded bg-sky-700 hover:bg-sky-600 text-sky-50 whitespace-nowrap"
              >
                Open in workspace →
              </button>
              <Link
                to={`/agent-runs?profile_id=${encodeURIComponent(profile.id)}`}
                className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 whitespace-nowrap"
              >
                Runs →
              </Link>
            </div>
          </header>
          {/*  — active task strip. Shows summary + last activity
              when present; quiet empty state when idle / no task. */}
          <ActiveTaskStrip lifecycle={profile.lifecycle} fallbackUpdatedAt={profile.updated_at} />
          {/*  — merge audit panel. Auto-targets the active
              task when present; operators paste a task_id for
              post-mortem inspection (merge audit is most useful
              after `manager.task.replied` lands, which clears
              current_task_id). */}
          <MergePanel defaultTaskId={profile.lifecycle?.current_task_id ?? null} />
          {/*  — state action buttons. Calls PATCH /api/manager/agents/:id
              and refreshes the profile (which re-derives lifecycle on the
              server side). Disabled while a PATCH is in flight. */}
          <LifecycleActions
            persisted={profile.status}
            pending={actionPending}
            onAction={onAction}
          />
          {actionError && (
            <div className="text-sm text-rose-400 break-all">{actionError}</div>
          )}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <Row label="Model" value={profile.model} mono />
            <ModelRuntimeRow modelId={profile.model} lookup={lookupModel} />
            <Row label="Channel" value={profile.channel} mono />
            <SkillsetRow skillset={profile.skillset} />
            <SkillsetRuntimeRow runtime={profile.skillset_runtime} />
            <Row label="Status" value={profile.status} />
            <Row label="Created" value={profile.created_at} mono />
            <Row label="Updated" value={profile.updated_at} mono />
          </dl>
          <SendMessageSection agentId={profile.id} />
          <ChannelBindingsSection agentId={profile.id} />
          <section>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Persona</div>
            {profile.persona.length === 0 ? (
              <div className="text-sm text-slate-500 italic">(empty)</div>
            ) : (
              <pre className="text-sm text-slate-200 whitespace-pre-wrap break-words bg-slate-900/60 border border-slate-800 rounded p-3 font-mono">
                {profile.persona}
              </pre>
            )}
            <div className="text-xs text-slate-500 mt-1">
              Read at session-init and woven into the agent prompt. Live edits
              apply to the next session / run.
            </div>
          </section>
        </div>
      )}
    </AgentsLayout>
  );
}

/**
 *  (UX W4) — inline "send a message" box so the agent detail
 * page is a usable hub, not just a read-only config view. POSTs to the
 * manager message endpoint (async accept) and surfaces the task id +
 * a link into the runs view.
 */
function SendMessageSection(props: { agentId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ taskId: string | null; status: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length === 0) return;
    setSending(true);
    setErr(null);
    setSent(null);
    const r = await sendAgentMessage(props.agentId, text.trim());
    setSending(false);
    if (!r.ok) {
      setErr(r.error ?? "send failed");
      return;
    }
    setText("");
    setSent({ taskId: r.taskId, status: r.status });
  }

  return (
    <section>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Send a message</div>
      <form onSubmit={send} className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Ask this agent to do something…"
          className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-600"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={sending || text.trim().length === 0}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-sky-50 disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          {sent && (
            <span className="text-xs text-slate-400">
              Sent — task <span className="font-mono">{(sent.taskId ?? "").slice(0, 12)}</span> ({sent.status}).{" "}
              <Link to={`/agent-runs?profile_id=${encodeURIComponent(props.agentId)}`} className="text-sky-400 hover:underline">
                View runs →
              </Link>
            </span>
          )}
          {err && <span className="text-xs text-rose-400">{err}</span>}
        </div>
      </form>
    </section>
  );
}

/**
 *  — channel binding management. Lists the recent conversations
 * bound to this agent and lets the operator bind/unbind. One agent per
 * conversation; binding replaces the current owner (warned inline).
 * Data is the ChannelHub recent-conversations snapshot (top 10 by
 * last-seen) — older idle bindings may not appear here.
 */
function ChannelBindingsSection(props: { agentId: string }) {
  const names = useAgentNameMap();
  const [conversations, setConversations] = useState<RecentConversation[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    listRecentConversations()
      .then(setConversations)
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const mine = conversations.filter(c => c.activeAgentId === props.agentId);
  const others = conversations.filter(c => c.activeAgentId !== props.agentId);
  const picked = others.find(c => c.conversationId === pick) ?? null;

  async function apply(conversationId: string, agentId: string | null) {
    setBusy(true);
    setErr(null);
    const r = await setConversationBinding(conversationId, agentId);
    setBusy(false);
    if (!r.ok) {
      setErr(`${r.error?.code ?? "error"}: ${r.error?.message ?? "bind failed"}`);
      return;
    }
    setPick("");
    reload();
  }

  return (
    <section>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Channels</div>
      {mine.length === 0 ? (
        <div className="text-sm text-slate-500 italic">
          No conversation bound — this agent is reachable via manager
          dispatch only.
        </div>
      ) : (
        <ul className="space-y-1">
          {mine.map(c => (
            <li
              key={c.conversationId}
              className="flex items-center gap-3 text-sm bg-slate-900/60 border border-slate-800 rounded px-3 py-1.5"
            >
              <span className="text-slate-400 text-xs">{c.provider}/{c.chatType}</span>
              <span className="font-mono text-slate-200">{c.conversationId}</span>
              <span className="text-xs text-slate-500">
                {relativeTime(new Date(c.lastSeenAt).toISOString())}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => apply(c.conversationId, null)}
                className="ml-auto text-xs text-rose-400 hover:underline disabled:opacity-50"
              >
                Unbind
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={pick}
          onChange={e => setPick(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-sky-600"
        >
          <option value="">Bind a conversation…</option>
          {others.map(c => (
            <option key={c.conversationId} value={c.conversationId}>
              {c.provider}/{c.chatType} · {c.conversationId}
              {c.activeAgentId ? ` — bound to ${names[c.activeAgentId] ?? c.activeAgentId}` : " — unbound"}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || pick.length === 0}
          onClick={() => apply(pick, props.agentId)}
          className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-sky-50 disabled:opacity-50"
        >
          Bind
        </button>
      </div>
      {picked?.activeAgentId && (
        <div className="mt-1 text-xs text-amber-400">
          ⚠ Currently bound to{" "}
          <span className="font-mono">{names[picked.activeAgentId] ?? picked.activeAgentId}</span> — binding
          here rebinds it to this agent; the current owner stops receiving
          messages from this channel.
        </div>
      )}
      {err && <div className="mt-1 text-xs text-rose-400 break-all">{err}</div>}
      <div className="text-xs text-slate-500 mt-1">
        Messages from a bound conversation route to this agent. List shows
        the 10 most recently seen conversations.
      </div>
    </section>
  );
}

/**
 *  — active task strip. Reads from the lifecycle block when
 * present; otherwise falls back to "no active task" + the profile's
 * `updated_at` so the user never sees a blank section. Never surfaces
 * `current_task_id` directly — operators can find that via /agent-runs.
 */
function ActiveTaskStrip(props: {
  lifecycle: AgentLifecycleView | undefined;
  fallbackUpdatedAt: string;
}) {
  const lc = props.lifecycle;
  const hasTask = lc?.current_task_id !== null && lc?.current_task_id !== undefined;
  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-slate-500">Active task</div>
      {hasTask ? (
        <div className="mt-1 text-sm text-slate-200 break-words">
          {lc?.current_activity_summary ?? <span className="italic text-slate-400">running</span>}
        </div>
      ) : (
        <div className="mt-1 text-sm text-slate-500 italic">no active task</div>
      )}
      <div className="mt-1 text-xs text-slate-500">
        Last activity {relativeTime(lc?.last_activity_at ?? props.fallbackUpdatedAt)}
        {(() => {
          const reasonCopy = humanizeLifecycleReason(lc?.reason);
          return reasonCopy ? (
            <span className="ml-2 text-amber-300">· {reasonCopy}</span>
          ) : null;
        })()}
      </div>
    </section>
  );
}

/**
 *  — state action buttons. Mapping per  ADR §3.2 / §6.1:
 *   draft    → Activate (→ ready)
 *   ready    → Disable (→ disabled) / Archive (→ archived)
 *   disabled → Enable (→ ready) / Archive (→ archived)
 *   archived → Restore (→ draft, NOT ready — ADR requires re-confirm
 *              before an archived agent re-enters a dispatchable state;
 *              fixed in  after  verifier flagged
 *              archived→ready as a product-safety regression).
 *
 * All buttons route through `PATCH /api/manager/agents/:id` with a
 * `{ status }` body (no manager-only gate; same path the manager
 * dispatch tool uses). Disabled while another action is pending so the
 * user can't fire two PATCHes at once.
 */
function LifecycleActions(props: {
  persisted: "initialized" | "archived" | "deleted_marker";
  pending: AgentLifecyclePersistedStatus | null;
  onAction: (next: AgentLifecyclePersistedStatus) => void;
}) {
  const actions: Array<{ label: string; next: AgentLifecyclePersistedStatus; tone: "primary" | "secondary" | "danger" }> = [];
  if (props.persisted === "initialized") {
    //  — Pause/Resume (accepts_tasks toggle) not yet wired;
    // Archive is the only lifecycle transition available from initialized.
    actions.push({ label: "Archive", next: "archived", tone: "danger" });
  } else if (props.persisted === "archived") {
    actions.push({ label: "Restore", next: "initialized", tone: "primary" });
  }
  // deleted_marker → no transitions available
  if (actions.length === 0) return null;
  const tones = {
    primary: "bg-sky-700 hover:bg-sky-600 text-sky-50",
    secondary: "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700",
    danger: "bg-rose-900 hover:bg-rose-800 text-rose-100",
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map(a => (
        <button
          key={a.next}
          type="button"
          disabled={props.pending !== null}
          onClick={() => props.onAction(a.next)}
          className={`text-xs px-3 py-1.5 rounded ${tones[a.tone]} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {props.pending === a.next ? `${a.label}…` : a.label}
        </button>
      ))}
    </div>
  );
}

/**
 *  — cross-link into the read-only Skillset UI so operators
 * can jump from "this agent is configured to use X" to the loaded /
 * disabled / rejected view for X without leaving the keyboard.
 */
function SkillsetRow(props: { skillset: string }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-slate-500 pt-0.5">Skillset</dt>
      <dd className="text-slate-200 font-mono">
        <Link
          to={`/skillsets/${encodeURIComponent(props.skillset)}`}
          className="hover:text-sky-300 underline decoration-dotted"
        >
          {props.skillset}
        </Link>
      </dd>
    </>
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
 *  — shows the resolver's view of which skillset ids will
 * actually contribute callable dynamic tools to the next session/run.
 * Mirrors `/agent-runs/:id` SkillsetRuntimeRow. See
 * `src/agent/agentSkillsetRuntime.ts` for the resolver semantics.
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
    value = `${r.status} — no callable skillset tools for this agent`;
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
 *  — shows runtime provider + availability for the profile's
 * `model`. Says "—" until the options API resolves; once loaded, an
 * unknown id renders "unknown (not in runtime registry)". This is the
 * "actual runtime provider / target model when known" surface
 * required by  §Required 5.
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
    //  — POST gate now rejects this state for NEW agents,
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
