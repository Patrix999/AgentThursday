import { useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { TopStatusBar } from "../shell/TopStatusBar";
import { MainCardsArea } from "../shell/MainCardsArea";
import { SummaryStream } from "../shell/SummaryStream";
import { Composer } from "../shell/Composer";
import { InspectDrawer } from "../shell/InspectDrawer";
import { InspectEntry } from "../shell/InspectEntry";
import { ThumbReachLayout } from "../mobile/ThumbReachLayout";
import { MobileComposer } from "../mobile/MobileComposer";
import { ActivityFeed } from "../activity/ActivityFeed";

/**
 * Default user-layer surface. Two independent shell trees — one shown only
 * at lg+ (`hidden lg:flex`), the other only below lg (`lg:hidden` inside
 * `ThumbReachLayout`). Both consume the same `useWorkspace` poll at the
 * parent level so polling is shared.
 */
export function Workspace() {
  const { data, error, lastRefreshedAt } = useWorkspace();
  const [inspectOpen, setInspectOpen] = useState(false);

  const errorBanner = error && (
    <div className="px-4 py-2 text-xs text-rose-400 bg-rose-950/40 border-b border-rose-900">
      workspace fetch error: {error}
    </div>
  );

  return (
    <>
      {/* Desktop */}
      <div className="hidden lg:flex h-full">
        <div className="flex flex-col flex-1 min-h-0">
          <TopStatusBar
            snapshot={data}
            lastRefreshedAt={lastRefreshedAt}
            onToggleInspect={() => setInspectOpen((v) => !v)}
            inspectOpen={inspectOpen}
          />
          {errorBanner}
          <div className="flex-1 overflow-y-auto" id="agent-thursday-main-scroll">
            <MainCardsArea snapshot={data} />
            <SummaryStream snapshot={data} />
            <ActivityFeed scrollContainerId="agent-thursday-main-scroll" />
          </div>
          <Composer snapshot={data} />
        </div>
        <InspectDrawer open={inspectOpen} onClose={() => setInspectOpen(false)} />
      </div>

      {/* Mobile shell */}
      <ThumbReachLayout
        top={
          <>
            <TopStatusBar snapshot={data} lastRefreshedAt={lastRefreshedAt} />
            {errorBanner}
          </>
        }
        scroll={
          <>
            <MainCardsArea snapshot={data} hideApprovalActions />
            <SummaryStream snapshot={data} />
            <ActivityFeed />
          </>
        }
        inspect={<InspectEntry />}
        bottom={<MobileComposer snapshot={data} />}
      />
    </>
  );
}
