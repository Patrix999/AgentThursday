import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkspace } from "../hooks/useWorkspace";
import { useInspect } from "../hooks/useInspect";
import { TopStatusBar } from "../shell/TopStatusBar";
import { MainCardsArea } from "../shell/MainCardsArea";
import { SummaryStream } from "../shell/SummaryStream";
import { Composer } from "../shell/Composer";
import { InspectEntry } from "../shell/InspectEntry";
import { ThumbReachLayout } from "../mobile/ThumbReachLayout";
import { MobileComposer } from "../mobile/MobileComposer";
import { MobileStatusRow } from "../mobile/MobileStatusRow";
import { MobileSummaryStream } from "../mobile/MobileSummaryStream";
import { ActivityFeed } from "../activity/ActivityFeed";
import { ContextRail } from "../context/ContextRail";
import { ContextInspectProvider } from "../context/ContextInspectProvider";
import { useDebugSurfaceMode } from "../hooks/useDebugSurfaceMode";
import { isDebugSurfaceVisible } from "../debugSurfaceMode";
import { listAgentProfiles } from "../api/agentProfiles";
import {
  clearActiveAgentPin,
  getActiveAgentPin,
  getActiveContextId,
  setActiveAgentPin,
} from "../auth/secret";
import { resolveActiveAgent } from "../../../src/agent/activeAgentResolver";

type RoutingBootstrap =
  | { status: "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

/**
 * Default user-layer surface. Two independent shell trees — one shown only
 * at lg+ (`hidden lg:flex`), the other only below lg (`lg:hidden` inside
 * `ThumbReachLayout`). Both consume the same `useWorkspace` poll at the
 * parent level so polling is shared.
 */
export function Workspace() {
  const [searchParams] = useSearchParams();
  const requestedAgentId = searchParams.get("agent_id")?.trim() ?? "";
  const [routing, setRouting] = useState<RoutingBootstrap>({
    status: "loading",
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function bootstrapRouting() {
      try {
        const agents = await listAgentProfiles();
        if (cancelled) return;
        if (agents === null) {
          setRouting({ status: "error", error: "agent list unavailable" });
          return;
        }
        if (requestedAgentId.length > 0) {
          const requested = agents.find((a) => a.id === requestedAgentId);
          if (!requested) {
            setRouting({
              status: "error",
              error: `agent not found: ${requestedAgentId}`,
            });
            return;
          }
          setActiveAgentPin(requested.id);
          setRouting({ status: "ready", error: null });
          return;
        }

        const resolved = resolveActiveAgent({
          pinnedAgentId: getActiveAgentPin(),
          storedAgentId: getActiveContextId(),
          agents,
        });
        if (resolved.pinIsStale) clearActiveAgentPin();
        if (
          resolved.agentId !== null
          && getActiveAgentPin() === null
          && (resolved.source === "first" || resolved.source === "stored")
        ) {
          setActiveAgentPin(resolved.agentId);
        }
        setRouting({ status: "ready", error: null });
      } catch (e) {
        if (!cancelled) {
          setRouting({ status: "error", error: String(e) });
        }
      }
    }
    void bootstrapRouting();
    return () => {
      cancelled = true;
    };
  }, [requestedAgentId]);

  if (routing.status !== "ready") {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950 px-4 text-sm text-slate-500">
        {routing.status === "error" ? `workspace routing error: ${routing.error}` : "Opening workspace..."}
      </div>
    );
  }

  return <WorkspaceShell />;
}

function WorkspaceShell() {
  const { data, error, lastRefreshedAt } = useWorkspace();
  const inspect = useInspect(true);
  // gate Inspect entry / context chip / context rail on the
  // resolved debug surface mode. `null` while the first /api/config
  // fetch is in flight; treat as "show nothing inspect-related yet"
  // so deployments shipped with `disable` never flash Inspect UI on
  // first paint.
  const debugMode = useDebugSurfaceMode();
  const showDebugSurface = debugMode !== null && isDebugSurfaceVisible(debugMode);

  const errorBanner = error && (
    <div className="px-4 py-2 text-xs text-rose-400 bg-rose-950/40 border-b border-rose-900">
      workspace fetch error: {error}
    </div>
  );

  return (
    // ContextInspectProvider wraps both desktop and mobile
    // trees so the read-only ContextIndicatorDialog (mounted from
    // `MobileStatusRow` and `TopStatusBar` chips) can read the same
    // shared `inspectContext` poll the Rail / Drawer use. Single HTTP
    // loop preserved per no extra mobile-side poll.
    <ContextInspectProvider>
      {/* Desktop — context rail + two-column main area + right activity accordion. */}
      <div className="hidden lg:flex h-full">
        {showDebugSurface && <ContextRail />}
        <div className="flex flex-col flex-1 min-w-0">
          <TopStatusBar
            snapshot={data}
            lastRefreshedAt={lastRefreshedAt}
            inspectSnapshot={inspect.data}
          />
          {errorBanner}
          <div className="flex-1 flex min-h-0 min-w-0">
            <div
              className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden"
              id="agentthursday-main-scroll"
            >
              <MainCardsArea snapshot={data} />
              <SummaryStream snapshot={data} />
            </div>
            <aside
              className="w-80 shrink-0 border-l border-slate-800 overflow-y-auto overflow-x-hidden"
            aria-label="Activity"
          >
              <ActivityFeed data={inspect.data} />
            </aside>
          </div>
          <Composer snapshot={data} />
        </div>

      </div>

      {/* mobile-first IA pass.
          - `MobileStatusRow` replaces `TopStatusBar` so the header is
            one compact row (≤ 56px target) and includes the operator's
            non-negotiable context indicator chip. an earlier revision makes it
            open a read-only context indicator dialog instead of Inspect.
          - `MobileSummaryStream` collapses older turns by default,
            so latest 1–3 stay above the fold at 360×780.
          - `ActivityFeed` is intentionally NOT rendered in the mobile
            primary scroll. Operators reach activity / inspect / archive
            via `InspectEntry → /inspect`. The desktop right-aside
            `ActivityFeed` is unchanged.
          when `debugSurfaceMode === "disable"` the mobile inspect
          entry is hidden. an earlier revision keeps the context chip visible. */}
      <ThumbReachLayout
        top={
          <>
            <MobileStatusRow
              snapshot={data}
              lastRefreshedAt={lastRefreshedAt}
              inspectSnapshot={inspect.data}
            />
            {errorBanner}
          </>
        }
        scroll={
          <>
            <MainCardsArea snapshot={data} hideApprovalActions />
            <MobileSummaryStream snapshot={data} />
            {/* mobile finally gets the same activity
                accordion (previously desktop-only; mobile had to
                detour to /inspect). Collapsed by default so it never
                crowds the conversation; same data, same component. */}
            <details className="px-1 pt-1">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs uppercase tracking-wide text-slate-500">
                Activity
              </summary>
              <ActivityFeed data={inspect.data} />
            </details>
          </>
        }
        inspect={showDebugSurface ? <InspectEntry /> : null}
        bottom={<MobileComposer snapshot={data} />}
      />
    </ContextInspectProvider>
  );
}
