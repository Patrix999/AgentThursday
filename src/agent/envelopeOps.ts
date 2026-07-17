/**
 * envelopeOps — evidence-envelope authority free functions.
 *
 * an earlier revision → 292 → 294b/c → 295e/g/h → 206a consolidated this module
 * as the agent-side authority for envelope store init, active-draft
 * resolution, CRUD, snapshot lifecycle, sweeper constants, read-only
 * orphan classification, and supplier/intent probes that the gated
 * sweeper consults.
 *
 * What this module owns now:
 *
 *   - Store lazy-init:
 *     `ensureEnvelopeStoreSyncFree`, `ensureEnvelopeStoreFree`.
 *   - Active-draft resolution + tie-break:
 *     `resolveActiveDraftEnvelopeIdFree`, `pickNewestDraftIdFree`
 *     (emits `evidence.envelope.multi_draft_anomaly`).
 *   - Sweeper + retention constants (re-aliased as `static readonly`
 *     on `AgentThursdayAgent` so existing call-sites stay byte-equal):
 *     `ENVELOPE_SWEEPER_ALARM_DELAY_S`,
 *     `ENVELOPE_SWEEPER_LAZY_THRESHOLD_MS`,
 *     `ENVELOPE_SWEEPER_READ_ONLY_THRESHOLD_MS`,
 *     `ENVELOPE_SNAPSHOT_RETENTION_LIMIT`.
 *   - Snapshot build + cleanup :
 *     `buildBoundedEnvelopeSnapshotFree`,
 *     `cleanupOldEnvelopeSnapshotsFree`.
 *   - Envelope CRUD :
 *     `devShellEnvelopeStartFree`, `devShellEnvelopeAddGateFree`,
 *     `devShellEnvelopeAddToolFree`, `devShellEnvelopeSealFree`,
 *     `devShellEnvelopeGetFree`, `devShellEnvelopeListFree`,
 *     `devShellEnvelopeListByTaskFree`,
 *     `devShellEnvelopeGetLatestTerminalFree`.
 *   - Reply-marker round-trip:
 *     `buildEnvelopeReplyMarker`, `parseEnvelopeReplyMarker`.
 *   - Read-only orphan classifier + supplier/intent probes used by
 *     the gated sweeper (an earlier revision/g/h):
 *     `classifyReadOnlySafeOrphan`, `SUPPLIER_MUTATION_TOOL_NAMES`,
 *     `hasOrphanSupplierMutation`, `hasOrphanPromptReadIntent`,
 *     `hasOrphanPromptMutationIntent`.
 *
 * What stays in `server.ts` (intentional — an earlier revision preflight):
 *
 *   - `_finalizeTaskTurn()` + fallback-reply path — lifecycle coupling
 *     with `onStepFinish` / `streamReply`; kept server-owned until a
 *     narrow Host interface is proven.
 *   - `sweepStaleDraftEnvelopes()` + `envelopeSweeperBackstop()` —
 *     `this.schedule()` resolves the backstop by name, so it must
 *     remain a class member; the sweeper threads `_finalizeTaskTurn`
 *     and stays paired with it (an earlier revision decision).
 *   - `_currentEnvelopeId` / `_currentTaskWrappedToolIds` /
 *     `_pinnedWrappedToolIdsByTask` — class fields on `AgentThursdayAgent`;
 *     load-bearing closure identity across the submitTask main chain.
 *
 * Host shape:
 *
 *   - `sql`                              — DO storage SQL tag.
 *   - `logEvent`                         — emit into `event_log`.
 *   - `getCurrentTaskId`                 — reads
 *     `agentthursdayState.currentTaskObject?.id`; the resolveActiveDraft anchor.
 *   - `getEnvelopeStoreCache`            — lazy-init guard.
 *   - `setEnvelopeStoreCache`            — lazy-init commit.
 *
 * CRUD adds extra read-only accessors via `EnvelopeCrudHost extends
 * EnvelopeStoreHost`.
 *
 * Key invariants (preserved across every move):
 *
 *   - `EnvelopeStoreClass` initialization unchanged: `onMutate` writes
 *     a bounded snapshot row + cleanup-on-terminal; `onMutateError`
 *     emits `evidence.envelope.persist.error`.
 *   - SQL table name (`envelope_snapshots`), event names, payload
 *     keys, K=500 retention, and the terminal-only cleanup trigger
 *     are byte-equal pre/post extraction.
 *   - `resolveActiveDraftEnvelopeId` order: memory → SQL rehydrate →
 *     adopt. `evidence.envelope.multi_draft_anomaly` payload shape
 *     `{task_id, count, envelope_ids, source}` unchanged.
 *   - Constants are re-aliased as `static readonly` on `AgentThursdayAgent`,
 *     so submitTask / sweeper / retention call-sites stay byte-equal
 *     (an earlier revision §"不改 submitTask 主链").
 *   - No schema migration.
 */

import { EnvelopeStore as EnvelopeStoreClass } from "../skillset/evidenceEnvelope";
import type {
  EnvelopeStore as EnvelopeStoreType,
  EvidenceEnvelope as EvidenceEnvelopeType,
} from "../skillset/evidenceEnvelope";
import type { DispatchResult } from "../skillset/devShell";
import { READ_TOOL_IDS } from "../skillset/devShell";
import type { GateResult } from "../skillset/gateRunner";
import { detectReadIntent } from "../skillset/readIntent";
import { detectMutationIntent } from "../skillset/mutationIntent";

export type EnvelopeOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface EnvelopeStoreHost {
  sql: EnvelopeOpsSqlTag;
  logEvent: (type: string, payload: unknown, traceId?: string | null) => void;
  getCurrentTaskId: () => string | null;
  getEnvelopeStoreCache: () => EnvelopeStoreType | null;
  setEnvelopeStoreCache: (store: EnvelopeStoreType | null) => void;
}

/**
 * alarm-backstop delay in seconds. The lazy sweeper
 * (triggered from /cli/status) handles the common "verifier polls
 * status and finds the demo hung" case quickly; this alarm catches
 * the silent case where no one polls. 30 min is a comfortable
 * ceiling above the longest observed turn length (12–15 min for
 * back-to-back gate.typecheck + gate.build).
 */
export const ENVELOPE_SWEEPER_ALARM_DELAY_S = 30 * 60;

// ── sweeper gate-aware grace ─────────────────────────────
// The 30-min backstop cannot tell a hung stream from a long-running
// gate chain: 381 attempt #4 (task-e20784d8) was sealed `failed` while
// gate.build's web_tsc was actively mid-run. If the DO shows a recent
// `tool.%` event, the alarm defers the seal one window instead —
// bounded by MAX_EXTENSIONS so a genuinely wedged turn still seals
// (worst case ≈ 30 + 2×15 = 60 min).
export const ENVELOPE_SWEEPER_MAX_EXTENSIONS = 2;
// Covers one gate phase timeout (450s) plus scheduling slack.
export const ENVELOPE_SWEEPER_ACTIVITY_WINDOW_MS = 12 * 60 * 1000;
export const ENVELOPE_SWEEPER_EXTENSION_DELAY_S = 15 * 60;

export interface SweeperExtensionDecision {
  extend: boolean;
  nextExtensions: number;
  lastToolEventAgeMs: number | null;
}

export function decideSweeperExtension(input: {
  extensions: number;
  lastToolEventAt: number | null;
  now: number;
}): SweeperExtensionDecision {
  const { extensions, lastToolEventAt, now } = input;
  const age = lastToolEventAt === null ? null : now - lastToolEventAt;
  if (extensions >= ENVELOPE_SWEEPER_MAX_EXTENSIONS || age === null) {
    return { extend: false, nextExtensions: extensions, lastToolEventAgeMs: age };
  }
  if (age < ENVELOPE_SWEEPER_ACTIVITY_WINDOW_MS) {
    return { extend: true, nextExtensions: extensions + 1, lastToolEventAgeMs: age };
  }
  return { extend: false, nextExtensions: extensions, lastToolEventAgeMs: age };
}

/**
 * default threshold for the lazy sweeper: ignore drafts
 * younger than this so an in-flight, healthy turn isn't pre-emptively
 * finalized while gates are still running. Threshold ≥ longest
 * expected single-turn duration.
 */
export const ENVELOPE_SWEEPER_LAZY_THRESHOLD_MS = 20 * 60 * 1000;

/**
 * short threshold for clearly-read-only orphan drafts.
 * A draft qualifies when (1) `execution.length === 0`, (2) no gate
 * logs / diff evidence attached, and (3) `submitTask.prompt.gate_intent_check`
 * for this task was logged with `detected: false`. The 20-min strict
 * threshold still applies to drafts that are NOT clearly read-only.
 */
export const ENVELOPE_SWEEPER_READ_ONLY_THRESHOLD_MS = 120 * 1000;

/**
 * keep-last-K retention for `envelope_snapshots` terminal
 * rows. Draft rows are never pruned by the K-LRU path: a live draft
 * may belong to the current turn; the sweeper closes drafts to
 * terminal, after which the next terminal write can reclaim them.
 * K=500 ≈ 5–10 days at current dogfood rate.
 */
export const ENVELOPE_SNAPSHOT_RETENTION_LIMIT = 500;

/**
 * bounded snapshot payload. gate stdout/stderr can easily
 * run hundreds of KB on a real `npm run build`; we keep an 8KB head +
 * 8KB tail window with a `truncated:true` marker. The in-memory
 * `EvidenceEnvelope` is unchanged — this transformation applies to
 * the SQL row only.
 *
 * an earlier revision moved this from `AgentThursdayAgent._buildBoundedEnvelopeSnapshot`
 * into a pure module-local free function. Behavior byte-equal: HEAD/
 * TAIL byte windows, truncation marker, gate_logs[*].stdout/stderr
 * targeting, and the `truncated:true` flag.
 */
export function buildBoundedEnvelopeSnapshotFree(
  env: EvidenceEnvelopeType,
): EvidenceEnvelopeType {
  const HEAD_BYTES = 8 * 1024;
  const TAIL_BYTES = 8 * 1024;
  const truncate = (s: string): string => {
    if (typeof s !== "string") return s;
    if (s.length <= HEAD_BYTES + TAIL_BYTES) return s;
    const head = s.slice(0, HEAD_BYTES);
    const tail = s.slice(s.length - TAIL_BYTES);
    const omitted = s.length - head.length - tail.length;
    return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
  };
  const gateLogs = env.evidence.gate_logs?.map((g) => {
    const headBig = (g.stdout?.length ?? 0) > HEAD_BYTES + TAIL_BYTES;
    const tailBig = (g.stderr?.length ?? 0) > HEAD_BYTES + TAIL_BYTES;
    const out = {
      ...g,
      stdout: truncate(g.stdout ?? ""),
      stderr: truncate(g.stderr ?? ""),
    } as typeof g & { truncated?: true };
    if (headBig || tailBig) out.truncated = true;
    return out;
  });
  return {
    ...env,
    evidence: {
      ...env.evidence,
      ...(gateLogs ? { gate_logs: gateLogs } : {}),
    },
  };
}

/**
 * keep-last-K cleanup for terminal `envelope_snapshots`.
 *
 * Triggered from `onMutate` only when the just-written envelope has
 * reached a terminal status (`sealed` / `failed`). Drafts are never
 * pruned here: they may belong to an in-flight turn. The sweeper
 *  closes orphan drafts to a terminal verdict, after
 * which the next terminal write becomes eligible for collection.
 *
 * SQL strategy: pick the `created_at` of the K-th most recent
 * terminal row, then delete terminal rows older than that.
 * Computing the threshold first keeps the DELETE fast and
 * deterministic on the existing `idx_envelope_snapshots_created_at`
 * index. If fewer than K terminal rows exist, the threshold
 * subquery yields zero rows and we no-op. This preserves any
 * envelope reachable through `/api/inspect/evidence` (the latest
 * terminal envelope by definition has the largest `created_at`)
 * and is independent of `task_id` so 199a "latest envelope per
 * task" is undisturbed (a task's latest is just one of the K most
 * recent terminal rows globally, since K ≫ active concurrency).
 *
 * Fail-soft: any SQL error is swallowed. GC must never block the
 * envelope write or the reply pipeline.
 *
 * an earlier revision moved this from `AgentThursdayAgent._cleanupOldEnvelopeSnapshots`
 * into a free function over `sql`. K is the module-local
 * `ENVELOPE_SNAPSHOT_RETENTION_LIMIT`, byte-equal to the prior
 * `AgentThursdayAgent.ENVELOPE_SNAPSHOT_RETENTION_LIMIT` static alias.
 */
export function cleanupOldEnvelopeSnapshotsFree(sql: EnvelopeOpsSqlTag): void {
  try {
    const K = ENVELOPE_SNAPSHOT_RETENTION_LIMIT;
    const thresholdRows = sql<{ created_at: number }>`
      SELECT created_at FROM envelope_snapshots
       WHERE envelope_status != 'draft'
       ORDER BY created_at DESC
       LIMIT 1 OFFSET ${K - 1}
    `;
    if (!thresholdRows || thresholdRows.length === 0) return;
    const threshold = thresholdRows[0].created_at;
    sql`
      DELETE FROM envelope_snapshots
       WHERE envelope_status != 'draft'
         AND created_at < ${threshold}
    `;
  } catch {
    // fail-soft — cleanup must never break envelope writes.
  }
}

/**
 * sync envelope-store ensure. Pre-198a this was async
 * because of a dynamic `import()`; the wrapper closures
 * (`getEnvelopeStore` / `getCurrentEnvelopeId`) are sync, so a tool
 * call firing right after a DO isolate restart could see the cache
 * `null` and skip with `no_envelope_store`. The static import here
 * makes ensure cheap and synchronous; the closures call this through
 * a thin delegate on `AgentThursdayAgent`.
 */
export function ensureEnvelopeStoreSyncFree(host: EnvelopeStoreHost): EnvelopeStoreType {
  const cached = host.getEnvelopeStoreCache();
  if (cached) return cached;
  const store = new EnvelopeStoreClass({
    // durable snapshot persistence. Every accepted mutation
    // persists a bounded JSON payload so /api/inspect/evidence
    // survives DO isolate restarts (in-memory map alone does not).
    onMutate: (env) => {
      try {
        const payload = JSON.stringify(buildBoundedEnvelopeSnapshotFree(env));
        host.sql`
          INSERT OR REPLACE INTO envelope_snapshots
            (envelope_id, task_id, skillset_id, agent_id, envelope_status, started_at, finished_at, payload, created_at)
          VALUES
            (${env.envelope_id}, ${env.task_id}, ${env.skillset_id}, ${env.agent_id}, ${env.envelope_status}, ${env.timestamps.started_at}, ${env.timestamps.finished_at ?? null}, ${payload}, ${Date.now()})
        `;
      } catch {
        // fail-soft — persistence failure must not break tool calls.
      }
      // keep-last-K LRU on terminal rows. Triggered only
      // when this write transitions the envelope to a terminal status,
      // so live drafts are never collected and we don't re-run the SQL
      // on every intermediate mutation.
      if (env.envelope_status === "sealed" || env.envelope_status === "failed") {
        cleanupOldEnvelopeSnapshotsFree(host.sql);
      }
    },
    // surface persistence failures via event_log. The
    // 196b `onMutate` block already catches+swallows any SQL throw so
    // tool execution keeps moving; without this hook we lose the
    // discriminator between "envelope state is wrong because we never
    // got here" and "envelope state is wrong because the SQL write
    // threw and was silently dropped". Fail-soft.
    onMutateError: (env, err) => {
      try {
        host.logEvent("evidence.envelope.persist.error", {
          envelope_id: env.envelope_id,
          task_id: env.task_id,
          envelope_status: env.envelope_status,
          error: err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200),
        });
      } catch { /* nested fail-soft — event_log glitch must not propagate */ }
    },
  });
  host.setEnvelopeStoreCache(store);
  return store;
}

/**
 * Async wrapper preserved for call sites that already `await`
 * (devShellEnvelope* callables, submitTask). Internally just
 * delegates to the sync ensure.
 */
export async function ensureEnvelopeStoreFree(
  host: EnvelopeStoreHost,
): Promise<EnvelopeStoreType> {
  return ensureEnvelopeStoreSyncFree(host);
}

/**
 * resolve the in-flight draft envelope id for the
 * current agent task, consulting (1) in-memory store and (2) the
 * durable `envelope_snapshots` SQL fallback. Used by tool wrappers
 * each time they fire so a DO isolate restart mid-saveMessages
 * doesn't drop the trailing executions on the floor.
 *
 * Tie-break: when more than one draft is found for the same task
 * (anomaly — the task should only have one open envelope per round),
 * pick the newest `started_at` so subsequent executions don't write
 * into a stale envelope from a prior turn that never sealed. Anomaly
 * is logged via `evidence.envelope.multi_draft_anomaly`.
 */
export function resolveActiveDraftEnvelopeIdFree(host: EnvelopeStoreHost): string | null {
  const taskId = host.getCurrentTaskId();
  if (!taskId) return null;
  const store = ensureEnvelopeStoreSyncFree(host);
  const memoryDrafts = store.list().filter(
    e => e.task_id === taskId && e.envelope_status === "draft",
  );
  if (memoryDrafts.length > 0) {
    return pickNewestDraftIdFree(host, memoryDrafts, taskId, "memory");
  }
  // Memory miss — try durable snapshots. Hydrating into the store
  // (via `adopt`) is what makes subsequent `addExecution` calls
  // succeed instead of returning null on the missing envelope.
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots
       WHERE task_id = ${taskId} AND envelope_status = 'draft'
       ORDER BY started_at DESC LIMIT 5
    `;
    if (rows.length === 0) return null;
    const restored: EvidenceEnvelopeType[] = [];
    for (const row of rows) {
      try {
        const env = JSON.parse(row.payload) as EvidenceEnvelopeType;
        store.adopt(env);
        restored.push(env);
      } catch {
        // skip unparseable row
      }
    }
    if (restored.length === 0) return null;
    return pickNewestDraftIdFree(host, restored, taskId, "sql_rehydrate");
  } catch {
    return null;
  }
}

export function pickNewestDraftIdFree(
  host: EnvelopeStoreHost,
  drafts: EvidenceEnvelopeType[],
  taskId: string,
  source: string,
): string | null {
  if (drafts.length === 0) return null;
  if (drafts.length > 1) {
    try {
      host.logEvent("evidence.envelope.multi_draft_anomaly", {
        task_id: taskId,
        count: drafts.length,
        envelope_ids: drafts.map(d => d.envelope_id),
        source,
      });
    } catch {
      // fail-soft
    }
  }
  const sorted = [...drafts].sort((a, b) =>
    a.timestamps.started_at < b.timestamps.started_at ? 1 : -1,
  );
  return sorted[0].envelope_id;
}

/**
 * envelope CRUD Host. Extends EnvelopeStoreHost with the
 * two cross-module capabilities envelope CRUD needs:
 *
 *   - `agentId`          — for envelope.createDraft({ agent_id })
 *   - `runGate`          — wraps devShellGateRunFree; called by
 *     `devShellEnvelopeAddGateFree`.
 *   - `dispatchReadTool` — wraps devShellDispatchFree; called by
 *     `devShellEnvelopeAddToolFree`.
 *
 * Kept additive so an earlier revision (finalize/sweeper) can layer further
 * capabilities without re-shaping the base store host.
 */
export interface EnvelopeCrudHost extends EnvelopeStoreHost {
  agentId: string;
  runGate: (target: string, traceId: string | null) => Promise<unknown>;
  dispatchReadTool: (
    toolId: string,
    input: Record<string, unknown>,
    traceId: string | null,
  ) => Promise<unknown>;
}

async function sha256HexFree(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * start a new draft envelope for the current task. Records
 * the declared intent and emits `evidence.envelope.draft`.
 */
export async function devShellEnvelopeStartFree(
  host: EnvelopeCrudHost,
  input: {
    task_id: string;
    intent_source: "task_card" | "plan_step" | "human_directive" | "subagent_delegation";
    intent_source_ref: string;
    intent_declared_goal: string;
    intent_expected_output?: Array<{ type: string; description: string; acceptance_check?: string }>;
    intent_workflow_pattern?: string;
    traceId?: string | null;
    // 2026-06-27 — the agent's resolved effective skillset (was hardcoded
    // "software-dev"). Caller passes it; falls back to "software-dev" (the
    // dev-shell surface is dev work) only if unresolved.
    skillset_id?: string;
  },
): Promise<unknown> {
  const store = await ensureEnvelopeStoreFree(host);
  const env = store.createDraft({
    task_id: input.task_id,
    skillset_id: input.skillset_id ?? "software-dev",
    agent_id: host.agentId,
    intent: {
      source: input.intent_source,
      source_ref: input.intent_source_ref,
      declared_goal: input.intent_declared_goal,
      expected_output: input.intent_expected_output ?? [],
      workflow_pattern: input.intent_workflow_pattern,
    },
  });
  host.logEvent("evidence.envelope.draft", {
    envelope_id: env.envelope_id,
    task_id: env.task_id,
    intent: env.intent,
  }, input.traceId ?? null);
  return env;
}

/**
 * run a gate (typecheck/build/test/dry_run) and append its
 * execution + structured gate evidence into the envelope. Emits
 * `evidence.envelope.gate_added`.
 */
export async function devShellEnvelopeAddGateFree(
  host: EnvelopeCrudHost,
  input: { envelope_id: string; target: string; traceId?: string | null },
): Promise<unknown> {
  const store = await ensureEnvelopeStoreFree(host);
  const result = await host.runGate(input.target, input.traceId ?? null);
  const gateResult = result as GateResult;
  const inputHashSrc = JSON.stringify({ target: gateResult.target });
  const hash = await sha256HexFree(inputHashSrc);
  const exec = store.addExecution(input.envelope_id, {
    tool_call: {
      tool_id: gateResult.tool_id,
      input_hash: hash,
      dispatched_at: new Date(Date.now() - gateResult.duration_ms).toISOString(),
    },
    tool_result: {
      status: gateResult.ok ? "ok" : "error",
      output: { exit_code: gateResult.exit_code, duration_ms: gateResult.duration_ms },
      finished_at: new Date().toISOString(),
      duration_ms: gateResult.duration_ms,
    },
  });
  if (exec) store.addGateEvidence(input.envelope_id, gateResult, exec.step_index);
  host.logEvent("evidence.envelope.gate_added", {
    envelope_id: input.envelope_id,
    gate_target: gateResult.target,
    exit_code: gateResult.exit_code,
    ok: gateResult.ok,
  }, input.traceId ?? null);
  return { envelope: store.get(input.envelope_id), gate: gateResult };
}

/**
 * wrap a read-side dev-shell dispatch and record the call
 * into envelope.execution[]. Rejects non-read tools with
 * `tool_id_not_in_read_allowlist`. Emits `evidence.envelope.tool_added`.
 */
export async function devShellEnvelopeAddToolFree(
  host: EnvelopeCrudHost,
  input: {
    envelope_id: string;
    tool_id: string;
    input: Record<string, unknown>;
    traceId?: string | null;
  },
): Promise<unknown> {
  const traceId = input.traceId ?? null;
  const store = await ensureEnvelopeStoreFree(host);
  const allowedReadTools: ReadonlyArray<string> = READ_TOOL_IDS;
  if (!allowedReadTools.includes(input.tool_id)) {
    host.logEvent("evidence.envelope.tool_added", {
      envelope_id: input.envelope_id,
      tool_id: input.tool_id,
      ok: false,
      rejected: "tool_id_not_in_read_allowlist",
    }, traceId);
    return {
      ok: false,
      error: { reason: "tool_id_not_in_read_allowlist", details: `tool_id ${input.tool_id} is not a read-side dev-shell tool; use devShellEnvelopeAddGate for gate tools or call the dispatcher directly` },
    };
  }
  const inputJson = JSON.stringify(input.input ?? {});
  const hash = await sha256HexFree(inputJson);

  const dispatchedAt = new Date().toISOString();
  const t0 = Date.now();
  const dispatchResultRaw = await host.dispatchReadTool(input.tool_id, input.input ?? {}, traceId);
  const dispatchResult = dispatchResultRaw as DispatchResult;
  const duration_ms = Date.now() - t0;

  const inputSummary = inputJson.length > 512 ? `${inputJson.slice(0, 512)}…[truncated]` : inputJson;
  let outputSummary: { summary: string; truncated: boolean } | undefined;
  try {
    const s = JSON.stringify(dispatchResult.output ?? null);
    if (s.length > 256) {
      outputSummary = { summary: `${s.slice(0, 256)}…`, truncated: true };
    } else {
      outputSummary = { summary: s, truncated: false };
    }
  } catch {
    outputSummary = { summary: "<unserializable>", truncated: true };
  }

  const exec = store.addExecution(input.envelope_id, {
    tool_call: {
      tool_id: dispatchResult.tool_id,
      input_hash: hash,
      input_summary: inputSummary,
      dispatched_at: dispatchedAt,
    },
    tool_result: {
      status: dispatchResult.ok ? "ok" : "error",
      output: outputSummary,
      error: dispatchResult.error
        ? {
            reason: dispatchResult.error.reason,
            retriable: false,
            details: dispatchResult.error.details ? dispatchResult.error.details.slice(0, 256) : undefined,
          }
        : undefined,
      finished_at: new Date().toISOString(),
      duration_ms,
    },
  });
  host.logEvent("evidence.envelope.tool_added", {
    envelope_id: input.envelope_id,
    tool_id: dispatchResult.tool_id,
    ok: dispatchResult.ok,
    step_index: exec ? exec.step_index : null,
    envelope_state: exec ? "appended" : "rejected_not_draft",
  }, traceId);
  return {
    envelope: store.get(input.envelope_id),
    tool: dispatchResult,
    step_index: exec ? exec.step_index : null,
  };
}

/**
 * seal an envelope. EnvelopeStore.seal computes the
 * `self_verify.verdict` (incl. an earlier revision §F2 `fabricated_tools`).
 * Emits `evidence.envelope.sealed` on `sealed` and
 * `evidence.envelope.failed` on `failed`.
 */
export async function devShellEnvelopeSealFree(
  host: EnvelopeCrudHost,
  input: { envelope_id: string; claimed_tools?: string[]; traceId?: string | null },
): Promise<unknown> {
  const store = await ensureEnvelopeStoreFree(host);
  const sealed = store.seal(input.envelope_id, input.claimed_tools ?? []);
  if (sealed) {
    host.logEvent(
      sealed.envelope_status === "sealed"
        ? "evidence.envelope.sealed"
        : "evidence.envelope.failed",
      {
        envelope_id: sealed.envelope_id,
        verdict: sealed.self_verify?.verdict,
        fabricated_tools: sealed.self_verify?.fabricated_tools,
      },
      input.traceId ?? null,
    );
  }
  return sealed;
}

/**
 * get an envelope by id with durable snapshot fallback.
 * Returns live store value first; on miss, reads the
 * `envelope_snapshots` SQL row written by `onMutate`.
 */
export async function devShellEnvelopeGetFree(
  host: EnvelopeCrudHost,
  input: { envelope_id: string },
): Promise<unknown> {
  const store = await ensureEnvelopeStoreFree(host);
  const live = store.get(input.envelope_id);
  if (live) return live;
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots WHERE envelope_id = ${input.envelope_id} LIMIT 1
    `;
    if (rows.length > 0) {
      return JSON.parse(rows[0].payload);
    }
  } catch {
    // fail-soft; treat as miss.
  }
  return null;
}

/**
 * list envelopes. Memory list unioned with the durable
 * snapshot tail (LIMIT 50, newest first), deduped by `envelope_id`
 * so live drafts win over their snapshots.
 */
export async function devShellEnvelopeListFree(
  host: EnvelopeCrudHost,
): Promise<unknown> {
  const store = await ensureEnvelopeStoreFree(host);
  const live = store.list();
  const seen = new Set(live.map((e) => e.envelope_id));
  const merged: unknown[] = [...live];
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots ORDER BY created_at DESC LIMIT 50
    `;
    for (const row of rows) {
      try {
        const env = JSON.parse(row.payload) as { envelope_id: string };
        if (env.envelope_id && !seen.has(env.envelope_id)) {
          seen.add(env.envelope_id);
          merged.push(env);
        }
      } catch {
        // skip unparseable row
      }
    }
  } catch {
    // fail-soft; memory-only list.
  }
  return merged;
}

/**
 * list envelopes filtered by task_id; same live + snapshot
 * union + dedupe shape as devShellEnvelopeListFree. Snapshot scan is
 * bounded by an earlier revision K=500 retention and the LIMIT 50 ceiling.
 */
export async function devShellEnvelopeListByTaskFree(
  host: EnvelopeCrudHost,
  input: { task_id: string },
): Promise<unknown> {
  const taskId = typeof input.task_id === "string" ? input.task_id : "";
  if (!taskId) return [];
  const store = await ensureEnvelopeStoreFree(host);
  const live = store.list().filter((e) => e.task_id === taskId);
  const seen = new Set(live.map((e) => e.envelope_id));
  const merged: unknown[] = [...live];
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots
       WHERE task_id = ${taskId}
       ORDER BY created_at DESC
       LIMIT 50
    `;
    for (const row of rows) {
      try {
        const env = JSON.parse(row.payload) as { envelope_id: string };
        if (env.envelope_id && !seen.has(env.envelope_id)) {
          seen.add(env.envelope_id);
          merged.push(env);
        }
      } catch {
        // skip unparseable row
      }
    }
  } catch {
    // fail-soft; memory-only list for this task.
  }
  return merged;
}

/**
 * return the most recent terminal envelope from snapshots,
 * or null. Snapshots are authoritative for terminal status because
 * `onMutate` persists every transition.
 */
export function devShellEnvelopeGetLatestTerminalFree(
  host: EnvelopeCrudHost,
): unknown {
  try {
    const rows = host.sql<{ payload: string }>`
      SELECT payload FROM envelope_snapshots
       WHERE envelope_status IN ('sealed', 'failed')
       ORDER BY created_at DESC
       LIMIT 1
    `;
    if (rows.length > 0) {
      try { return JSON.parse(rows[0].payload); } catch { return null; }
    }
  } catch {
    // fail-soft
  }
  return null;
}

/**
 * final-reply envelope marker helpers.
 *
 * Build site: `submitTask` appends `[envelope: <id>]` to the
 * user-visible reply so the verifier / inspect endpoint can fetch the
 * sealed envelope without scraping event_log.
 *
 * Parse site: `/cli/status` extracts the marker from the most recent
 * final reply to surface drift between rendered marker and active
 * envelope id.
 *
 * Both sides MUST agree on the literal form and the regex. Co-locating
 * them here eliminates the silent drift surface that an asymmetric
 * extraction (build OR parse alone) would create.
 *
 * Out of scope : non-server marker sites in
 * `channelHub.ts`, `replyEmptyFallback.ts`, `inspectRoutes.ts`,
 * `discordDirect.ts`. Those parse the same shape but for fallback /
 * Discord-render / inspect reasons and are not part of the
 * submitTask main-chain build/parse pair. They remain untouched here
 * and are candidates for a follow-up consolidation card.
 */
const ENVELOPE_REPLY_MARKER_RE = /\[envelope:\s*(env-[a-z0-9]+-[a-z0-9]+)\s*\]/i;

export function buildEnvelopeReplyMarker(envelopeId: string): string {
  return `[envelope: ${envelopeId}]`;
}

export function parseEnvelopeReplyMarker(
  text: string | null | undefined,
): { marker: string | null; envelopeIdLower: string | null } {
  if (!text) return { marker: null, envelopeIdLower: null };
  const m = text.match(ENVELOPE_REPLY_MARKER_RE);
  if (!m) return { marker: null, envelopeIdLower: null };
  return {
    marker: `[envelope: ${m[1]}]`,
    envelopeIdLower: m[1].toLowerCase(),
  };
}

/**
 * an earlier revision read-only-safe orphan classification helper.
 *
 * The lazy sweeper (`/cli/status` path) and the alarm backstop
 * (`envelopeSweeperBackstop`) each computed the same boolean from the
 * same two inputs: the in-memory envelope and the latest
 * `submitTask.prompt.gate_intent_check` event for the task. The two
 * blocks were byte-equal modulo variable names, so any future tweak
 * (e.g. additional evidence channels, a new gate-intent shape) had to
 * be applied twice or risk asymmetric drift between the lazy and
 * alarm paths.
 *
 * Eligibility (mirrors an earlier revision invariants):
 *   1. `execution[]` empty on the persisted envelope payload.
 *   2. No `evidence.gate_logs[]` and no `evidence.diff[]`.
 *   3. A `submitTask.prompt.gate_intent_check` event for the task was
 *      logged with `detected=false`. Absence of the event is NOT
 *      eligible — pre-206a tasks fall into the strict 20-min path.
 *
 * Method bodies (`sweepStaleDraftEnvelopes`, `envelopeSweeperBackstop`)
 * stay server-side per an earlier revision §"非目标" — they are tied to DO
 * scheduler, `_finalizeTaskTurn` idempotency, fallback reply
 * enqueue, and `_ensureEnvelopeStoreSync`. Only this pure
 * classification is portable.
 *
 * Fail-soft: any sql throw collapses to `false`, keeping the orphan on
 * the strict path — same posture as the inline implementation.
 */
export function classifyReadOnlySafeOrphan(
  sql: EnvelopeOpsSqlTag,
  taskId: string,
  inMemory: EvidenceEnvelopeType | null | undefined,
): boolean {
  const noExecution = (inMemory?.execution?.length ?? 0) === 0;
  const noEvidence =
    (inMemory?.evidence?.gate_logs?.length ?? 0) === 0 &&
    (inMemory?.evidence?.diff?.length ?? 0) === 0;
  if (!noExecution || !noEvidence) return false;
  // sweeper-side prompt read-intent re-check. The
  // happy-path submitTask.finally already disqualifies read-intent
  // prompts from the read-only-safe pass . But when
  // submitTask hangs and the sweeper races ahead, that detection
  // never ran in-process. Re-derive from the `task.submitted` event
  // payload so a read-intent prompt cannot be sealed as PASS just
  // because gate-intent didn't fire and tools didn't dispatch.
  if (hasOrphanPromptReadIntent(sql, taskId)) return false;
  // sweeper-side unwrapped-mutation re-check. Same
  // failure mode as read-intent above: if a write/delete supplier
  // tool fired but the round never landed in execution, the
  // read-only-safe short-circuit must NOT pass. Re-derive from the
  // persisted `supplier.signal.summary` row(s) for this task.
  if (hasOrphanSupplierMutation(sql, taskId)) return false;
  // sweeper-side prompt mutation-intent re-check. If
  // the original prompt asked for write/delete/edit on a repo path
  // and the sweeper has zero execution + zero supplier mutation
  // dispatch, the read-only-safe pass would seal a fabricated
  // mutation narrative as PASS. Re-derive from the `task.submitted`
  // event payload so a mutation-intent prompt cannot short-circuit.
  if (hasOrphanPromptMutationIntent(sql, taskId)) return false;
  let promptGateIntentLogged = false;
  let promptGateIntentDetected = false;
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const intentRows = sql<{ payload: string }>`
      SELECT payload FROM event_log
       WHERE event_type = 'submitTask.prompt.gate_intent_check'
         AND payload LIKE ${taskIdLike}
       ORDER BY created_at DESC LIMIT 1
    `;
    if (intentRows.length > 0) {
      promptGateIntentLogged = true;
      try {
        const obj = JSON.parse(intentRows[0].payload) as { detected?: boolean };
        promptGateIntentDetected = obj.detected === true;
      } catch { /* unparseable payload — leave detected=false */ }
    }
  } catch { /* fail-soft — defaults keep this orphan on the strict path */ }
  return promptGateIntentLogged && !promptGateIntentDetected;
}

/**
 * sweeper-side read-intent detection on the original
 * prompt. Returns true iff the most recent `task.submitted` event for
 * `taskId` carries a `task` text whose prompt matches `detectReadIntent`.
 * Used by `classifyReadOnlySafeOrphan` to disqualify read-intent
 * orphans from the read-only-safe pass, and by the sweeper call into
 * `_finalizeTaskTurn` to thread `readIntentObserved: true` through to
 * `EvidenceEnvelope.seal` so the strict-ring fail emits the dedicated
 * `read_intent_no_execution` reason — matching the contract that
 * submitTask.finally enforces .
 *
 * Fail-soft: any SQL / JSON / regex throw returns `false`, which means
 * the sweeper falls back to the conservative strict path (still safe,
 * just doesn't get the dedicated reason).
 */
/**
 * supplier-side mutation tool names the Think
 * `createWorkspaceTools` factory exposes. These are dispatched at
 * the top level of `streamText({tools})` (not inside codemode), and
 * when the agent has no envelope-wrapped mapping for them (compare
 * to the contract-registry `repo.write` / `repo.delete`), the call
 * succeeds at the file system layer but leaves no auditable
 * execution[] entry on the envelope.
 *
 * Single source of truth for the `submitTask.finally` (happy-path)
 * + sweeper detectors + the smoke regression that asserts every
 * supplier mutation tool surface is covered.
 */
export const SUPPLIER_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "delete",
  "edit",
]);

/**
 * sweeper-side detection mirror for unwrapped mutation
 * tool calls. Returns true iff any persisted `supplier.signal.summary`
 * row for `taskId` records a step whose `toolCallNames` includes a
 * Think-workspace mutation tool. Used by `classifyReadOnlySafeOrphan`
 * to disqualify the read-only-safe pass, and threaded through to
 * `EvidenceEnvelope.seal` so the strict-ring fail emits
 * `mutation_intent_unwrapped_execution` — matching the contract that
 * submitTask.finally enforces.
 *
 * Fail-soft: any SQL / JSON throw returns `false`, leaving the orphan
 * on the strict ring-presence path (still safe — a missing-execution
 * envelope still fails, just without the dedicated reason).
 */
export function hasOrphanSupplierMutation(
  sql: EnvelopeOpsSqlTag,
  taskId: string,
): boolean {
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const rows = sql<{ payload: string }>`
      SELECT payload FROM event_log
       WHERE event_type = 'supplier.signal.summary'
         AND payload LIKE ${taskIdLike}
       ORDER BY created_at DESC
    `;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as {
          steps?: Array<{ toolCallNames?: unknown }>;
        };
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        for (const step of steps) {
          const names = Array.isArray(step.toolCallNames) ? step.toolCallNames : [];
          for (const n of names) {
            if (typeof n === "string" && SUPPLIER_MUTATION_TOOL_NAMES.has(n)) {
              return true;
            }
          }
        }
      } catch { /* unparseable row — try next */ }
    }
    return false;
  } catch {
    return false;
  }
}

export function hasOrphanPromptReadIntent(
  sql: EnvelopeOpsSqlTag,
  taskId: string,
): boolean {
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const rows = sql<{ payload: string }>`
      SELECT payload FROM event_log
       WHERE event_type = 'task.submitted'
         AND payload LIKE ${taskIdLike}
       ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) return false;
    const parsed = JSON.parse(rows[0].payload) as {
      task?: unknown;
      taskPrompt?: unknown;
    };
    // Detect on BOTH fields and OR the results. `task`
    // is the human-visible display (an earlier revision, equals what
    // submitTask.finally runs against). `taskPrompt` is the richer
    // framed version (only present when `display !== task`, e.g.
    // Discord channel metadata + verifier framing prefixed to a
    // read prompt). Mixed/framing prompts can land on either field
    // depending on `display`/`task` divergence and resubmit row
    // ordering (`ORDER BY created_at DESC LIMIT 1` may pick a later
    // submit's row whose `display` no longer carries the read intent
    // even though the original framed prompt did). A union match is
    // strictly more permissive than the previous priority/fallback
    // and aligns this sweeper with the happy-path detector's intent.
    const taskText = typeof parsed.task === "string" ? parsed.task : "";
    const taskPromptText = typeof parsed.taskPrompt === "string" ? parsed.taskPrompt : "";
    if (!taskText && !taskPromptText) return false;
    return (taskText !== "" && detectReadIntent(taskText).detected)
      || (taskPromptText !== "" && detectReadIntent(taskPromptText).detected);
  } catch {
    return false;
  }
}

/**
 * sweeper-side prompt mutation-intent detection mirror.
 * Returns true iff the most recent `task.submitted` event for
 * `taskId` carries a prompt that matches `detectMutationIntent`.
 * Used by `classifyReadOnlySafeOrphan` to disqualify mutation-intent
 * orphans from the read-only-safe pass, and threaded through to
 * `EvidenceEnvelope.seal` via `mutationIntentNoExecution` so the
 * strict-ring fail emits the dedicated `mutation_intent_no_execution`
 * reason — matching the contract that submitTask.finally enforces.
 *
 * Fail-soft: any SQL / JSON / regex throw returns `false`, leaving the
 * orphan on the strict path (still safe — a missing-execution envelope
 * still fails, just without the dedicated reason).
 */
export function hasOrphanPromptMutationIntent(
  sql: EnvelopeOpsSqlTag,
  taskId: string,
): boolean {
  try {
    const taskIdLike = `%"taskId":"${taskId}"%`;
    const rows = sql<{ payload: string }>`
      SELECT payload FROM event_log
       WHERE event_type = 'task.submitted'
         AND payload LIKE ${taskIdLike}
       ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) return false;
    const parsed = JSON.parse(rows[0].payload) as {
      task?: unknown;
      taskPrompt?: unknown;
    };
    const promptText =
      typeof parsed.task === "string"
        ? parsed.task
        : typeof parsed.taskPrompt === "string"
          ? parsed.taskPrompt
          : "";
    if (!promptText) return false;
    return detectMutationIntent(promptText).detected;
  } catch {
    return false;
  }
}
