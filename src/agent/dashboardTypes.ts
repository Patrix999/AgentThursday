//  — dashboard type declarations moved from `src/server.ts`
// (pre-edit lines 552-625, leading comments preserved verbatim). All
// `type` (compile-time only) — relocation is byte-equivalent at runtime.
//
// `DashboardCore` and `DashboardSection` are still consumed from
// outside the agent module: `src/routes/cliRoutes.ts` imports them
// `from "../server"`. `src/server.ts` re-exports them so that external
// import path stays valid (`export type { DashboardCore, DashboardSection }
// from "./agent/dashboardTypes"`).

//  — daily dogfood observability dashboard v1.
//
// Inline section returned by /cli/status. Read-only, auth-gated by the
// global `requireSecret` on /cli/*. Composes the DO-side core
// (`AgentThursdayAgent.getDashboardCore`) with a fail-soft cross-DO outbox
// lookup against ChannelHub. Never returns secrets / raw payload_json /
// provider tokens — outbox shape comes from
// `ChannelHubAgent.inspectOutbox` which already redacts.
//
// Drift flags appended here (route layer): `outbox_missing`,
// `outbox_provider_error`, `patch_apply_outbox_unknown`. The DO core
// handles the four envelope-side flags. Combined whitelist size = 7
// ( baseline of 6 +  patch-apply outbox unknown).
//
// Fail-soft: if ChannelHub is unavailable, `latest_outbox` becomes
// `"unknown"` and no outbox-derived drift flag is emitted. Likewise,
// if the patch-apply outbox summary call fails, `patch_apply_outbox`
// becomes `"unknown"` and `patch_apply_outbox_unknown` is added.
// /cli/status must never throw because of dashboard composition.
export type DashboardCore = {
  current_task: {
    task_id: string | null;
    task_lifecycle: string | null;
    loop_stage: string;
    ready_for_next_round: boolean;
    active_intervention_count: number;
    last_final_reply_marker: string | null;
  };
  latest_envelope: {
    envelope_id: string;
    task_id: string;
    envelope_status: string;
    verdict: string | null;
    started_at: string;
  } | null;
  drift_flags: string[];
  instance_name: string;
};

export type DashboardOutboxRow = {
  outbox_id: string;
  provider: string;
  status: string;
  kind: string | null;
  has_error: boolean;
  matches_envelope: boolean;
  created_at: number;
};

export type DashboardVersion = {
  instance_name: string;
  service_version: string;
  //  — Cloudflare Workers `[version_metadata]` binding.
  // Auto-populated by the Workers runtime in production. Each field is
  // independently fail-soft: any missing or non-string value becomes
  // `null` rather than 500-ing the most-polled endpoint. Local
  // `wrangler dev` typically lacks the binding entirely → all three
  // fields are null but `instance_name` and `service_version` still
  // serve so 213's contract holds.
  worker_version_id: string | null;
  worker_version_tag: string | null;
  worker_version_timestamp: string | null;
};

//  — redaction-safe latest patch-apply outbox summary surfaced
// on `/cli/status.dashboard`. Read-only mirror of the most recent
// `patch_apply_outbox` row plus a `matches_event` cross-check. Field
// set is identical to ChannelHub `getLatestPatchApplyOutboxSummary`
// "ready" branch — never includes `patch_text`, raw token, raw
// signature, auth header, or worker secret.
export type DashboardPatchApplyOutboxRow = {
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

export type DashboardSection = {
  current_task: DashboardCore["current_task"];
  latest_envelope: DashboardCore["latest_envelope"];
  latest_outbox: DashboardOutboxRow | "missing" | "unknown";
  patch_apply_outbox: DashboardPatchApplyOutboxRow | "missing" | "unknown";
  drift_flags: string[];
  version: DashboardVersion;
};
