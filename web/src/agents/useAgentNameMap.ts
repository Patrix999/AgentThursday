import { useEffect, useState } from "react";
import { listAgentProfiles } from "../api/agentProfiles";

/**
 *  (UX W3) — id → display-name map for replacing raw
 * `agent-<uuid>` strings across the UI. Fail-soft: an empty map keeps
 * callers rendering the raw id.
 */
export function useAgentNameMap(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    listAgentProfiles()
      .then((rows) => {
        if (cancelled || rows === null) return;
        const m: Record<string, string> = {};
        for (const a of rows) m[a.id] = a.name;
        setNames(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return names;
}
