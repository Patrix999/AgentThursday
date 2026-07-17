import { test } from "node:test";
import assert from "node:assert/strict";

import {
  seedInitialKnowledgeIfNeeded,
  purgeAgentThursdaySeedKnowledge,
  AGENTTHURSDAY_SEED_KNOWLEDGE,
  type AgentMigrationHost,
} from "./migrations";

// AgentThursday project knowledge is OPERATOR context. A scoped (user-owned)
// agent must never be seeded with it, and leaked seeds on existing user agents
// must be purged WITHOUT touching the user's own remembered knowledge.

type Row = { key: string; content: string };

function fakeHost(initial: Row[] = []): { host: AgentMigrationHost; rows: Row[] } {
  const rows: Row[] = [...initial];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT key FROM memory_knowledge LIMIT 1")) {
      return rows.slice(0, 1).map((r) => ({ key: r.key }));
    }
    if (text.startsWith("INSERT INTO memory_knowledge")) {
      rows.push({ key: String(values[0]), content: String(values[1]) });
      return [];
    }
    if (text.startsWith("SELECT COUNT(*) AS n FROM memory_knowledge WHERE key =")) {
      const n = rows.filter((r) => r.key === values[0] && r.content === values[1]).length;
      return [{ n }];
    }
    if (text.startsWith("DELETE FROM memory_knowledge WHERE key =")) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].key === values[0] && rows[i].content === values[1]) rows.splice(i, 1);
      }
      return [];
    }
    throw new Error(`unhandled sql in fake: ${text}`);
  }) as AgentMigrationHost["sql"];
  return { host: { sql }, rows };
}

test("user-owned agent is NEVER seeded with AgentThursday knowledge", async () => {
  const { host, rows } = fakeHost();
  await seedInitialKnowledgeIfNeeded(host, false);
  assert.equal(rows.length, 0);
});

test("operator agent seeds the canonical AgentThursday knowledge when empty", async () => {
  const { host, rows } = fakeHost();
  await seedInitialKnowledgeIfNeeded(host, true);
  assert.equal(rows.length, AGENTTHURSDAY_SEED_KNOWLEDGE.length);
  assert.deepEqual(
    rows.map((r) => r.key).sort(),
    AGENTTHURSDAY_SEED_KNOWLEDGE.map(([k]) => k).sort(),
  );
});

test("operator seed is idempotent — never double-seeds a non-empty table", async () => {
  const { host, rows } = fakeHost([{ key: "anything", content: "x" }]);
  await seedInitialKnowledgeIfNeeded(host, true);
  assert.equal(rows.length, 1);
});

test("purge removes exactly the leaked AgentThursday seeds", async () => {
  const seeded: Row[] = AGENTTHURSDAY_SEED_KNOWLEDGE.map(([key, content]) => ({ key, content }));
  const { host, rows } = fakeHost(seeded);
  const removed = purgeAgentThursdaySeedKnowledge(host);
  assert.equal(removed, AGENTTHURSDAY_SEED_KNOWLEDGE.length);
  assert.equal(rows.length, 0);
});

test("purge NEVER deletes the user's own knowledge under a colliding key", async () => {
  // A user agent legitimately remembered something under key "project" — its
  // content differs from the seed, so it must survive the purge.
  const userRow: Row = { key: "project", content: "my own project notes about robot tipping" };
  const { host, rows } = fakeHost([userRow, ...AGENTTHURSDAY_SEED_KNOWLEDGE.map(([key, content]) => ({ key, content }))]);
  const removed = purgeAgentThursdaySeedKnowledge(host);
  assert.equal(removed, AGENTTHURSDAY_SEED_KNOWLEDGE.length);
  assert.deepEqual(rows, [userRow]);
});

test("purge is idempotent on an already-clean user agent", async () => {
  const { host, rows } = fakeHost([{ key: "note", content: "unrelated" }]);
  const removed = purgeAgentThursdaySeedKnowledge(host);
  assert.equal(removed, 0);
  assert.equal(rows.length, 1);
});
