import { useEffect, useState } from "react";
import {
  fetchActiveContext,
  fetchContextHistory,
  switchContext,
} from "../api/contextActions";
import type {
  ActiveContext,
  ContextHistoryEntry,
} from "../../shared/schema";
import { getDebugReadonlyNotice } from "../debugSurfaceMode";

/**
 * context identity summary. Renders the active
 * contextId + creation reason at the top of FutureActions so the
 * operator can see which logical context they are operating on.
 * Refreshes on `agentthursday:context:compacted` (the same event the legacy
 * compact and an earlier revision reset paths dispatch) and on the new
 * `agentthursday:context:switched` event dispatched by `<NewContextAction>`.
 *
 * an earlier revision (2026-05-21) — extracted from ContextPanel.tsx; behavior
 * unchanged (same fetches, same event listeners, same DOM tree).
 */
export function ContextIdentity({ actionsEnabled }: { actionsEnabled: boolean }) {
  const [active, setActive] = useState<ActiveContext | null>(null);
  const [history, setHistory] = useState<ContextHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [a, h] = await Promise.all([fetchActiveContext(), fetchContextHistory()]);
        if (!mounted) return;
        if (a) setActive(a);
        if (h) setHistory(h.contexts);
      } catch (e) {
        if (mounted) setError(String(e));
      }
    }
    void load();
    function onRefresh() {
      void load();
    }
    window.addEventListener("agentthursday:context:compacted", onRefresh);
    window.addEventListener("agentthursday:context:switched", onRefresh);
    return () => {
      mounted = false;
      window.removeEventListener("agentthursday:context:compacted", onRefresh);
      window.removeEventListener("agentthursday:context:switched", onRefresh);
    };
  }, []);

  async function onSwitch(contextId: string) {
    if (!actionsEnabled) {
      setSwitchError(getDebugReadonlyNotice());
      return;
    }
    if (switching) return;
    setSwitching(contextId);
    setSwitchError(null);
    const res = await switchContext({ contextId, reason: "manual-ui-switch" });
    if (res.ok && res.data) {
      setSwitching(null);
      // The client helper already wrote the new contextId to
      // localStorage; subsequent fetches will carry the header. Fire
      // the same refresh events the new-context flow uses so inspect /
      // pressure rail / compactions all re-fetch against the newly
      // active DO.
      window.dispatchEvent(new Event("agentthursday:context:compacted"));
      window.dispatchEvent(new Event("agentthursday:context:switched"));
    } else {
      const message = (res.data as unknown as { error?: string })?.error
        ?? res.error
        ?? `HTTP ${res.status}`;
      setSwitching(null);
      setSwitchError(message);
    }
  }

  if (error) {
    return (
      <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-[10px] text-rose-300">
        context identity error: {error}
      </div>
    );
  }
  if (!active) {
    return <div className="text-[10px] text-slate-500">loading context identity…</div>;
  }

  const closedCount = history.filter((c) => !c.isActive).length;

  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-1 text-[10px] text-slate-300">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-400">Active context</span>
        <span className="font-mono text-sky-300">{shortContextId(active.contextId)}</span>
        <span className="ml-auto text-slate-500">
          {closedCount > 0 ? `+${closedCount} closed` : "first context"}
        </span>
      </div>
      <div className="text-[10px] text-slate-500">
        opened: {new Date(active.createdAt).toISOString()}
        {active.reason ? <> · reason: <span className="text-slate-400">{active.reason}</span></> : null}
      </div>
      {switchError && (
        <div className="rounded border border-rose-700 bg-rose-950/40 px-2 py-1 text-rose-300">
          switch failed: {switchError}
        </div>
      )}
      {history.length > 1 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
            history ({history.length}) · click to switch
          </summary>
          <ul className="mt-1 space-y-0.5">
            {history.map((c) => (
              <li key={c.contextId} className="flex items-center gap-2 truncate">
                <button
                  type="button"
                  onClick={() => onSwitch(c.contextId)}
                  disabled={c.isActive || switching !== null}
                  className={`flex flex-1 items-center gap-2 truncate rounded px-1 py-0.5 text-left ${
                    c.isActive
                      ? "cursor-default bg-sky-950/40 text-sky-300"
                      : switching === c.contextId
                        ? "cursor-progress text-slate-500"
                        : "text-slate-300 hover:bg-slate-800"
                  }`}
                  title={c.isActive ? "Currently active" : actionsEnabled ? `Switch to ${c.contextId}` : getDebugReadonlyNotice()}
                >
                  <span className="font-mono text-slate-400">{shortContextId(c.contextId)}</span>
                  <span className={c.isActive ? "text-sky-300" : switching === c.contextId ? "text-amber-300" : "text-slate-500"}>
                    {c.isActive ? "active" : switching === c.contextId ? "switching…" : "closed"}
                  </span>
                  <span className="ml-auto text-slate-500">
                    {c.messageCountAtEnd !== null ? `${c.messageCountAtEnd} msgs` : ""}
                  </span>
                  <span className="text-slate-500 truncate">{c.reason ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function shortContextId(id: string): string {
  // contextIds are emitted as `ctx_<uuid>`; strip the prefix and keep
  // the first 8 hex chars for display.
  const stripped = id.startsWith("ctx_") ? id.slice(4) : id;
  return stripped.length > 12 ? `${stripped.slice(0, 8)}…` : stripped;
}
