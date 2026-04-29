import { useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";
import { LadderTimeline } from "./LadderTimeline";
import { TraceList } from "./TraceList";
import { ToolEventList } from "./ToolEventList";
import { DebugPanel } from "./DebugPanel";
import { RecoverActions } from "./RecoverActions";
import { ChannelTimeline } from "./ChannelTimeline";
import { DegradationBanner } from "./DegradationBanner";
import { useChannelSnapshot } from "../hooks/useChannelSnapshot";

type Tab = "ladder" | "trace" | "tools" | "channel" | "debug";

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
export function InspectContent({ data, loading, error }: Props) {
  const [tab, setTab] = useState<Tab>("ladder");
  const channel = useChannelSnapshot(tab === "channel");

  return (
    <div className="flex flex-col h-full">
      {data && <DegradationBanner diagnostics={data.degradationDiagnostics} />}
      <Tabs current={tab} onChange={setTab} />
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
      </div>
      <div className="border-t border-slate-800 px-4 py-3">
        <RecoverActions />
      </div>
    </div>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "ladder", label: "Ladder" },
    { id: "trace", label: "Trace" },
    { id: "tools", label: "Tools" },
    { id: "channel", label: "Channel" },
    { id: "debug", label: "Debug" },
  ];
  return (
    <div className="flex border-b border-slate-800 bg-slate-900/80">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-2 text-xs uppercase tracking-wide ${
            current === t.id
              ? "text-sky-300 border-b-2 border-sky-400"
              : "text-slate-400 hover:text-slate-100"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
