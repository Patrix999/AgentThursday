//  — first  extraction.
// `AgentThursdayAgent.codemodeProbe` previously lived inline in `src/server.ts`.
// The free function below holds the verbatim body; `AgentThursdayAgent.codemodeProbe`
// is now a thin delegate that constructs a minimal host shim and calls
// `runCodemodeProbe(host)`. The only deviation from a pure `this.foo` →
// `host.foo` rewrite is that `new DynamicWorkerExecutor(...)` was changed
// to `await import("@cloudflare/codemode")` inside the existing try-block:
// the module imports `cloudflare:workers`, which tsx cannot resolve, so a
// module-top static import would make this file unloadable in the
// in-memory FakeHost smoke. The dynamic import preserves the function's
// I/O contract — failures still funnel into the same catch block — and
// only shifts DWE module-load timing from worker-init to first probe call.

import type { DynamicWorkerExecutor as DynamicWorkerExecutorType } from "@cloudflare/codemode";

type DynamicWorkerExecutorOptions = ConstructorParameters<typeof DynamicWorkerExecutorType>[0];

export interface CodemodeProbeResult {
  ok: boolean;
  toolsRegistered: string[];
  executeRegistered: boolean;
  executeProbeResult?: { result: unknown; error?: string; logs?: string[] };
  timestamp: number;
  durationMs: number;
}

export interface CodemodeProbeHost {
  readonly env: { LOADER: DynamicWorkerExecutorOptions["loader"] };
  readonly _bundledModules: Record<string, { js: string }> | null;
  getTools(): Record<string, unknown>;
  logEvent(type: string, payload: Record<string, unknown>): void;
}

export async function runCodemodeProbe(host: CodemodeProbeHost): Promise<CodemodeProbeResult> {
  const start = Date.now();
  const tools = host.getTools();
  const toolsRegistered = Object.keys(tools);
  const executeRegistered = "execute" in tools;
  let probeResult: { result: unknown; error?: string; logs?: string[] } | undefined;
  if (executeRegistered) {
    try {
      const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
      const executor = new DynamicWorkerExecutor({
        loader: host.env.LOADER,
        modules: (host._bundledModules ?? undefined) as unknown as Record<string, string> | undefined,
      });
      const r = await executor.execute("return 1 + 1", []);
      probeResult = { result: r.result, error: r.error, logs: r.logs };
    } catch (e) {
      const err = e instanceof Error
        ? `${e.name}: ${e.message}\n${(e.stack ?? "").slice(0, 800)}`
        : String(e).slice(0, 800);
      probeResult = { result: undefined, error: err };
    }
  }
  const durationMs = Date.now() - start;
  const ok = executeRegistered && !!probeResult && !probeResult.error && probeResult.result === 2;
  host.logEvent("tool.health.probe", {
    tool: "execute",
    ok,
    executeRegistered,
    errorPreview: probeResult?.error?.slice(0, 200) ?? null,
    durationMs,
  });
  return {
    ok,
    toolsRegistered,
    executeRegistered,
    executeProbeResult: probeResult,
    timestamp: start,
    durationMs,
  };
}
