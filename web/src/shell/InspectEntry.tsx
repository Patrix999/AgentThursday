import { Link } from "react-router-dom";
import { getActiveAgentPin, getActiveContextId } from "../auth/secret";

/** Mobile-only entry to /inspect. Desktop uses the drawer. */
export function InspectEntry() {
  const activeAgentId = getActiveAgentPin() ?? (getActiveContextId() || null);
  const inspectTo = activeAgentId
    ? `/inspect?agent_id=${encodeURIComponent(activeAgentId)}`
    : "/inspect";
  return (
    <div className="lg:hidden border-t border-slate-800 bg-slate-900/80 px-4 py-2">
      <Link
        to={inspectTo}
        className="text-xs text-slate-400 hover:text-slate-100 underline underline-offset-2"
      >
        Open professional inspect →
      </Link>
    </div>
  );
}
