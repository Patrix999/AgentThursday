import { useEffect, useState } from "react";
import { PageHeader } from "../nav/PageHeader";
import { authHeaders, clearSecret } from "../auth/secret";

/**
 *  — Models catalog page (read-only). Mirrors the
 * `src/modelProfiles.ts` MODEL_PROFILES shape returned by GET
 * /api/models. Aligned with the Agents/Skillsets layout (dark theme,
 * unified PageHeader).
 *
 * v1 is a read-only catalog: it shows which models exist and their
 * tool-call reliability so agent creation isn't a blind pick.
 * Connecting a genuinely new external model needs backend work
 * (getModel / MODEL_PROFILES / bindings) — a follow-up card.
 */
type Capability = "reliable" | "partial" | "risky" | "unsupported" | "unknown";

interface ModelProfile {
  modelId: string;
  provider: string;
  adapter: string;
  capabilities: {
    toolCalls: Capability;
    streamingToolCalls: Capability;
  };
  knownRisks: string[];
  recommendedUse: string[];
  notes?: string;
}

const DEFAULT_MODEL_ID = "@cf/moonshotai/kimi-k2.6";

function capTone(c: Capability): string {
  if (c === "reliable") return "border-emerald-700 text-emerald-300";
  if (c === "partial" || c === "risky") return "border-amber-700 text-amber-300";
  if (c === "unsupported") return "border-rose-800 text-rose-300";
  return "border-slate-700 text-slate-400";
}

export default function ModelsRoute() {
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    //  — /api/models is behind the X-AgentThursday-Secret umbrella;
    // send auth headers and bounce to the secret gate on 401 (same
    // pattern as the agent-runs / workflow-runs api helpers). A bare
    // fetch returned 401 in the browser.
    fetch("/api/models", { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          clearSecret();
          window.dispatchEvent(new Event("agentthursday:unauthorized"));
          return Promise.reject(new Error("unauthorized"));
        }
        return res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`));
      })
      .then((data: ModelProfile[]) => setProfiles(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      <PageHeader title="Models" />

      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        {error !== null && <p className="text-sm text-rose-400">load failed: {error}</p>}
        {profiles === null && error === null && (
          <p className="text-sm text-slate-500">loading…</p>
        )}
        {profiles !== null && (
          <ul className="space-y-3 max-w-3xl">
            {profiles.map((p) => (
              <li key={p.modelId} className="rounded border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-slate-100 break-all">{p.modelId}</span>
                  {p.modelId === DEFAULT_MODEL_ID && (
                    <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-mono text-sky-200">default</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {p.provider} · {p.adapter}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-mono">
                  <span className={`rounded border px-1.5 py-0.5 ${capTone(p.capabilities.toolCalls)}`}>
                    tool calls: {p.capabilities.toolCalls}
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 ${capTone(p.capabilities.streamingToolCalls)}`}>
                    streaming: {p.capabilities.streamingToolCalls}
                  </span>
                </div>
                {p.recommendedUse.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-slate-400 space-y-0.5">
                    {p.recommendedUse.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
                {p.knownRisks.length > 0 && (
                  <p className="mt-2 text-[11px] text-amber-400/80">
                    ⚠ {p.knownRisks.join(" · ")}
                  </p>
                )}
                {p.notes && <p className="mt-1 text-[11px] text-slate-500">{p.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
