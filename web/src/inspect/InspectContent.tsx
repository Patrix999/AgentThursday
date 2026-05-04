import { useEffect, useRef, useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";
import { LadderTimeline } from "./LadderTimeline";
import { TraceList } from "./TraceList";
import { ToolEventList } from "./ToolEventList";
import { DebugPanel } from "./DebugPanel";
import { RecoverActions } from "./RecoverActions";
import { ChannelTimeline } from "./ChannelTimeline";
import { DegradationBanner } from "./DegradationBanner";
import { useChannelSnapshot } from "../hooks/useChannelSnapshot";
import { WorkspaceFileManager } from "../workspace/WorkspaceFileManager";
import { MemoryPanel } from "../memory/MemoryPanel";
import { ContextPanel } from "../context/ContextPanel";
import { ArchivePanel } from "./ArchivePanel";
import { MemoryCandidatesPanel } from "./MemoryCandidatesPanel";

type Tab = "ladder" | "trace" | "tools" | "channel" | "workspace" | "memory" | "candidates" | "context" | "archive" | "debug";

const TAB_LIST: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "ladder", label: "Ladder" },
  { id: "trace", label: "Trace" },
  { id: "tools", label: "Tools" },
  { id: "channel", label: "Channel" },
  { id: "workspace", label: "Workspace" },
  { id: "memory", label: "Memory" },
  { id: "candidates", label: "Candidates" },
  { id: "context", label: "Context" },
  { id: "archive", label: "Archive" },
  { id: "debug", label: "Debug" },
];

function tabLabel(tab: Tab): string {
  return TAB_LIST.find((t) => t.id === tab)?.label ?? tab;
}

type Props = {
  data: InspectSnapshot | null;
  loading: boolean;
  error: string | null;
};

/**
 * Tab structure shared by InspectDrawer (desktop) and InspectRoute (mobile).
 *  added the Channel tab. ChannelHub state is fetched lazily — only
 * when the Channel tab is active — same pattern as `useInspect(open)`.
 * RecoverActions sits below the tabs so it's always reachable.
 */
const VALID_HASH_TABS: ReadonlySet<Tab> = new Set([
  "ladder", "trace", "tools", "channel", "workspace", "memory", "context", "archive", "debug",
]);

function readHashTab(): Tab | null {
  // light deep-link from mobile context chip (and any
  // other entry that wants to land on a specific inspect tab).
  // Reads `window.location.hash` once on mount; ignores invalid or
  // missing hashes. SSR-safe via `typeof window` guard.
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "").trim();
  return raw && VALID_HASH_TABS.has(raw as Tab) ? (raw as Tab) : null;
}

export function InspectContent({ data, loading, error }: Props) {
  const [tab, setTab] = useState<Tab>(() => readHashTab() ?? "ladder");
  const channel = useChannelSnapshot(tab === "channel");

  // Keep the URL hash in sync when the user picks a tab so the
  // deep-link survives page refresh / share-link cases.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = window.location.hash.replace(/^#/, "");
    if (current !== tab) {
      // `replaceState` to avoid spamming the browser history.
      window.history.replaceState(null, "", `${window.location.pathname}#${tab}`);
    }
  }, [tab]);

  return (
    <div className="flex flex-col h-full">
      {data && <DegradationBanner diagnostics={data.degradationDiagnostics} />}
      {/* desktop keeps the horizontal tab strip; mobile
          gets a menu button + bottom sheet. Both variants drive the
          same `tab` state, and the URL hash deep-link from 
          continues to seed the initial tab regardless of viewport. */}
      <div className="hidden lg:block">
        <Tabs current={tab} onChange={setTab} />
      </div>
      <MobileTabMenu current={tab} onChange={setTab} />
      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {error && tab !== "channel" && (
          <div className="mb-2 text-xs text-rose-400">inspect fetch error: {error}</div>
        )}
        {loading && !data && tab !== "channel" && <div className="text-sm text-slate-500">Loading…</div>}
        {data && (
          <>
            {tab === "ladder" && <LadderTimeline ladder={data.ladder} />}
            {tab === "trace" && <TraceList trace={data.trace} />}
            {tab === "tools" && <ToolEventList toolEvents={data.toolEvents} />}
            {tab === "debug" && <DebugPanel debugRaw={data.debugRaw} />}
          </>
        )}
        {tab === "channel" && (
          <ChannelTimeline data={channel.data} loading={channel.loading} error={channel.error} />
        )}
        {tab === "workspace" && <WorkspaceFileManager />}
        {tab === "memory" && <MemoryPanel />}
        {tab === "candidates" && <MemoryCandidatesPanel />}
        {tab === "context" && <ContextPanel />}
        {tab === "archive" && <ArchivePanel />}
      </div>
      <div className="border-t border-slate-800 px-4 py-3">
        <RecoverActions />
      </div>
    </div>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  // `min-w-0 overflow-x-auto no-scrollbar` keeps the desktop strip from
  // pushing the page wider; per-button `flex-shrink-0 whitespace-nowrap`
  // keeps labels intact.
  //
  // Translate vertical mouse wheel to horizontal scroll when the strip
  // has horizontal overflow and the user's wheel input is dominantly
  // vertical (`|deltaY| > |deltaX|`). Trackpad horizontal gestures
  // (deltaX dominant) keep their native behavior. Only consume the
  // event when we actually scroll, so vertical page scrolling on
  // viewports where the strip fits without overflow is not blocked.
  const stripRef = useRef<HTMLDivElement | null>(null);
  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const el = stripRef.current;
    if (!el) return;
    const hasHorizontalOverflow = el.scrollWidth > el.clientWidth;
    if (!hasHorizontalOverflow) return;
    const dx = e.deltaX;
    const dy = e.deltaY;
    if (Math.abs(dy) <= Math.abs(dx)) return;
    el.scrollLeft += dy;
    e.preventDefault();
  }
  return (
    <div
      ref={stripRef}
      onWheel={onWheel}
      className="no-scrollbar min-w-0 overflow-x-auto border-b border-slate-800 bg-slate-900/80"
    >
      <div className="flex w-max">
        {TAB_LIST.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            data-inspect-tab={t.id}
            className={`flex-shrink-0 whitespace-nowrap px-3 py-2 text-xs uppercase tracking-wide ${
              current === t.id
                ? "text-sky-300 border-b-2 border-sky-400"
                : "text-slate-400 hover:text-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * mobile inspect navigation.
 *
 * Replaces the desktop horizontal tab strip on `<lg` viewports with a
 * single menu button that opens a bottom sheet listing all inspect
 * sections. the operator said the desktop tabbar didn't feel mobile-native;
 * this surface is built around tap-to-open + tap-to-select, with a
 * tap-anywhere-on-backdrop or a Close button to dismiss. No swipe
 * gestures are added in v1 — tap is the primary mobile primitive and
 * adding gesture handling would expand scope.
 *
 * Hash deep-link from  still drives the initial tab; the
 * sheet selection updates the same `tab` state so the hash stays in
 * sync via the parent's existing `replaceState` effect.
 */
function MobileTabMenu({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const [open, setOpen] = useState(false);

  // Close the sheet when ESC is pressed (helpful on tablets with
  // bluetooth keyboards, otherwise no-op on touch devices).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="mobile-inspect-menu-button"
        className="w-full flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/80 text-slate-200 active:bg-slate-800"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">section</span>
          <span className="text-sm font-semibold">{tabLabel(current)}</span>
        </span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex flex-col justify-end bg-slate-950/70"
          role="dialog"
          aria-modal="true"
          aria-label="Inspect sections"
          data-testid="mobile-inspect-sheet"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-slate-900 border-t border-slate-700 rounded-t-lg shadow-2xl pb-[env(safe-area-inset-bottom)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <span className="text-xs uppercase tracking-wide text-slate-500">Inspect sections</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-slate-400 hover:text-slate-100 active:text-slate-200 px-2"
                aria-label="Close inspect sections"
              >
                Close
              </button>
            </div>
            <ul className="max-h-[70dvh] overflow-y-auto py-2">
              {TAB_LIST.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(t.id);
                      setOpen(false);
                    }}
                    data-inspect-tab={t.id}
                    className={`w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px] ${
                      current === t.id
                        ? "bg-sky-950/40 text-sky-200"
                        : "text-slate-200 active:bg-slate-800"
                    }`}
                  >
                    <span className="text-sm">{t.label}</span>
                    {current === t.id && (
                      <span className="text-xs text-sky-300" aria-hidden>●</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
