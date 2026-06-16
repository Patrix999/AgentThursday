/**
 *  — `ChannelHubAgent` schema/migration setup, extracted from
 * `src/channelHub.ts` `onStart()`.
 *
 * `ensureChannelHubSchema(agent, agentthursdayDiscordBotId)` runs the additive,
 * idempotent DDL + column-migration block that `onStart()` previously ran
 * inline. Each statement is `IF NOT EXISTS` (table/index) or
 * attempt-and-swallow (`ALTER TABLE ADD COLUMN` on SQLite, which has no
 * `IF NOT EXISTS` for columns). No table/column/index semantics changed
 * in this card — behavior is preserved verbatim.
 *
 * The helper accepts the agent (for its `sql` template tag) and the
 * Discord bot id read from env at the call site. `env` is `protected` on
 * the Agent base class, so the caller must read it; the helper takes the
 * one field it actually needs as an explicit argument.
 */

import type { Agent } from "agents";

export type ChannelHubSchemaHost = Agent<Env, Record<string, never>>;

export function ensureChannelHubSchema(
  agent: ChannelHubSchemaHost,
  agentthursdayDiscordBotId: string | undefined,
): void {
  // §D-11 — additive, idempotent. Each table individually IF NOT EXISTS.

  agent.sql`
    CREATE TABLE IF NOT EXISTS channel_inbox (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      sender_provider_user_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      addressed_to_agent INTEGER NOT NULL,
      addressed_signals_json TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      raw_ref TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, provider_message_id)
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_channel_inbox_conv_status_at ON channel_inbox(conversation_id, status, created_at)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_channel_inbox_status_at ON channel_inbox(status, created_at)`;

  agent.sql`
    CREATE TABLE IF NOT EXISTS channel_outbox (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      reply_to_provider_message_id TEXT,
      text TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_channel_outbox_status_at ON channel_outbox(status, created_at)`;

  agent.sql`
    CREATE TABLE IF NOT EXISTS channel_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'unknown',
      is_self INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (provider, provider_user_id)
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_channel_identities_provider_user ON channel_identities(provider, provider_user_id)`;

  agent.sql`
    CREATE TABLE IF NOT EXISTS channel_conversations (
      conversation_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      provider_channel_id TEXT,
      provider_thread_id TEXT,
      capability_json TEXT NOT NULL DEFAULT '{}',
      policy_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `;

  //  —  conversation → agent live binding. Additive,
  // idempotent. NULL means "unbound" (existing behavior: routePending
  // falls back to canonical active context). When set, points to an
  // agent row owned by the registry DO (stored under the legacy
  // `agent_profiles` table); no cross-DO SQL FK — validation happens
  // at set-time + route-time via RPC.
  //
  //  — column NAME stays `active_profile_id` for storage
  // compatibility; the VALUE it carries is the agent_id used as the
  // per-agent DO routing key. New code reads/writes the
  // `activeAgentId` field on the API; the only column-aware code is
  // here, in `getConversationBinding` / `setConversationBinding`, and
  // in the `routePending` per-row resolver call site. See
  //
  const conversationCols = agent.sql<{ name: string }>`PRAGMA table_info(channel_conversations)`;
  if (!conversationCols.some(c => c.name === "active_profile_id")) {
    agent.sql`ALTER TABLE channel_conversations ADD COLUMN active_profile_id TEXT`;
  }

  //  — additive route metadata on channel_inbox. Idempotent via
  // PRAGMA table_info check (mirrors the kanban_mutations migration in
  // AgentThursdayAgent.onStart). Existing rows get NULL until they're routed.
  const inboxCols = agent.sql<{ name: string }>`PRAGMA table_info(channel_inbox)`;
  if (!inboxCols.some(c => c.name === "route_action")) {
    agent.sql`ALTER TABLE channel_inbox ADD COLUMN route_action TEXT`;
  }
  if (!inboxCols.some(c => c.name === "route_reason")) {
    agent.sql`ALTER TABLE channel_inbox ADD COLUMN route_reason TEXT`;
  }
  if (!inboxCols.some(c => c.name === "routed_at")) {
    agent.sql`ALTER TABLE channel_inbox ADD COLUMN routed_at INTEGER`;
  }
  if (!inboxCols.some(c => c.name === "handoff_task_id")) {
    agent.sql`ALTER TABLE channel_inbox ADD COLUMN handoff_task_id TEXT`;
  }

  //  — additive outbox kind + approval link.
  const outboxCols = agent.sql<{ name: string }>`PRAGMA table_info(channel_outbox)`;
  if (!outboxCols.some(c => c.name === "kind")) {
    agent.sql`ALTER TABLE channel_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`;
  }
  if (!outboxCols.some(c => c.name === "approval_id")) {
    agent.sql`ALTER TABLE channel_outbox ADD COLUMN approval_id TEXT`;
  }

  //  — channel_approvals state machine. Single-resolution semantics
  // enforced by the `status` field plus the resolve callable. Payload hash
  // is stored so a payload mutation invalidates a pending approval.
  agent.sql`
    CREATE TABLE IF NOT EXISTS channel_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      warning TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      target_tool_call_id TEXT,
      provider TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      outbox_id TEXT,
      status TEXT NOT NULL,
      resolved_scope TEXT,
      resolved_actor TEXT,
      audit TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_channel_approvals_status_at ON channel_approvals(status, created_at)`;

  //  —  approval token store. Distinct from `channel_approvals`
  // (, outbox-level reply approval) because these tokens bind a
  // specific (agent, tool_id, input_hash) tuple for runtime tool replay
  // rather than gating an outbound message. `token_hash` is the only
  // representation of the secret persisted; raw token never lands here.
  // `reviewer_signature_hash` likewise — raw signatures are forbidden by
  //  ADR §D5 and never written through any code path.
  agent.sql`
    CREATE TABLE IF NOT EXISTS agent_tool_approvals (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      tier INTEGER NOT NULL,
      status TEXT NOT NULL,
      reviewer_id TEXT,
      reviewer_signature_hash TEXT,
      agent_reason TEXT,
      summary TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      consumed_at INTEGER,
      key_id TEXT
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_agent_tool_approvals_status_at ON agent_tool_approvals(status, created_at)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_agent_tool_approvals_agent_tool ON agent_tool_approvals(agent_id, tool_id)`;
  //  — idempotent in-place migration for tables that pre-date
  // the `key_id` column (any DO whose `agent_tool_approvals` was first
  // created under /b). SQLite throws "duplicate column name"
  // when the column already exists; treat that as success.
  try {
    agent.sql`ALTER TABLE agent_tool_approvals ADD COLUMN key_id TEXT`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column/i.test(msg)) throw e;
  }

  //  — propose-patch artifact store ( reviewer/write-boundary
  // ADR §D4). Holds verifier-only patch proposals so an agent can surface
  // a candidate diff without writing the working tree. Apply path is NOT
  // implemented in this card — + wires apply via approval replay.
  // Failure modes (path-deny, redaction-violation) are fail-closed at
  // creation time and produce no row, so inspect can never leak a
  // policy-failed artifact's body.
  agent.sql`
    CREATE TABLE IF NOT EXISTS propose_patch_artifacts (
      artifact_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'propose_patch',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      task_id TEXT,
      envelope_id TEXT,
      conversation_id TEXT,
      tool_id TEXT NOT NULL,
      target_paths TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      patch_format TEXT NOT NULL DEFAULT 'unified_diff',
      patch_text TEXT NOT NULL,
      summary TEXT NOT NULL,
      policy_check TEXT NOT NULL,
      redaction_check TEXT NOT NULL,
      policy_version TEXT NOT NULL
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_propose_patch_artifacts_status_at ON propose_patch_artifacts(status, created_at)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_propose_patch_artifacts_agent_tool ON propose_patch_artifacts(agent_id, tool_id)`;

  //  — patch apply event log. One row per apply attempt
  // (success or verify-failure). Combines the event_log + outbox roles
  // for v1 — the row IS the durable evidence that an apply was
  // attempted, the verifier replays it from inspect. If 220+ requires
  // a distinct outbox semantic (e.g. external delivery), split then.
  //
  // Hard egress contract: no `patch_text`, no `token`, no signature,
  // no auth header, no secret. Only references that point back to
  // already-redacted rows (`artifact_id` / `token_id` / `input_hash`)
  // and structural metadata (declared diff paths, hunk count, status).
  agent.sql`
    CREATE TABLE IF NOT EXISTS patch_apply_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      target_paths TEXT NOT NULL,
      declared_paths_in_diff TEXT,
      hunks_parsed INTEGER,
      status TEXT NOT NULL,
      error_code TEXT,
      gate_required INTEGER NOT NULL,
      dry_run_unavailable INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_patch_apply_events_at ON patch_apply_events(created_at)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_patch_apply_events_artifact ON patch_apply_events(artifact_id)`;

  //  — additive columns for real-dry-run evidence. SQLite has
  // no `ADD COLUMN IF NOT EXISTS`, so we attempt-and-swallow the
  // duplicate-column error. Idempotent across DO restarts.
  try { agent.sql`ALTER TABLE patch_apply_events ADD COLUMN dry_run_exit_code INTEGER`; } catch { /* already added */ }
  try { agent.sql`ALTER TABLE patch_apply_events ADD COLUMN head_sha TEXT`; } catch { /* already added */ }

  //  — additive `base_sha` column on artifact rows so apply
  // dry-run can fail closed when the sandbox checkout HEAD has moved
  // off the tree the artifact was written against. Nullable for
  // historical compatibility (rows proposed before this card simply
  // skip the mismatch check; see `applyPatchDryRun`).
  try { agent.sql`ALTER TABLE propose_patch_artifacts ADD COLUMN base_sha TEXT`; } catch { /* already added */ }

  //  — split apply event-log from outbox/evidence semantics.
  // `patch_apply_events` stays as the immutable attempt log (+).
  // `patch_apply_outbox` is the redaction-safe evidence/delivery view:
  // every event that reaches the post-validation path gets exactly one
  // outbox row referencing it (UNIQUE event_id). v1 has no external
  // delivery — `delivery_status` is just `ready`. The columns mirror
  // event-log fields that are already redaction-safe; never includes
  // `patch_text`, raw token, raw signature, auth header, or worker
  // secret. Same write boundary as the event log: structural preflight
  // failures that don't create an event also don't create an outbox row.
  agent.sql`
    CREATE TABLE IF NOT EXISTS patch_apply_outbox (
      outbox_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      artifact_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      gate_required INTEGER NOT NULL,
      dry_run_unavailable INTEGER NOT NULL,
      dry_run_exit_code INTEGER,
      head_sha TEXT,
      target_paths TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_patch_apply_outbox_at ON patch_apply_outbox(created_at)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_patch_apply_outbox_artifact ON patch_apply_outbox(artifact_id)`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_patch_apply_outbox_event ON patch_apply_outbox(event_id)`;

  //  — one-time Discord identity self repair. Older builds set
  // `is_self=1` for any `authorIsBot=true`, so  /  (Discord bots that
  // talk to  but are NOT ) ended up flagged as self and got
  // `loopback from self` ignores at the router. Reconcile against
  // AGENT_THURSDAY_DISCORD_BOT_ID, which is the only true "self" for Discord.
  // No-op when AGENT_THURSDAY_DISCORD_BOT_ID is unset (avoid clearing all selfs).
  if (agentthursdayDiscordBotId) {
    agent.sql`
      UPDATE channel_identities
      SET is_self = CASE WHEN provider_user_id = ${agentthursdayDiscordBotId} THEN 1 ELSE 0 END
      WHERE provider = 'discord'
    `;
  }
}
