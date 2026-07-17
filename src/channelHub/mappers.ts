/**
 * `ChannelHubAgent` row mappers + inspect-row types, extracted
 * from `src/channelHub.ts`.
 *
 * Pure functions and shared types — no DO state, no env access, no I/O.
 * Behavior preserved verbatim; consumers in `channelHub.ts` import these.
 *
 * Inspect-row types are kept here (rather than `schema.ts`) because they
 * describe redaction-safe egress shapes, not on-disk DDL. The on-disk
 * tables are declared in `schema.ts`.
 */

import type {
  ChannelInboxItem,
  ChannelInboxStatus,
  ChannelAttachment,
  ChannelChatType,
  ChannelProvider,
} from "../schema";

// On-disk shape returned by `SELECT ... FROM channel_inbox`. Used by
// `rowToInboxItem` and by `channelHub.ts` itself when typing
// `this.sql<InboxRow>\`SELECT ...\``.
export type InboxRow = {
  id: string;
  provider: string;
  conversation_id: string;
  provider_message_id: string;
  sender_provider_user_id: string;
  chat_type: string;
  addressed_to_agent: number;
  addressed_signals_json: string;
  text: string;
  attachments_json: string;
  raw_ref: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  // additive route metadata; nullable on rows ingested before migration.
  route_action: string | null;
  route_reason: string | null;
  routed_at: number | null;
  handoff_task_id: string | null;
};

// patch artifact inspect row. `patch_text` is intentionally
// excluded; only `patch_text_length` (UTF-8 bytes) surfaces. Verifier
// gets enough to reason about size + policy without loading multi-KiB
// diff bodies into the inspect surface.
export type PatchArtifactInspectRow = {
  artifact_id: string;
  kind: string;
  status: string;
  created_at: number;
  agent_id: string;
  task_id: string | null;
  envelope_id: string | null;
  conversation_id: string | null;
  tool_id: string;
  target_paths: string[];
  input_hash: string;
  patch_format: string;
  patch_text_length: number;
  summary: string;
  policy_check: {
    passed: boolean;
    allowed_paths: string[];
    denied_paths: { path: string; reason: string }[];
    policy_version: string;
  };
  redaction_check: {
    passed: boolean;
    hits: { category: string; count: number }[];
    policy_version: string;
  };
  policy_version: string;
  // pinned base tree SHA (40-hex, lowercase) the patch was
  // authored against. Null on legacy artifacts proposed before this
  // card, on artifacts whose proposer didn't supply one, or on rows
  // whose stored value is somehow malformed. `applyPatchDryRun` uses
  // this to fail closed (`base_sha_mismatch`) before invoking
  // `git apply --check` if the sandbox-resolved `head_sha` differs.
  base_sha: string | null;
};

// patch apply event inspect row. Mirrors the on-disk
// table without ever exposing raw token / signature / patch body. The
// table itself never stores those, but the typed shape makes the
// egress contract explicit at the type system level. an earlier revision added
// `dry_run_exit_code` and `head_sha` for real-dry-run provenance.
export type PatchApplyEventInspectRow = {
  event_id: string;
  event_type: string;
  artifact_id: string;
  token_id: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  target_paths: string[];
  declared_paths_in_diff: string[] | null;
  hunks_parsed: number | null;
  status: string;
  error_code: string | null;
  gate_required: boolean;
  dry_run_unavailable: boolean;
  created_at: number;
  dry_run_exit_code: number | null;
  head_sha: string | null;
};

// patch apply outbox/evidence inspect row. Same redaction
// contract as the event-log inspect: never exposes `patch_text`, raw
// token, raw signature, auth header, or worker secret. The outbox
// table is a redaction-safe view of apply evidence keyed by a stable
// `outbox_id`, with a foreign key to the originating event_id and a
// `delivery_status` field that v1 leaves at `'ready'` (no external
// delivery semantics yet — an earlier revision only does the data-boundary split).
export type PatchApplyOutboxInspectRow = {
  outbox_id: string;
  event_id: string;
  artifact_id: string;
  token_id: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  status: string;
  error_code: string | null;
  gate_required: boolean;
  dry_run_unavailable: boolean;
  dry_run_exit_code: number | null;
  head_sha: string | null;
  target_paths: string[];
  delivery_status: string;
  created_at: number;
};

export function safeParseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function safeParsePolicyCheck(raw: string): PatchArtifactInspectRow["policy_check"] {
  try {
    const v = JSON.parse(raw);
    if (typeof v === "object" && v !== null) {
      const passed = typeof v.passed === "boolean" ? v.passed : true;
      const allowed_paths = Array.isArray(v.allowed_paths) ? v.allowed_paths.filter((x: unknown) => typeof x === "string") : [];
      const denied_paths = Array.isArray(v.denied_paths)
        ? v.denied_paths.filter((d: unknown): d is { path: string; reason: string } =>
            typeof d === "object" && d !== null
            && typeof (d as { path?: unknown }).path === "string"
            && typeof (d as { reason?: unknown }).reason === "string")
        : [];
      const policy_version = typeof v.policy_version === "string" ? v.policy_version : "unknown";
      return { passed, allowed_paths, denied_paths, policy_version };
    }
  } catch { /* fall through */ }
  return { passed: true, allowed_paths: [], denied_paths: [], policy_version: "unknown" };
}

export function safeParseRedactionCheck(raw: string): PatchArtifactInspectRow["redaction_check"] {
  try {
    const v = JSON.parse(raw);
    if (typeof v === "object" && v !== null) {
      const passed = typeof v.passed === "boolean" ? v.passed : true;
      const hits = Array.isArray(v.hits)
        ? v.hits.filter((h: unknown): h is { category: string; count: number } =>
            typeof h === "object" && h !== null
            && typeof (h as { category?: unknown }).category === "string"
            && typeof (h as { count?: unknown }).count === "number")
        : [];
      const policy_version = typeof v.policy_version === "string" ? v.policy_version : "unknown";
      return { passed, hits, policy_version };
    }
  } catch { /* fall through */ }
  return { passed: true, hits: [], policy_version: "unknown" };
}

export function rowToInboxItem(r: InboxRow): ChannelInboxItem {
  return {
    id: r.id,
    provider: r.provider as ChannelProvider,
    conversationId: r.conversation_id,
    providerMessageId: r.provider_message_id,
    senderProviderUserId: r.sender_provider_user_id,
    chatType: r.chat_type as ChannelChatType,
    addressedToAgent: r.addressed_to_agent === 1,
    addressedSignals: safeParseArray<string>(r.addressed_signals_json),
    text: r.text,
    attachments: safeParseArray<ChannelAttachment>(r.attachments_json),
    rawRef: r.raw_ref,
    status: r.status as ChannelInboxStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    routeAction: (r.route_action as ChannelInboxItem["routeAction"]) ?? null,
    routeReason: r.route_reason,
    routedAt: r.routed_at,
    handoffTaskId: r.handoff_task_id,
  };
}
