import type { AgentLifecycleView } from "../api/agentProfiles";

/**
 * shared lifecycle badge for `/agents` list + detail.
 *
 * Four-layer model (ADR v2):
 *   lifecycle persisted: initialized | archived | deleted_marker
 *   runtime derived:     healthy | running | stale
 *   policy:              accepts_tasks (pass-through)
 *
 * When the server omits the `lifecycle` block entirely (older Worker,
 * fail-soft fallback), `lifecycle` is `undefined` and we fall back to
 * the bare persisted status from the profile.
 */
export function LifecycleBadge(props: {
  lifecycle: AgentLifecycleView | undefined;
  persistedFallback: "initialized" | "archived" | "deleted_marker" | string;
  size?: "sm" | "md";
}) {
  const size = props.size ?? "sm";
  const cls = size === "sm" ? "text-[11px] px-1.5 py-0.5" : "text-xs px-2 py-1";
  const lc = props.lifecycle;

  if (lc) {
    // Lifecycle view available — use full four-layer badge.
    if (lc.persisted === "archived") {
      return <Badge cls={cls} tone="slate" label="Archived" />;
    }
    if (lc.persisted === "deleted_marker") {
      return <Badge cls={cls} tone="rose" label="Deleted" />;
    }
    // persisted === "initialized"
    if (!lc.accepts_tasks) {
      return <Badge cls={cls} tone="zinc" label="Paused" />;
    }
    if (lc.derived === "running") {
      return <Badge cls={cls} tone="emerald" label="Active · Running" />;
    }
    if (lc.derived === "stale") {
      return <Badge cls={cls} tone="amber" label="Active ⚠ Stale" />;
    }
    // healthy
    return <Badge cls={cls} tone="sky" label="Active" />;
  }

  // Fallback: lifecycle block unavailable (older Worker).
  const p = props.persistedFallback;
  if (p === "archived") return <Badge cls={cls} tone="slate" label="Archived" />;
  if (p === "deleted_marker") return <Badge cls={cls} tone="rose" label="Deleted" />;
  // initialized (or legacy ready/draft/disabled from old Worker)
  return <Badge cls={cls} tone="sky" label="Active" />;
}

function Badge(props: {
  label: string;
  cls: string;
  tone: "slate" | "zinc" | "sky" | "emerald" | "amber" | "rose";
}) {
  const tones: Record<typeof props.tone, string> = {
    slate: "bg-slate-800 text-slate-300 border-slate-700",
    zinc: "bg-zinc-800 text-zinc-400 border-zinc-700",
    sky: "bg-sky-900/60 text-sky-200 border-sky-800",
    emerald: "bg-emerald-900/60 text-emerald-200 border-emerald-800",
    amber: "bg-amber-900/60 text-amber-200 border-amber-800",
    rose: "bg-rose-900/60 text-rose-200 border-rose-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded border font-medium whitespace-nowrap ${props.cls} ${tones[props.tone]}`}
    >
      {props.label}
    </span>
  );
}

/**
 * human-readable lifecycle `reason` copy.
 *
 * Stale reasons (ADR v2 §2.2) can be comma-joined from the resolver.
 * Each is mapped to a user-facing sentence.
 */
export function humanizeLifecycleReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string" || reason.length === 0) return null;

  const parts = reason.split(",");
  const mapped = parts.map((r) => {
    const s = r.trim();
    switch (s) {
      // stale reasons
      case "task_overdue":
        return "Task overdue — check agent status";
      case "poll_failure":
        return "Unreachable — poll failures detected";
      case "config_drift":
        return "Config changed — awaiting verification";
      case "expired_approval":
        return "Approval expired";
      // Legacy reason strings (back-compat with old resolver)
      case "approval_pending":
        return "Waiting for your approval";
      case "awaiting_subagent":
        return "Waiting on subagent";
      case "external_event":
        return "Waiting for external event";
      case "truthfulness":
        return "Paused — last turn flagged for truthfulness";
      case "budget_exceeded":
        return "Paused — token/cost budget exhausted";
      case "repeated_timeout":
        return "Paused — repeated timeouts";
      case "tool_permission_denied":
        return "Paused — needs a missing tool permission";
      default:
        return s;
    }
  });

  return mapped.join(" · ");
}

/**
 * relative timestamp helper. "just now" for < 1m, otherwise
 * coarse age (Xm / Xh / Xd). ISO string falls back to "—" when missing.
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (typeof iso !== "string" || iso.length === 0) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const deltaMs = now.getTime() - t;
  if (deltaMs < 60_000) return "just now";
  const m = Math.floor(deltaMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
