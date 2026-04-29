import type { InspectSnapshot } from "../../shared/schema";
import { SearchResultsPanel } from "./SearchResultsPanel";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { ExecutionResultPanel } from "./ExecutionResultPanel";
import { WorkspaceChangePanel } from "./WorkspaceChangePanel";

type Intent = NonNullable<InspectSnapshot["actionUiIntents"]>[number];

/**
 * Card 126 — generic visual renderer for an `ActionUiIntent`.
 *
 * v1 only knows how to render the four built-in component names from
 * Card 125's backend: `GenericToolEventCard`, `GenericEventCard`,
 * `DegradationCard`, `PauseCard`. All four use a single visual chrome
 * with type-based color accent + a small structured props row, because
 * Card 127 will introduce per-tool components and we don't want to
 * over-design the chrome before that lands.
 *
 * Visual hierarchy goal (kanban §"Make tool/action cards visually
 * prominent"): clear title, small type badge, relative timestamp,
 * accent color, and enough breathing room to read as a card — not a
 * row in a debug table.
 */
export function ActivityCard({ intent }: { intent: Intent }) {
  const tone = toneForType(intent.type);
  return (
    <article className={`rounded-lg border ${tone.border} ${tone.bg} p-4 shadow-sm`}>
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs uppercase font-mono px-2 py-0.5 rounded ${tone.badge}`}>
            {tone.label}
          </span>
          <span className="text-sm font-medium text-slate-100 truncate">{intent.title}</span>
        </div>
        <span className="text-xs text-slate-500 shrink-0">{relativeTime(intent.sourceEventAt)}</span>
      </header>
      {intent.summary && (
        <p className="mt-2 text-sm text-slate-300 break-words">{intent.summary}</p>
      )}
      <ComponentBody name={intent.component.name} props={intent.component.props} />
    </article>
  );
}

/**
 * Card 127 — dispatch to the per-component renderer based on the
 * backend-supplied `component.name`. Each renderer takes a defensive
 * narrowing of `props: unknown` so a malformed/unknown shape degrades
 * gracefully rather than crashing the feed.
 */
function ComponentBody({ name, props }: { name: string; props: unknown }) {
  if (name === "SearchResultsPanel") {
    const p = (props ?? {}) as {
      queryPreview?: unknown; mode?: unknown; sourceId?: unknown;
      sourceIdsCount?: unknown; strategy?: unknown; pathPreview?: unknown;
      maxResults?: unknown;
    };
    if (typeof p.queryPreview !== "string") return null;
    return (
      <SearchResultsPanel
        queryPreview={p.queryPreview}
        mode={typeof p.mode === "string" ? p.mode : null}
        sourceId={typeof p.sourceId === "string" ? p.sourceId : null}
        sourceIdsCount={typeof p.sourceIdsCount === "number" ? p.sourceIdsCount : null}
        strategy={typeof p.strategy === "string" ? p.strategy : null}
        pathPreview={typeof p.pathPreview === "string" ? p.pathPreview : null}
        maxResults={typeof p.maxResults === "number" ? p.maxResults : null}
      />
    );
  }
  if (name === "FilePreviewPanel") {
    const p = (props ?? {}) as {
      sourceId?: unknown; pathPreview?: unknown; maxBytes?: unknown;
    };
    if (typeof p.sourceId !== "string" || typeof p.pathPreview !== "string") return null;
    return (
      <FilePreviewPanel
        sourceId={p.sourceId}
        pathPreview={p.pathPreview}
        maxBytes={typeof p.maxBytes === "number" ? p.maxBytes : null}
      />
    );
  }
  if (name === "ExecutionResultPanel") {
    const p = (props ?? {}) as {
      variant?: unknown; tier?: unknown; preview?: unknown;
      reason?: unknown; sandboxId?: unknown;
    };
    const variant = p.variant === "sandbox" ? "sandbox" : "execute";
    return (
      <ExecutionResultPanel
        variant={variant}
        tier={typeof p.tier === "number" ? p.tier : null}
        preview={typeof p.preview === "string" ? p.preview : null}
        reason={typeof p.reason === "string" ? p.reason : null}
        sandboxId={typeof p.sandboxId === "string" ? p.sandboxId : null}
      />
    );
  }
  if (name === "WorkspaceChangePanel") {
    const p = (props ?? {}) as {
      mutationKind?: unknown; path?: unknown;
      key?: unknown; checkpoint?: unknown;
    };
    const mutationKind = typeof p.mutationKind === "string" ? p.mutationKind : "mutation";
    return (
      <WorkspaceChangePanel
        mutationKind={mutationKind}
        path={typeof p.path === "string" ? p.path : null}
        key_={typeof p.key === "string" ? p.key : null /* react reserves `key` */}
        checkpoint={typeof p.checkpoint === "string" ? p.checkpoint : null}
      />
    );
  }
  if (name === "GenericToolEventCard") {
    return <ToolPropsRow props={props} />;
  }
  return null;
}

function ToolPropsRow({ props }: { props: unknown }) {
  const p = (props ?? {}) as { toolName?: string; subEvent?: string | null; taskId?: string | null };
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt className="text-slate-500">tool</dt>
      <dd className="text-slate-300 font-mono break-all">
        {p.toolName ?? "—"}
        {p.subEvent && <span className="text-slate-500"> · {p.subEvent}</span>}
      </dd>
      {p.taskId && (
        <>
          <dt className="text-slate-500">task</dt>
          <dd className="text-slate-400 font-mono break-all">{p.taskId}</dd>
        </>
      )}
    </dl>
  );
}

function toneForType(type: Intent["type"]): {
  border: string;
  bg: string;
  badge: string;
  label: string;
} {
  switch (type) {
    case "agent.degradation":
      return {
        border: "border-amber-800/60",
        bg: "bg-amber-950/20",
        badge: "bg-amber-900/60 text-amber-200",
        label: "degradation",
      };
    case "agent.pause":
      return {
        border: "border-sky-800/60",
        bg: "bg-sky-950/20",
        badge: "bg-sky-900/60 text-sky-200",
        label: "pause",
      };
    case "tool.search_results":
      return {
        border: "border-violet-800/60",
        bg: "bg-violet-950/20",
        badge: "bg-violet-900/60 text-violet-200",
        label: "search",
      };
    case "tool.file_read":
      return {
        border: "border-emerald-800/60",
        bg: "bg-emerald-950/20",
        badge: "bg-emerald-900/60 text-emerald-200",
        label: "file read",
      };
    case "tool.execution_result":
      return {
        border: "border-fuchsia-800/60",
        bg: "bg-fuchsia-950/20",
        badge: "bg-fuchsia-900/60 text-fuchsia-200",
        label: "exec",
      };
    case "tool.workspace_mutation":
      return {
        border: "border-cyan-800/60",
        bg: "bg-cyan-950/20",
        badge: "bg-cyan-900/60 text-cyan-200",
        label: "workspace",
      };
    case "generic.tool_event":
      return {
        border: "border-slate-700",
        bg: "bg-slate-900/60",
        badge: "bg-slate-800 text-slate-300",
        label: "tool",
      };
    case "generic.event":
      return {
        border: "border-slate-800",
        bg: "bg-slate-950/40",
        badge: "bg-slate-800 text-slate-500",
        label: "event",
      };
  }
}

function relativeTime(at: number): string {
  const delta = Date.now() - at;
  if (delta < 0) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
