import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { resolveActiveAgent } from "../../../src/agent/activeAgentResolver";
import {
  clearActiveAgentPin,
  getActiveAgentPin,
  getActiveContextId,
  setActiveAgentPin,
} from "../auth/secret";
import { listAgentProfiles } from "../api/agentProfiles";
import type { AgentProfileWithLifecycle } from "../api/agentProfiles";

const POLL_MS = 10_000;

/**
 *  — workspace active cloud-agent selector.
 *
 * Lives in `TopStatusBar`. Reads the cloud agents list from
 * `/api/agent-profiles` ( `agents:` alias) and lets the user
 * pick which agent the workspace console addresses. The pick is
 * sticky (`setActiveAgentPin`) so reload preserves it and the
 * canonical-pointer reconcile in `useWorkspace` doesn't revert it.
 *
 * On pick we update both `agentthursday.activeAgentPin.id` and
 * `agentthursday.contextId` (same value): the latter is what
 * `authHeaders()` ships as `X-AgentThursday-Context-Id`, which the server
 * resolves into the per-agent `AgentThursdayAgent` DO ( guarantees
 * DO name == agent_id). The next `useWorkspace` poll lands on the
 * new agent's snapshot.
 *
 * Empty state (no agents): renders a "+ Create agent" link to
 * `/agents/new` instead of the dropdown.
 */
export function ActiveAgentSelector({ variant = "desktop" }: { variant?: "desktop" | "mobile" } = {}) {
  const [agents, setAgents] = useState<AgentProfileWithLifecycle[] | null>(null);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const list = await listAgentProfiles();
      if (cancelled || list === null) return;
      setAgents(list);
    }
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    function bump() {
      setTick((t) => t + 1);
    }
    window.addEventListener("agentthursday:active-agent:changed", bump);
    window.addEventListener("agentthursday:context:reconciled", bump);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("agentthursday:active-agent:changed", bump);
      window.removeEventListener("agentthursday:context:reconciled", bump);
    };
  }, []);

  const resolved = agents === null
    ? {
        agentId: getActiveAgentPin() ?? (getActiveContextId() || null),
        source: "none" as const,
        pinIsStale: false,
      }
    : resolveActiveAgent({
        pinnedAgentId: getActiveAgentPin(),
        storedAgentId: getActiveContextId(),
        agents,
      });

  useEffect(() => {
    if (agents !== null && resolved.pinIsStale) clearActiveAgentPin();
  }, [agents, resolved.pinIsStale]);

  useEffect(() => {
    function clearPending() {
      setPendingAgentId(null);
    }
    window.addEventListener("agentthursday:context:reconciled", clearPending);
    window.addEventListener("agentthursday:workspace:refreshed", clearPending);
    return () => {
      window.removeEventListener("agentthursday:context:reconciled", clearPending);
      window.removeEventListener("agentthursday:workspace:refreshed", clearPending);
    };
  }, []);

  //  — promote the soft "first" default to a real pin once the
  // agents list resolves. Without this, a fresh user with no pin and an
  // empty `agentthursday.contextId` lands here showing agent A (the list head),
  // while `authHeaders()` ships no `X-AgentThursday-Context-Id` so the server
  // resolves via the canonical registry pointer (often DEMO_INSTANCE).
  // The next reconcile writes DEMO_INSTANCE into `agentthursday.contextId`; the
  // resolver still returns first=A because DEMO_INSTANCE isn't in the
  // agents list, so the selector permanently displays A while the
  // console talks to DEMO_INSTANCE. Pinning on mount makes the
  // displayed agent the routed agent by construction, mirroring the
  // create-flow auto-pin in `AgentNewRoute` ( §5).
  useEffect(() => {
    if (
      resolved.source === "first"
      && resolved.agentId !== null
      && agents !== null
      && getActiveAgentPin() === null
    ) {
      setActiveAgentPin(resolved.agentId);
    }
  }, [agents, resolved.source, resolved.agentId]);

  if (agents !== null && agents.length === 0) {
    return (
      <Link
        to="/agents/new"
        data-testid={`${variant}-active-agent-empty`}
        className="text-xs px-2 py-1 rounded border border-sky-700/60 bg-sky-950/60 text-sky-200 hover:bg-sky-900/60"
      >
        + Create cloud agent
      </Link>
    );
  }

  const current = resolved.agentId
    ? (agents ?? []).find((a) => a.id === resolved.agentId) ?? null
    : null;
  const switching = pendingAgentId !== null;

  const widthCls = variant === "mobile" ? "max-w-[8rem]" : "max-w-[14rem]";
  const paddingCls = variant === "mobile" ? "px-1.5 py-1 text-[10px]" : "px-2 py-1 text-xs";

  return (
    <label
      data-testid={`${variant}-active-agent-selector`}
      className="inline-flex items-center gap-1.5 shrink-0"
      title={current ? `Active cloud agent: ${current.name} (${current.id})` : "Active cloud agent"}
    >
      <span className={`uppercase tracking-wide text-slate-500 ${variant === "mobile" ? "text-[10px]" : "text-xs"}`}>
        agent
      </span>
      <select
        value={resolved.agentId ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          if (id.length > 0) {
            setPendingAgentId(id);
            setActiveAgentPin(id);
          }
        }}
        className={`bg-slate-900 border rounded text-slate-200 font-mono truncate ${widthCls} ${paddingCls} focus:outline-none ${
          switching
            ? "border-sky-500 shadow-[0_0_0_1px_rgba(14,165,233,0.35)]"
            : "border-slate-700 focus:border-sky-600"
        }`}
      >
        {agents === null && <option value="">Loading…</option>}
        {agents !== null &&
          agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
      </select>
      {switching ? <SwitchingDot variant={variant} /> : current && <StatusDot status={current.status} variant={variant} />}
    </label>
  );
}

function SwitchingDot({ variant }: { variant: "desktop" | "mobile" }) {
  const size = variant === "mobile" ? "w-2 h-2" : "w-2.5 h-2.5";
  return (
    <span
      title="switching agent"
      className={`inline-block rounded-full border-2 border-sky-500 border-t-transparent animate-spin ${size}`}
    />
  );
}

function StatusDot({ status, variant }: { status: string; variant: "desktop" | "mobile" }) {
  const cls =
    status === "ready"
      ? "bg-emerald-500"
      : status === "archived"
        ? "bg-slate-600"
        : status === "draft"
          ? "bg-amber-400"
          : "bg-slate-500";
  const size = variant === "mobile" ? "w-1.5 h-1.5" : "w-2 h-2";
  return (
    <span
      title={`status: ${status}`}
      className={`inline-block rounded-full ${cls} ${size}`}
    />
  );
}
