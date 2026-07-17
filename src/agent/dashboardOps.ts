/**
 * Step 9 dashboard core extraction.
 *
 * `getDashboardCoreFree` is the body of `AgentThursdayAgent.getDashboardCore`
 * lifted verbatim from `src/server.ts` (pre-extraction lines
 * 4486-4583). The `@callable()` decorator stays on the thin delegate
 * in `server.ts`; the RPC surface is unchanged.
 *
 * See:
 *
 * Host shape is intentionally narrow — eight capabilities only, and
 * **never** `AgentThursdayAgent` itself (verifier AC 5 bullet 3):
 *
 *   - `sql`                                 — typed template-tag access
 *                                              to four COUNT(*) queries
 *                                              over `checkpoints`,
 *                                              `review_notes`, and
 *                                              `kanban_mutations`.
 *                                              SQL strings, table names,
 *                                              column names, ordering,
 *                                              and limits are
 *                                              byte-identical to the
 *                                              pre-extraction body.
 *   - `getSafeState`                        — current `AgentThursdayState`,
 *                                              source of
 *                                              `currentTaskObject`,
 *                                              `lastActionResult`,
 *                                              `waitingForHuman`,
 *                                              `currentObstacle`.
 *   - `getCliSession`                       — `CliSession` snapshot
 *                                              (the dashboard reads
 *                                              `taskId`, `taskLifecycle`,
 *                                              `loopStage`,
 *                                              `readyForNextRound`).
 *                                              `session.taskId` is the
 *                                              canonical taskId source
 *                                              here, NOT
 *                                              `s.currentTaskObject?.id`
 *                                              — sibling methods use
 *                                              the latter, but
 *                                              `getDashboardCore` uses
 *                                              `session.taskId`
 *                                              (preserved verbatim).
 *   - `getNewestEnvelopeForTask`            — composed envelope-store +
 *                                              snapshot-table walk
 *                                              behind a single accessor;
 *                                              read-only. Returns the
 *                                              newest `EvidenceEnvelope`
 *                                              for the bound task or
 *                                              `null`.
 *   - `getCurrentTaskFinalReply`            — last assistant final-text
 *                                              for the bound task,
 *                                              capped at `maxLen=4000`
 *                                              **literal** (the
 *                                              composition-root method
 *                                              defaults to 200 elsewhere
 *                                              — dashboard core must
 *                                              keep 4000 to preserve
 *                                              marker-detection
 *                                              behaviour on long
 *                                              replies).
 *   - `hasSealedPassEnvelopeForCurrentTask` — an earlier revision newest-
 *                                              envelope acceptance
 *                                              check. Drives the
 *                                              `envelopeAccepted` /
 *                                              `gateOpen` lattice and
 *                                              the
 *                                              `ready_false_after_handled_fail`
 *                                              drift trigger.
 *   - `isHandledNoToolGateIntentFail`       — an earlier revision handled-but-
 *                                              failed signal. Drives
 *                                              `handledNoToolFail` and
 *                                              the
 *                                              `ready_false_after_handled_fail`
 *                                              drift flag (when
 *                                              `!session.readyForNextRound`).
 *   - `instanceName`                        — `AgentThursdayAgent.name` (the
 *                                              DO base property
 *                                              populated by the
 *                                              `getAgentByName` resolve)
 *                                              flattened to a string so
 *                                              the Host does not see the
 *                                              full Agent.
 *
 * Closed drift-flag whitelist (push order preserved byte-equivalent):
 *   1. `ready_false_after_handled_fail`
 *   2. `marker_missing`
 *   3. `envelope_orphan`
 *   4. `marker_mismatch`
 *
 * Outbox-derived drift flags (`outbox_missing`,
 * `outbox_provider_error`, `patch_apply_outbox_unknown`) are appended
 * inside `buildDashboardSectionFree` further down in this module
 * (an earlier revision extracted that body from `src/server.ts` as well).
 *
 * `AgentThursdayAgent` is never imported here (AC 5 bullet 3); smoke
 * `card300-dashboard-core-extraction-smoke.ts` verifies the cycle stays
 * broken via dynamic import.
 */

import type { EvidenceEnvelope as EvidenceEnvelopeType } from "../skillset/evidenceEnvelope";
import type { CliSession, AgentThursdayState } from "../types";
import type { DashboardCore, DashboardSection, DashboardVersion } from "./dashboardTypes";
import { parseEnvelopeReplyMarker } from "./envelopeOps";

export type DashboardOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface DashboardCoreHost {
  sql: DashboardOpsSqlTag;
  getSafeState: () => AgentThursdayState;
  getCliSession: () => CliSession;
  getNewestEnvelopeForTask: (taskId: string) => EvidenceEnvelopeType | null;
  getCurrentTaskFinalReply: (taskId: string | null | undefined, maxLen?: number) => string | null;
  hasSealedPassEnvelopeForCurrentTask: (taskId: string | null | undefined) => boolean;
  isHandledNoToolGateIntentFail: (taskId: string | null | undefined) => boolean;
  instanceName: string;
}

export function getDashboardCoreFree(host: DashboardCoreHost): DashboardCore {
  const session = host.getCliSession();
  const taskId = session.taskId;

  let latestEnvelope: {
    envelope_id: string;
    task_id: string;
    envelope_status: string;
    verdict: string | null;
    started_at: string;
  } | null = null;
  if (taskId) {
    const newest = host.getNewestEnvelopeForTask(taskId);
    if (newest) {
      latestEnvelope = {
        envelope_id: newest.envelope_id,
        task_id: newest.task_id,
        envelope_status: newest.envelope_status,
        verdict: newest.self_verify?.verdict ?? null,
        started_at: newest.timestamps.started_at,
      };
    }
  }

  const lastReply = host.getCurrentTaskFinalReply(taskId, 4000);
  const { marker: lastFinalReplyMarker, envelopeIdLower: lastFinalReplyMarkerEnv } =
    parseEnvelopeReplyMarker(lastReply);

  const s = host.getSafeState();
  const lar = s.lastActionResult;
  const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;
  const ckptCount  = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const noteCount  = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const appliedMut = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const pendingMut = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
  const envelopeAccepted = host.hasSealedPassEnvelopeForCurrentTask(taskId);
  const handledNoToolFail = host.isHandledNoToolGateIntentFail(taskId);
  const hasArtifact = envelopeAccepted || handledNoToolFail || ckptCount > 0 || noteCount > 0 || appliedMut > 0;
  const noBlockers = !s.waitingForHuman && !(s.currentObstacle?.blocked);
  const gateOpen = (envelopeAccepted || handledNoToolFail || lar?.outcome === "success") && hasArtifact && noBlockers;
  const activeInterventionCount = [s.waitingForHuman, !!(s.currentObstacle?.blocked), pendingMut > 0, !gateOpen].filter(Boolean).length;

  const driftFlags: string[] = [];

  if (handledNoToolFail && !session.readyForNextRound) {
    driftFlags.push("ready_false_after_handled_fail");
  }

  if (latestEnvelope
      && (latestEnvelope.envelope_status === "sealed" || latestEnvelope.envelope_status === "failed")
      && lastReply
      && !lastFinalReplyMarkerEnv) {
    driftFlags.push("marker_missing");
  }

  if (latestEnvelope && taskId && latestEnvelope.task_id !== taskId) {
    driftFlags.push("envelope_orphan");
  }

  if (latestEnvelope
      && lastFinalReplyMarkerEnv
      && lastFinalReplyMarkerEnv !== latestEnvelope.envelope_id.toLowerCase()) {
    driftFlags.push("marker_mismatch");
  }

  return {
    current_task: {
      task_id: taskId,
      task_lifecycle: session.taskLifecycle,
      loop_stage: session.loopStage,
      ready_for_next_round: session.readyForNextRound,
      active_intervention_count: activeInterventionCount,
      last_final_reply_marker: lastFinalReplyMarker,
    },
    latest_envelope: latestEnvelope,
    drift_flags: driftFlags,
    instance_name: host.instanceName,
  };
}

/**
 * Step 9 dashboard section extraction.
 *
 * `buildDashboardSectionFree` is the body of the top-level
 * `buildDashboardSection(env, core)` lifted verbatim from `src/server.ts`
 * (pre-extraction lines 344-434). The composition root constructs
 * `DashboardSectionDeps` from the `Env` it owns; this module never
 * touches `Env`, `AgentThursdayAgent`, or `getAgentByName` directly.
 *
 * Deps shape — two callbacks only:
 *
 *   - `getChannelHubStub`           — async resolver returning a stub
 *                                      narrowed to the two outbox
 *                                      methods this composer reads
 *                                      (`inspectOutbox`,
 *                                      `getLatestPatchApplyOutboxSummary`).
 *                                      Invoked twice — once per
 *                                      cross-DO call — preserving the
 *                                      two original `getAgentByName`
 *                                      sites byte-equivalent.
 *   - `readWorkerVersionMetadata`   — closure over `env`; returns the
 *                                      three CF `version_metadata`
 *                                      fields with per-field null
 *                                      guards (delegates to the
 *                                      existing helper in
 *                                      `./dashboardHelpers`).
 *
 * Closed route-layer drift-flag whitelist (push order preserved
 * byte-equivalent):
 *   1. `outbox_missing`
 *   2. `outbox_provider_error`
 *   3. `patch_apply_outbox_unknown`
 *
 * Fail-soft asymmetry preserved:
 *   - outbox inspect catch → `latest_outbox = "unknown"`, NO drift flag
 *   - patch-apply summary catch → `patch_apply_outbox = "unknown"` AND
 *     push `patch_apply_outbox_unknown`
 *
 * `service_version: "0.1.0"` stays inline (composer constant, not a
 * dep). `Array.from(new Set(driftFlags))` defensive dedupe preserved.
 *
 * `AgentThursdayAgent` / `Env` / `getAgentByName` are never referenced here
 * (AC 6 bullet 4); smoke
 * `card301-dashboard-section-extraction-smoke.ts` verifies the module
 * does not export `AgentThursdayAgent`.
 */

export interface ChannelHubOutboxStub {
  inspectOutbox(input: {
    marker?: string;
    envelope_id?: string;
    outbox_id?: string;
    conversation_id?: string;
    limit?: number;
  }): Promise<{
    rows: Array<{
      outbox_id: string;
      provider: string;
      status: string;
      kind: string | null;
      has_error: boolean;
      created_at: number;
      envelope_markers: string[];
    }>;
  }>;
  getLatestPatchApplyOutboxSummary(): Promise<
    | { status: "missing" }
    | {
        status: "ready";
        outbox_id: string;
        event_id: string;
        artifact_id: string;
        apply_status: string;
        error_code: string | null;
        delivery_status: string;
        created_at: number;
        gate_required: boolean;
        dry_run_unavailable: boolean;
        dry_run_exit_code: number | null;
        head_sha: string | null;
        matches_event: boolean;
      }
  >;
}

export interface DashboardSectionDeps {
  getChannelHubStub: () => Promise<ChannelHubOutboxStub>;
  readWorkerVersionMetadata: () => Pick<
    DashboardVersion,
    "worker_version_id" | "worker_version_tag" | "worker_version_timestamp"
  >;
}

export async function buildDashboardSectionFree(
  deps: DashboardSectionDeps,
  core: DashboardCore,
): Promise<DashboardSection> {
  const driftFlags = [...core.drift_flags];
  let latestOutbox: DashboardSection["latest_outbox"] = "unknown";
  let patchApplyOutbox: DashboardSection["patch_apply_outbox"] = "unknown";

  if (core.latest_envelope) {
    try {
      const channelStub = await deps.getChannelHubStub();
      const result = await channelStub.inspectOutbox({
        envelope_id: core.latest_envelope.envelope_id,
        limit: 1,
      });
      const row = result.rows[0];
      if (!row) {
        latestOutbox = "missing";
        if (
          core.latest_envelope.envelope_status === "sealed" ||
          core.latest_envelope.envelope_status === "failed"
        ) {
          driftFlags.push("outbox_missing");
        }
      } else {
        const matches = row.envelope_markers.includes(
          core.latest_envelope.envelope_id.toLowerCase(),
        );
        latestOutbox = {
          outbox_id: row.outbox_id,
          provider: row.provider,
          status: row.status,
          kind: row.kind,
          has_error: row.has_error,
          matches_envelope: matches,
          created_at: row.created_at,
        };
        if (row.has_error) driftFlags.push("outbox_provider_error");
      }
    } catch {
      latestOutbox = "unknown";
    }
  }

  // patch-apply outbox summary is envelope-independent
  // (apply evidence persists across envelope/task scope). Always
  // attempt the cross-DO read; fail-soft to "unknown" + drift flag.
  try {
    const channelStub = await deps.getChannelHubStub();
    const summary = await channelStub.getLatestPatchApplyOutboxSummary();
    if (summary.status === "missing") {
      patchApplyOutbox = "missing";
    } else {
      patchApplyOutbox = {
        outbox_id: summary.outbox_id,
        event_id: summary.event_id,
        artifact_id: summary.artifact_id,
        apply_status: summary.apply_status,
        error_code: summary.error_code,
        delivery_status: summary.delivery_status,
        created_at: summary.created_at,
        gate_required: summary.gate_required,
        dry_run_unavailable: summary.dry_run_unavailable,
        dry_run_exit_code: summary.dry_run_exit_code,
        head_sha: summary.head_sha,
        matches_event: summary.matches_event,
      };
    }
  } catch {
    patchApplyOutbox = "unknown";
    driftFlags.push("patch_apply_outbox_unknown");
  }

  const dedupedDriftFlags = Array.from(new Set(driftFlags));

  return {
    current_task: core.current_task,
    latest_envelope: core.latest_envelope,
    latest_outbox: latestOutbox,
    patch_apply_outbox: patchApplyOutbox,
    drift_flags: dedupedDriftFlags,
    version: {
      instance_name: core.instance_name,
      service_version: "0.1.0",
      ...deps.readWorkerVersionMetadata(),
    },
  };
}
