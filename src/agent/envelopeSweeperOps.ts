/**
 * Envelope sweeper orchestration — extracted from `server.ts` `AgentThursdayAgent`
 * (Card: server.ts LoC reduction, 2026-06-16). PURE MOVE: the two method
 * bodies (`sweepStaleDraftEnvelopes` lazy sweep + `envelopeSweeperBackstop`
 * alarm seal) are copied verbatim with `this.<x>` → `host.<x>`; no logic,
 * threshold, verdict, or event-name change. The decidable logic
 * (`classifyReadOnlySafeOrphan`, `hasOrphan*`, `decideSweeperExtension`) was
 * already pure in `envelopeOps`; this only lifts the SQL + finalize-callback
 * wiring behind a host interface so `server.ts` keeps thin delegators.
 *
 * `server.ts` imports `agents` (→ cloudflare:workers) transitively, so this
 * module stays node-importable: only `import type` from runtime-bearing
 * modules (erased at compile time) plus the already-pure `envelopeOps`.
 */
import {
  type EnvelopeStoreHost,
  ENVELOPE_SWEEPER_EXTENSION_DELAY_S,
  ENVELOPE_SWEEPER_LAZY_THRESHOLD_MS,
  ENVELOPE_SWEEPER_READ_ONLY_THRESHOLD_MS,
  decideSweeperExtension,
  classifyReadOnlySafeOrphan,
  hasOrphanPromptReadIntent,
  hasOrphanSupplierMutation,
  hasOrphanPromptMutationIntent,
} from "./envelopeOps";
import type {
  EnvelopeStore as EnvelopeStoreType,
  EvidenceEnvelope as EvidenceEnvelopeType,
} from "../skillset/evidenceEnvelope";

/** Opts the sweeper passes to `_finalizeTaskTurn` (a subset of its full opts). */
export interface SweeperFinalizeOpts {
  taskId: string;
  envelopeId: string;
  source: string;
  readOnlySafe: boolean;
  readIntentObserved: boolean;
  mutationIntentObservedUnwrapped: boolean;
  mutationIntentNoExecution: boolean;
  mutationToolsExpected: boolean;
}

/** Result shape the sweeper reads from `_finalizeTaskTurn`. */
export interface SweeperFinalizeResult {
  sealed: boolean;
  envelopeStatus: "sealed" | "failed" | "draft" | null;
  verdict?: string;
  verdictReason?: string;
  idempotentNoop: boolean;
}

/** I/O the sweeper needs from the `AgentThursdayAgent` DO (the established host pattern). */
export interface EnvelopeSweeperHost {
  sql: EnvelopeStoreHost["sql"];
  ensureEnvelopeStore: () => EnvelopeStoreType;
  finalizeTaskTurn: (opts: SweeperFinalizeOpts) => SweeperFinalizeResult;
  finalizeTaskLifecycleIfNeeded: (
    taskId: string,
    source: string,
    opts: { envelopeVerdict: "pass" | "partial" | "fail" | null },
  ) => void;
  enqueueChannelHubFallbackReply: (
    taskId: string,
    envelopeId: string,
    verdictReason?: string,
  ) => Promise<void>;
  logEvent: (eventType: string, payload: Record<string, unknown>) => void;
  schedule: (seconds: number, method: string, payload: unknown) => Promise<unknown>;
}

export interface SweepStaleDraftEnvelopesResult {
  scanned: number;
  finalized: Array<{ envelope_id: string; task_id: string; status: string; verdict: string | null; idempotent: boolean; readOnlySafe: boolean }>;
  threshold_ms: number;
  read_only_threshold_ms: number;
  source: string;
}

export async function sweepStaleDraftEnvelopesFree(
  host: EnvelopeSweeperHost,
  input?: { thresholdMs?: number; source?: string },
): Promise<SweepStaleDraftEnvelopesResult> {
  const thresholdMs = input?.thresholdMs ?? ENVELOPE_SWEEPER_LAZY_THRESHOLD_MS;
  // read-only-safe orphan drafts get a much shorter
  // cutoff. Pull at the lower threshold so both tiers are
  // discoverable in one pass; per-row classification decides which
  // cutoff each row must clear.
  const readOnlyThresholdMs = Math.min(
    thresholdMs,
    ENVELOPE_SWEEPER_READ_ONLY_THRESHOLD_MS,
  );
  const source = input?.source ?? "manual";
  const nowMs = Date.now();
  const strictCutoffMs = nowMs - thresholdMs;
  const readOnlyCutoffIso = new Date(nowMs - readOnlyThresholdMs).toISOString();
  let rows: Array<{ envelope_id: string; task_id: string; payload: string; started_at: string }> = [];
  try {
    rows = host.sql<{ envelope_id: string; task_id: string; payload: string; started_at: string }>`
      SELECT envelope_id, task_id, payload, started_at FROM envelope_snapshots
       WHERE envelope_status = 'draft' AND started_at < ${readOnlyCutoffIso}
       ORDER BY started_at ASC LIMIT 20
    `;
  } catch {
    // fail-soft — return empty summary
    return {
      scanned: 0,
      finalized: [],
      threshold_ms: thresholdMs,
      read_only_threshold_ms: readOnlyThresholdMs,
      source,
    };
  }
  const store = host.ensureEnvelopeStore();
  const finalized: Array<{ envelope_id: string; task_id: string; status: string; verdict: string | null; idempotent: boolean; readOnlySafe: boolean }> = [];
  for (const row of rows) {
    try {
      if (!store.get(row.envelope_id)) {
        try {
          const restored = JSON.parse(row.payload) as EvidenceEnvelopeType;
          store.adopt(restored);
        } catch {
          continue;
        }
      }
      // classify orphan as read-only-safe iff:
      //   (1) execution[] empty AND no gate/diff evidence on the
      //       persisted envelope payload (parsed-once for cheapness);
      //   (2) `submitTask.prompt.gate_intent_check` event for this
      //       task was logged with detected=false. Absence of the
      //       event is treated as NOT eligible — pre-206a tasks fall
      //       into the strict 20-min path.
      // If not eligible AND younger than the strict cutoff, skip
      // this row entirely so a healthy in-flight turn (running
      // gates, sandbox cold-start, etc.) is not pre-empted.
      const startedAtMs = Date.parse(row.started_at);
      const passedStrictCutoff = !Number.isNaN(startedAtMs) && startedAtMs < strictCutoffMs;
      const inMemory = store.get(row.envelope_id);
      const readOnlySafeOrphan = classifyReadOnlySafeOrphan(host.sql, row.task_id, inMemory);
      if (!readOnlySafeOrphan && !passedStrictCutoff) {
        continue;
      }
      // when the orphan's original prompt asked for a
      // file read, thread `readIntentObserved: true` into seal so
      // the sweeper path emits the same `read_intent_no_execution`
      // verdict reason that submitTask.finally would have ,
      // instead of the strict-ring generic missing-rings reason.
      const readIntentObservedForOrphan = hasOrphanPromptReadIntent(
        host.sql,
        row.task_id,
      );
      // same sweeper-side mirror for unwrapped mutation.
      // Persisted `supplier.signal.summary` rows are the system of
      // record; if any step's toolCallNames contained a
      // SUPPLIER_MUTATION_TOOL_NAMES entry, thread the flag through
      // so seal emits `mutation_intent_unwrapped_execution`.
      const mutationObservedForOrphan = hasOrphanSupplierMutation(
        host.sql,
        row.task_id,
      );
      // sweeper-side prompt mutation-intent mirror. When
      // the original prompt declared mutation intent and no supplier
      // mutation tool fired (mutationObservedForOrphan === false),
      // thread the flag through so seal emits
      // `mutation_intent_no_execution`. The two mutation flags are
      // mutually exclusive at seal-time (295d's
      // `mutation_intent_unwrapped_execution` takes precedence).
      // an earlier revision C — sweeper mirror: thread the prompt-side mutation
      // intent so seal emits `missing_mutation_evidence` whenever the
      // execution ring lacks `repo.write` / `repo.patch`. This is the
      // generalisation of 295e (subsumes the empty-execution subcase)
      // and the new gate for the read-only-only execution shape.
      const promptMutationIntentForOrphan = hasOrphanPromptMutationIntent(
        host.sql,
        row.task_id,
      );
      const mutationIntentNoExecutionForOrphan =
        !mutationObservedForOrphan && promptMutationIntentForOrphan;
      const result = host.finalizeTaskTurn({
        taskId: row.task_id,
        envelopeId: row.envelope_id,
        source: `sweeper.${source}`,
        readOnlySafe: readOnlySafeOrphan,
        readIntentObserved: readIntentObservedForOrphan,
        mutationIntentObservedUnwrapped: mutationObservedForOrphan,
        mutationIntentNoExecution: mutationIntentNoExecutionForOrphan,
        mutationToolsExpected: promptMutationIntentForOrphan,
      });
      if (result.sealed || result.idempotentNoop) {
        host.finalizeTaskLifecycleIfNeeded(row.task_id, `sweeper.${source}`, {
          envelopeVerdict: (result.verdict as "pass" | "partial" | "fail" | undefined) ?? null,
        });
        finalized.push({
          envelope_id: row.envelope_id,
          task_id: row.task_id,
          status: result.envelopeStatus ?? "unknown",
          verdict: result.verdict ?? null,
          idempotent: result.idempotentNoop,
          readOnlySafe: readOnlySafeOrphan,
        });
        // Only fire the system fallback reply when the sweeper
        // actually performed the seal this run. An idempotent noop
        // means a previous path already finalized — and either the
        // happy path emitted a real LLM reply, or a prior sweeper
        // run already enqueued the fallback. Either way, don't
        // double-enqueue. The ChannelHub side has its own marker
        // dedupe, but this guard avoids a needless RPC.
        if (result.sealed && !result.idempotentNoop) {
          await host.enqueueChannelHubFallbackReply(row.task_id, row.envelope_id, result.verdictReason);
        }
      }
    } catch {
      // fail-soft per row
    }
  }
  try {
    host.logEvent("evidence.envelope.sweeper.run", {
      source,
      scanned: rows.length,
      finalized_count: finalized.length,
      threshold_ms: thresholdMs,
      read_only_threshold_ms: readOnlyThresholdMs,
      read_only_safe_count: finalized.filter(f => f.readOnlySafe).length,
    });
  } catch {
    // fail-soft
  }
  return {
    scanned: rows.length,
    finalized,
    threshold_ms: thresholdMs,
    read_only_threshold_ms: readOnlyThresholdMs,
    source,
  };
}

export async function envelopeSweeperBackstopFree(
  host: EnvelopeSweeperHost,
  payload: { envelopeId: string; taskId: string; extensions?: number } | undefined,
  _schedule: unknown,
): Promise<void> {
  if (!payload || typeof payload.envelopeId !== "string" || typeof payload.taskId !== "string") {
    return;
  }
  // gate-aware grace: a recent `tool.%` event means the
  // turn is actively working (e.g. a gate chain), not hung. Defer the
  // seal one window, bounded by ENVELOPE_SWEEPER_MAX_EXTENSIONS.
  // Any probe/schedule throw falls through to the normal seal path.
  try {
    const extensions = typeof payload.extensions === "number" ? payload.extensions : 0;
    const rows = host.sql<{ created_at: number }>`
      SELECT created_at FROM event_log WHERE event_type LIKE 'tool.%' ORDER BY id DESC LIMIT 1
    `;
    const decision = decideSweeperExtension({
      extensions,
      lastToolEventAt: rows.length > 0 ? rows[0].created_at : null,
      now: Date.now(),
    });
    if (decision.extend) {
      await host.schedule(ENVELOPE_SWEEPER_EXTENSION_DELAY_S, "envelopeSweeperBackstop", {
        envelopeId: payload.envelopeId,
        taskId: payload.taskId,
        extensions: decision.nextExtensions,
      });
      host.logEvent("evidence.envelope.sweeper.extended", {
        envelope_id: payload.envelopeId,
        task_id: payload.taskId,
        extensions: decision.nextExtensions,
        last_tool_event_age_ms: decision.lastToolEventAgeMs,
      });
      return;
    }
  } catch { /* fail-soft → normal seal path */ }
  try {
    // mirror the lazy sweeper's read-only-orphan
    // classification so a hung read-only turn that survives until
    // the 30-min alarm still seals as `pass + read_only_no_action_required`
    // rather than `fail`. Strict ring-presence path still applies
    // when the prompt had gate intent or any tool actually
    // dispatched (an earlier revision invariant).
    const store = host.ensureEnvelopeStore();
    let inMemory = store.get(payload.envelopeId);
    if (!inMemory) {
      try {
        const rows = host.sql<{ payload: string }>`
          SELECT payload FROM envelope_snapshots WHERE envelope_id = ${payload.envelopeId} LIMIT 1
        `;
        if (rows.length > 0) {
          try {
            const restored = JSON.parse(rows[0].payload) as EvidenceEnvelopeType;
            store.adopt(restored);
            inMemory = store.get(payload.envelopeId);
          } catch { /* unparseable — strict path */ }
        }
      } catch { /* fail-soft */ }
    }
    const readOnlySafeOrphan = classifyReadOnlySafeOrphan(host.sql, payload.taskId, inMemory);
    // sweeper-alarm path mirrors the lazy-sweeper read-
    // intent thread-through so an alarm-driven seal of a read-intent
    // orphan still emits the dedicated verdict reason.
    const readIntentObservedForOrphan = hasOrphanPromptReadIntent(
      host.sql,
      payload.taskId,
    );
    // sweeper-alarm path likewise mirrors the lazy
    // sweeper's unwrapped-mutation detection.
    const mutationObservedForOrphan = hasOrphanSupplierMutation(
      host.sql,
      payload.taskId,
    );
    // sweeper-alarm mirror for prompt mutation-intent
    // no-execution. Same mutual-exclusivity guard as the lazy path.
    // an earlier revision C — same sweeper mirror as the lazy path.
    const promptMutationIntentForOrphan = hasOrphanPromptMutationIntent(
      host.sql,
      payload.taskId,
    );
    const mutationIntentNoExecutionForOrphan =
      !mutationObservedForOrphan && promptMutationIntentForOrphan;
    const result = host.finalizeTaskTurn({
      taskId: payload.taskId,
      envelopeId: payload.envelopeId,
      source: "sweeper.alarm",
      readOnlySafe: readOnlySafeOrphan,
      readIntentObserved: readIntentObservedForOrphan,
      mutationIntentObservedUnwrapped: mutationObservedForOrphan,
      mutationIntentNoExecution: mutationIntentNoExecutionForOrphan,
      mutationToolsExpected: promptMutationIntentForOrphan,
    });
    if (result.sealed || result.idempotentNoop) {
      host.finalizeTaskLifecycleIfNeeded(payload.taskId, "sweeper.alarm", {
        envelopeVerdict: (result.verdict as "pass" | "partial" | "fail" | undefined) ?? null,
      });
    }
    if (result.sealed && !result.idempotentNoop) {
      await host.enqueueChannelHubFallbackReply(payload.taskId, payload.envelopeId, result.verdictReason);
    }
    try {
      host.logEvent("evidence.envelope.sweeper.alarm.run", {
        envelope_id: payload.envelopeId,
        task_id: payload.taskId,
        status: result.envelopeStatus ?? "unknown",
        idempotent: result.idempotentNoop,
      });
    } catch { /* fail-soft */ }
  } catch { /* fail-soft */ }
}
