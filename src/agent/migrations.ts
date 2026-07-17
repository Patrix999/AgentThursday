/**
 * M8.9 onStart migrations / startup schema noise extraction.
 *
 * Pulled verbatim from `AgentThursdayAgent.onStart()` in `src/server.ts` so the
 * composition-root file shrinks toward a thin orchestrator. No DDL
 * strings, table names, index names, column names, ALTER ordering,
 * event types, or log payload shapes were changed; only the location
 * of the SQL calls moved.
 *
 * Host shape is intentionally narrow: only `sql` is needed. Migrations
 * + seed do not emit events; the surrounding `onStart()` still owns
 * `logEvent("agent.woken", ...)` and the bundled-modules ready/failed
 * pair.
 *
 * The order of operations in `runAgentMigrations`:
 *   1. event_log CREATE + PRAGMA + ALTER trace_id (kept tight as a
 *      pair, same as before)
 *   2. memory_knowledge, review_notes, checkpoints, kanban_mutations
 *      (initial CREATE only)
 *   3. agent_memories + 2 indexes (M7.2 an earlier revision)
 *   4. context_history + index, context_active (M7.7v3 an earlier revision)
 *   5. conversation_archive + 2 indexes, conversation_archive_flushes
 *      + index (M7.8 an earlier revision)
 *   6. conversation_retrieval_log + index (M7.8 an earlier revision)
 *   7. context_hygiene_runs + index (M7.8 an earlier revision)
 *   8. envelope_snapshots + index (M8.3 an earlier revision)
 *   9. skillset_disabled 
 *  10. kanban_mutations PRAGMA + 3 ALTERs (status / applied_at /
 *      evidence) — runs AFTER step 2's CREATE, exactly as before.
 *
 * `seedInitialKnowledgeIfNeeded` only inserts the four canonical
 * memory_knowledge rows when the table is empty; idempotent on subsequent
 * starts.
 */

export type AgentSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface AgentMigrationHost {
  sql: AgentSqlTag;
}

export async function runAgentMigrations(host: AgentMigrationHost): Promise<void> {
  const { sql } = host;
  sql`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  // Migrate: add trace_id column if not present
  const cols = sql<{ name: string }>`PRAGMA table_info(event_log)`;
  if (!cols.some(c => c.name === "trace_id")) {
    sql`ALTER TABLE event_log ADD COLUMN trace_id TEXT`;
  }
  sql`
    CREATE TABLE IF NOT EXISTS memory_knowledge (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS review_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS kanban_mutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_ref TEXT NOT NULL,
      mutation_type TEXT NOT NULL,
      description TEXT NOT NULL,
      diff_hint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      applied_at INTEGER,
      evidence TEXT,
      created_at INTEGER NOT NULL
    )
  `;
  // Agent Memory v1. Additive, idempotent. See
  // docs/design/agent-memory-v1.md. Profile boundary = this DO.
  sql`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      key TEXT,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL,
      active INTEGER NOT NULL DEFAULT 1,
      supersedes_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_agent_memories_type_active ON agent_memories(type, active)`;
  sql`CREATE INDEX IF NOT EXISTS idx_agent_memories_key ON agent_memories(key)`;
  // memory consolidation ledger. One row per consolidation pass:
  // what the LLM extractor pulled from conversation, how many promoted into
  // agent_memories, and the promoted ids (for rollback). `mode` = write (operator
  // agents) | dry_run (scoped users — extracted + scored but NOT written).
  // `parse_status` separates "extraction failed / unparseable" from "nothing to
  // extract" so a promoted:0 is diagnosable.
  sql`
    CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT,
      source_chunks INTEGER NOT NULL,
      extracted INTEGER NOT NULL,
      promoted INTEGER NOT NULL,
      skipped_dup INTEGER NOT NULL,
      below_threshold INTEGER NOT NULL,
      parse_status TEXT NOT NULL,
      promoted_memory_ids TEXT,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_created ON memory_consolidation_runs(agent_id, created_at)`;
  // single-row watermark: how many live dialog turns have already
  // been consolidated, so the end-of-turn auto-trigger extracts only NEW turns
  // (bounds cost + avoids re-promoting the same content across runs). Persisted (not
  // an instance field) so it survives DO eviction — otherwise every cold start would
  // re-extract the whole window.
  sql`
    CREATE TABLE IF NOT EXISTS memory_consolidation_watermark (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_turn_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `;
  // M7.7v3 an earlier revision — context_history: one row per logical
  // context (open or closed). an earlier revision added the queries; the DDL was
  // dropped during the an earlier revision commit so a fresh DO would fail on
  // first query. Carrying both DDLs forward together (idempotent).
  // The active context is now tracked separately via context_active
  // so switching back to a closed context can update the routing
  // pointer without re-opening the historical row.
  sql`
    CREATE TABLE IF NOT EXISTS context_history (
      context_id TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      message_count_at_end INTEGER
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_context_history_ended ON context_history(ended_at)`;
  // M7.7v3 single-row pointer to the registry's active
  // contextId. CHECK (id=1) enforces uniqueness so we can do
  // INSERT OR REPLACE without juggling multiple rows. Lives only on
  // the registry DO (DEMO_INSTANCE); per-context DOs create the table
  // via this idempotent DDL but never read or write it.
  sql`
    CREATE TABLE IF NOT EXISTS context_active (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_context_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL
    )
  `;
  // Conversation Archive. The registry DO
  // (DEMO_INSTANCE) is the canonical owner; per-context DOs run the
  // same DDL idempotently but never write to it (their reset path
  // RPCs the registry's `archiveChunks` callable, and the registry's
  // `newContext` RPCs the closing DO's `drainForArchive` callable
  // and writes the returned chunks here).
  //
  // `text` carries the original sanitized turn text (audit-quality);
  // `index_text` is an optional boilerplate-stripped variant for
  // search index reuse. an earlier revision stripBoilerplate is the source.
  sql`
    CREATE TABLE IF NOT EXISTS conversation_archive (
      chunk_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      message_id TEXT,
      message_index INTEGER,
      role TEXT,
      speaker TEXT,
      surface TEXT,
      task_id TEXT,
      card_id TEXT,
      type TEXT,
      harness_class TEXT,
      text TEXT NOT NULL,
      index_text TEXT,
      redaction_flags TEXT,
      source_ref TEXT,
      is_synthetic_compaction INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      trigger TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_conversation_archive_context ON conversation_archive(context_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_conversation_archive_archived ON conversation_archive(archived_at)`;
  // Per-flush audit row so operators can query "what was archived for
  // contextId=X under trigger=context.reset?". One row per flush
  // attempt, including failures (status=`failed`) and no-ops
  // (status=`skipped` for empty contexts).
  sql`
    CREATE TABLE IF NOT EXISTS conversation_archive_flushes (
      flush_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_archive_flushes_context ON conversation_archive_flushes(context_id)`;
  // Conversation retrieval audit log. Records each
  // `conversation_search` invocation: the (capped) query, filters,
  // returned refs (chunk_ids + their context_ids), and any caller-
  // supplied trace/context/task identity. an earlier revision will aggregate
  // this log to score topics for memory promotion (frequency,
  // cross-context recurrence, used vs. returned).
  sql`
    CREATE TABLE IF NOT EXISTS conversation_retrieval_log (
      retrieval_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      filters_json TEXT,
      returned_refs_json TEXT,
      used_refs_json TEXT,
      trace_id TEXT,
      context_id TEXT,
      task_id TEXT,
      result_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_retrieval_log_created ON conversation_retrieval_log(created_at)`;
  // context hygiene run audit. One row per
  // `runContextHygiene` invocation: trigger source, decision
  // (skipped|proposed|auto-applied|failed), risk gates that fired
  // (if any), pressure snapshot, before/after counts, and the
  // archive flush id + an earlier revision compact plan id when an auto-apply
  // happened. Lives on each per-context DO that ran hygiene on
  // itself; the registry isn't involved.
  sql`
    CREATE TABLE IF NOT EXISTS context_hygiene_runs (
      run_id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      pressure_message_count INTEGER NOT NULL,
      pressure_threshold INTEGER NOT NULL,
      before_message_count INTEGER NOT NULL,
      after_message_count INTEGER,
      archive_flush_id TEXT,
      applied_compact_plan_id TEXT,
      risk_conditions_json TEXT,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_context_hygiene_runs_created ON context_hygiene_runs(created_at)`;
  // durable envelope snapshots so /api/inspect/evidence
  // survives DO isolate restarts. The in-memory EnvelopeStore is still
  // the primary; this row is INSERT OR REPLACE'd on every accepted
  // mutation (createDraft / addExecution / addGateEvidence /
  // addDiffEvidence / seal). gate_logs stdout/stderr are bounded
  // (8KB head + 8KB tail) before serialization so SQL row size stays
  // sane across many turns.
  sql`
    CREATE TABLE IF NOT EXISTS envelope_snapshots (
      envelope_id TEXT PRIMARY KEY,
      task_id TEXT,
      skillset_id TEXT,
      agent_id TEXT,
      envelope_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_envelope_snapshots_created ON envelope_snapshots(created_at)`;
  // operator-disabled skillset persistence.
  //
  // an earlier revision's in-memory `_skillsetDisabled` Map was lost between
  // back-to-back HTTP requests in production (POST disable returned
  // the disabled summary, but the immediate GET runtime saw the
  // skillset re-enabled). DO instance fields *should* persist
  // across consecutive requests, but in production they did not —
  // most likely because the agents-SDK RPC plumbing or DO isolate
  // recycle reset transient class fields. SQL-backed state is the
  // documented persistence layer on this DO and survives even
  // isolate restarts, so the disabled set lives here. Source of
  // truth is this table; the snapshot builder reads it on every
  // build (no cache).
  sql`
    CREATE TABLE IF NOT EXISTS skillset_disabled (
      skillset_id TEXT PRIMARY KEY,
      disabled_at TEXT NOT NULL,
      reason TEXT
    )
  `;
  // M9.0 AgentProfile storage.
  // Stored on the DEMO_INSTANCE registry DO (global config, not
  // per-context). Defaults match an earlier revision §4 first-slice:
  // persona stored but not yet consumed; status="ready" so newly
  // created agents are listable without a separate PATCH step.
  // 2026-06-22 — `name` is unique PER OWNER, not platform-wide: the global
  // UNIQUE(name) was dropped (see the recreation migration below) so every
  // tenant can hold its own default "Agent Thursday" agent. The per-owner
  // uniqueness guard is the synchronous pre-check in createAgentProfile.
  sql`
    CREATE TABLE IF NOT EXISTS agent_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      channel TEXT NOT NULL,
      skillset TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // M9.0 manager custom skillsets. Stored on the same
  // DEMO_INSTANCE registry DO as agent_profile because skillset
  // definitions are global config visible to every per-context DO
  // that resolves an agent's effective skillset. id is the manifest
  // id (e.g. "manager-tools-custom"); embedded ids are rejected at
  // the validation layer, not by SQL. manifest_json is the
  // canonicalized EmbeddedManifest blob the loader consumes;
  // source_yaml is the operator's original text for round-trips.
  sql`
    CREATE TABLE IF NOT EXISTS custom_skillset (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL,
      source_yaml TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // M9.0 AgentRun durable row. Pairs run_id ↔
  // workflow_instance_id on the registry DO so a run is inspectable
  // after Cloudflare's workflow backplane purges its own state
  // (paid-tier retention is finite; the DO row outlives it). Status
  // transitions: 'started' → 'ok' | 'failed'. turn_id/envelope_id are
  // refs into AgentThursdayAgent event_log; they are not the trace itself
  // (an earlier revision §3 C1 step output cap).
  sql`
    CREATE TABLE IF NOT EXISTS agent_run (
      run_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      workflow_instance_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      turn_id TEXT,
      envelope_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // M9.1 observable workflow run model. Structured ledger for
  // a manager-led multi-subagent dispatch, written by the dispatch path
  // (record-only; no execution change). v1 "run" = one manager dispatch
  // invocation: `run_id = wfr-<parent_task_id>` is the observation
  // identity for the CURRENT ad-hoc manager dispatch and is stable WITHIN
  // a run (all subagents under one manager task share `parent_task_id`).
  // It is NOT a cross-conversation durable id — an earlier revision's executor will
  // mint/own its own run identity. The durable contract is the schema +
  // tree shape + ID field semantics, not this v1 derivation formula.
  sql`
    CREATE TABLE IF NOT EXISTS workflow_run (
      run_id TEXT PRIMARY KEY,
      source_task_id TEXT,
      root_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      caps TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS workflow_phase (
      phase_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      phase_order INTEGER NOT NULL DEFAULT 0,
      depends_on_phase_ids TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS workflow_agent (
      agent_node_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      status TEXT NOT NULL DEFAULT 'dispatched',
      prompt_preview TEXT,
      result_summary TEXT,
      failure_reason TEXT,
      retry_state TEXT,
      rough_token_count INTEGER,
      rough_cost REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // named workflow descriptor store (manager.workflow_save /
  // workflow_run_named). One row per name; version increments on upsert.
  sql`
    CREATE TABLE IF NOT EXISTS workflow_descriptor (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      descriptor_json TEXT NOT NULL,
      created_by_agent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // BYO-key provider credential store. One row per provider
  // (v1 single operator). `api_key` is platform-encrypted at rest by
  // CF; it is never logged and never returned over HTTP (only
  // `key_hint`). Replaces the per-worker wrangler-secret approach so
  // keys can be added at runtime without a redeploy.
  sql`
    CREATE TABLE IF NOT EXISTS provider_credential (
      provider TEXT PRIMARY KEY,
      base_url TEXT,
      api_key TEXT NOT NULL,
      key_hint TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // BYO Discord bot registry. `token` is write-only (list
  // returns token_hint), platform-encrypted at rest; allowed_channels
  // is a JSON array of channel ids each owned by exactly one bot.
  sql`
    CREATE TABLE IF NOT EXISTS discord_bot (
      bot_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      label TEXT,
      allowed_channels_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // cache the provider's discovered model ids (JSON array)
  // so any listed model is runnable without re-fetching at create time.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(provider_credential)`;
    if (!cols.some((c) => c.name === "models_json")) {
      sql`ALTER TABLE provider_credential ADD COLUMN models_json TEXT`;
    }
    // 2026-06-22 — `enabled_models_json` = the subset of discovered models the
    // user has explicitly enabled for the agent-create picker. `models_json`
    // stays the full discovered set (the runtime gate in resolveProviderForModel,
    // which must never shrink and strand a live agent); the picker shows only
    // enabled ∩ discovered. Null = nothing enabled yet (discover → enable flow).
    if (!cols.some((c) => c.name === "enabled_models_json")) {
      sql`ALTER TABLE provider_credential ADD COLUMN enabled_models_json TEXT`;
    }
  }
  // M9.3 user-product multi-tenancy groundwork (ADDITIVE ONLY;
  // no behavior change in this card — enforcement lands in 426b/c).
  //   · agent_profile / discord_bot gain `owner_user_id`. A constant
  //     NOT NULL DEFAULT backfills every existing row to the admin sentinel
  //     ('user-admin' == ADMIN_USER_ID in src/agent/requestIdentity.ts), so
  //     the current operator keeps all existing agents/bots.
  //   · `user_provider_credential` is a NEW per-(user,provider) key table.
  //     The legacy `provider_credential` table stays as the admin/global
  //     fallback (read order user → legacy → env), so nothing regresses.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(agent_profile)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE agent_profile ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
    }
  }
  // an earlier revision (2026-07-09) — real lineage: physical origin/parent_agent_id
  // columns (were annotation-only). Additive + guarded = safe on long-lived
  // DOs; old rows default to user_created/null (lineage accrues forward).
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(agent_profile)`;
    if (!cols.some((c) => c.name === "origin")) {
      sql`ALTER TABLE agent_profile ADD COLUMN origin TEXT NOT NULL DEFAULT 'user_created'`;
    }
    if (!cols.some((c) => c.name === "parent_agent_id")) {
      sql`ALTER TABLE agent_profile ADD COLUMN parent_agent_id TEXT`;
    }
    // physical retention_policy (was annotation-only): drives the
    // spawned-agent lifecycle sweep (task_scoped → auto-archive when idle).
    if (!cols.some((c) => c.name === "retention_policy")) {
      sql`ALTER TABLE agent_profile ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'durable'`;
    }
  }
  // 2026-06-22 — drop the legacy GLOBAL UNIQUE(name) on agent_profile so a
  // name is unique PER OWNER, not platform-wide. Without this, only one user
  // across the whole platform could hold "Agent Thursday" and every other
  // user's first-login onboarding 409'd. SQLite can't drop a column
  // constraint in place, so recreate the table. Idempotent: only runs while
  // the legacy `name TEXT NOT NULL UNIQUE` is still in the stored schema
  // (post-migration the regex no longer matches, so it never runs again; a
  // fresh DO already creates the table without UNIQUE above). Gated on the
  // owner_user_id column existing so the recreated table carries it. The four
  // statements are contiguous with NO await between them, so CF DO coalesces
  // them into one atomic unit — a crash can't leave the table dropped.
  // No DB-level UNIQUE replaces it: the synchronous owner-scoped pre-check in
  // createAgentProfile is the guard, and archived rows legitimately reuse a
  // live agent's name (lifecycle) which a hard per-owner index would reject.
  {
    const apMaster = sql<{ sql: string | null }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_profile'
    `;
    const apCreateSql = apMaster.length > 0 ? String(apMaster[0].sql ?? "") : "";
    const apCols = sql<{ name: string }>`PRAGMA table_info(agent_profile)`;
    const hasLegacyUnique = /\bname\b\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(apCreateSql);
    // SCHEMA-DRIFT GUARD before an IRREVERSIBLE drop. A long-lived registry DO
    // carries the union of every schema version it has ever run, which may
    // include a column some past migrations.ts version added and later code
    // dropped. The recreation copies ONLY these 10 named columns, so an
    // unexpected extra column would be destroyed by the DROP. Recreate ONLY
    // when the live column set is EXACTLY the expected set; on ANY drift skip +
    // log loudly and leave the table (and the legacy UNIQUE) untouched. Both
    // catastrophic paths (missing col → SELECT throws; extra col → silent data
    // loss) reduce to "column-set mismatch", so this one guard closes both.
    // this guard MUST list every physical column added ABOVE it in
    // this migration pass, or the set drifts and the recreate skips forever.
    // an earlier revision added `origin`/`parent_agent_id` (lines ~509) which run before
    // this block, so the live table already carries them here.
    const EXPECTED_AGENT_PROFILE_COLS = [
      "id", "name", "model", "channel", "skillset", "persona",
      "status", "created_at", "updated_at", "owner_user_id",
      "origin", "parent_agent_id", "retention_policy",
    ];
    const liveCols = apCols.map((c) => c.name).slice().sort();
    const expectedCols = EXPECTED_AGENT_PROFILE_COLS.slice().sort();
    const colsMatch =
      liveCols.length === expectedCols.length &&
      expectedCols.every((c, i) => c === liveCols[i]);
    if (hasLegacyUnique && colsMatch) {
      sql`DROP TABLE IF EXISTS agent_profile_new`;
      sql`
        CREATE TABLE agent_profile_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          channel TEXT NOT NULL,
          skillset TEXT NOT NULL,
          persona TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'ready',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          owner_user_id TEXT NOT NULL DEFAULT 'user-admin',
          origin TEXT NOT NULL DEFAULT 'user_created',
          parent_agent_id TEXT,
          retention_policy TEXT NOT NULL DEFAULT 'durable'
        )
      `;
      sql`
        INSERT INTO agent_profile_new
          (id, name, model, channel, skillset, persona, status, created_at, updated_at, owner_user_id, origin, parent_agent_id, retention_policy)
        SELECT
          id, name, model, channel, skillset, persona, status, created_at, updated_at, owner_user_id, origin, parent_agent_id, retention_policy
        FROM agent_profile
      `;
      sql`DROP TABLE agent_profile`;
      sql`ALTER TABLE agent_profile_new RENAME TO agent_profile`;
    } else if (hasLegacyUnique && !colsMatch) {
      console.warn(
        `[migrations] agent_profile per-owner-uniqueness migration SKIPPED: column-set drift ` +
          `(live=[${liveCols.join(",")}] expected=[${expectedCols.join(",")}]). ` +
          `Legacy global UNIQUE(name) left in place; investigate before recreating.`,
      );
    }
  }
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(discord_bot)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE discord_bot ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
    }
  }
  // 2026-06-17 — custom skillsets gain `owner_user_id` (the operator: custom skillsets
  // must be owner-scoped; system/embedded ones stay global — embedded live in
  // code, not this table, so they're never owner-filtered). Same default as
  // agent_profile so pre-column rows fall to admin. One-off backfill: attribute
  // each custom skillset to the owner of an agent that uses it (its creating
  // tenant) — so a user's agent-authored skillset (e.g. `paper-collector`,
  // built by a user's manager) becomes theirs, not admin's. On a fresh deploy
  // the table is empty so the UPDATE is a no-op.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(custom_skillset)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE custom_skillset ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
      sql`
        UPDATE custom_skillset
           SET owner_user_id = (
             SELECT p.owner_user_id FROM agent_profile p
              WHERE p.skillset = custom_skillset.id LIMIT 1
           )
         WHERE EXISTS (
           SELECT 1 FROM agent_profile p2 WHERE p2.skillset = custom_skillset.id
         )
      `;
    }
  }
  // 2026-06-18 — workflow store/ledger gain `owner_user_id` (multi-tenancy:
  // a scoped user's manager.workflow_* tools must not read/overwrite the
  // operator's GLOBAL workflow_descriptor rows or read other tenants' runs).
  // Same default as agent_profile so every pre-column row backfills to the
  // admin sentinel — i.e. existing workflows stay the OPERATOR's private ones
  // (unlike custom_skillset there is NO system-owner seeding for workflows, so
  // scoped users see zero baseline workflows by design, not the admin's).
  // workflow_phase / workflow_agent are children of a run and inherit its owner
  // via the run row — no separate column.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(workflow_descriptor)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE workflow_descriptor ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
    }
  }
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(workflow_run)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE workflow_run ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
    }
  }
  // 2026-06-18 — conversation_archive gains `owner_user_id` (multi-tenancy:
  // the base `conversation_search` tool reads the registry-global archive, so
  // without an owner filter a scoped user agent could search EVERY tenant's
  // archived conversations). Default backfills pre-column rows to admin so the
  // operator keeps full cross-context search; scoped users only match their own
  // owner's archives. The security boundary is the READ filter
  // (`conversationSearchFree` scopeOwnerId); the write stamp is best-effort.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(conversation_archive)`;
    if (!cols.some((c) => c.name === "owner_user_id")) {
      sql`ALTER TABLE conversation_archive ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'user-admin'`;
    }
  }
  sql`
    CREATE TABLE IF NOT EXISTS user_provider_credential (
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT NOT NULL,
      key_hint TEXT NOT NULL,
      label TEXT,
      models_json TEXT,
      enabled_models_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, provider)
    )
  `;
  // 2026-06-22 — back-fill enabled_models_json on pre-existing user credential
  // rows (see provider_credential note above; picker = enabled subset, runtime
  // gate = full models_json).
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(user_provider_credential)`;
    if (!cols.some((c) => c.name === "enabled_models_json")) {
      sql`ALTER TABLE user_provider_credential ADD COLUMN enabled_models_json TEXT`;
    }
  }
  // P1 end-user accounts live on the registry DO so the
  // ADMIN-gated approval action runs in the secret-protected console (the operator:
  // "approve 放 console 更保险"), not on a public link. The gateway resolves
  // users here over the service binding at login; the operator approves in
  // the console. `user_id` is what the gateway later puts in X-AgentThursday-User-Id.
  sql`
    CREATE TABLE IF NOT EXISTS app_user (
      user_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      sub TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  sql`CREATE UNIQUE INDEX IF NOT EXISTS app_user_provider_sub ON app_user(provider, sub)`;
  // 2026-06-19 — workspace file share (replaces fyimd external-publishing).
  // A global agent capability: an agent snapshots a single workspace file into
  // this OWNER-SCOPED registry-DO table so (a) other agents of the same owner
  // and (b) the owner user can read it. There is deliberately NO public column
  // and NO public route — "no public sharing" is structural: every read is
  // filtered by `owner_user_id`. Content is snapshotted (per-agent workspaces
  // are isolated, so a reference would be unreachable cross-agent). Lives on
  // the registry DO like workflow_run; per-agent DOs keep an empty copy.
  sql`
    CREATE TABLE IF NOT EXISTS shared_file (
      file_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_agent_name TEXT,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS shared_file_owner ON shared_file(owner_user_id, created_at)`;
  // turn share links: frozen per-turn snapshots, readable BY LINK
  // (crypto-random id). Owner recorded for a future manage/revoke surface.
  sql`
    CREATE TABLE IF NOT EXISTS turn_share (
      share_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS turn_share_owner ON turn_share(owner_user_id, created_at)`;
  // per-turn token usage (tokens only; cost is computed at display
  // time from the frontend pricing table so price changes never migrate data).
  // Keyed by the turn's anchoring user message id (joins getDialogTurns) and
  // the task id (the finalize-time UPDATE key). cached NULL = provider didn't
  // report a cache breakdown (cost falls back to full-price upper bound).
  sql`
    CREATE TABLE IF NOT EXISTS task_usage (
      task_id TEXT PRIMARY KEY,
      message_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_in_cached INTEGER,
      model TEXT,
      provider TEXT,
      created_at INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS task_usage_message ON task_usage(message_id)`;
  // native scheduled tasks v1. OWNER-SCOPED registry-DO table
  // (per-agent DOs keep an empty copy, like shared_file). The registry DO's
  // minute tick claims due rows (advance next_run_at BEFORE dispatch) and
  // dispatches through the normal manager message path under the row owner's
  // identity, fail-closed. Safety valves (per-owner cap, min interval,
  // auto-disable on consecutive failures) live in scheduledTaskOps.ts.
  sql`
    CREATE TABLE IF NOT EXISTS scheduled_task (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      interval_s INTEGER,
      at_hour INTEGER,
      at_minute INTEGER,
      at_weekday INTEGER,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      last_task_id TEXT,
      last_status TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS scheduled_task_due ON scheduled_task(enabled, next_run_at)`;
  sql`CREATE INDEX IF NOT EXISTS scheduled_task_owner ON scheduled_task(owner_user_id, created_at)`;
  // per-schedule execution history (dispatched → ok|failed).
  // Pruned to the most recent rows per schedule in scheduledTaskOps.
  sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_run (
      task_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      started_at TEXT NOT NULL,
      settled_at TEXT
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS scheduled_task_run_sched ON scheduled_task_run(schedule_id, started_at)`;
  // 2026-06-23 — user-uploaded documents. We persist ONLY the agent-readable
  // markdown (raw files are converted via env.AI.toMarkdown and discarded, per
  // the operator). The markdown body lives in R2 (DOCS_BUCKET, owner-keyed `r2_key`); this
  // OWNER-SCOPED registry-DO row carries the metadata + a short preview for
  // listing/search. Reads are always owner-filtered; the `document.*` agent tool
  // resolves the owner from the dispatching agent. Lives on the registry DO like
  // shared_file; per-agent DOs keep an empty copy.
  sql`
    CREATE TABLE IF NOT EXISTS uploaded_document (
      doc_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      char_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      preview TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS uploaded_document_owner ON uploaded_document(owner_user_id, created_at)`;
  // 2026-06-25 — async upload (fyimd queue). A PDF/office upload that fyimd routes
  // to its async queue is recorded as `processing` with the poll URL in
  // `pending_ref`; it flips to `done` (markdown written to R2) when a later list /
  // read lazily re-polls fyimd. Additive ALTER (no DROP) — existing rows back-fill
  // to `done` via the DEFAULT, so old synchronous uploads keep working unchanged.
  const udCols = sql<{ name: string }>`PRAGMA table_info(uploaded_document)`;
  if (!udCols.some(c => c.name === "status")) {
    sql`ALTER TABLE uploaded_document ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`;
  }
  if (!udCols.some(c => c.name === "pending_ref")) {
    sql`ALTER TABLE uploaded_document ADD COLUMN pending_ref TEXT`;
  }
  // Migrate: add status/applied_at/evidence columns to kanban_mutations if not present
  const kmCols = sql<{ name: string }>`PRAGMA table_info(kanban_mutations)`;
  if (!kmCols.some(c => c.name === "status")) {
    sql`ALTER TABLE kanban_mutations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`;
  }
  if (!kmCols.some(c => c.name === "applied_at")) {
    sql`ALTER TABLE kanban_mutations ADD COLUMN applied_at INTEGER`;
  }
  if (!kmCols.some(c => c.name === "evidence")) {
    sql`ALTER TABLE kanban_mutations ADD COLUMN evidence TEXT`;
  }
}

/**
 * the canonical AgentThursday project-knowledge seed. This is OPERATOR
 * (admin) context: a user-product agent must never carry it (the leak that made
 * DS Manager believe its job was to advance AgentThursday). Kept as a single source
 * of truth so the seed and the purge can never drift.
 */
export const AGENTTHURSDAY_SEED_KNOWLEDGE: ReadonlyArray<readonly [string, string]> = [
  ["project", "AgentThursday — 云原生 durable agent OS，运行在 Cloudflare Durable Objects + Agents SDK 上。"],
  ["m0-dod", "M0 DoD: DoD-1 稳定身份, DoD-2 session 恢复, DoD-3 model adapter, DoD-4 profile 可感知, DoD-5 intelligence awareness, DoD-6 event trace 可回放。"],
  ["stack", "技术栈: Cloudflare Workers + Durable Objects + Agents SDK v0.0.95 + TypeScript。"],
  ["dogfood", "固定 dogfood 问题: 如何使用新构建的 agent 开发当前项目？"],
];

/**
 * Seed the AgentThursday project knowledge — ONLY for operator/admin agents.
 * an earlier revision: callers MUST pass `isOperator`. A scoped (user-owned) agent gets
 * nothing here; the leaked seeds on existing user agents are removed by
 * `purgeAgentThursdaySeedKnowledge`. Unchanged behavior for operators: seed only when
 * the table is empty (idempotent).
 */
export async function seedInitialKnowledgeIfNeeded(host: AgentMigrationHost, isOperator: boolean): Promise<void> {
  if (!isOperator) return;
  const { sql } = host;
  const existing = sql<{ key: string }>`SELECT key FROM memory_knowledge LIMIT 1`;
  if (existing.length === 0) {
    for (const [key, content] of AGENTTHURSDAY_SEED_KNOWLEDGE) {
      sql`INSERT INTO memory_knowledge (key, content) VALUES (${key}, ${content})`;
    }
  }
}

/**
 * remove leaked AgentThursday seed knowledge from a NON-operator agent.
 * Deletes ONLY rows whose (key, content) EXACTLY match a canonical seed pair,
 * so a user agent's own remembered knowledge (even under the same key) is never
 * touched. Returns the number of rows removed. Idempotent.
 */
export function purgeAgentThursdaySeedKnowledge(host: AgentMigrationHost): number {
  const { sql } = host;
  let removed = 0;
  for (const [key, content] of AGENTTHURSDAY_SEED_KNOWLEDGE) {
    const before = sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory_knowledge WHERE key = ${key} AND content = ${content}`;
    const count = before.length > 0 ? Number(before[0].n) : 0;
    if (count > 0) {
      sql`DELETE FROM memory_knowledge WHERE key = ${key} AND content = ${content}`;
      removed += count;
    }
  }
  return removed;
}
