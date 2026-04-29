import { useEffect, useState } from "react";
import { getSecret, setSecret, clearSecret, authHeaders } from "./secret";

type GateState =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "needs-secret"; reason: "empty" | "wrong" }
  | { kind: "misconfigured" };

/**
 * SecretGate runs once at app boot and re-runs whenever a request 401s.
 * - 401 → "wrong" prompt (clears stored secret first)
 * - 503 `auth.misconfigured` → "worker auth not configured" message
 *   (the worker is refusing all traffic; user can't fix this from the browser)
 */
export function SecretGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });

  async function probe(silent: boolean) {
    if (!getSecret()) {
      setState({ kind: "needs-secret", reason: "empty" });
      return;
    }
    if (!silent) setState({ kind: "checking" });
    try {
      const res = await fetch("/api/workspace", { headers: authHeaders() });
      if (res.status === 401) {
        clearSecret();
        setState({ kind: "needs-secret", reason: "wrong" });
        return;
      }
      if (res.status === 503) {
        setState({ kind: "misconfigured" });
        return;
      }
      if (res.ok) {
        setState({ kind: "ok" });
        return;
      }
      // Other failures: let downstream show its own error; treat as ok for gate purposes
      setState({ kind: "ok" });
    } catch {
      // Network error — also let the app render and surface it inline
      setState({ kind: "ok" });
    }
  }

  useEffect(() => {
    void probe(false);
    const onUnauthorized = () => void probe(false);
    window.addEventListener("agent-thursday:unauthorized", onUnauthorized);
    return () => window.removeEventListener("agent-thursday:unauthorized", onUnauthorized);
  }, []);

  if (state.kind === "checking") {
    return <FullScreen>Checking auth…</FullScreen>;
  }

  if (state.kind === "misconfigured") {
    return (
      <FullScreen>
        <div className="max-w-md w-full space-y-3 text-center">
          <div className="text-amber-300 text-lg font-semibold">Worker auth not configured</div>
          <p className="text-slate-400 text-sm">
            The worker returned <code className="text-slate-200">503 auth.misconfigured</code>.
            <code className="block mt-2 text-xs">AGENT_THURSDAY_SHARED_SECRET</code> must be set on the
            deployed worker (or <code className="text-xs">AGENT_THURSDAY_ALLOW_INSECURE_DEV=true</code> in
            local <code className="text-xs">.dev.vars</code>). See{" "}
            <code className="text-xs">docs/ops/auth.md</code>.
          </p>
        </div>
      </FullScreen>
    );
  }

  if (state.kind === "needs-secret") {
    return <SecretPrompt reason={state.reason} onSubmit={(s) => { setSecret(s); void probe(true); }} />;
  }

  return <>{children}</>;
}

function SecretPrompt({ reason, onSubmit }: { reason: "empty" | "wrong"; onSubmit: (s: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <FullScreen>
      <form
        className="max-w-sm w-full space-y-3"
        onSubmit={(e) => { e.preventDefault(); if (value) onSubmit(value); }}
      >
        <div className="text-lg font-semibold">AgentThursday workspace</div>
        {reason === "wrong" && (
          <div className="text-rose-400 text-sm">Secret rejected by worker (401). Try again.</div>
        )}
        <label className="block text-sm text-slate-300">Worker secret</label>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-sky-500"
          placeholder="AGENT_THURSDAY_SHARED_SECRET"
        />
        <button
          type="submit"
          disabled={!value}
          className="w-full rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed py-2 font-medium"
        >
          Continue
        </button>
      </form>
    </FullScreen>
  );
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full w-full flex items-center justify-center p-6 text-slate-100">
      {children}
    </div>
  );
}
