/**
 *  — `ChannelHubAgent` approval token lifecycle helpers, extracted
 * from `src/channelHub.ts`.
 *
 * Moves four method bodies behind free functions that take a `Host`-shaped
 * `Agent<Env, Record<string, never>>` reference. The public `@callable()`
 * methods on `ChannelHubAgent` stay in `channelHub.ts` as thin delegates;
 * only the body lives here.
 *
 * Contained:
 *  - `createApprovalRequestImpl`   ( — issue pending approval row)
 *  - `decideApprovalImpl`          ( — pending → granted | denied)
 *  - `consumeApprovalTokenImpl`    ( — granted → consumed, single use)
 *  - `lookupApprovalHashImpl`      (  — legacy `channel_approvals` lookup)
 *
 * Out of scope per  §Scope:
 *  - `resolveApproval()` STAYS in `channelHub.ts` (depends on `getAgentThursdayStub`
 *    + `lookupSenderRole`, which are ChannelHubAgent-private surfaces).
 *  - No SQL/schema/table-name changes.
 *  - No token-derivation, single-use-consume, or redaction-behavior changes.
 *  - No public callable name / parameter / response shape changes.
 *
 * Approval token security invariants preserved byte-equivalent:
 *  - HMAC key resolution by `key_id` (v1 / legacy_shared / null compat).
 *  - `verifyApprovalToken` binding rules + constant-time compare.
 *  - `redactApprovalRow` remains the sole egress point for any row exposure;
 *    `token_hash` never crosses the egress boundary.
 *  - Failure paths in `consumeApprovalTokenImpl` never mutate row state.
 *
 * Note: `lookupApprovalHashImpl` is the only function here that reads the
 * legacy `channel_approvals` table (). The other three operate on
 * `agent_tool_approvals` (+). Kept together because both surfaces
 * are "approval token lifecycle" from the callable's point of view; the
 * table split is an implementation detail of the legacy resolve vs. the
 * v2 token state machine.
 */

import type { Agent } from "agents";
import {
  canonicalInputHash,
  clampTtlSecondsByTier,
  hashReviewerSignature,
  issueApprovalToken,
  redactApprovalRow,
  resolveApprovalHmacKey,
  verifyApprovalToken,
  type ApprovalInspectRow,
  type ApprovalRecord,
  type ApprovalStatus,
} from "../skillset/approvalToken";
import type { Tier } from "../skillset/types";

export type ChannelHubApprovalOpsHost = Agent<Env, Record<string, never>>;

// ---------------------------------------------------------------------------
// createApprovalRequest ()
// ---------------------------------------------------------------------------

export type CreateApprovalRequestInput = {
  agent_id?: unknown;
  tool_id?: unknown;
  tier?: unknown;
  input?: unknown;
  input_hash?: unknown;
  summary?: unknown;
  agent_reason?: unknown;
  ttl_seconds?: unknown;
};

export type CreateApprovalRequestResult =
  | {
      ok: true;
      token_id: string;
      token: string;
      expires_at: number;
      row: ApprovalInspectRow;
    }
  | { ok: false; error: string; detail?: string };

export type ApprovalHmacEnv = {
  AGENT_THURSDAY_APPROVAL_HMAC_KEY?: string;
  AGENT_THURSDAY_SHARED_SECRET?: string;
};

export async function createApprovalRequestImpl(
  agent: ChannelHubApprovalOpsHost,
  env: ApprovalHmacEnv,
  input: CreateApprovalRequestInput,
): Promise<CreateApprovalRequestResult> {
  const ID_RE = /^[A-Za-z0-9_.:\-\/]{1,256}$/;
  const agentId = typeof input.agent_id === "string" ? input.agent_id.trim() : "";
  if (!ID_RE.test(agentId)) {
    return { ok: false, error: "agent_id_invalid" };
  }
  const toolId = typeof input.tool_id === "string" ? input.tool_id.trim() : "";
  if (!ID_RE.test(toolId)) {
    return { ok: false, error: "tool_id_invalid" };
  }
  const tierRaw = input.tier;
  if (typeof tierRaw !== "number" || (tierRaw !== 4 && tierRaw !== 5)) {
    return {
      ok: false,
      error: "tier_not_approval_required",
      detail: "approval tokens are only issued for tier 4 or 5",
    };
  }
  const tier = tierRaw as Tier;

  let inputHash: string;
  if (typeof input.input_hash === "string" && input.input_hash.length > 0) {
    if (input.input !== undefined) {
      return { ok: false, error: "input_and_input_hash_both_supplied" };
    }
    if (!/^[a-f0-9]{64}$/i.test(input.input_hash)) {
      return { ok: false, error: "input_hash_invalid" };
    }
    inputHash = input.input_hash.toLowerCase();
  } else if (input.input !== undefined) {
    try {
      inputHash = await canonicalInputHash(input.input);
    } catch {
      return { ok: false, error: "input_canonicalize_failed" };
    }
  } else {
    return { ok: false, error: "input_or_input_hash_required" };
  }

  const TEXT_CAP = 4000;
  const summary = typeof input.summary === "string" && input.summary.length > 0
    ? input.summary.slice(0, TEXT_CAP) : null;
  const agentReason = typeof input.agent_reason === "string" && input.agent_reason.length > 0
    ? input.agent_reason.slice(0, TEXT_CAP) : null;

  let requestedTtlSec = 0;
  if (
    typeof input.ttl_seconds === "number" &&
    Number.isFinite(input.ttl_seconds) &&
    input.ttl_seconds > 0
  ) {
    requestedTtlSec = Math.floor(input.ttl_seconds);
  }
  const cappedTtlSec = clampTtlSecondsByTier(tier, requestedTtlSec);
  if (!Number.isFinite(cappedTtlSec) || cappedTtlSec <= 0) {
    return { ok: false, error: "ttl_clamp_failed" };
  }

  //  — prefer the dedicated approval HMAC key; fall back to
  // AGENT_THURSDAY_SHARED_SECRET so deployments mid-rotation still issue tokens.
  // The chosen key's id is persisted on the row.
  const resolved = resolveApprovalHmacKey({
    approvalHmacKey: env.AGENT_THURSDAY_APPROVAL_HMAC_KEY,
    sharedSecret: env.AGENT_THURSDAY_SHARED_SECRET,
  });
  if (resolved === null) {
    return { ok: false, error: "hmac_key_unconfigured" };
  }
  const { hmacKey, key_id } = resolved;

  const issued = await issueApprovalToken({
    hmacKey,
    agent_id: agentId,
    tool_id: toolId,
    input_hash: inputHash,
  });

  const now = Date.now();
  const expiresAt = now + cappedTtlSec * 1000;

  agent.sql`
    INSERT INTO agent_tool_approvals (
      token_id, token_hash, agent_id, tool_id, input_hash, tier, status,
      reviewer_id, reviewer_signature_hash, agent_reason, summary,
      expires_at, created_at, decided_at, consumed_at, key_id
    ) VALUES (
      ${issued.token_id}, ${issued.token_hash}, ${agentId}, ${toolId},
      ${inputHash}, ${tier}, 'pending',
      NULL, NULL, ${agentReason}, ${summary},
      ${expiresAt}, ${now}, NULL, NULL, ${key_id}
    )
  `;

  const record: ApprovalRecord = {
    token_id: issued.token_id,
    // Held only locally for shape compatibility with redactApprovalRow;
    // never surfaced — the redactor strips it. The persisted hash is
    // already in DB; the in-memory copy here is a no-op.
    token_hash: "",
    agent_id: agentId,
    tool_id: toolId,
    input_hash: inputHash,
    tier,
    status: "pending",
    reviewer_id: null,
    reviewer_signature_hash: null,
    agent_reason: agentReason,
    summary,
    expires_at: expiresAt,
    created_at: now,
    decided_at: null,
    consumed_at: null,
    key_id,
  };
  const row = redactApprovalRow(record);

  return {
    ok: true,
    token_id: issued.token_id,
    token: issued.token,
    expires_at: expiresAt,
    row,
  };
}

// ---------------------------------------------------------------------------
// decideApproval ()
// ---------------------------------------------------------------------------

export type DecideApprovalInput = {
  token_id?: unknown;
  decision?: unknown;
  reviewer_id?: unknown;
  reviewer_signature?: unknown;
};

export type DecideApprovalResult =
  | { ok: true; row: ApprovalInspectRow }
  | { ok: false; error: string; detail?: string };

export async function decideApprovalImpl(
  agent: ChannelHubApprovalOpsHost,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const TOKEN_ID_RE = /^tok_[a-f0-9]{8,64}$/i;
  const ID_RE = /^[A-Za-z0-9_.:\-\/]{1,256}$/;

  const tokenId = typeof input.token_id === "string" ? input.token_id : "";
  if (!TOKEN_ID_RE.test(tokenId)) {
    return { ok: false, error: "token_id_invalid" };
  }

  const decisionRaw = input.decision;
  if (decisionRaw !== "grant" && decisionRaw !== "deny") {
    return {
      ok: false,
      error: "decision_invalid",
      detail: "decision must be 'grant' or 'deny'",
    };
  }
  const decision = decisionRaw;

  const reviewerId = typeof input.reviewer_id === "string"
    ? input.reviewer_id.trim() : "";
  if (!ID_RE.test(reviewerId)) {
    return { ok: false, error: "reviewer_id_invalid" };
  }

  let reviewerSigHash: string | null = null;
  if (input.reviewer_signature !== undefined && input.reviewer_signature !== null) {
    if (
      typeof input.reviewer_signature !== "string" ||
      input.reviewer_signature.length === 0
    ) {
      return { ok: false, error: "reviewer_signature_invalid" };
    }
    const SIG_CAP = 4000;
    if (input.reviewer_signature.length > SIG_CAP) {
      return { ok: false, error: "reviewer_signature_too_long" };
    }
    reviewerSigHash = await hashReviewerSignature(input.reviewer_signature);
  }

  type StatusRow = { status: string };
  const existing = agent.sql<StatusRow>`
    SELECT status FROM agent_tool_approvals
    WHERE token_id = ${tokenId}
    LIMIT 1
  `;
  if (existing.length === 0) {
    return { ok: false, error: "approval_not_found" };
  }
  if (existing[0].status !== "pending") {
    return {
      ok: false,
      error: "approval_not_pending",
      detail: `current_status=${existing[0].status}`,
    };
  }

  const newStatus: ApprovalStatus = decision === "grant" ? "granted" : "denied";
  const now = Date.now();

  agent.sql`
    UPDATE agent_tool_approvals
    SET status = ${newStatus},
        reviewer_id = ${reviewerId},
        reviewer_signature_hash = ${reviewerSigHash},
        decided_at = ${now}
    WHERE token_id = ${tokenId} AND status = 'pending'
  `;

  type ApprovalQRow = {
    token_id: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    tier: number;
    status: string;
    reviewer_id: string | null;
    reviewer_signature_hash: string | null;
    agent_reason: string | null;
    summary: string | null;
    expires_at: number;
    created_at: number;
    decided_at: number | null;
    consumed_at: number | null;
    key_id: string | null;
  };
  const rows = agent.sql<ApprovalQRow>`
    SELECT token_id, agent_id, tool_id, input_hash, tier, status,
           reviewer_id, reviewer_signature_hash,
           agent_reason, summary,
           expires_at, created_at, decided_at, consumed_at,
           key_id
    FROM agent_tool_approvals
    WHERE token_id = ${tokenId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    // Defence-in-depth: SELECT after UPDATE on the same primary key
    // should always find the row. If it doesn't, surface explicitly
    // rather than silently returning a stale view.
    return { ok: false, error: "approval_read_back_failed" };
  }
  const r = rows[0];
  const record: ApprovalRecord = {
    token_id: r.token_id,
    token_hash: "",
    agent_id: r.agent_id,
    tool_id: r.tool_id,
    input_hash: r.input_hash,
    tier: r.tier as Tier,
    status: r.status as ApprovalStatus,
    reviewer_id: r.reviewer_id,
    reviewer_signature_hash: r.reviewer_signature_hash,
    agent_reason: r.agent_reason,
    summary: r.summary,
    expires_at: r.expires_at,
    created_at: r.created_at,
    decided_at: r.decided_at,
    consumed_at: r.consumed_at,
    key_id: r.key_id,
  };
  return { ok: true, row: redactApprovalRow(record) };
}

// ---------------------------------------------------------------------------
// consumeApprovalToken ()
// ---------------------------------------------------------------------------

export type ConsumeApprovalTokenInput = {
  token_id?: unknown;
  token?: unknown;
  agent_id?: unknown;
  tool_id?: unknown;
  input?: unknown;
  input_hash?: unknown;
};

export type ConsumeApprovalTokenResult =
  | { ok: true; row: ApprovalInspectRow }
  | { ok: false; error: string; detail?: string };

export async function consumeApprovalTokenImpl(
  agent: ChannelHubApprovalOpsHost,
  env: ApprovalHmacEnv,
  input: ConsumeApprovalTokenInput,
): Promise<ConsumeApprovalTokenResult> {
  const TOKEN_ID_RE = /^tok_[a-f0-9]{8,64}$/i;
  const ID_RE = /^[A-Za-z0-9_.:\-\/]{1,256}$/;

  const tokenId = typeof input.token_id === "string" ? input.token_id : "";
  if (!TOKEN_ID_RE.test(tokenId)) {
    return { ok: false, error: "token_id_invalid" };
  }

  const rawToken = typeof input.token === "string" ? input.token : "";
  //  issues 32-byte hex (64 chars). Reject anything obviously
  // malformed before HMAC; never echo the raw token in any response.
  if (!/^[a-f0-9]{1,256}$/i.test(rawToken) || rawToken.length === 0) {
    return { ok: false, error: "token_invalid" };
  }

  const agentId = typeof input.agent_id === "string"
    ? input.agent_id.trim() : "";
  if (!ID_RE.test(agentId)) {
    return { ok: false, error: "agent_id_invalid" };
  }
  const toolId = typeof input.tool_id === "string"
    ? input.tool_id.trim() : "";
  if (!ID_RE.test(toolId)) {
    return { ok: false, error: "tool_id_invalid" };
  }

  let inputHash: string;
  if (typeof input.input_hash === "string" && input.input_hash.length > 0) {
    if (input.input !== undefined) {
      return { ok: false, error: "input_and_input_hash_both_supplied" };
    }
    if (!/^[a-f0-9]{64}$/i.test(input.input_hash)) {
      return { ok: false, error: "input_hash_invalid" };
    }
    inputHash = input.input_hash.toLowerCase();
  } else if (input.input !== undefined) {
    try {
      inputHash = await canonicalInputHash(input.input);
    } catch {
      return { ok: false, error: "input_canonicalize_failed" };
    }
  } else {
    return { ok: false, error: "input_or_input_hash_required" };
  }

  type ApprovalQRowFull = {
    token_id: string;
    token_hash: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    tier: number;
    status: string;
    reviewer_id: string | null;
    reviewer_signature_hash: string | null;
    agent_reason: string | null;
    summary: string | null;
    expires_at: number;
    created_at: number;
    decided_at: number | null;
    consumed_at: number | null;
    key_id: string | null;
  };
  // SELECTs `token_hash` because verify needs it. The hash never
  // crosses the egress boundary — only `redactApprovalRow`'s output
  // does, and that strips it.
  const rows = agent.sql<ApprovalQRowFull>`
    SELECT token_id, token_hash, agent_id, tool_id, input_hash, tier, status,
           reviewer_id, reviewer_signature_hash,
           agent_reason, summary,
           expires_at, created_at, decided_at, consumed_at,
           key_id
    FROM agent_tool_approvals
    WHERE token_id = ${tokenId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return { ok: false, error: "approval_not_found" };
  }
  const r = rows[0];

  // Resolve HMAC key by the key_id the row was ISSUED under.
  // - "v1"            → AGENT_THURSDAY_APPROVAL_HMAC_KEY (must be configured)
  // - "legacy_shared" → AGENT_THURSDAY_SHARED_SECRET (legacy issue path)
  // - null            → legacy compat per  §C: fall back to
  //                     AGENT_THURSDAY_SHARED_SECRET. This is the pre-212c
  //                     issue path; rotation is deferred to 212f.
  let hmacKey: string;
  if (r.key_id === "v1") {
    if (
      typeof env.AGENT_THURSDAY_APPROVAL_HMAC_KEY !== "string" ||
      env.AGENT_THURSDAY_APPROVAL_HMAC_KEY.length === 0
    ) {
      return {
        ok: false,
        error: "hmac_key_unconfigured",
        detail: "row.key_id=v1 but AGENT_THURSDAY_APPROVAL_HMAC_KEY not set",
      };
    }
    hmacKey = env.AGENT_THURSDAY_APPROVAL_HMAC_KEY;
  } else {
    if (
      typeof env.AGENT_THURSDAY_SHARED_SECRET !== "string" ||
      env.AGENT_THURSDAY_SHARED_SECRET.length === 0
    ) {
      return {
        ok: false,
        error: "hmac_key_unconfigured",
        detail: `row.key_id=${r.key_id ?? "null"} but AGENT_THURSDAY_SHARED_SECRET not set`,
      };
    }
    hmacKey = env.AGENT_THURSDAY_SHARED_SECRET;
  }

  const now = Date.now();
  const record: ApprovalRecord = {
    token_id: r.token_id,
    token_hash: r.token_hash,
    agent_id: r.agent_id,
    tool_id: r.tool_id,
    input_hash: r.input_hash,
    tier: r.tier as Tier,
    status: r.status as ApprovalStatus,
    reviewer_id: r.reviewer_id,
    reviewer_signature_hash: r.reviewer_signature_hash,
    agent_reason: r.agent_reason,
    summary: r.summary,
    expires_at: r.expires_at,
    created_at: r.created_at,
    decided_at: r.decided_at,
    consumed_at: r.consumed_at,
    key_id: r.key_id,
  };

  const verdict = await verifyApprovalToken({
    hmacKey,
    presented_token: rawToken,
    record,
    agent_id: agentId,
    tool_id: toolId,
    input_hash: inputHash,
    now_ms: now,
  });

  if (!verdict.ok) {
    //  §B: failure paths do not mutate row state.
    return { ok: false, error: verdict.reason };
  }

  agent.sql`
    UPDATE agent_tool_approvals
    SET status = 'consumed', consumed_at = ${now}
    WHERE token_id = ${tokenId} AND status = 'granted'
  `;

  type ApprovalQRow = {
    token_id: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
    tier: number;
    status: string;
    reviewer_id: string | null;
    reviewer_signature_hash: string | null;
    agent_reason: string | null;
    summary: string | null;
    expires_at: number;
    created_at: number;
    decided_at: number | null;
    consumed_at: number | null;
    key_id: string | null;
  };
  const updated = agent.sql<ApprovalQRow>`
    SELECT token_id, agent_id, tool_id, input_hash, tier, status,
           reviewer_id, reviewer_signature_hash,
           agent_reason, summary,
           expires_at, created_at, decided_at, consumed_at,
           key_id
    FROM agent_tool_approvals
    WHERE token_id = ${tokenId}
    LIMIT 1
  `;
  if (updated.length === 0) {
    return { ok: false, error: "approval_read_back_failed" };
  }
  const u = updated[0];
  const updatedRecord: ApprovalRecord = {
    token_id: u.token_id,
    token_hash: "",
    agent_id: u.agent_id,
    tool_id: u.tool_id,
    input_hash: u.input_hash,
    tier: u.tier as Tier,
    status: u.status as ApprovalStatus,
    reviewer_id: u.reviewer_id,
    reviewer_signature_hash: u.reviewer_signature_hash,
    agent_reason: u.agent_reason,
    summary: u.summary,
    expires_at: u.expires_at,
    created_at: u.created_at,
    decided_at: u.decided_at,
    consumed_at: u.consumed_at,
    key_id: u.key_id,
  };
  return { ok: true, row: redactApprovalRow(updatedRecord) };
}

// ---------------------------------------------------------------------------
// lookupApprovalHash ( — legacy `channel_approvals` table)
// ---------------------------------------------------------------------------

/**
 *  — minimal lookup used by the `/discord/interactions` button
 * handler to fetch the canonical payload hash for an approval, so the
 * resolve call can echo it back as `payloadHashEcho`. Returns null if the
 * approval row doesn't exist (e.g. expired and pruned in the future).
 *
 * Reads `channel_approvals` (legacy  table), NOT
 * `agent_tool_approvals` (+). Same boundary as `resolveApproval()`
 * in `channelHub.ts`.
 */
export function lookupApprovalHashImpl(
  agent: ChannelHubApprovalOpsHost,
  approvalId: string,
): string | null {
  const row = agent.sql<{ payload_hash: string }>`
    SELECT payload_hash FROM channel_approvals WHERE id = ${approvalId} LIMIT 1
  `[0];
  return row?.payload_hash ?? null;
}
