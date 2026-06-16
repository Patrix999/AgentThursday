/**
 *  —  onStart migrations / startup schema noise extraction.
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
 *   3. agent_memories + 2 indexes ( )
 *   4. context_history + index, context_active ( Cards 148/149)
 *   5. conversation_archive + 2 indexes, conversation_archive_flushes
 *      + index ( )
 *   6. conversation_retrieval_log + index ( )
 *   7. context_hygiene_runs + index ( )
 *   8. envelope_snapshots + index ( )
 *   9. skillset_disabled ()
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
  //  Profile boundary = this DO.
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
  //   / 149 — context_history: one row per logical
  // context (open or closed).  added the queries; the DDL was
  // dropped during the  commit so a fresh DO would fail on
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
  //   — single-row pointer to the registry's active
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
  // search index reuse.  stripBoilerplate is the source.
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
  // supplied trace/context/task identity.  will aggregate
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
  // archive flush id +  compact plan id when an auto-apply
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
  //  — operator-disabled skillset persistence.
  //
  // 's in-memory `_skillsetDisabled` Map was lost between
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
  //  —  AgentProfile storage.
  // Stored on the DEMO_INSTANCE registry DO (global config, not
  // per-context). UNIQUE(name) lets the API surface 409 conflict for
  // duplicate-name creates. Defaults match  §4 first-slice:
  // persona stored but not yet consumed; status="ready" so newly
  // created agents are listable without a separate PATCH step.
  sql`
    CREATE TABLE IF NOT EXISTS agent_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,
      channel TEXT NOT NULL,
      skillset TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  //  —  manager custom skillsets. Stored on the same
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
  //  —  AgentRun durable row. Pairs run_id ↔
  // workflow_instance_id on the registry DO so a run is inspectable
  // after Cloudflare's workflow backplane purges its own state
  // (paid-tier retention is finite; the DO row outlives it). Status
  // transitions: 'started' → 'ok' | 'failed'. turn_id/envelope_id are
  // refs into AgentThursdayAgent event_log; they are not the trace itself
  // ( §3 C1 step output cap).
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
  //  —  observable workflow run model. Structured ledger for
  // a manager-led multi-subagent dispatch, written by the dispatch path
  // (record-only; no execution change). v1 "run" = one manager dispatch
  // invocation: `run_id = wfr-<parent_task_id>` is the observation
  // identity for the CURRENT ad-hoc manager dispatch and is stable WITHIN
  // a run (all subagents under one manager task share `parent_task_id`).
  // It is NOT a cross-conversation durable id — 's executor will
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
  //  — named workflow descriptor store (manager.workflow_save /
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
  //  — BYO-key provider credential store. One row per provider
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
  //  — BYO Discord bot registry. `token` is write-only (list
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
  //  — cache the provider's discovered model ids (JSON array)
  // so any listed model is runnable without re-fetching at create time.
  {
    const cols = sql<{ name: string }>`PRAGMA table_info(provider_credential)`;
    if (!cols.some((c) => c.name === "models_json")) {
      sql`ALTER TABLE provider_credential ADD COLUMN models_json TEXT`;
    }
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

export async function seedInitialKnowledgeIfNeeded(host: AgentMigrationHost): Promise<void> {
  const { sql } = host;
  const existing = sql<{ key: string }>`SELECT key FROM memory_knowledge LIMIT 1`;
  if (existing.length === 0) {
    for (const [key, content] of [
      ["project", "AgentThursday — 云原生 durable agent OS，运行在 Cloudflare Durable Objects + Agents SDK 上。"],
      ["m0-dod", "M0 DoD: DoD-1 稳定身份, DoD-2 session 恢复, DoD-3 model adapter, DoD-4 profile 可感知, DoD-5 intelligence awareness, DoD-6 event trace 可回放。"],
      ["stack", "技术栈: Cloudflare Workers + Durable Objects + Agents SDK v0.0.95 + TypeScript。"],
      ["dogfood", "固定 dogfood 问题: 如何使用新构建的 agent 开发当前项目？"],
    ] as [string, string][]) {
      sql`INSERT INTO memory_knowledge (key, content) VALUES (${key}, ${content})`;
    }
  }
}
