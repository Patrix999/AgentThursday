/**
 *  — `ChannelHubAgent` patch-apply inspect helpers, extracted
 * from `src/channelHub.ts`.
 *
 * Pure SELECT + row-map for the three read-only inspect surfaces over
 * `patch_apply_events` / `patch_apply_outbox`. Decorators + public
 * method signatures remain on `ChannelHubAgent`; only the bodies
 * delegate here.
 *
 * Redaction contract preserved verbatim: no `patch_text`, no raw token,
 * no raw signature, no auth header, no worker secret. The on-disk
 * tables never stored those.
 *
 * Write surfaces (`applyPatchDryRun`, `writePatchApplyOutbox`) are NOT
 * extracted in this card — they touch env / sandbox / multi-site write
 * paths and stay inline for behavior-preserving safety.  is
 * read-side only on the apply boundary; the only write extracted here
 * is `proposePatchArtifactImpl` in `patchArtifacts.ts`, which is its
 * own self-contained INSERT.
 */

import type { Agent } from "agents";
import { ARTIFACT_ID_RE } from "../skillset/patchPolicy";
import {
  type PatchApplyEventInspectRow,
  type PatchApplyOutboxInspectRow,
  safeParseArray,
} from "./mappers";

export type ChannelHubPatchApplyHost = Agent<Env, Record<string, never>>;

export type InspectPatchApplyEventsInput = {
  event_id?: string;
  artifact_id?: string;
  limit?: number;
};

export function inspectPatchApplyEventsImpl(
  agent: ChannelHubPatchApplyHost,
  input: InspectPatchApplyEventsInput,
): { rows: PatchApplyEventInspectRow[] } {
  const EVENT_ID_RE = /^evt_apply_[a-f0-9]{16}$/i;
  const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  type EventQRow = {
    event_id: string;
    event_type: string;
    artifact_id: string;
    token_id: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    target_paths: string;
    declared_paths_in_diff: string | null;
    hunks_parsed: number | null;
    status: string;
    dry_run_exit_code: number | null;
    head_sha: string | null;
    error_code: string | null;
    gate_required: number;
    dry_run_unavailable: number;
    created_at: number;
  };

  let rows: EventQRow[] = [];
  if (typeof input.event_id === "string" && input.event_id.length > 0) {
    if (!EVENT_ID_RE.test(input.event_id)) return { rows: [] };
    rows = agent.sql<EventQRow>`
      SELECT event_id, event_type, artifact_id, token_id, agent_id, tool_id,
             input_hash, target_paths, declared_paths_in_diff, hunks_parsed,
             status, error_code, gate_required, dry_run_unavailable, created_at,
             dry_run_exit_code, head_sha
      FROM patch_apply_events
      WHERE event_id = ${input.event_id}
      LIMIT 1
    `;
  } else if (typeof input.artifact_id === "string" && input.artifact_id.length > 0) {
    if (!ARTIFACT_ID_RE.test(input.artifact_id)) return { rows: [] };
    rows = agent.sql<EventQRow>`
      SELECT event_id, event_type, artifact_id, token_id, agent_id, tool_id,
             input_hash, target_paths, declared_paths_in_diff, hunks_parsed,
             status, error_code, gate_required, dry_run_unavailable, created_at,
             dry_run_exit_code, head_sha
      FROM patch_apply_events
      WHERE artifact_id = ${input.artifact_id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = agent.sql<EventQRow>`
      SELECT event_id, event_type, artifact_id, token_id, agent_id, tool_id,
             input_hash, target_paths, declared_paths_in_diff, hunks_parsed,
             status, error_code, gate_required, dry_run_unavailable, created_at,
             dry_run_exit_code, head_sha
      FROM patch_apply_events
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  const inspectRows: PatchApplyEventInspectRow[] = rows.map((r) => ({
    event_id: r.event_id,
    event_type: r.event_type,
    artifact_id: r.artifact_id,
    token_id: r.token_id,
    agent_id: r.agent_id,
    tool_id: r.tool_id,
    input_hash: r.input_hash,
    target_paths: safeParseArray<string>(r.target_paths),
    declared_paths_in_diff: r.declared_paths_in_diff !== null
      ? safeParseArray<string>(r.declared_paths_in_diff) : null,
    hunks_parsed: r.hunks_parsed,
    status: r.status,
    error_code: r.error_code,
    gate_required: r.gate_required === 1,
    dry_run_unavailable: r.dry_run_unavailable === 1,
    created_at: r.created_at,
    dry_run_exit_code: r.dry_run_exit_code,
    head_sha: r.head_sha,
  }));
  return { rows: inspectRows };
}

export type InspectPatchApplyOutboxInput = {
  outbox_id?: string;
  event_id?: string;
  artifact_id?: string;
  limit?: number;
};

export function inspectPatchApplyOutboxImpl(
  agent: ChannelHubPatchApplyHost,
  input: InspectPatchApplyOutboxInput,
): { rows: PatchApplyOutboxInspectRow[] } {
  const OUTBOX_ID_RE = /^out_patch_apply_[a-f0-9]{16}$/i;
  const EVENT_ID_RE = /^evt_apply_[a-f0-9]{16}$/i;
  const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  type OutboxQRow = {
    outbox_id: string;
    event_id: string;
    artifact_id: string;
    token_id: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    status: string;
    error_code: string | null;
    gate_required: number;
    dry_run_unavailable: number;
    dry_run_exit_code: number | null;
    head_sha: string | null;
    target_paths: string;
    delivery_status: string;
    created_at: number;
  };

  let rows: OutboxQRow[] = [];
  if (typeof input.outbox_id === "string" && input.outbox_id.length > 0) {
    if (!OUTBOX_ID_RE.test(input.outbox_id)) return { rows: [] };
    rows = agent.sql<OutboxQRow>`
      SELECT outbox_id, event_id, artifact_id, token_id, agent_id, tool_id,
             input_hash, status, error_code, gate_required, dry_run_unavailable,
             dry_run_exit_code, head_sha, target_paths, delivery_status, created_at
      FROM patch_apply_outbox
      WHERE outbox_id = ${input.outbox_id}
      LIMIT 1
    `;
  } else if (typeof input.event_id === "string" && input.event_id.length > 0) {
    if (!EVENT_ID_RE.test(input.event_id)) return { rows: [] };
    rows = agent.sql<OutboxQRow>`
      SELECT outbox_id, event_id, artifact_id, token_id, agent_id, tool_id,
             input_hash, status, error_code, gate_required, dry_run_unavailable,
             dry_run_exit_code, head_sha, target_paths, delivery_status, created_at
      FROM patch_apply_outbox
      WHERE event_id = ${input.event_id}
      LIMIT 1
    `;
  } else if (typeof input.artifact_id === "string" && input.artifact_id.length > 0) {
    if (!ARTIFACT_ID_RE.test(input.artifact_id)) return { rows: [] };
    rows = agent.sql<OutboxQRow>`
      SELECT outbox_id, event_id, artifact_id, token_id, agent_id, tool_id,
             input_hash, status, error_code, gate_required, dry_run_unavailable,
             dry_run_exit_code, head_sha, target_paths, delivery_status, created_at
      FROM patch_apply_outbox
      WHERE artifact_id = ${input.artifact_id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = agent.sql<OutboxQRow>`
      SELECT outbox_id, event_id, artifact_id, token_id, agent_id, tool_id,
             input_hash, status, error_code, gate_required, dry_run_unavailable,
             dry_run_exit_code, head_sha, target_paths, delivery_status, created_at
      FROM patch_apply_outbox
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  const inspectRows: PatchApplyOutboxInspectRow[] = rows.map((r) => ({
    outbox_id: r.outbox_id,
    event_id: r.event_id,
    artifact_id: r.artifact_id,
    token_id: r.token_id,
    agent_id: r.agent_id,
    tool_id: r.tool_id,
    input_hash: r.input_hash,
    status: r.status,
    error_code: r.error_code,
    gate_required: r.gate_required === 1,
    dry_run_unavailable: r.dry_run_unavailable === 1,
    dry_run_exit_code: r.dry_run_exit_code,
    head_sha: r.head_sha,
    target_paths: safeParseArray<string>(r.target_paths),
    delivery_status: r.delivery_status,
    created_at: r.created_at,
  }));
  return { rows: inspectRows };
}

export type LatestPatchApplyOutboxSummary =
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
    };

export function getLatestPatchApplyOutboxSummaryImpl(
  agent: ChannelHubPatchApplyHost,
): LatestPatchApplyOutboxSummary {
  type OutboxQRow = {
    outbox_id: string;
    event_id: string;
    artifact_id: string;
    token_id: string;
    tool_id: string;
    input_hash: string;
    status: string;
    error_code: string | null;
    gate_required: number;
    dry_run_unavailable: number;
    dry_run_exit_code: number | null;
    head_sha: string | null;
    delivery_status: string;
    created_at: number;
  };
  const outboxRows = agent.sql<OutboxQRow>`
    SELECT outbox_id, event_id, artifact_id, token_id, tool_id,
           input_hash, status, error_code, gate_required,
           dry_run_unavailable, dry_run_exit_code, head_sha,
           delivery_status, created_at
    FROM patch_apply_outbox
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const o = outboxRows[0];
  if (!o) return { status: "missing" };

  type EventQRow = {
    event_id: string;
    artifact_id: string;
    token_id: string;
    tool_id: string;
    input_hash: string;
    status: string;
    error_code: string | null;
    gate_required: number;
    dry_run_unavailable: number;
    dry_run_exit_code: number | null;
    head_sha: string | null;
  };
  const eventRows = agent.sql<EventQRow>`
    SELECT event_id, artifact_id, token_id, tool_id, input_hash,
           status, error_code, gate_required, dry_run_unavailable,
           dry_run_exit_code, head_sha
    FROM patch_apply_events
    WHERE event_id = ${o.event_id}
    LIMIT 1
  `;
  const e = eventRows[0];

  const matchesEvent = e
    ? e.event_id === o.event_id
      && e.artifact_id === o.artifact_id
      && e.token_id === o.token_id
      && e.input_hash === o.input_hash
      && e.status === o.status
      && (e.error_code ?? null) === (o.error_code ?? null)
      && (e.head_sha ?? null) === (o.head_sha ?? null)
      && (e.dry_run_exit_code ?? null) === (o.dry_run_exit_code ?? null)
      && e.dry_run_unavailable === o.dry_run_unavailable
      && e.gate_required === o.gate_required
    : false;

  return {
    status: "ready",
    outbox_id: o.outbox_id,
    event_id: o.event_id,
    artifact_id: o.artifact_id,
    apply_status: o.status,
    error_code: o.error_code,
    delivery_status: o.delivery_status,
    created_at: o.created_at,
    gate_required: o.gate_required === 1,
    dry_run_unavailable: o.dry_run_unavailable === 1,
    dry_run_exit_code: o.dry_run_exit_code,
    head_sha: o.head_sha,
    matches_event: matchesEvent,
  };
}
