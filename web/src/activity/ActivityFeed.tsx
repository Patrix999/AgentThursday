import { useEffect, useMemo, useRef, useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";
import { useInspect } from "../hooks/useInspect";
import { ActivityCard } from "./ActivityCard";

type Intent = NonNullable<InspectSnapshot["actionUiIntents"]>[number];

type Props = {
  /** Optional id of the parent scroll container; if provided, the
   *  IntersectionObserver roots itself there instead of the viewport. */
  scrollContainerId?: string;
};

const EMPTY_COPY =
  "Waiting for model actions… Search, file reads, execution, and workspace changes will appear here.";

const FEED_CAP = 20;
const RAIL_CAP = 12;

/**
 * M7.6 v2 — single-active card + right-side thumbnail rail.
 *
 * Pat redesign brief:
 *   - keep one active card visible at a time
 *   - shrink the rest into a thumbnail rail attached to the dialog
 *   - user clicks a thumbnail to enlarge it as the new active card
 *
 * Layout:
 *   - desktop / wide viewport: horizontal split inside this section.
 *     Active card grows in the left column (`flex-1`), thumbnails stack
 *     vertically in a fixed-width right column.
 *   - narrow viewport: thumbnail rail collapses below the active card
 *     as a horizontal scroll strip (`flex-row overflow-x-auto`).
 *
 * Selection model:
 *   - Default behavior: `selectedId === null` → active card is the
 *     latest intent. New arrivals swap in seamlessly without scrolling
 *     anything.
 *   - User clicks a thumbnail: `selectedId === intent.id` → that intent
 *     becomes the pinned active card. New arrivals are still rendered
 *     in the rail but DO NOT replace the user's pinned selection. A
 *     small "↑ N new" affordance lets the user return to "follow
 *     latest" mode.
 *
 * Anti-focus-stealing:
 *   - This component never calls `scrollTo` / `scrollIntoView`. The
 *     active card swap happens in-place; thumbnails appear in the rail
 *     without affecting page scroll. The earlier Card 129 "feed scroll"
 *     concept is gone — there's nothing to scroll inside the feed
 *     anymore.
 *   - The optional `scrollContainerId` prop is kept as a hook for
 *     future surfaces that want to know whether the user is at the
 *     bottom of the parent dialog scroll container.
 */
export function ActivityFeed({ scrollContainerId: _scrollContainerId }: Props = {}) {
  const { data } = useInspect(true);
  const intents = useMemo<Intent[]>(() => {
    const all = data?.actionUiIntents ?? [];
    return all.filter(isDefaultFeedIntent).slice(0, FEED_CAP);
  }, [data?.actionUiIntents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keep track of how many new intents have arrived since user pinned
  // a non-latest selection. Only used for the "follow latest" hint.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [newSincePin, setNewSincePin] = useState(0);

  useEffect(() => {
    const seen = seenIdsRef.current;
    let firstSnapshot = seen.size === 0;
    let added = 0;
    for (const intent of intents) {
      if (!seen.has(intent.id)) {
        if (!firstSnapshot) added += 1;
        seen.add(intent.id);
      }
    }
    if (selectedId === null) {
      // Following latest — newCount stays 0; latest auto-promotes.
      setNewSincePin(0);
    } else if (added > 0) {
      setNewSincePin((c) => c + added);
    }
  }, [intents, selectedId]);

  const latest = intents[0] ?? null;
  const active: Intent | null = selectedId
    ? (intents.find((i) => i.id === selectedId) ?? latest)
    : latest;
  const railIntents = intents.filter((i) => i.id !== active?.id).slice(0, RAIL_CAP);

  function followLatest() {
    setSelectedId(null);
    setNewSincePin(0);
  }

  if (intents.length === 0) {
    return (
      <section className="px-4 py-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Activity</div>
        <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-500 text-center">
          {EMPTY_COPY}
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-slate-500">Activity</span>
        {selectedId !== null && newSincePin > 0 && (
          <button
            type="button"
            onClick={followLatest}
            className="rounded-full bg-cyan-700 hover:bg-cyan-600 px-3 py-0.5 text-xs text-cyan-50"
          >
            ↑ {newSincePin} new — follow latest
          </button>
        )}
      </div>
      <div className="flex flex-col lg:flex-row gap-3">
        {/* Active card — large, prominent, attached visually to the
            dialog area (which renders directly above this section) */}
        <div className="flex-1 min-w-0">
          {active && <ActivityCard intent={active} />}
        </div>
        {/* Thumbnail rail — vertical on desktop, horizontal scroll on narrow */}
        {railIntents.length > 0 && (
          <aside
            className="lg:w-44 lg:shrink-0 lg:max-h-[60vh] lg:overflow-y-auto
                       flex flex-row lg:flex-col gap-2 overflow-x-auto pb-1 lg:pb-0"
            aria-label="Recent activity"
          >
            {railIntents.map((intent) => (
              <ThumbnailButton
                key={intent.id}
                intent={intent}
                onClick={() => {
                  setSelectedId(intent.id);
                  setNewSincePin(0);
                }}
              />
            ))}
          </aside>
        )}
      </div>
    </section>
  );
}

function ThumbnailButton({
  intent,
  onClick,
}: {
  intent: Intent;
  onClick: () => void;
}) {
  const tone = thumbnailToneFor(intent.type);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 lg:shrink min-w-[8rem] lg:min-w-0 text-left rounded-md border ${tone.border} ${tone.bg} px-2 py-1.5 hover:brightness-125 transition`}
      title={intent.title}
    >
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] uppercase font-mono px-1 rounded ${tone.badge}`}>
          {tone.label}
        </span>
        <span className="text-[10px] text-slate-500 ml-auto">
          {relativeShort(intent.sourceEventAt)}
        </span>
      </div>
      <div className="mt-1 text-xs text-slate-200 truncate">{intent.title}</div>
    </button>
  );
}

function thumbnailToneFor(type: Intent["type"]): {
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
    case "agent.degradation":
      return { border: "border-amber-800/60", bg: "bg-amber-950/30", badge: "bg-amber-900/60 text-amber-200", label: "deg" };
    case "agent.pause":
      return { border: "border-sky-800/60", bg: "bg-sky-950/30", badge: "bg-sky-900/60 text-sky-200", label: "pause" };
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

function isDefaultFeedIntent(intent: Intent): boolean {
  if (intent.priority === "debug") return false;
  if (intent.placementHint.region === "debug") return false;
  // Conversation-first invariant for degradation/pause stays — they
  // should not be top-pinned as default UI cards. They appear via
  // chat reply markers (Card 116 / 120) and Inspect drawer banner.
  if (intent.type === "agent.degradation") return false;
  if (intent.type === "agent.pause") return false;
  return (
    intent.type === "generic.tool_event"
    || intent.type === "tool.search_results"
    || intent.type === "tool.file_read"
    || intent.type === "tool.execution_result"
    || intent.type === "tool.workspace_mutation"
  );
}
