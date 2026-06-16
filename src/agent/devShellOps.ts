/**
 * devShellOps — dev-shell read + gate + write dispatch free functions.
 *
 *  extracts the dev-shell read/gate surfaces from
 * `src/server.ts` per  preflight §2 (two-module split:
 * `devShellOps.ts` for read/gate/write, `envelopeOps.ts` for
 * envelope store/finalize/sweeper/CRUD).
 *
 *  (first wave) moved five read+gate surfaces.
 * adds the write dispatcher:
 *
 *   - `devShellDispatchFree`           — /184a read dispatcher
 *   - `devShellObservabilityCheckFree` — /187a observability inspector
 *   - `devShellGateRunFree`            —  gate runner (sync; DO agent path)
 *   - `startGateJobFree`               —  async gate kickoff (returns {job_id})
 *   - `getGateJobStatusFree`           —  trace-id keyed job polling
 *   - `devShellWriteDispatchFree`      — /193/212f write dispatcher ()
 *
 * Envelope store/finalize/sweeper/CRUD is deferred to Cards 291/292/294.
 *
 * Host shape:
 *
 *   - `sql`        — DO storage SQL tag (used by observability/getGateJobStatus)
 *   - `env`        — Worker env (used to look up `Sandbox` DO + repo env vars)
 *   - `workspace`  — `readFile` / `glob` from agents-SDK workspace (used by dispatch)
 *   - `logEvent`   — emit into `event_log`; threads `trace_id` through
 *   - `waitUntil`  — `ctx.waitUntil` bound method; lets `startGateJobFree`
 *                    fire bg gate work without binding to HTTP response.
 *
 * `startGateJobFree` calls `devShellGateRunFree(host, …)` directly
 * (NOT a server method) so the free functions don't re-enter the
 * agent surface — preserves  async-start invariant without
 * forming a runtime cycle.
 *
 * Behavior contract ( spec §"必须保持的行为契约"):
 *
 *   - callable names/signatures, route paths, event names, payload
 *     keys, error reason strings unchanged.
 *   - `startGateJobFree` mints fresh `gate-${crypto.randomUUID()}`;
 *     caller cannot inject job_id / trace_id.
 *   - `event_log.trace_id = job_id` remains the index.
 *   - `TYPECHECK_PHASES` is not touched here; root timeout not bumped.
 *   - `devShellGateRunFree` sync semantics preserved for DO-internal
 *     callers (agent tool dispatch via  auto-gate); only the
 *     HTTP route uses the async-start path through `startGateJobFree`.
 */

import { getSandbox } from "@cloudflare/sandbox";

import { dispatchReadTool } from "../skillset/devShell";
import { runGate } from "../skillset/gateRunner";
import { ensureRepoCheckout } from "../skillset/repoMaterialization";
import {
  computeToolEventsGap,
  extractTraceToolCallNames,
} from "../skillset/observabilityCheck";
import { auditConversationSearchUsage } from "../skillset/conversationSearchTrigger";
import { dispatchWriteTool, makeSandboxWriteBackend } from "../skillset/devShellWrite";
import type {
  ApprovalConsumeResult,
  WorkspaceWriteBackend,
} from "../skillset/devShellWrite";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";

import type { EventLogRow } from "./agentConstants";

export type DevShellOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/**
 * Narrow workspace shape consumed by `devShellDispatchFree`. The
 * agents-SDK workspace has more methods; only `readFile` and `glob`
 * are surfaced here so the Host can be satisfied without leaking the
 * full Agent surface.
 */
export interface DevShellOpsWorkspace {
  readFile: (path: string) => Promise<string | null>;
  glob: (pattern: string) => Promise<Array<{ path: string }>>;
}

export interface DevShellOpsHost {
  sql: DevShellOpsSqlTag;
  env: Env;
  workspace: DevShellOpsWorkspace;
  logEvent: (type: string, payload: unknown, traceId?: string | null) => void;
  /**
   * `ctx.waitUntil` bound method. The Host does not surface the
   * full `DurableObjectState`; only this narrow capability is
   * needed by `startGateJobFree` to fire-and-forget background gate
   * work without blocking the HTTP response ( invariant —
   * decouples production gate runs from Cloudflare's ~90s sync HTTP
   * envelope, CF error 1101).
   */
  waitUntil: (promise: Promise<unknown>) => void;
}

function makeSandboxExec(env: Env) {
  return async (command: string) => {
    const sb = getSandbox(env.Sandbox, "agentthursday-dev-shell");
    const r = await sb.exec(command);
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      exit_code: typeof r.exitCode === "number" ? r.exitCode : 0,
    };
  };
}

async function materializeRepoForDispatch(
  host: DevShellOpsHost,
  sandboxExec: ReturnType<typeof makeSandboxExec>,
  traceId: string | null,
): Promise<string | undefined> {
  try {
    const checkout = await ensureRepoCheckout(
      sandboxExec,
      host.env as unknown as { AGENT_THURSDAY_REPO_URL?: string; AGENT_THURSDAY_GIT_TOKEN?: string; GITHUB_TOKEN?: string },
    );
    if (!checkout.error) {
      host.logEvent("repo.materialization", {
        baseDir: checkout.baseDir,
        existed: checkout.existed,
        head_sha: checkout.head_sha,
        source_url_redacted: checkout.source_url_redacted,
        token_source: checkout.token_source,
      }, traceId);
      return checkout.baseDir;
    }
    host.logEvent("repo.materialization.error", {
      baseDir: checkout.baseDir,
      source_url_redacted: checkout.source_url_redacted,
      token_source: checkout.token_source,
      error_snippet: checkout.error,
    }, traceId);
    return undefined;
  } catch (e) {
    host.logEvent("repo.materialization.error", {
      error_snippet: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    }, traceId);
    return undefined;
  }
}

/**
 * /184a — read-only dev-shell dispatcher. Validates input,
 * materializes the repo into the dev-shell sandbox (idempotent), and
 * runs `dispatchReadTool` with workspace + sandbox backends wired in.
 * Returns the structured `DispatchResult` unchanged so callers can
 * inspect output / error / backend ('real' vs 'stub').
 */
export async function devShellDispatchFree(
  host: DevShellOpsHost,
  input: { tool_id: string; input: Record<string, unknown>; traceId?: string | null },
): Promise<unknown> {
  const traceId = input.traceId ?? null;
  const sandboxExec = makeSandboxExec(host.env);
  const repoBaseDir = await materializeRepoForDispatch(host, sandboxExec, traceId);
  return dispatchReadTool(input.tool_id, input.input ?? {}, {
    emit: (ev) => host.logEvent(ev.type, ev.payload, traceId),
    traceId,
    workspace: {
      readFile: async (p: string) => host.workspace.readFile(p),
      glob: async (pattern: string) => {
        const entries = await host.workspace.glob(pattern);
        return entries.map((e: { path: string }) => e.path.replace(/^\/+/, ""));
      },
    },
    sandboxExec,
    repoBaseDir,
  });
}

/**
 * /187a — toolEvents observability + conversation_search
 * trigger audit. Read-only inspector: pulls recent toolEvents and the
 * latest `supplier.signal.summary` (cross-check source per 178 §6.2),
 * computes the gap report, and optionally audits a query for
 * conversation_search trigger reliability.
 */
export function devShellObservabilityCheckFree(
  host: DevShellOpsHost,
  input?: { query?: string },
): unknown {
  const toolEventRows = host.sql<{ event_type: string }>`
    SELECT event_type FROM event_log
    WHERE event_type LIKE 'tool.%'
    ORDER BY created_at DESC LIMIT 200
  `;
  const toolEvents = toolEventRows.map(r => ({ toolName: r.event_type }));

  const supplierRows = host.sql<{ payload: string; created_at: number }>`
    SELECT payload, created_at FROM event_log
    WHERE event_type = 'supplier.signal.summary'
    ORDER BY created_at DESC LIMIT 50
  `;
  let traceToolNames: string[] = [];
  let latestSupplierAt: number | null = null;
  let latestSupplierTaskId: string | null = null;
  for (const r of supplierRows) {
    try {
      const p = JSON.parse(r.payload) as { taskId?: string };
      if (latestSupplierAt === null) {
        latestSupplierAt = r.created_at;
        latestSupplierTaskId = typeof p.taskId === "string" ? p.taskId : null;
        traceToolNames = extractTraceToolCallNames(p);
        break;
      }
    } catch { /* skip */ }
  }

  const gap = computeToolEventsGap(toolEvents, traceToolNames);

  let conversationSearchAudit: ReturnType<typeof auditConversationSearchUsage> | null = null;
  if (input?.query) {
    conversationSearchAudit = auditConversationSearchUsage({
      query: input.query,
      toolEventsToolNames: toolEvents.map(e => e.toolName),
    });
  }

  return {
    latest_supplier_signal: {
      task_id: latestSupplierTaskId,
      at: latestSupplierAt,
    },
    tool_events_gap: gap,
    conversation_search_audit: conversationSearchAudit,
    warning: gap.gapDetected ? "toolEvents_gap" : null,
  };
}

/**
 *  — gate runner. Runs an allowlisted gate (typecheck /
 * build / test / dry_run) via the agentthursday-dev-shell sandbox container.
 * Emits dispatch + result/error events through `logEvent` so
 * toolEvents has the gate trace. Returns the structured `GateResult`;
 * callers (e.g. envelope wiring) fold the result into evidence.
 *
 * Sync semantics. The DO-internal  auto-gate path calls this
 * directly during a task turn (within the DO request envelope, not
 * subject to CF 1101). For HTTP, the route uses `startGateJobFree`
 * which kicks off `devShellGateRunFree` under `waitUntil` so the
 * response is detached from gate duration.
 */
export async function devShellGateRunFree(
  host: DevShellOpsHost,
  input: { target: string; traceId?: string | null },
): Promise<unknown> {
  const traceId = input.traceId ?? null;
  const sandboxExec = makeSandboxExec(host.env);
  const repoBaseDir = await materializeRepoForDispatch(host, sandboxExec, traceId);
  return runGate(input.target, {
    emit: (ev) => host.logEvent(ev.type, ev.payload, traceId),
    traceId,
    sandboxExec,
    repoBaseDir,
  });
}

/**
 *  — async gate job entry. Returns `{ job_id }` immediately;
 * the actual gate work runs in the background via the Host's
 * `waitUntil` so the HTTP response is not bound to gate duration.
 * Required because production `gate_typecheck` root phase exceeds
 * Cloudflare's ~90s synchronous HTTP envelope (CF error 1101) even
 * though the 600s phase budget is sized correctly.
 *
 * `job_id` is freshly minted (caller cannot inject) and is used as
 * the `trace_id` for every event emitted by `devShellGateRunFree`
 * on this run, so `getGateJobStatusFree({ job_id })` can scan
 * `event_log` by `trace_id` and surface phase progress + the
 * eventual aggregate `tool.gate_<target>.result` row.
 *
 * Internally calls `devShellGateRunFree(host, …)` directly so the
 * free function does not re-enter the agent surface — preserves the
 *  §"free fn 内部不要回调 server method 形成循环" constraint.
 */
export function startGateJobFree(
  host: DevShellOpsHost,
  input: { target: string },
): { job_id: string; target: string; status: "started"; started_at: number } {
  const target = typeof input?.target === "string" ? input.target : "";
  const jobId = `gate-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  host.logEvent("gate.job.started", { job_id: jobId, target, started_at: startedAt }, jobId);
  const bgWork = (async () => {
    try {
      const result = await devShellGateRunFree(host, { target, traceId: jobId }) as {
        ok?: boolean;
        exit_code?: number;
        timed_out?: boolean;
        failed_reason?: string;
      };
      host.logEvent("gate.job.finished", {
        job_id: jobId,
        target,
        ok: result?.ok ?? null,
        exit_code: result?.exit_code ?? null,
        timed_out: result?.timed_out ?? null,
        failed_reason: result?.failed_reason ?? null,
        duration_ms: Date.now() - startedAt,
      }, jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.logEvent("gate.job.error", {
        job_id: jobId,
        target,
        error_snippet: msg.slice(0, 500),
        duration_ms: Date.now() - startedAt,
      }, jobId);
    }
  })();
  host.waitUntil(bgWork);
  return { job_id: jobId, target, status: "started", started_at: startedAt };
}

/**
 *  — poll an async gate job. Reads every `event_log` row
 * whose `trace_id` matches the supplied `job_id` and derives a
 * coarse status from the bracketing `gate.job.started` /
 * `gate.job.finished` / `gate.job.error` events.
 *
 * Returns up to 200 events, oldest-first so callers can iterate
 * phase_started/phase_finished in order. Each payload is JSON-parsed
 * when possible; raw string otherwise (matches `getInspectSnapshot`).
 *
 * The `substr(payload, 1, 4000)` cap is preserved from the original
 * implementation — large aggregate `tool.gate_<target>.result` rows
 * may surface as raw string when truncated mid-JSON.
 * verifier doc notes this as a known follow-up for harness needs
 * full aggregate payload; phase rows + `gate.job.finished` bracket
 * row provide sufficient durable evidence for status/exit/timeout.
 */
export function getGateJobStatusFree(
  host: DevShellOpsHost,
  input: { job_id: string },
): {
  job_id: string;
  status: "in_progress" | "done" | "error" | "unknown";
  events: Array<{ event_type: string; payload: unknown; created_at: number }>;
} {
  const jobId = typeof input?.job_id === "string" ? input.job_id : "";
  if (!jobId) {
    return { job_id: "", status: "unknown", events: [] };
  }
  const rows = host.sql<EventLogRow>`
    SELECT event_type, substr(payload, 1, 4000) AS payload, created_at, trace_id FROM event_log
    WHERE trace_id = ${jobId}
    ORDER BY created_at ASC LIMIT 200
  `;
  const events = rows.map(r => {
    let payload: unknown = r.payload;
    try { payload = JSON.parse(r.payload); } catch { /* keep raw */ }
    return { event_type: r.event_type, payload, created_at: r.created_at };
  });
  let status: "in_progress" | "done" | "error" | "unknown" = "in_progress";
  if (events.length === 0) {
    status = "unknown";
  } else {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event_type === "gate.job.finished") { status = "done"; break; }
      if (events[i].event_type === "gate.job.error") { status = "error"; break; }
    }
  }
  return { job_id: jobId, status, events };
}

// ──  — write dispatcher ──────────────────────────────────────
//
// Write-side surface for `devShellWriteDispatch`. Narrow Host: only the
// capabilities the dispatcher actually needs. Cross-DO callbacks
// (`consumeApproval` → ChannelHubAgent) stay at the composition root in
// `src/server.ts` and are surfaced here as lambdas so this module does
// not import ChannelHub / agentNamespace specifics.
//
// Behavior contract ( §"必须保持的行为契约"):
//
//   - supported write tool ids unchanged (`repo.write`, `repo.patch`,
//     `repo.delete`) — enforced inside `dispatchWriteTool`.
//   - manifest path policy: read software-dev `safety_policy.path_allowlist` /
//     `path_denylist` exactly as before; no broadening.
//   - sandbox → DO scratch fallback unchanged: try `ensureRepoCheckout`,
//     on success build `makeSandboxWriteBackend` against the sandbox FS
//     and emit `repo.materialization`; on failure/exception fall back
//     to the Host's scratch workspace and emit `repo.materialization.error`.
//   - `dev_shell.write.backend` event emitted byte-equal after backend
//     selection.
//   - approval normalization unchanged: only string `token_id` + string
//     `token` pairs flow through; non-string shapes are dropped to
//     `undefined`, which makes tier-≥4 dispatch return `approval_required`
//     via the dispatcher's fail-closed path.
//   - error reason strings unchanged: all reason strings live inside
//     `dispatchWriteTool` and are not touched here.

export interface DevShellWriteWorkspace {
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
}

export interface DevShellWriteHost {
  env: Env;
  /**
   * Caller agent id, passed through to `dispatchWriteTool` so the
   * approval-consume callback can bind verify against the same agent
   * that presented the token.
   */
  agentId: string;
  /**
   * DO scratch workspace used as fallback when repo materialization
   * fails. Mirrors the agents-SDK Agent workspace methods byte-equal;
   * no globbing surface is exposed because write dispatch never globs.
   */
  workspace: DevShellWriteWorkspace;
  logEvent: (type: string, payload: unknown, traceId?: string | null) => void;
  /**
   * Cross-DO approval consume callback. Host wires this to
   * `ChannelHubAgent.consumeApprovalToken` in the composition root so
   * this module stays free of ChannelHub imports. Receives the
   * dispatcher-canonical `input_hash` — NEVER receives raw input.
   */
  consumeApproval: (req: {
    token_id: string;
    token: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
  }) => Promise<ApprovalConsumeResult>;
  /**
   *  B — gate set by a successful `repo.prepare`. When this
   * returns `false`, the write dispatcher short-circuits with
   * `no_prepared_worktree` instead of attempting `ensureRepoCheckout`,
   * so agents cannot blind-write into an empty Tier-0 scratch
   * workspace. Optional for backward compatibility with hosts that
   * predate .
   */
  isRepoPrepared?: () => boolean;
}

/**
 * /193/212f — Developer Shell write dispatcher.
 *
 *  routes writes into the production sandbox checkout so
 * `repo.read` / `gate.*` see the patched files in the same workspace.
 *  layers approval-token consumption for tier-≥4 tools.
 *
 * Same event routing as `devShellDispatchFree` (logEvent → event_log →
 * toolEvents). Manifest path policy comes from the embedded software-dev
 * manifest so the dispatcher can enforce both the global denylist and
 * the manifest-level allow/deny lists.
 */
export async function devShellWriteDispatchFree(
  host: DevShellWriteHost,
  input: {
    tool_id: string;
    input: Record<string, unknown>;
    traceId?: string | null;
    approval?: { token_id?: unknown; token?: unknown };
  },
): Promise<unknown> {
  const traceId = input.traceId ?? null;
  const env = host.env;
  const swdev = EMBEDDED_MANIFESTS.find(m => m.id === "software-dev")?.manifest;
  const safety = swdev?.safety_policy;
  const manifestPolicy = {
    allowlist: Array.isArray(safety?.path_allowlist) ? safety.path_allowlist : [],
    denylist: Array.isArray(safety?.path_denylist) ? safety.path_denylist : [],
  };

  //  B — `no prepared worktree` gate. Reject repo.write /
  // repo.patch / repo.delete BEFORE any approval consume or
  // ensureRepoCheckout. The gate is opt-in via `host.isRepoPrepared`
  // so legacy /api/dev-shell admin endpoints that bypass the agent
  // runtime keep working unchanged.
  if (host.isRepoPrepared && !host.isRepoPrepared()) {
    host.logEvent("tool." + input.tool_id + ".error", {
      reason: "no_prepared_worktree",
      details: "no prepared worktree; call repo.prepare first",
      tool_id: input.tool_id,
      worktree_path: null,
    }, traceId);
    return {
      ok: false,
      tool_id: input.tool_id,
      error: {
        reason: "no_prepared_worktree",
        details: "no prepared worktree; call repo.prepare first",
      },
      duration_ms: 0,
      contract: { tier: 3, emit_events: [], required_evidence: [] },
      backend: "stub" as const,
      worktree_path: null,
    };
  }

  let writeBackend: WorkspaceWriteBackend;
  let backendKind: "sandbox" | "workspace_scratch_fallback" = "workspace_scratch_fallback";
  let worktreePath: string | null = null;

  const sandboxExec = makeSandboxExec(env);

  try {
    const checkout = await ensureRepoCheckout(
      sandboxExec,
      env as unknown as { AGENT_THURSDAY_REPO_URL?: string; AGENT_THURSDAY_GIT_TOKEN?: string; GITHUB_TOKEN?: string },
    );
    if (!checkout.error && checkout.baseDir) {
      const sb = getSandbox(env.Sandbox, "agentthursday-dev-shell");
      writeBackend = makeSandboxWriteBackend(
        {
          readFile: async (p: string) => sb.readFile(p),
          writeFile: async (p: string, content: string) => sb.writeFile(p, content),
          deleteFile: async (p: string) => sb.deleteFile(p),
          mkdir: async (p: string, opts?: { recursive?: boolean }) => sb.mkdir(p, opts),
        },
        checkout.baseDir,
      );
      backendKind = "sandbox";
      worktreePath = checkout.baseDir;
      host.logEvent("repo.materialization", {
        baseDir: checkout.baseDir,
        existed: checkout.existed,
        head_sha: checkout.head_sha,
        source_url_redacted: checkout.source_url_redacted,
        token_source: checkout.token_source,
        consumer: "dev_shell_write",
      }, traceId);
    } else {
      const ws = host.workspace;
      writeBackend = {
        readFile: async (p: string) => ws.readFile(p),
        writeFile: async (p: string, content: string) => { await ws.writeFile(p, content); },
        deleteFile: async (p: string) => { await ws.deleteFile(p); },
      };
      host.logEvent("repo.materialization.error", {
        baseDir: checkout.baseDir,
        source_url_redacted: checkout.source_url_redacted,
        token_source: checkout.token_source,
        error_snippet: checkout.error,
        consumer: "dev_shell_write",
      }, traceId);
    }
  } catch (e) {
    const ws = host.workspace;
    writeBackend = {
      readFile: async (p: string) => ws.readFile(p),
      writeFile: async (p: string, content: string) => { await ws.writeFile(p, content); },
      deleteFile: async (p: string) => { await ws.deleteFile(p); },
    };
    host.logEvent("repo.materialization.error", {
      error_snippet: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      consumer: "dev_shell_write",
    }, traceId);
  }

  host.logEvent("dev_shell.write.backend", {
    kind: backendKind,
    tool_id: input.tool_id,
  }, traceId);

  let approvalArg: { token_id: string; token: string } | undefined;
  if (input.approval && typeof input.approval === "object") {
    const t = input.approval as { token_id?: unknown; token?: unknown };
    if (typeof t.token_id === "string" && typeof t.token === "string") {
      approvalArg = { token_id: t.token_id, token: t.token };
    }
  }

  return dispatchWriteTool(input.tool_id, input.input ?? {}, {
    emit: (ev) => host.logEvent(ev.type, ev.payload, traceId),
    traceId,
    workspace: writeBackend,
    manifestPolicy,
    approval: approvalArg,
    agentId: host.agentId,
    consumeApproval: host.consumeApproval,
    worktreePath,
  });
}
