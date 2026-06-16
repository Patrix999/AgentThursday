import type { AgentRunStatus } from "../api/agentRuns";

const COLORS: Record<AgentRunStatus, string> = {
  started: "bg-sky-900/50 text-sky-200 border-sky-800",
  awaiting_event: "bg-amber-900/50 text-amber-200 border-amber-800",
  ok: "bg-emerald-900/50 text-emerald-200 border-emerald-800",
  failed: "bg-rose-900/50 text-rose-200 border-rose-800",
  timeout: "bg-slate-800 text-slate-300 border-slate-700",
};

export function StatusBadge(props: { status: AgentRunStatus }) {
  const cls = COLORS[props.status] ?? "bg-slate-800 text-slate-300 border-slate-700";
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${cls}`}>
      {props.status}
    </span>
  );
}
