import { useSearchParams } from "react-router-dom";
import { useInspect } from "../hooks/useInspect";
import { InspectContent } from "../inspect/InspectContent";
import { ContextInspectProvider } from "../context/ContextInspectProvider";
import { useDebugSurfaceMode } from "../hooks/useDebugSurfaceMode";
import { isDebugSurfaceVisible, getDebugDisabledNotice } from "../debugSurfaceMode";
import { PageHeader } from "../nav/PageHeader";

/**
 * Mobile-primary inspect surface. Always polling while the route is mounted
 * (the user navigated here intentionally). Desktop users normally use the
 * drawer (M7.1 surface decision); this route is also reachable from desktop.
 *
 * when `AGENT_THURSDAY_DEBUG_SURFACE_MODE === "disable"` we show a
 * minimal "disabled by deployment config" notice instead of mounting
 * the full inspect tree. Critical: we must NOT call `useInspect(true)`
 * in that branch — the hook starts the `/api/inspect` polling loop on
 * mount, and `disable` mode is supposed to short-circuit before any
 * debug payload is fetched.
 */
export function InspectRoute() {
  const debugMode = useDebugSurfaceMode();
  const backTo = useInspectBackTarget();
  // Mode still resolving: render a minimal placeholder; do NOT mount
  // the polling tree until we know whether we're allowed to.
  if (debugMode === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Inspect" backTo={backTo} backLabel="← Back" />
        <div className="flex-1 min-h-0 px-4 py-3 text-sm text-slate-500">Loading…</div>
      </div>
    );
  }
  if (!isDebugSurfaceVisible(debugMode)) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Inspect" backTo={backTo} backLabel="← Back" />
        <div
          className="flex-1 min-h-0 px-6 py-8 flex items-start justify-center"
          data-testid="inspect-disabled-notice"
        >
          <div className="max-w-md text-sm text-slate-300 space-y-2">
            <div className="text-amber-300 font-semibold">Inspect disabled</div>
            <p className="text-slate-400">{getDebugDisabledNotice()}</p>
          </div>
        </div>
      </div>
    );
  }
  return <InspectRouteEnabled />;
}

function InspectRouteEnabled() {
  const { data, loading, error } = useInspect(true);
  const backTo = useInspectBackTarget();
  // Mobile inspect route can also reach the Context tab; wrap so the
  // tab's `useSharedContextInspect()` resolves to a real provider on
  // this route too. (Desktop wraps inside Workspace.tsx.)
  return (
    <ContextInspectProvider>
      <div className="flex flex-col h-full">
        <PageHeader title="Inspect" backTo={backTo} backLabel="← Back" />
        <div className="flex-1 min-h-0">
          <InspectContent data={data} loading={loading} error={error} />
        </div>
      </div>
    </ContextInspectProvider>
  );
}

function useInspectBackTarget(): string {
  const [searchParams] = useSearchParams();
  const agentId = searchParams.get("agent_id")?.trim() ?? "";
  return agentId.length > 0
    ? `/workspace?agent_id=${encodeURIComponent(agentId)}`
    : "/workspace";
}
