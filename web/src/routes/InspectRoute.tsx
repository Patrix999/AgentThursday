import { Link } from "react-router-dom";
import { useInspect } from "../hooks/useInspect";
import { InspectContent } from "../inspect/InspectContent";

/**
 * Mobile-primary inspect surface. Always polling while the route is mounted
 * (the user navigated here intentionally). Desktop users normally use the
 * drawer (M7.1 surface decision); this route is also reachable from desktop.
 */
export function InspectRoute() {
  const { data, loading, error } = useInspect(true);

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 flex items-center gap-3 px-4 py-3 bg-slate-900 border-b border-slate-800">
        <Link
          to="/"
          className="text-sm text-slate-400 hover:text-slate-100"
          aria-label="Back to workspace"
        >
          ← Back
        </Link>
        <span className="text-xs uppercase tracking-wide text-slate-500">Inspect</span>
      </header>
      <div className="flex-1 min-h-0">
        <InspectContent data={data} loading={loading} error={error} />
      </div>
    </div>
  );
}
