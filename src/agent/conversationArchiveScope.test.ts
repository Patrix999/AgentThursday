import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  writeArchiveFlushFree,
  archiveChunksFree,
  conversationSearchFree,
  buildSearchLikeTerms,
  emptyConversationSearchResult,
  type ArchiveWriteHost,
  type ArchiveSearchHost,
  type ArchiveOpsSqlTag,
} from "./archiveOps";
import { ADMIN_USER_ID } from "./requestIdentity";
import type { ConversationSearchInput } from "../schema/archive";

/**
 * Multi-tenancy (Cluster B) — conversation_archive owner scoping.
 *
 * `conversation_search` reads the registry-global `conversation_archive`. A
 * scoped user must only match its OWN owner's archives; admin (operator) sees
 * all. The WRITE stamps the owner (best-effort), the READ filter is the
 * security boundary. The tool's `execute()` resolves the caller's owner and
 * FAILS CLOSED (null → empty results).
 *
 * Asserts: (a) scoped user sees only own rows, (b) admin sees all, (c) write
 * stamps owner, (d) fail-closed on unresolved owner, (e) cross-tenant row
 * invisible to another user.
 */
type ArchiveRow = {
  chunk_id: string;
  context_id: string;
  role: string | null;
  text: string;
  index_text: string | null;
  archived_at: number;
  trigger: string;
  is_synthetic_compaction: number;
  owner_user_id: string;
};

function makeFakeArchive(initial: ArchiveRow[] = []): {
  writeHost: ArchiveWriteHost;
  searchHost: ArchiveSearchHost;
  rows: ArchiveRow[];
} {
  const rows: ArchiveRow[] = [...initial];
  const sql: ArchiveOpsSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as Array<string | number | null>;

    if (text.startsWith("INSERT OR REPLACE INTO conversation_archive")) {
      // Positional binds match the INSERT column order in archiveOps.
      const [chunk_id, context_id, , , role, , , , , , , textVal, index_text, , , isSynth, , archived_at, trigger, owner_user_id] =
        v as Array<string | number | null>;
      rows.push({
        chunk_id: String(chunk_id),
        context_id: String(context_id),
        role: role === null ? null : String(role),
        text: String(textVal),
        index_text: index_text === null ? null : String(index_text),
        archived_at: Number(archived_at),
        trigger: String(trigger),
        is_synthetic_compaction: Number(isSynth),
        owner_user_id: String(owner_user_id),
      });
      return [];
    }
    if (text.startsWith("INSERT INTO conversation_archive_flushes")) return [];
    if (text.startsWith("INSERT INTO conversation_retrieval_log")) return [];

    if (text.startsWith("SELECT chunk_id, context_id") && text.includes("FROM conversation_archive")) {
      // an earlier revision bind order: t0..t4 (LIKE terms, 2 binds each interleaved as
      // index_text/text within one slot → but positionally each ${t} appears
      // 3× in the slot: null-check, index_text LIKE, text LIKE), then ctx×2,
      // from×2, to×2, role×2, owner×2, topK. We stitch by reading the distinct
      // term patterns from the leading binds until the ctx sentinel pattern.
      // Simpler: the 5 slots each contribute 3 identical binds (null,idx,txt).
      const termBinds: (string | null)[] = [];
      for (let i = 0; i < 5; i++) termBinds.push(v[i * 3] as string | null);
      const afterTerms = 15; // 5 slots × 3 binds
      const filterCtx = v[afterTerms] as string | null;
      const filterFrom = v[afterTerms + 2] as number | null;
      const filterTo = v[afterTerms + 4] as number | null;
      const filterRole = v[afterTerms + 6] as string | null;
      const filterOwner = v[afterTerms + 8] as string | null;
      const topK = v[afterTerms + 10] as number;
      const needles = termBinds
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase());
      const out = rows
        // AND semantics: every term must appear in index_text or text.
        .filter((r) =>
          needles.every(
            (n) => (r.index_text ?? "").toLowerCase().includes(n) || r.text.toLowerCase().includes(n),
          ),
        )
        .filter((r) => filterCtx === null || r.context_id === filterCtx)
        .filter((r) => filterFrom === null || r.archived_at >= filterFrom)
        .filter((r) => filterTo === null || r.archived_at <= filterTo)
        .filter((r) => filterRole === null || r.role === filterRole)
        .filter((r) => filterOwner === null || r.owner_user_id === filterOwner)
        .sort((a, b) => b.archived_at - a.archived_at)
        .slice(0, topK);
      return out.map((r) => ({
        chunk_id: r.chunk_id,
        context_id: r.context_id,
        message_id: null,
        message_index: null,
        role: r.role,
        trigger: r.trigger,
        archived_at: r.archived_at,
        text: r.text,
        index_text: r.index_text,
        is_synthetic_compaction: r.is_synthetic_compaction,
      }));
    }

    throw new Error(`unhandled sql in fake: ${text}`);
  }) as ArchiveOpsSqlTag;

  const writeHost: ArchiveWriteHost = {
    sql,
    logEvent: () => {},
    getMessages: () => [],
    ensureActiveContext: () => ({ context_id: "ctx", reason: null, created_at: 0 }),
  };
  const searchHost: ArchiveSearchHost = { sql, logEvent: () => {} };
  return { writeHost, searchHost, rows };
}

function chunk(text: string, role: "user" | "assistant" = "user") {
  return { messageId: "m1", messageIndex: 0, role, text, indexText: text, isSyntheticCompaction: false };
}

describe("conversation_archive — write stamps owner (c)", () => {
  it("archiveChunksFree stamps the supplied owner on every chunk", () => {
    const { writeHost, rows } = makeFakeArchive();
    archiveChunksFree(writeHost, {
      contextId: "ctx-a",
      trigger: "context.reset",
      chunks: [chunk("hello alice")],
      ownerUserId: "user-alice",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_user_id, "user-alice");
  });

  it("omitted owner falls to the admin sentinel (best-effort write)", () => {
    const { writeHost, rows } = makeFakeArchive();
    writeArchiveFlushFree(writeHost, {
      contextId: "ctx-op",
      trigger: "context.new",
      chunks: [chunk("operator note")],
      reason: null,
    });
    assert.equal(rows[0].owner_user_id, ADMIN_USER_ID);
  });

  // Track A drain-to-self: the LOCAL write path (`writeArchiveFlushLocal`
  // host closure) now resolves THIS DO's own owner and passes it to
  // `writeArchiveFlushFree` (previously the local write omitted owner → admin).
  // Assert the explicit owner is stamped (not the admin sentinel) so a scoped
  // agent's own owner-scoped search can match its locally-archived rows.
  it("local write with explicit non-admin owner stamps that owner (drain-to-self)", () => {
    const { writeHost, rows } = makeFakeArchive();
    writeArchiveFlushFree(writeHost, {
      contextId: "ctx-scoped",
      trigger: "context.reset",
      chunks: [chunk("scoped user note")],
      reason: null,
      ownerUserId: "user-alice",
    });
    assert.equal(rows[0].owner_user_id, "user-alice");
    assert.notEqual(rows[0].owner_user_id, ADMIN_USER_ID);
  });

  it("round-trip: locally-written scoped rows are found by that owner, hidden from others", () => {
    const { writeHost, searchHost } = makeFakeArchive();
    writeArchiveFlushFree(writeHost, {
      contextId: "ctx-scoped",
      trigger: "context.reset",
      chunks: [chunk("alice deployment secret")],
      reason: null,
      ownerUserId: "user-alice",
    });
    const q: ConversationSearchInput = { query: "deployment secret", topK: 10 };
    assert.deepEqual(conversationSearchFree(searchHost, q, "user-alice").hits.map((h) => h.chunkId).length, 1);
    assert.deepEqual(conversationSearchFree(searchHost, q, "user-bob").hits, []);
  });
});

describe("conversation_archive — owner-scoped search (a)(b)(e)", () => {
  function seeded() {
    return makeFakeArchive([
      { chunk_id: "c1", context_id: "ctx-a", role: "user", text: "alice secret plan", index_text: "alice secret plan", archived_at: 30, trigger: "t", is_synthetic_compaction: 0, owner_user_id: "user-alice" },
      { chunk_id: "c2", context_id: "ctx-b", role: "user", text: "bob secret plan", index_text: "bob secret plan", archived_at: 20, trigger: "t", is_synthetic_compaction: 0, owner_user_id: "user-bob" },
      { chunk_id: "c3", context_id: "ctx-op", role: "user", text: "operator secret plan", index_text: "operator secret plan", archived_at: 10, trigger: "t", is_synthetic_compaction: 0, owner_user_id: ADMIN_USER_ID },
    ]);
  }
  const query: ConversationSearchInput = { query: "secret plan", topK: 10 };

  it("(a)(e) scoped user matches ONLY own owner's rows", () => {
    const { searchHost } = seeded();
    const res = conversationSearchFree(searchHost, query, "user-alice");
    assert.deepEqual(res.hits.map((h) => h.chunkId), ["c1"]);
  });

  it("(b) admin (undefined scope) matches ALL tenants' rows", () => {
    const { searchHost } = seeded();
    const res = conversationSearchFree(searchHost, query, undefined);
    assert.deepEqual(res.hits.map((h) => h.chunkId).sort(), ["c1", "c2", "c3"]);
  });

  it("(e) bob can never see alice's or the operator's archive", () => {
    const { searchHost } = seeded();
    const res = conversationSearchFree(searchHost, query, "user-bob");
    assert.deepEqual(res.hits.map((h) => h.chunkId), ["c2"]);
  });
});

describe("conversation_search tool execute() — fail-closed (d)", () => {
  // The tool's `execute()` is: `const id = await resolveOwner(); if (id === null)
  // return emptyConversationSearchResult(input); ...`. That null→empty branch is
  // the fail-closed boundary. We test `emptyConversationSearchResult` directly
  // (pure) rather than `buildConversationTools`. Post-an earlier revision the tool reads the
  // agent's own DO via an injected `searchArchive` thunk (bound to the local
  // `conversationSearch` callable) — the DEMO_INSTANCE→admin special-case +
  // scoped/admin pass-through live in the injected `resolveOwner` thunk
  // (server.ts `_resolveOwnArchiveOwnerIdentity`) and are exercised by the
  // `conversationSearchFree` scope tests above. See the report's honesty note.
  it("(d) emptyConversationSearchResult → zero hits, ok:true (never all-tenants)", () => {
    const res = emptyConversationSearchResult({ query: "anything", topK: 7 } as ConversationSearchInput);
    assert.equal(res.resultCount, 0);
    assert.deepEqual(res.hits, []);
    assert.equal(res.ok, true);
    assert.equal(res.topK, 7);
  });
});

describe("long-query LIKE pattern safety (no SQLite 'pattern too complex')", () => {
  const MAX_BYTES = 40;
  const bytes = (x: string) => new TextEncoder().encode(x).length;

  it("every emitted LIKE term stays within the byte cap (incl. % wrappers)", () => {
    const longCjk = "我想找一下之前我们讨论过的关于双路记忆本地和外部互相印证的那次对话里最后是怎么决定的来着还有检索质量";
    const longEng = "dual path memory verification decision from before what did we conclude about retrieval quality and the search bug";
    for (const q of [longCjk, longEng, "双路记忆", "a", "边".repeat(100)]) {
      const terms = buildSearchLikeTerms(q);
      assert.ok(terms.length >= 1, `at least one term for: ${q}`);
      assert.ok(terms.length <= 5, "term count capped at 5");
      for (const t of terms) {
        // content = pattern minus the two % wrappers; must fit the cap so the
        // final `%…%` pattern stays under SQLite's ~50-byte LIKE limit.
        assert.ok(bytes(t) <= MAX_BYTES + 2, `pattern within budget: ${bytes(t)}b`);
      }
    }
  });

  it("splits on whitespace into AND terms; a space-less run yields one capped term", () => {
    assert.deepEqual(buildSearchLikeTerms("alpha beta gamma").length, 3);
    assert.equal(buildSearchLikeTerms("双路记忆本地外部互相印证最后怎么决定的来着检索质量问题很长").length, 1);
  });

  it("LIKE specials in a term are escaped", () => {
    const [p] = buildSearchLikeTerms("100%_off");
    assert.ok(p.includes("\\%") && p.includes("\\_"), "% and _ escaped");
  });

  it("a long CJK NL query returns ok:true without throwing (the bug was a 500)", () => {
    const rows = [{
      chunk_id: "c1", context_id: "ctx-a", role: "assistant" as const,
      text: "我们讨论过双路记忆，本地与外部互相印证，最后决定先上伪流。",
      index_text: null, archived_at: 1000, trigger: "flush", is_synthetic_compaction: 0,
      owner_user_id: "user-alice",
    }];
    const { searchHost } = makeFakeArchive(rows);
    // Whole NL question — before an earlier revision this became one >50-byte LIKE pattern
    // and SQLite threw "pattern too complex". Now it returns cleanly (whether
    // it HITS depends on content overlap — NL recall is FTS5's job, documented).
    const q = { query: "我想找一下之前我们讨论过的关于双路记忆本地和外部互相印证的那次对话最后是怎么决定的" } as ConversationSearchInput;
    const res = conversationSearchFree(searchHost, q, "user-alice");
    assert.equal(res.ok, true);
  });

  it("multi-keyword query matches rows containing ALL terms (AND), improving recall", () => {
    const rows = [
      {
        chunk_id: "c1", context_id: "ctx-a", role: "assistant" as const,
        text: "我们讨论过双路记忆，本地与外部互相印证，最后决定先上伪流。",
        index_text: null, archived_at: 1000, trigger: "flush", is_synthetic_compaction: 0,
        owner_user_id: "user-alice",
      },
      {
        chunk_id: "c2", context_id: "ctx-a", role: "assistant" as const,
        text: "双路记忆的部署方案还没定。",
        index_text: null, archived_at: 900, trigger: "flush", is_synthetic_compaction: 0,
        owner_user_id: "user-alice",
      },
    ];
    const { searchHost } = makeFakeArchive(rows);
    // Both terms present only in c1 → AND selects c1, drops c2.
    const q = { query: "双路记忆 互相印证" } as ConversationSearchInput;
    const res = conversationSearchFree(searchHost, q, "user-alice");
    assert.equal(res.resultCount, 1);
    assert.equal(res.hits[0].chunkId, "c1");
  });
});
