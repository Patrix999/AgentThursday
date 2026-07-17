import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authHeaders } from "../auth/secret";
import { listAgentProfiles } from "../api/agentProfiles";

/**
 * an earlier revision (UX W2) — getting-started checklist. Steps check off from
 * live config state so a new operator always sees the next action.
 * Hidden once everything is done.
 */
export function GettingStarted() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [hasAgent, setHasAgent] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/models/credentials", { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHasKey(((d?.credentials ?? []) as unknown[]).length > 0))
      .catch(() => setHasKey(false));
    listAgentProfiles()
      .then((rows) => setHasAgent((rows ?? []).length > 0))
      .catch(() => setHasAgent(false));
  }, []);

  if (hasKey === null || hasAgent === null) return null;
  if (hasKey && hasAgent) return null;

  const steps: Array<{ done: boolean; label: string; to: string; cta: string }> = [
    { done: hasKey, label: "Add a provider API key (or use the built-in Workers AI models)", to: "/settings", cta: "Settings" },
    { done: hasKey, label: "Browse available models", to: "/models", cta: "Models" },
    { done: hasAgent, label: "Create your first cloud agent", to: "/agents/new", cta: "New agent" },
    { done: false, label: "Send it a message from the workspace", to: "/workspace", cta: "Workspace" },
  ];

  return (
    <section className="mb-5 rounded border border-sky-900/60 bg-sky-950/20 p-4">
      <h2 className="text-sm font-semibold text-sky-200">Getting started</h2>
      <ol className="mt-2 space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className={s.done ? "text-emerald-400" : "text-slate-600"}>
              {s.done ? "✓" : "○"}
            </span>
            <span className={s.done ? "text-slate-500 line-through" : "text-slate-300"}>
              {s.label}
            </span>
            {!s.done && (
              <Link to={s.to} className="ml-auto text-xs text-sky-400 hover:underline whitespace-nowrap">
                {s.cta} →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
