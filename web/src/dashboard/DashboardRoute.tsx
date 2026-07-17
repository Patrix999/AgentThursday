import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../nav/PageHeader";
import { GettingStarted } from "./GettingStarted";
import type { AgentProfileCreateInput } from "../../shared/schema";
import {
  createAgentProfile,
  getAgentProfileOptions,
  listAgentProfiles,
  type AgentLifecycleView,
  type AgentProfileOptions,
  type AgentProfileWithLifecycle,
} from "../api/agentProfiles";
import { listAgentRuns, type AgentRunListRow } from "../api/agentRuns";
import {
  fetchActiveContext,
  fetchContextHistory,
} from "../api/contextActions";
import type { ActiveContext, ContextHistoryList } from "../../shared/schema";
import { setActiveAgentPin } from "../auth/secret";
import { LifecycleBadge, relativeTime } from "../agents/LifecycleBadge";
import { OwnerBadge } from "../agents/OwnerBadge";
import { listUsers, type AppUser } from "../api/users";

type DashboardData = {
  agents: AgentProfileWithLifecycle[];
  runs: AgentRunListRow[];
  options: AgentProfileOptions;
  activeContext: ActiveContext | null;
  contextHistory: ContextHistoryList;
  users: AppUser[];
};

type LoadState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: DashboardData; error: null }
  | { status: "error"; data: null; error: string };

export function DashboardRoute() {
  const [state, setState] = useState<LoadState>({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [agents, runs, options, activeContext, contextHistory, users] = await Promise.all([
          listAgentProfiles(),
          listAgentRuns({ limit: 100 }),
          getAgentProfileOptions(),
          fetchActiveContext(),
          fetchContextHistory(),
          listUsers().catch(() => null), // fail-soft: dashboard still loads without the users metric
        ]);
        if (cancelled) return;
        if (agents === null || runs === null || options === null || contextHistory === null) {
          setState({
            status: "error",
            data: null,
            error: "dashboard data unavailable",
          });
          return;
        }
        setState({
          status: "ready",
          data: {
            agents,
            runs,
            options,
            activeContext,
            contextHistory,
            users: users ?? [],
          },
          error: null,
        });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", data: null, error: String(e) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <PageHeader title="Dashboard" />

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <GettingStarted />
        {state.status === "loading" && (
          <div className="text-sm text-slate-500">Loading dashboard...</div>
        )}
        {state.status === "error" && (
          <div className="rounded border border-rose-900 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
            {state.error}
          </div>
        )}
        {state.status === "ready" && <DashboardContent data={state.data} />}
      </main>
    </div>
  );
}

function DashboardContent({ data }: { data: DashboardData }) {
  const vm = useMemo(() => buildDashboardView(data), [data]);

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="agents" value={String(data.agents.length)} detail={`${vm.ranAgents.length} ran`} />
        <Metric label="users" value={String(data.users.length)} detail={`${data.users.filter((u) => u.status === "approved").length} approved · ${data.users.filter((u) => u.status !== "approved").length} pending`} to="/users" />
        <Metric label="skillsets in use" value={String(vm.usedSkillsets.length)} detail={`${vm.totalAssignedAgents} assigned agents`} />
        <Metric label="agent runs" value={String(data.runs.length)} detail="latest 100 loaded" />
        <Metric label="workspaces" value={String(vm.contexts.length)} detail={vm.activeContextId ? "1 active" : "no active pointer"} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-5">
          <RanAgentsSection rows={vm.ranAgents} emptyAgents={vm.neverRanAgents} />
          <UsedSkillsetsSection rows={vm.usedSkillsets} />
          <WorkspacesSection rows={vm.contexts} />
        </div>
        <AgentInitPanel options={data.options} />
      </section>
    </div>
  );
}

function Metric(props: { label: string; value: string; detail: string; to?: string }) {
  const body = (
    <>
      <div className="text-xs uppercase text-slate-500">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{props.value}</div>
      <div className="mt-1 text-xs text-slate-400">{props.detail}</div>
    </>
  );
  const cls = "rounded border border-slate-800 bg-slate-900/50 px-4 py-3";
  return props.to ? (
    <Link to={props.to} className={`${cls} block hover:border-slate-600`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function RanAgentsSection(props: {
  rows: RanAgentRow[];
  emptyAgents: AgentProfileWithLifecycle[];
}) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/40">
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Agents that have run</h2>
          <p className="text-xs text-slate-500">Sorted by latest run activity.</p>
        </div>
        <div className="flex-1" />
        <Link to="/agent-runs" className="text-xs text-sky-300 hover:text-sky-200">
          All runs
        </Link>
      </div>
      <div className="divide-y divide-slate-800">
        {props.rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-slate-500">No agent runs yet.</div>
        )}
        {props.rows.map((row) => (
          <div key={row.agent.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/agents/${encodeURIComponent(row.agent.id)}`}
                className="text-sm font-medium text-slate-100 hover:text-sky-200"
              >
                {row.agent.name}
              </Link>
              <LifecycleBadge lifecycle={row.agent.lifecycle} persistedFallback={row.agent.status} />
              <OwnerBadge ownerUserId={row.agent.owner_user_id} ownerEmail={row.agent.owner_email} />
              <RunStatus status={row.latestRun.status} />
              <span className="text-xs text-slate-500">
                last run {relativeTime(row.latestRun.updated_at)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span>
                <span className="text-slate-500">skillset</span> {row.agent.skillset}
              </span>
              <span>
                <span className="text-slate-500">runs</span> {row.runCount}
              </span>
              <span className="font-mono text-slate-500">{row.agent.id}</span>
              <Link
                to={`/workspace?agent_id=${encodeURIComponent(row.agent.id)}`}
                onClick={() => setActiveAgentPin(row.agent.id)}
                className="ml-auto rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
              >
                Open workspace
              </Link>
            </div>
          </div>
        ))}
      </div>
      {props.emptyAgents.length > 0 && (
        <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">
          Ready but not run:{" "}
          {props.emptyAgents.slice(0, 5).map((a, idx) => (
            <span key={a.id}>
              {idx > 0 ? ", " : ""}
              <Link to={`/agents/${encodeURIComponent(a.id)}`} className="text-slate-300 hover:text-sky-200">
                {a.name}
              </Link>
            </span>
          ))}
          {props.emptyAgents.length > 5 ? `, +${props.emptyAgents.length - 5} more` : ""}
        </div>
      )}
    </section>
  );
}

function UsedSkillsetsSection({ rows }: { rows: UsedSkillsetRow[] }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/40">
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Skillsets in use</h2>
          <p className="text-xs text-slate-500">Assigned agents plus observed runs.</p>
        </div>
        <div className="flex-1" />
        <Link to="/skillsets" className="text-xs text-sky-300 hover:text-sky-200">
          Skillsets
        </Link>
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-2">
        {rows.length === 0 && (
          <div className="text-sm text-slate-500">No skillsets are assigned yet.</div>
        )}
        {rows.map((row) => (
          <Link
            key={row.id}
            to={`/skillsets/${encodeURIComponent(row.id)}`}
            className="rounded border border-slate-800 bg-slate-950/50 px-3 py-3 hover:border-slate-600"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">{row.name}</div>
                <div className="mt-1 text-xs text-slate-500">{row.description}</div>
              </div>
              <div className="shrink-0 text-right text-xs text-slate-400">
                <div>{row.assignedAgents} agents</div>
                <div>{row.runCount} runs</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function WorkspacesSection({ rows }: { rows: WorkspaceRow[] }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/40">
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Active workspaces</h2>
          <p className="text-xs text-slate-500">Context routing state from the registry pointer.</p>
        </div>
      </div>
      <div className="divide-y divide-slate-800">
        {rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-slate-500">No context history yet.</div>
        )}
        {rows.slice(0, 8).map((row) => (
          <div key={row.contextId} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-xs text-slate-300">{row.contextId}</span>
                {row.isActive && (
                  <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-200">
                    active
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {row.reason ?? "no reason"} · created {relativeTime(new Date(row.createdAt).toISOString())}
              </div>
            </div>
            <Link
              to="/workspace"
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              Open
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentInitPanel({ options }: { options: AgentProfileOptions }) {
  const navigate = useNavigate();
  const firstAvailableModel = options.models.find((m) => m.runtimeStatus === "available");
  const [name, setName] = useState("");
  const [model, setModel] = useState(firstAvailableModel?.id ?? "");
  const [skillset, setSkillset] = useState(options.skillsets[0]?.id ?? "");
  const [channel, setChannel] = useState("local:dashboard");
  const [persona, setPersona] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const input: AgentProfileCreateInput = {
      name: name.trim(),
      model,
      channel: channel.trim(),
      skillset,
      persona,
      status: "initialized",
    };
    const res = await createAgentProfile(input);
    setSubmitting(false);
    if (res.ok && res.profile) {
      setActiveAgentPin(res.profile.id);
      navigate(`/workspace?agent_id=${encodeURIComponent(res.profile.id)}`);
      return;
    }
    setError(res.error ? `${res.error.code}: ${res.error.message}` : "create failed");
  }

  const selectedSkillset = options.skillsets.find((s) => s.id === skillset) ?? null;

  return (
    <aside className="rounded border border-slate-800 bg-slate-900/60 p-4 xl:sticky xl:top-20 xl:self-start">
      <h2 className="text-sm font-semibold text-slate-100">New agent</h2>
      <p className="mt-1 text-xs text-slate-500">
        Initialize an agent and open its workspace immediately.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <PanelField label="Name">
          <input
            required
            minLength={1}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-sky-600"
            placeholder="e.g. dashboard-operator"
          />
        </PanelField>
        <PanelField label="Model">
          <select
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-sky-600"
          >
            {options.models.map((m) => (
              <option key={m.id} value={m.id} disabled={m.runtimeStatus !== "available"}>
                {m.label}{m.runtimeStatus === "available" ? "" : " (not configured)"}
              </option>
            ))}
          </select>
        </PanelField>
        <PanelField label="Skillset">
          <select
            required
            value={skillset}
            onChange={(e) => setSkillset(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-sky-600"
          >
            {options.skillsets.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
            ))}
          </select>
          {selectedSkillset && (
            <div className="mt-1 text-xs text-slate-500">{selectedSkillset.description}</div>
          )}
        </PanelField>
        <PanelField label="Channel">
          <input
            required
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-sky-600"
          />
        </PanelField>
        <PanelField label="Persona">
          <textarea
            rows={4}
            maxLength={2000}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-sky-600"
            placeholder="Optional operating notes"
          />
        </PanelField>
        {error && <div className="text-sm text-rose-300">{error}</div>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-sky-700 px-3 py-2 text-sm text-sky-50 hover:bg-sky-600 disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create and open workspace"}
        </button>
      </form>
    </aside>
  );
}

function PanelField(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs uppercase text-slate-500">{props.label}</div>
      {props.children}
    </label>
  );
}

function RunStatus({ status }: { status: AgentRunListRow["status"] }) {
  const classes =
    status === "ok"
      ? "bg-emerald-900/60 text-emerald-200"
      : status === "failed" || status === "timeout"
      ? "bg-rose-900/60 text-rose-200"
      : "bg-amber-900/60 text-amber-200";
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${classes}`}>
      {status}
    </span>
  );
}

type RanAgentRow = {
  agent: AgentProfileWithLifecycle;
  latestRun: AgentRunListRow;
  runCount: number;
};

type UsedSkillsetRow = {
  id: string;
  name: string;
  description: string;
  assignedAgents: number;
  runCount: number;
};

type WorkspaceRow = {
  contextId: string;
  reason: string | null;
  createdAt: number;
  isActive: boolean;
};

function buildDashboardView(data: DashboardData): {
  ranAgents: RanAgentRow[];
  neverRanAgents: AgentProfileWithLifecycle[];
  usedSkillsets: UsedSkillsetRow[];
  contexts: WorkspaceRow[];
  totalAssignedAgents: number;
  activeContextId: string | null;
} {
  const agentsById = new Map(data.agents.map((a) => [a.id, a]));
  const runsByAgent = new Map<string, AgentRunListRow[]>();
  for (const run of data.runs) {
    const rows = runsByAgent.get(run.profile_id) ?? [];
    rows.push(run);
    runsByAgent.set(run.profile_id, rows);
  }
  for (const rows of runsByAgent.values()) {
    rows.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }

  const ranAgents: RanAgentRow[] = [];
  const neverRanAgents: AgentProfileWithLifecycle[] = [];
  for (const agent of data.agents) {
    const runs = runsByAgent.get(agent.id) ?? [];
    if (runs[0]) {
      ranAgents.push({ agent, latestRun: runs[0], runCount: runs.length });
    } else {
      neverRanAgents.push(agent);
    }
  }
  ranAgents.sort((a, b) => Date.parse(b.latestRun.updated_at) - Date.parse(a.latestRun.updated_at));
  neverRanAgents.sort((a, b) => lifecycleTime(b.lifecycle, b.updated_at) - lifecycleTime(a.lifecycle, a.updated_at));

  const skillsetMeta = new Map(data.options.skillsets.map((s) => [s.id, s]));
  const assignedBySkillset = new Map<string, number>();
  for (const agent of data.agents) {
    assignedBySkillset.set(agent.skillset, (assignedBySkillset.get(agent.skillset) ?? 0) + 1);
  }
  const runsBySkillset = new Map<string, number>();
  for (const run of data.runs) {
    const agent = agentsById.get(run.profile_id);
    if (!agent) continue;
    runsBySkillset.set(agent.skillset, (runsBySkillset.get(agent.skillset) ?? 0) + 1);
  }
  const skillsetIds = new Set<string>([
    ...assignedBySkillset.keys(),
    ...runsBySkillset.keys(),
  ]);
  const usedSkillsets = [...skillsetIds].map((id) => {
    const meta = skillsetMeta.get(id);
    return {
      id,
      name: meta?.name ?? id,
      description: meta?.description ?? "Custom or unavailable skillset metadata.",
      assignedAgents: assignedBySkillset.get(id) ?? 0,
      runCount: runsBySkillset.get(id) ?? 0,
    };
  }).sort((a, b) => b.runCount - a.runCount || b.assignedAgents - a.assignedAgents || a.id.localeCompare(b.id));

  const activeContextId =
    data.activeContext?.contextId
    ?? data.contextHistory.contexts.find((c) => c.isActive)?.contextId
    ?? null;
  const contexts = data.contextHistory.contexts.map((c) => ({
    contextId: c.contextId,
    reason: c.reason,
    createdAt: c.createdAt,
    isActive: c.isActive || c.contextId === activeContextId,
  }));

  return {
    ranAgents,
    neverRanAgents,
    usedSkillsets,
    contexts,
    totalAssignedAgents: data.agents.length,
    activeContextId,
  };
}

function lifecycleTime(lifecycle: AgentLifecycleView | undefined, fallback: string): number {
  const value = lifecycle?.last_activity_at ?? fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
