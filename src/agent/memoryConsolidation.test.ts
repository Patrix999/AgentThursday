import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

import {
  type MemoryWriteHost,
  type MemoryOpsSqlTag,
  parseMemoryExtraction,
  buildMemoryExtractionPrompt,
  consolidateMemoriesFree,
} from "./memoryOps";

/**
 * contradiction pruning in memory consolidation. The LLM extractor
 * may flag a new memory as superseding an existing one (by [index]); the
 * consolidator must soft-delete the referenced row, bypass the dedup drop for
 * such intentional updates, and ledger the supersede count.
 */
function mkSqlite(): { host: MemoryWriteHost; db: DatabaseSync; events: Array<{ type: string; payload: unknown }> } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const params = values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as Array<
      string | number | bigint | null | Uint8Array
    >;
    // INSERT ... RETURNING must run as a query so rememberMemoryFree gets the id.
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)/i.test(text) || /RETURNING/i.test(text);
    const stmt = db.prepare(text);
    if (isQuery) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }) as unknown as MemoryOpsSqlTag;
  const events: Array<{ type: string; payload: unknown }> = [];
  const host: MemoryWriteHost = { sql, logEvent: (type, payload) => events.push({ type, payload }) };
  // minimal schema (mirrors migrations.ts)
  sql`CREATE TABLE agent_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, key TEXT, content TEXT NOT NULL, source TEXT NOT NULL, confidence REAL, active INTEGER NOT NULL DEFAULT 1, supersedes_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
  sql`CREATE TABLE memory_consolidation_runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, mode TEXT NOT NULL, model TEXT, source_chunks INTEGER NOT NULL, extracted INTEGER NOT NULL, promoted INTEGER NOT NULL, skipped_dup INTEGER NOT NULL, below_threshold INTEGER NOT NULL, parse_status TEXT NOT NULL, promoted_memory_ids TEXT, created_at INTEGER NOT NULL)`;
  return { host, db, events };
}

function seed(host: MemoryWriteHost, content: string): number {
  const rows = host.sql<{ id: number }>`INSERT INTO agent_memories (type, key, content, source, confidence, active, supersedes_id, created_at, updated_at) VALUES ('fact', NULL, ${content}, 'seed', 0.9, 1, NULL, 1, 1) RETURNING id`;
  return rows[0].id;
}
function activeContents(host: MemoryWriteHost): string[] {
  return host.sql<{ content: string }>`SELECT content FROM agent_memories WHERE active = 1 ORDER BY id`.map((r) => r.content);
}
function isActive(host: MemoryWriteHost, id: number): boolean {
  return host.sql<{ active: number }>`SELECT active FROM agent_memories WHERE id = ${id}`[0]?.active === 1;
}

describe("parseMemoryExtraction — supersedes ", () => {
  it("parses a non-negative integer index, treats null/absent/negative/non-int as null", () => {
    const r = parseMemoryExtraction(JSON.stringify([
      { type: "fact", content: "a", confidence: 0.9, reason: "", supersedes: 2 },
      { type: "fact", content: "b", confidence: 0.9, reason: "", supersedes: null },
      { type: "fact", content: "c", confidence: 0.9, reason: "" },
      { type: "fact", content: "d", confidence: 0.9, reason: "", supersedes: -1 },
      { type: "fact", content: "e", confidence: 0.9, reason: "", supersedes: 1.5 },
    ]));
    assert.equal(r.parseStatus, "ok");
    assert.deepEqual(r.candidates.map((c) => c.supersedes), [2, null, null, null, null]);
  });
});

describe("buildMemoryExtractionPrompt — an earlier revision", () => {
  it("numbers existing memories and injects the date + supersedes contract", () => {
    const p = buildMemoryExtractionPrompt("dialog", ["old fact one", "old fact two"], "2026-06-29");
    assert.match(p, /\[0\] old fact one/);
    assert.match(p, /\[1\] old fact two/);
    assert.match(p, /Today's date is 2026-06-29/);
    assert.match(p, /supersedes/);
  });
  it("omits the date line when nowIso is not provided", () => {
    const p = buildMemoryExtractionPrompt("dialog", [], undefined);
    assert.doesNotMatch(p, /Today's date is/);
  });
});

describe("consolidateMemoriesFree — contradiction pruning ", () => {
  it("supersedes the referenced existing memory and ledgers the count", () => {
    const { host } = mkSqlite();
    const id0 = seed(host, "the operator's source id is a-long-uuid-aaaa");
    const id1 = seed(host, "The project is AgentThursday");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;

    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "the operator's source id is now usrc-7tx49jad", confidence: 0.9, reason: "changed", supersedes: 0 }],
    });

    assert.equal(ledger.promoted, 1);
    assert.equal(ledger.superseded, 1);
    assert.deepEqual(ledger.superseded_memory_ids, [id0]);
    assert.equal(isActive(host, id0), false, "old source-id memory soft-deleted");
    assert.equal(isActive(host, id1), true, "unrelated memory untouched");
    assert.deepEqual(activeContents(host), ["The project is AgentThursday", "the operator's source id is now usrc-7tx49jad"]);
  });

  it("a superseding candidate bypasses the dup check (a contradiction is close to what it replaces)", () => {
    const { host } = mkSqlite();
    const id0 = seed(host, "default subagent model is kimi-k2.6");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    // content is lexically close to the existing one → would be a dup if unflagged
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "default subagent model is deepseek-v4-pro", confidence: 0.9, reason: "changed", supersedes: 0 }],
    });
    assert.equal(ledger.promoted, 1);
    assert.equal(ledger.superseded, 1);
    assert.equal(ledger.skipped_dup, 0);
    assert.equal(isActive(host, id0), false);
  });

  it("a NON-superseding dup is still skipped, and below-threshold is still skipped", () => {
    const { host } = mkSqlite();
    seed(host, "The project is AgentThursday");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [
        { type: "fact", content: "The project is AgentThursday", confidence: 0.95, reason: "dup", supersedes: null },
        { type: "fact", content: "a brand new low-confidence claim", confidence: 0.3, reason: "weak", supersedes: null },
      ],
    });
    assert.equal(ledger.promoted, 0);
    assert.equal(ledger.skipped_dup, 1);
    assert.equal(ledger.below_threshold, 1);
    assert.equal(ledger.superseded, 0);
  });

  it("rejects a mis-pointed (unrelated) supersede — old memory stays active, new promotes fresh", () => {
    const { host, events } = mkSqlite();
    const id0 = seed(host, "the operator's source id is usrc-7tx49jad");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    // supersedes=0 but content is unrelated to refs[0] → guard must reject the soft-delete
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "Deploys run through sg docker on aarch64", confidence: 0.9, reason: "new", supersedes: 0 }],
    });
    assert.equal(ledger.promoted, 1, "still promoted as a fresh memory");
    assert.equal(ledger.superseded, 0, "no supersede applied");
    assert.equal(isActive(host, id0), true, "the unrelated existing memory was NOT soft-deleted");
    assert.ok(events.some((e) => e.type === "memory.consolidation.supersede_rejected"), "rejection is audited");
  });

  it("rejects a supersede sharing only ONE significant token (cross-dimension mis-flag)", () => {
    const { host, events } = mkSqlite();
    const id0 = seed(host, "the operator prefers the color blue");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    // shares only "pat" (a single significant token) with the old memory → < 2 → reject
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "the operator works with the React framework", confidence: 0.9, reason: "new", supersedes: 0 }],
    });
    assert.equal(ledger.superseded, 0, "a single shared token must NOT authorise a supersede");
    assert.equal(isActive(host, id0), true, "the cross-dimension memory stays active");
    assert.ok(events.some((e) => e.type === "memory.consolidation.supersede_rejected"));
  });

  it("allows a supersede with >= 2 shared significant tokens (genuine update)", () => {
    const { host } = mkSqlite();
    const id0 = seed(host, "The default subagent model is kimi");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    // shares "default","subagent","model" (>= 2 significant) → supersede allowed
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "The default subagent model is deepseek", confidence: 0.9, reason: "changed", supersedes: 0 }],
    });
    assert.equal(ledger.superseded, 1);
    assert.equal(isActive(host, id0), false);
  });

  it("an out-of-range supersedes index does not crash — promotes as a fresh memory", () => {
    const { host } = mkSqlite();
    seed(host, "only one existing");
    const existingRefs = host.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    const ledger = consolidateMemoriesFree(host, {
      agentId: "agent-x", mode: "write", model: "m", sourceChunks: 1, parseStatus: "ok",
      existingRefs,
      candidates: [{ type: "fact", content: "a genuinely new fact about deploys", confidence: 0.9, reason: "new", supersedes: 9 }],
    });
    assert.equal(ledger.promoted, 1);
    assert.equal(ledger.superseded, 0);
  });
});
