/**
 * Agent Tool Surface Integration Skeleton.
 * extends 188/194 wiring so agent-facing tool calls
 * record into the current turn's evidence envelope (execution[] for
 * read-side; execution[] + gate_logs for gate-side). Adds two demo
 * tools: `git_log` and `gate_build`.
 *
 * Read / verify only. Write / commit / push / deploy stay locked.
 */

import { tool } from "ai";
import { z } from "zod";
import { dispatchReadTool } from "./devShell";
import { runGate } from "./gateRunner";
import type { DispatchEvent, DispatchResult, WorkspaceReadBackend, SandboxExec } from "./devShell";
import type { GateResult } from "./gateRunner";
import type { EnvelopeStore } from "./evidenceEnvelope";

export interface AgentToolBindingContext {
  emit(event: DispatchEvent): void;
  workspace: WorkspaceReadBackend;
  sandboxExec: SandboxExec;
  /**
   * 196 — lazy lookup of the envelope store. Captured as a getter so
   * wrappers always read the latest `_envelopeStoreCache` rather than
   * the value at `_buildM81AgentSafeReadTools()` call time. Returning
   * undefined means the store is not yet initialized; recording
   * helpers fail-soft to a no-op.
   */
  getEnvelopeStore?: () => EnvelopeStore | undefined;
  /**
   * 189: lazy repo materialization. Called before each repo.* /
   * git.* / gate.* tool invocation; returns the checkout dir or
   * undefined if materialization failed (in which case the tool
   * falls back to its bare-cwd behavior, which surfaces honest
   * "no repo" evidence).
   */
  ensureRepoBaseDir?: () => Promise<string | undefined>;
  /**
   * 196: returns the envelope id of the current agent turn (or null
   * when the runtime did not create one — e.g. paused / errored).
   * Tool wrappers record `execution[]` entries into this envelope.
   */
  getCurrentEnvelopeId?: () => string | null;
  /**
   * 196: notifies the runtime that a tool wrapper actually fired in
   * this turn so seal() can use the wrapped set as `claimed_tools`,
   * keeping fabricated_tools=[] without depending on text extraction.
   */
  recordWrappedToolId?: (toolId: string) => void;
  /**
   * 196a: fail-soft diagnostic hook fired when envelope recording is
   * skipped (no envelope id, store missing, or addExecution returned
   * null). Lets the runtime emit a log event so silent gaps surface.
   */
  onRecordSkipped?: (info: { envelopeId: string | null; toolId: string; reason: string }) => void;
  /**
   *  B — invoked when `repo.prepare` succeeds. Flips the
   * agent's "prepared" flag so the write dispatcher
   * (`devShellWriteDispatchFree`) lets repo.write / repo.patch /
   * repo.delete through instead of returning `no_prepared_worktree`.
   */
  markRepoPrepared?: (info: { worktree_path: string; head_sha: string }) => void;
  /**
   *  B — agent-side write dispatch entry point. Wraps the DO's
   * `devShellWriteDispatch` callable so the wrappers below can route
   * repo.write / repo.patch through the same pipeline as the admin
   * `/api/dev-shell` route, including the `no_prepared_worktree` gate,
   * manifest path allow/deny, and approval-token consumption.
   *
   * Returns the dispatcher's raw result (compatible with
   * `WriteDispatchResult` shape: ok / tool_id / output / error /
   * duration_ms / backend / diff). The wrapper records execution into
   * the current envelope via `recordReadExecution` (write-side gate
   * checks land in `evidenceEnvelope.seal()` via  C).
   */
  dispatchWriteTool?: (input: {
    tool_id: string;
    input: Record<string, unknown>;
    traceId?: string | null;
    approval?: { token_id?: unknown; token?: unknown };
  }) => Promise<unknown>;
}

const M8_1 = "[ Developer Shell]";

const READ_INPUT_SUMMARY_CAP = 512;
const READ_OUTPUT_SUMMARY_CAP = 256;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function summarizeOutput(output: unknown): { summary: string; truncated: boolean } {
  try {
    const s = JSON.stringify(output ?? null);
    if (s.length > READ_OUTPUT_SUMMARY_CAP) {
      return { summary: `${s.slice(0, READ_OUTPUT_SUMMARY_CAP)}…`, truncated: true };
    }
    return { summary: s, truncated: false };
  } catch {
    return { summary: "<unserializable>", truncated: true };
  }
}

/**
 * 196 — record a read-side tool dispatch into the current envelope's
 * execution[]. Fail-soft: any error here must not break the tool call.
 */
async function recordReadExecution(
  ctx: AgentToolBindingContext,
  result: DispatchResult,
  rawInput: Record<string, unknown>,
  dispatchedAtIso: string,
  duration_ms: number,
): Promise<void> {
  try {
    const envelopeId = ctx.getCurrentEnvelopeId?.() ?? null;
    const store = ctx.getEnvelopeStore?.();
    if (!envelopeId || !store) {
      ctx.onRecordSkipped?.({
        envelopeId,
        toolId: result.tool_id,
        reason: !envelopeId ? "no_envelope_id" : "no_envelope_store",
      });
      return;
    }
    const inputJson = JSON.stringify(rawInput ?? {});
    const hash = await sha256Hex(inputJson);
    const inputSummary = inputJson.length > READ_INPUT_SUMMARY_CAP
      ? `${inputJson.slice(0, READ_INPUT_SUMMARY_CAP)}…[truncated]`
      : inputJson;
    const outputSummary = summarizeOutput(result.output);
    const exec = store.addExecution(envelopeId, {
      tool_call: {
        tool_id: result.tool_id,
        input_hash: hash,
        input_summary: inputSummary,
        dispatched_at: dispatchedAtIso,
      },
      tool_result: {
        status: result.ok ? "ok" : "error",
        output: outputSummary,
        error: result.error
          ? {
              reason: result.error.reason,
              retriable: false,
              details: result.error.details ? result.error.details.slice(0, 256) : undefined,
            }
          : undefined,
        finished_at: new Date().toISOString(),
        duration_ms,
      },
    });
    if (exec) {
      // 196a — only mark the tool as "claimed" once the envelope
      // accepted it into execution[]. Otherwise a no-op addExecution
      // (sealed envelope, missing draft) would leak claimed without
      // evidenced and re-trigger the fabricated_tools mismatch.
      ctx.recordWrappedToolId?.(result.tool_id);
    } else {
      ctx.onRecordSkipped?.({
        envelopeId,
        toolId: result.tool_id,
        reason: "add_execution_null",
      });
    }
  } catch {
    // fail-soft: never break tool execution on envelope wiring errors.
  }
}

/**
 *  — narrow recording context. Lets `recordGateExecution`
 * be called from sites that don't construct a full
 * `AgentToolBindingContext` (e.g. the pre-finalize positive
 * gate-intent dispatch guard in server.ts). `AgentToolBindingContext`
 * is a structural superset, so existing tool-wrapper callers continue
 * to satisfy this signature without change.
 */
export interface GateExecutionRecordingTarget {
  getCurrentEnvelopeId?: () => string | null;
  getEnvelopeStore?: () => EnvelopeStore | undefined;
  recordWrappedToolId?: (toolId: string) => void;
  onRecordSkipped?: (info: { envelopeId: string | null; toolId: string; reason: string }) => void;
}

/**
 * 196 — record a gate-side tool run into the current envelope's
 * execution[] and append gate_logs evidence. Fail-soft.
 *
 * 207c — exported and accepts a narrowed `GateExecutionRecordingTarget`
 * so the pre-finalize guard can persist auto-dispatched gate evidence
 * via the same path the agent tool wrappers use.
 */
export async function recordGateExecution(
  ctx: GateExecutionRecordingTarget,
  result: GateResult,
): Promise<void> {
  try {
    const envelopeId = ctx.getCurrentEnvelopeId?.() ?? null;
    const store = ctx.getEnvelopeStore?.();
    if (!envelopeId || !store) {
      ctx.onRecordSkipped?.({
        envelopeId,
        toolId: result.tool_id,
        reason: !envelopeId ? "no_envelope_id" : "no_envelope_store",
      });
      return;
    }
    const inputHashSrc = JSON.stringify({ target: result.target });
    const hash = await sha256Hex(inputHashSrc);
    const dispatchedAt = new Date(Date.now() - result.duration_ms).toISOString();
    // 196a — bounded structured phase summary so verifiers can
    // mechanically check 195/195a phase contract via /api/inspect
    // without fishing through raw stdout. Only metadata fields; raw
    // stdout/stderr stay in `evidence.gate_logs[*]` per existing
    // GateLogEvidence contract.
    const phasesSummary = (result.phases ?? []).map((p) => ({
      phase: p.phase,
      timeout_s: p.timeout_s,
      exit_code: p.exit_code,
      duration_ms: p.duration_ms,
      timed_out: p.timed_out,
      ...(p.skipped_due_to_previous_failure
        ? { skipped_due_to_previous_failure: true }
        : {}),
    }));
    const exec = store.addExecution(envelopeId, {
      tool_call: {
        tool_id: result.tool_id,
        input_hash: hash,
        input_summary: inputHashSrc,
        dispatched_at: dispatchedAt,
      },
      tool_result: {
        status: result.ok ? "ok" : "error",
        output: {
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          phases: phasesSummary,
        },
        finished_at: new Date().toISOString(),
        duration_ms: result.duration_ms,
      },
    });
    if (exec) {
      store.addGateEvidence(envelopeId, result, exec.step_index);
      // 196a — see recordReadExecution; only claim once execution[] accepted.
      ctx.recordWrappedToolId?.(result.tool_id);
    } else {
      ctx.onRecordSkipped?.({
        envelopeId,
        toolId: result.tool_id,
        reason: "add_execution_null",
      });
    }
  } catch {
    // fail-soft.
  }
}

export function buildAgentSafeReadTools(ctx: AgentToolBindingContext) {
  return {
    repo_read: tool({
      description: `${M8_1} Read a single file from the agentthursday / AT repo working tree. Path is subject to the global denylist (.env*, .git/, secrets/). Use this instead of content_read when you need the agent's actual workspace state.`,
      inputSchema: z.object({
        path: z.string().describe("relative path inside the repo (e.g. 'src/server.ts')"),
      }),
      execute: async ({ path }) => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await dispatchReadTool("repo.read", { path }, {
          emit: ctx.emit,
          workspace: ctx.workspace,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, { path }, dispatchedAt, Date.now() - t0);
        return result;
      },
    }),
    repo_prepare: tool({
      description: `${M8_1} : Prepare the controlled repo worktree before writing. Idempotent — call once at the start of any task that may use repo.write / repo.patch (the write dispatcher rejects mutations until a successful prepare has fired). Returns head_sha, branch, worktree_path, and git status. The repo / ref are allowlisted; no token is exposed, no push is performed.`,
      inputSchema: z.object({
        repo_id: z.string().optional().describe("repo id (informational; checkout source is server-allowlisted)"),
        branch: z.string().optional().describe("branch or ref (informational; checkout currently materializes the server-configured default ref)"),
        task_id: z.string().optional().describe("task id this worktree is bound to (informational)"),
      }),
      execute: async ({ repo_id, branch, task_id }) => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const input: Record<string, unknown> = {};
        if (typeof repo_id === "string") input.repo_id = repo_id;
        if (typeof branch === "string") input.branch = branch;
        if (typeof task_id === "string") input.task_id = task_id;
        const result = await dispatchReadTool("repo.prepare", input, {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, input, dispatchedAt, Date.now() - t0);
        if (result.ok && result.output && typeof result.output === "object") {
          const out = result.output as { worktree_path?: unknown; head_sha?: unknown };
          if (typeof out.worktree_path === "string" && typeof out.head_sha === "string") {
            ctx.markRepoPrepared?.({ worktree_path: out.worktree_path, head_sha: out.head_sha });
          }
        }
        return result;
      },
    }),
    repo_write: tool({
      description: `${M8_1} : Write (replace) a file in the prepared repo worktree. Requires repo.prepare to have fired first; otherwise returns no_prepared_worktree. Path is constrained by the software-dev manifest allow/deny lists. Use repo.patch for single-line edits; use repo.write when the entire file should be replaced. : after your LAST write/patch in a task you MUST actually call gate.typecheck (then gate.build) before finishing — saying in your reply that you ran them is NOT enough; without a real gate tool call the envelope seals failed with reason missing_gate_evidence. If a gate genuinely cannot run, state the concrete blocker in your reply.`,
      inputSchema: z.object({
        path: z.string().describe("relative path inside the repo"),
        content: z.string().describe("full new file content (256KB cap)"),
        expected_existing_hash: z
          .string()
          .optional()
          .describe("optional sha256 of the existing file; if present and mismatched the write is rejected"),
      }),
      execute: async (args) => {
        if (!ctx.dispatchWriteTool) {
          return {
            ok: false,
            tool_id: "repo.write",
            error: { reason: "write_dispatcher_unavailable" },
            duration_ms: 0,
            contract: { tier: 3, emit_events: [], required_evidence: [] },
            backend: "stub" as const,
          };
        }
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await ctx.dispatchWriteTool({
          tool_id: "repo.write",
          input: args as Record<string, unknown>,
        });
        await recordReadExecution(
          ctx,
          result as DispatchResult,
          args as Record<string, unknown>,
          dispatchedAt,
          Date.now() - t0,
        );
        return result;
      },
    }),
    repo_patch: tool({
      description: `${M8_1} : Apply a string-replacement patch to a single file in the prepared repo worktree. Requires repo.prepare to have fired first; otherwise returns no_prepared_worktree. \`old_string\` must occur exactly once in the file; the entire match is replaced by \`new_string\`. Prefer this over repo.write for small edits. : after your LAST write/patch in a task you MUST actually call gate.typecheck (then gate.build) before finishing — saying in your reply that you ran them is NOT enough; without a real gate tool call the envelope seals failed with reason missing_gate_evidence. If a gate genuinely cannot run, state the concrete blocker in your reply.`,
      inputSchema: z.object({
        path: z.string().describe("relative path inside the repo"),
        old_string: z.string().describe("exact text to find (must occur exactly once)"),
        new_string: z.string().describe("replacement text"),
      }),
      execute: async (args) => {
        if (!ctx.dispatchWriteTool) {
          return {
            ok: false,
            tool_id: "repo.patch",
            error: { reason: "write_dispatcher_unavailable" },
            duration_ms: 0,
            contract: { tier: 3, emit_events: [], required_evidence: [] },
            backend: "stub" as const,
          };
        }
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await ctx.dispatchWriteTool({
          tool_id: "repo.patch",
          input: args as Record<string, unknown>,
        });
        await recordReadExecution(
          ctx,
          result as DispatchResult,
          args as Record<string, unknown>,
          dispatchedAt,
          Date.now() - t0,
        );
        return result;
      },
    }),
    repo_grep: tool({
      description: `${M8_1} Grep across repo files matching a pattern, with optional include glob. Returns file/line/text matches; cap at 200 files × 500 matches. Use this to locate code instead of relying on memory.`,
      inputSchema: z.object({
        pattern: z.string().describe("text pattern (regex)"),
        include_glob: z.string().optional().describe("limit search to paths matching this glob (e.g. '**/*.ts')"),
      }),
      execute: async ({ pattern, include_glob }) => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await dispatchReadTool("repo.grep", { pattern, include_glob }, {
          emit: ctx.emit,
          workspace: ctx.workspace,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, { pattern, include_glob }, dispatchedAt, Date.now() - t0);
        return result;
      },
    }),
    git_status: tool({
      description: `${M8_1} Run 'git status --porcelain' in the agent sandbox and return the porcelain output + exit code. Use this to confirm working-tree state before claiming changes are clean.`,
      inputSchema: z.object({}),
      execute: async () => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await dispatchReadTool("git.status", {}, {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, {}, dispatchedAt, Date.now() - t0);
        return result;
      },
    }),
    git_show: tool({
      description: `${M8_1} Run 'git show <ref>' for a commit / blob ref. Ref is whitelist-validated; arbitrary shell is rejected.`,
      inputSchema: z.object({
        ref: z.string().describe("git ref like 'HEAD', a sha, or 'main'"),
      }),
      execute: async ({ ref }) => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const result = await dispatchReadTool("git.show", { ref }, {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, { ref }, dispatchedAt, Date.now() - t0);
        return result;
      },
    }),
    git_log: tool({
      description: `${M8_1} Run 'git log' (oneline format) in the agent sandbox. Returns recent commit subjects + sha. Use this to understand what changed recently before claiming "we did X".`,
      inputSchema: z.object({
        max_count: z.number().int().positive().max(200).optional().describe("max commits to return (default 20, hard cap 200)"),
      }),
      execute: async ({ max_count }) => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const dispatchedAt = new Date().toISOString();
        const t0 = Date.now();
        const input: Record<string, unknown> = {};
        if (typeof max_count === "number") input.max_count = max_count;
        const result = await dispatchReadTool("git.log", input, {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordReadExecution(ctx, result, input, dispatchedAt, Date.now() - t0);
        return result;
      },
    }),
    gate_typecheck: tool({
      description: `${M8_1} Run 'npm run typecheck' in the agent sandbox; returns exit code + stdout/stderr + per-phase breakdown (root / tui / scripts). Only this fixed command is allowed; arbitrary targets are rejected. **Use this tool whenever the user asks to verify typecheck, the typecheck gate, or 'npm run typecheck' — call the tool, do not narrate a plan like "I'll run typecheck" / "我去跑 typecheck".** Merely saying you will run it without dispatching this tool is a violation ( will fail the envelope). Exception: if the user explicitly forbids tool use ("不要调用任何工具" / "don't call any tools"), do not call this tool and do not fabricate a result; plainly say you cannot verify without running it.`,
      inputSchema: z.object({}),
      execute: async () => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const result = await runGate("typecheck", {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordGateExecution(ctx, result);
        return result;
      },
    }),
    gate_build: tool({
      description: `${M8_1} Run 'npm run build:web' (production web build) in the agent sandbox; returns exit code + stdout/stderr + per-phase breakdown (web_tsc / web_vite). Only this fixed command is allowed. **Use this tool whenever the user asks to verify build, the build gate, 'gate.build', or whether build still passes — call the tool, do not narrate a plan like "我去跑 gate" / "我直接跑 gate" / "I'll go run the gate".** Merely saying you will run it without dispatching this tool is a violation ( will fail the envelope). Exception: if the user explicitly forbids tool use ("不要调用任何工具" / "don't call any tools"), do not call this tool and do not fabricate a result; plainly say you cannot verify without running it.`,
      inputSchema: z.object({}),
      execute: async () => {
        const repoBaseDir = await ctx.ensureRepoBaseDir?.();
        const result = await runGate("build", {
          emit: ctx.emit,
          sandboxExec: ctx.sandboxExec,
          repoBaseDir,
        });
        await recordGateExecution(ctx, result);
        return result;
      },
    }),
    evidence_get: tool({
      description: `${M8_1} Inspect a previously-created evidence envelope by id. Returns the four-ring envelope (intent / execution / evidence / self_verify) so the agent can self-check what really happened in a task.`,
      inputSchema: z.object({
        envelope_id: z.string().describe("envelope id returned from a prior envelope/start call"),
      }),
      execute: async ({ envelope_id }) => {
        const store = ctx.getEnvelopeStore?.();
        if (!store) {
          return { ok: false, error: { reason: "envelope_store_unavailable" } };
        }
        const env = store.get(envelope_id);
        return env ?? { ok: false, error: { reason: "envelope_not_found", envelope_id } };
      },
    }),
  };
}
