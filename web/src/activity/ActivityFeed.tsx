import { useEffect, useMemo, useRef, useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";
import { ActivityCard } from "./ActivityCard";

type Intent = NonNullable<InspectSnapshot["actionUiIntents"]>[number];

const EMPTY_COPY =
  "Waiting for model actions… Search, file reads, execution, and workspace changes will appear here.";

const FEED_CAP = 30;

/**
 * v3 accordion (an earlier revision v3) — the operator redesign:
 *
 *   - The activity surface is now a right-side independent panel,
 *     not part of the conversation column.
 *   - Each intent is an accordion item: header (always visible) +
 *     body (expanded only when active).
 *   - Newest intent auto-expands; older items collapse to a thin
 *     header row.
 *   - Click a header to toggle.
 *   - When a new intent of the same `type` as an existing collapsed
 *     item arrives, that item auto-expands again, with the same
 *     "fresh" visual cue as a brand-new item.
 *   - The conversation column owns nothing about activity now; this
 *     component is pure render of `inspect.actionUiIntents`.
 *
 * Anti-focus-stealing red line is preserved: this component never
 * calls `scrollTo` / `scrollIntoView`. New items append at the top of
 * the accordion in place; existing scroll position is unaffected.
 */
export function ActivityFeed({ data }: { data: InspectSnapshot | null }) {
  const visible = useMemo<Intent[]>(() => {
    const all = data?.actionUiIntents ?? [];
    return all.filter(isDefaultFeedIntent).slice(0, FEED_CAP);
  }, [data?.actionUiIntents]);

  // Track per-intent expanded state. Default newest expanded; older
  // collapsed. Updates reactively when new intents arrive.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seenIdsRef = useRef<Set<string>>(new Set());
  const userToggledIdsRef = useRef<Set<string>>(new Set());
  const lastTypeIdRef = useRef<Record<Intent["type"], string | undefined>>(
    {} as Record<Intent["type"], string | undefined>,
  );

  useEffect(() => {
    const seen = seenIdsRef.current;
    const userToggled = userToggledIdsRef.current;
    const lastByType = lastTypeIdRef.current;
    const addedIds = new Set<string>();
    const reactivatedIds = new Set<string>();
    let mutated = false;
    const nextExpanded = { ...expanded };

    for (const intent of visible) {
      if (!seen.has(intent.id)) {
        seen.add(intent.id);
        addedIds.add(intent.id);
        // New intent: expand it.
        nextExpanded[intent.id] = true;
        // the operator rule: if a previously-collapsed item of the same type
        // exists, also re-expand it — "fresh" visual same as new.
        // User toggles still win: don't override a manual collapse.
        const prevId = lastByType[intent.type];
        if (
          prevId
          && prevId !== intent.id
          && nextExpanded[prevId] === false
          && !userToggled.has(prevId)
        ) {
          nextExpanded[prevId] = true;
          reactivatedIds.add(prevId);
        }
        lastByType[intent.type] = intent.id;
        mutated = true;
      }
    }

    // Auto-collapse inactive items on every new arrival while preserving
    // explicit user toggles and same-type reactivation.
    if (addedIds.size > 0 && visible.length > 0) {
      const newestId = visible[0].id;
      for (const intent of visible) {
        if (intent.id === newestId) continue;
        if (reactivatedIds.has(intent.id)) continue;
        if (userToggled.has(intent.id)) continue;
        if (nextExpanded[intent.id] !== false) {
          nextExpanded[intent.id] = false;
          mutated = true;
        }
      }
    }

    if (mutated) setExpanded(nextExpanded);
  }, [visible, expanded]);

  function toggle(id: string) {
    userToggledIdsRef.current.add(id);
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (data === null) {
    return <ActivityLoadingSkeleton />;
  }

  if (visible.length === 0) {
    return (
      <div className="px-4 py-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Activity</div>
        <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-500 text-center">
          {EMPTY_COPY}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Activity</div>
      <ul className="divide-y divide-slate-800/70 rounded border border-slate-800/70 bg-slate-950/40">
        {visible.map((intent) => {
          const isOpen = expanded[intent.id] !== false;
          const tone = headerToneFor(intent.type);
          return (
            <li key={intent.id}>
              <button
                type="button"
                onClick={() => toggle(intent.id)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-slate-900/60"
              >
                <span className="text-slate-500 font-mono text-[10px] w-3 shrink-0">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className={`text-[10px] uppercase font-mono px-1.5 rounded shrink-0 ${tone.badge}`}>
                  {tone.label}
                </span>
                <span className="text-sm text-slate-200 truncate flex-1 min-w-0">
                  {intent.title}
                </span>
                <HeaderStatusGlyph intent={intent} />
                <span className="text-[10px] text-slate-500 shrink-0 ml-2 font-mono">
                  {relativeShort(intent.sourceEventAt)}
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pl-8">
                  <ActivityCard intent={intent} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// lifecycle status glyph in the collapsed header so the
// operator sees running/ok/error without expanding.
function HeaderStatusGlyph({ intent }: { intent: Intent }) {
  const lc = (intent.component.props as { lifecycle?: { status?: unknown } } | null)?.lifecycle;
  const status = lc && typeof lc.status === "string" ? lc.status : null;
  if (status === null) return null;
  if (status === "running") return <span className="shrink-0 text-[10px] text-amber-400 font-mono">⏳</span>;
  if (status === "error") return <span className="shrink-0 text-[10px] text-rose-400 font-mono">✗</span>;
  return <span className="shrink-0 text-[10px] text-emerald-400 font-mono">✓</span>;
}

function headerToneFor(type: Intent["type"]): {
  border: string;
  bg: string;
  badge: string;
  label: string;
} {
  switch (type) {
    case "tool.search_results":
      return { border: "border-violet-800/60", bg: "bg-violet-950/30", badge: "bg-violet-900/60 text-violet-200", label: "search" };
    case "tool.file_read":
      return { border: "border-emerald-800/60", bg: "bg-emerald-950/30", badge: "bg-emerald-900/60 text-emerald-200", label: "file" };
    case "tool.execution_result":
      return { border: "border-fuchsia-800/60", bg: "bg-fuchsia-950/30", badge: "bg-fuchsia-900/60 text-fuchsia-200", label: "exec" };
    case "tool.workspace_mutation":
      return { border: "border-cyan-800/60", bg: "bg-cyan-950/30", badge: "bg-cyan-900/60 text-cyan-200", label: "ws" };
    case "tool.lifecycle":
      return { border: "border-indigo-800/60", bg: "bg-indigo-950/30", badge: "bg-indigo-900/60 text-indigo-200", label: "mgr" };
    case "agent.degradation":
      return { border: "border-amber-800/60", bg: "bg-amber-950/30", badge: "bg-amber-900/60 text-amber-200", label: "deg" };
    case "agent.pause":
      return { border: "border-sky-800/60", bg: "bg-sky-950/30", badge: "bg-sky-900/60 text-sky-200", label: "pause" };
    case "workflow.run":
      return { border: "border-orange-800/60", bg: "bg-orange-950/30", badge: "bg-orange-900/60 text-orange-200", label: "run" };
    case "generic.tool_event":
      return { border: "border-slate-700", bg: "bg-slate-900/60", badge: "bg-slate-800 text-slate-300", label: "tool" };
    case "generic.event":
      return { border: "border-slate-800", bg: "bg-slate-950/40", badge: "bg-slate-800 text-slate-500", label: "evt" };
  }
}

function relativeShort(at: number): string {
  const delta = Date.now() - at;
  if (delta < 0) return "now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ActivityLoadingSkeleton() {
  return (
    <div className="px-4 py-3" aria-label="Loading activity">
      <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Activity</div>
      <div className="divide-y divide-slate-800/70 rounded border border-slate-800/70 bg-slate-950/40 animate-pulse">
        {[0, 1, 2, 3].map((idx) => (
          <div key={idx} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-slate-800" />
              <div className="h-4 w-10 rounded bg-slate-800/80" />
              <div className="h-4 min-w-0 flex-1 rounded bg-slate-800/70" />
              <div className="h-3 w-8 rounded bg-slate-800/50" />
            </div>
            {idx === 0 && (
              <div className="ml-8 mt-2 space-y-2">
                <div className="h-3 w-9/12 rounded bg-slate-800/60" />
                <div className="h-3 w-6/12 rounded bg-slate-800/50" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function isDefaultFeedIntent(intent: Intent): boolean {
  if (intent.priority === "debug") return false;
  if (intent.placementHint.region === "debug") return false;
  if (intent.type === "agent.degradation") return false;
  if (intent.type === "agent.pause") return false;
  return (
    intent.type === "generic.tool_event"
    || intent.type === "tool.search_results"
    || intent.type === "tool.file_read"
    || intent.type === "tool.execution_result"
    || intent.type === "tool.workspace_mutation"
    || intent.type === "tool.lifecycle"
    || intent.type === "workflow.run"
  );
}
