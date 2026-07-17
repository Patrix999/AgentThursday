/**
 * M8.9 `getTools()` family extraction step 6 (final): execute
 * family D (`execute`).
 *
 * Per an earlier revision preflight §4 split order this is the sixth and last step
 * — the codemode `execute` tool plus the per-workspace-tool
 * instrumentation that lives inside its IIFE. an earlier revision §6 flagged this
 * as the highest-risk family because three previously-shipped wrappers
 * must travel together byte-equal:
 *
 *   - an earlier revision **inner** wrap — instruments every workspace tool
 *     (`read` / `write` / `list` / `edit` / `glob` / ...) so each inner
 *     call emits `tool.<id>.{dispatch,result,error}`. Without this,
 *     the 187b scan flagged `missingInToolEvents=['write']` because
 *     codemode's outer `tool.execute` was the only event seen.
 *   - an earlier revision **outer** wrap — instruments `execute` itself so its
 *     own success / failure emits `tool.execute.{result,error}`
 *     mirroring the inner pattern. Without this, codemode's
 *     `execute` throw (e.g. Workers Loader sandbox refusing
 *     `require('fs')`) became an AI-SDK tool-error part only, leaving
 *     inspect / RCA blind. Re-throw preserves the AI SDK tool-error
 *     contract that downstream supplierSignal (2a) keys off.
 *   - an earlier revision bundled-modules cast — `DynamicWorkerExecutor`'s TS
 *     signature is narrowed to `Record<string,string>` but at runtime
 *     it forwards the map straight to `loader.get(...).modules`,
 *     which accepts the wider `{ js: string }` Module shape. Cast
 *     through `unknown` to bridge the gap.
 *
 * an earlier revision §3 sketched `ExecutionToolHost = { workspace, env, logEvent,
 * getBundledModules }`. Implementation narrows `env` to the single
 * `loader` (= `env.LOADER`) the IIFE actually uses — passing the full
 * `env` would widen the Host surface unnecessarily.
 *
 * agent-facing `sandbox_exec` tool removed for the M8.3 demo
 * surface. The agent runtime is read/verify only: read/git workspace
 * tools + fixed `gate.build` / `gate.typecheck` via the M8.1 dispatcher.
 * Arbitrary shell (pwd / ls / git clone / find /, /opt/agentthursday/prewarm-*
 * probes) was leaking into demo envelopes and breaking the showcase
 * contract. The admin `/api/sandbox/exec` endpoint in `server.ts` stays
 * — it is auth-gated and not part of the agent's tool surface.
 *
 * Tool name, description, Zod input schema (owned upstream by
 * `createExecuteTool` from `@cloudflare/think`), event names + payload
 * shapes, the bundled-modules cast, the tier-1/tier-2 codePreview
 * logic, and the re-throw-on-error contract are preserved verbatim
 * from `src/server.ts:945-1049` (pre-an earlier revision).
 */

import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";

export interface ExecutionToolHost {
  /**
   * Live agent workspace (an earlier revision auto-spread base). Passed straight
   * into `createWorkspaceTools(...)` — identity preserved.
   */
  workspace: Workspace;
  /**
   * Workers Loader service binding (`env.LOADER`). Narrowed from the
   * full `env` to keep the Host surface minimal; `DynamicWorkerExecutor`
   * is the only consumer.
   */
  loader: Env["LOADER"];
  /**
   * Lazy getter for `_bundledModules` (an earlier revision Module-object form
   * `{ js: string }`). The field can be `null` before
   * `_initBundledModules()` resolves; the getter is invoked once
   * at executor-construction time (for the `modules` option) and
   * again per `execute` call (for the tier-1/tier-2 decision).
   * Inline behavior `(this._bundledModules ?? undefined)` is
   * preserved — getter returns `null`, mapped to `undefined` at the
   * cast site.
   */
  getBundledModules: () => Record<string, { js: string }> | null;
  logEvent: (type: string, payload: unknown) => void;
}

export function buildExecutionTool(host: ExecutionToolHost) {
  const { workspace, loader, getBundledModules, logEvent } = host;
  // instrument the legacy workspace tool surface so
  // each inner read/write/list/edit/glob emits a `tool.<id>.{dispatch
  // |result|error}` row into event_log. These tools are called from
  // INSIDE codemode (`execute`), so without this wrapper the outer
  // `tool.execute` event was the only thing toolEvents saw and the
  // 187b scan flagged `missingInToolEvents=['write']`.
  //
  // Payload is summary-only: path + content_bytes (size, NOT
  // content), input keys, error reason. No file contents or
  // secrets ever leave this scope.
  const rawWorkspaceTools = createWorkspaceTools(workspace);
  const summarizeInput = (toolName: string, input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object") return { tool: toolName };
    const i = input as Record<string, unknown>;
    const out: Record<string, unknown> = { tool: toolName };
    if (typeof i.path === "string") out.path = i.path;
    if (typeof i.dir === "string") out.dir = i.dir;
    if (typeof i.pattern === "string") out.pattern = i.pattern;
    if (typeof i.content === "string") out.content_bytes = i.content.length;
    if (typeof i.text === "string") out.text_bytes = i.text.length;
    return out;
  };
  const summarizeError = (e: unknown): { reason: string; message_snippet: string } => {
    const msg = e instanceof Error ? e.message : String(e);
    return { reason: "workspace_tool_error", message_snippet: msg.slice(0, 200) };
  };
  const instrumented: Record<string, unknown> = {};
  for (const [toolName, raw] of Object.entries(rawWorkspaceTools as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      instrumented[toolName] = raw;
      continue;
    }
    // Most tool() outputs from the AI SDK expose an `execute` method
    // we can wrap. If a tool doesn't, pass it through unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawTool = raw as any;
    if (typeof rawTool.execute !== "function") {
      instrumented[toolName] = rawTool;
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedExecute = async (input: any, opts: any) => {
      logEvent(`tool.${toolName}.dispatch`, summarizeInput(toolName, input));
      try {
        const result = await rawTool.execute(input, opts);
        logEvent(`tool.${toolName}.result`, { tool: toolName, ok: true });
        return result;
      } catch (e) {
        logEvent(`tool.${toolName}.error`, summarizeError(e));
        throw e;
      }
    };
    instrumented[toolName] = { ...rawTool, execute: wrappedExecute };
  }
  const base = createExecuteTool({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: instrumented as any,
    executor: new DynamicWorkerExecutor({
      loader,
      // an earlier revision: bundledModules uses Module-object form `{ js: ... }`
      // (the explicit-type form Workers Loader requires for keys without
      // `.js`/`.py` extension). DynamicWorkerExecutor's TS signature is
      // narrowed to `Record<string,string>`, but at runtime it forwards
      // the map straight to `loader.get(...).modules`, which accepts the
      // wider Module shape. Cast through unknown to bridge the gap.
      modules: (getBundledModules() ?? undefined) as unknown as Record<string, string> | undefined,
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execute = { ...base, execute: async (input: any, opts: any) => {
    const bundled = getBundledModules();
    const tier = (bundled && Object.keys(bundled).length > 0) ? 2 : 1;
    // an earlier revision Track B-3 — capped code preview for trace analysis.
    // CodeInput shape is `{ code: string }` per `@cloudflare/codemode/shared`.
    const codePreview = typeof input?.code === "string" ? (input.code as string).slice(0, 200) : null;
    logEvent("tool.execute", {
      tier,
      reason: tier === 2 ? "codemode + bundled npm deps" : "codemode JS/TS",
      codePreview,
    });
    // an earlier revision (2b) — emit structured .result / .error events
    // mirroring the workspace-tool `instrumented` pattern above.
    // Without this, codemode's `execute` throw (e.g. Workers Loader
    // sandbox refusing Node-only APIs like `require('fs')` /
    // `child_process.execSync`) becomes an AI-SDK `tool-error` part
    // only; the event stream has a `tool.execute` entry and no
    // follow-up, leaving inspect / RCA blind to whether the call
    // succeeded, failed, or never ran. Re-throw on error to preserve
    // the AI SDK tool-error contract that downstream supplierSignal
    // (2a) keys off.
    try {
      const result = await base.execute!(input, opts);
      logEvent("tool.execute.result", { tool: "execute", ok: true });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent("tool.execute.error", {
        tool: "execute",
        reason: "execute_threw",
        message_snippet: msg.slice(0, 200),
      });
      throw e;
    }
  } };
  return { execute };
}
