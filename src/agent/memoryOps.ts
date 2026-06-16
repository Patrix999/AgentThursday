/**
 *  —  Step 9 memory read-path extraction.
 *
 * Six memory read-side helpers pulled verbatim from `AgentThursdayAgent`
 * (`src/server.ts` lines ~1492–1529, 2904–2919, 5231–5260, 5287–5310,
 * 5312–5544, 5568–5595). No SQL strings, table names, column names,
 * truncation marker bytes, event names, or callable payloads changed
 * — only the location of the calls moved.
 *
 * See:
 *   - ``
 *   - ``
 *
 * Host shape is intentionally narrow — four capabilities only:
 *   - `sql`             — typed template-tag access for the three
 *                          tables touched by this scope:
 *                          `memory_knowledge` (R-only, soul-prompt
 *                          injection), `agent_memories` (R-only here;
 *                          write path stays at composition root and
 *                          moves in ), and
 *                          `conversation_archive` (R-only).
 *   - `logEvent`        — only `tool.memory.list` is emitted from
 *                          this read scope. Remember/recall/forget
 *                          continue to fire from their own
 *                          @callable's at the composition root.
 *   - `getLastAssistantText` — host capability since this is a
 *                              `private` accessor on `AgentThursdayAgent`
 *                              that reads the SDK message store
 *                              with sanitization rules out of
 *                              memoryOps' scope.
 *   - `getMessages`     — SDK-base accessor used by the v1 candidate
 *                          heuristic to fold recent dialog turns
 *                          into the archive walk.
 *
 * Wrapper retention: every helper retains its `AgentThursdayAgent` delegate
 * in `src/server.ts`. Two closures are load-bearing and stay
 * byte-identical by construction:
 *   - `withContext("soul")` provider at `server.ts:692` — closes
 *     over `this.readKnowledge()`.
 *   - `getTools()` `readKnowledge` closure at `server.ts:1031` —
 *     same shape.
 * Only the `readKnowledge` method body becomes a delegate;
 * `this.readKnowledge()` keeps its identity.
 *
 * Failure-safe contract on `listMemoryCandidatesFree`: any internal
 * throw collapses to `{ ok:true, blockedReason:"internal: ...",
 * items:[], generatedAt }` so an inspect surface never 500s. The
 * outer `generatedAt` on the result shell is captured at entry;
 * `buildMemoryCandidatesV1Free` independently captures its own
 * `Date.now()` for candidateId derivation. This mirrors the pre-
 * extraction server.ts behavior — the two timestamps are not joined
 * across the boundary.
 *
 *  extends this module with the **write side**
 * (`rememberMemoryFree` / `recallMemoryFree` / `forgetMemoryFree`).
 * Those helpers take a narrower `MemoryWriteHost` ({ sql, logEvent })
 * since they don't need message/conversation accessors. The
 * `@callable()` decorators stay on the `AgentThursdayAgent` methods so the
 * RPC surface is unchanged.
 */

import type { UIMessage } from "ai";

import { SOUL } from "./soulPrompt";
import type {
  MemoryCandidateInspectItem,
  MemoryCandidateSourceRef,
  MemoryCandidateType,
  MemoryCandidatesResult,
  MemoryEntry,
  MemoryRecallMatch,
  MemorySnapshot,
  MemoryType,
} from "../schema";

export type MemoryOpsSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface MemoryReadHost {
  sql: MemoryOpsSqlTag;
  logEvent: (type: string, payload: unknown) => void;
  getLastAssistantText: (maxLen?: number) => string;
  getMessages: () => UIMessage[];
}

/**
 *  — narrow write host. The three write callables
 * (`rememberMemory` / `recallMemory` / `forgetMemory`) only ever touch
 * `agent_memories` via `sql` and emit `tool.memory.{remember,recall,forget}`
 * via `logEvent`. Kept deliberately separate from `MemoryReadHost` so
 * the write boundary stays at the minimum capability — the read
 * accessors (`getLastAssistantText`, `getMessages`) are not in scope
 * here and must not become a back door.
 */
export interface MemoryWriteHost {
  sql: MemoryOpsSqlTag;
  logEvent: (type: string, payload: unknown) => void;
}

// ──  — readKnowledge ─────────────────────────────────────────
//  — bounded read. SOUL+knowledge is injected via
// `withContext("soul")` on every model invocation, so an unbounded
// memory_knowledge table grows linearly into every prompt + into
// the DO isolate's working set. Hard cap rows + total characters
// so a hot ChannelHub submit path can't OOM the isolate just by
// accumulating knowledge entries over months of dogfood.
export function readKnowledgeFree(host: MemoryReadHost): string {
  const KNOWLEDGE_ROW_CAP = 50;
  const KNOWLEDGE_CHAR_BUDGET = 16_000;
  const rows = host.sql<{ key: string; content: string }>`
      SELECT key, content FROM memory_knowledge
      ORDER BY key
      LIMIT ${KNOWLEDGE_ROW_CAP}
    `;
  const parts: string[] = [];
  let totalChars = 0;
  let truncatedRows = 0;
  for (const r of rows) {
    const segment = `[${r.key}] ${r.content}`;
    if (totalChars + segment.length > KNOWLEDGE_CHAR_BUDGET) {
      truncatedRows = rows.length - parts.length;
      break;
    }
    parts.push(segment);
    totalChars += segment.length + 3; // separator
  }
  let out = parts.join(" | ");
  // Total row count from a separate cheap COUNT, so the marker can
  // tell the model how much was hidden whether truncation hit the
  // row cap or the char budget.
  const totalRows = Number((host.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM memory_knowledge`)[0]?.n ?? 0);
  const hiddenByRowCap = Math.max(0, totalRows - rows.length);
  const totalHidden = hiddenByRowCap + truncatedRows;
  if (totalHidden > 0) {
    out += ` | [knowledge truncated: ${totalHidden} entr${totalHidden === 1 ? "y" : "ies"} hidden — ${rows.length - truncatedRows}/${totalRows} shown, ${totalChars}/${KNOWLEDGE_CHAR_BUDGET} chars]`;
  }
  return out;
}

// ──  — getMemoryLayers ───────────────────────────────────────
//  — bounded read.
// /api/memory pulls this on every refresh; an unbounded scan over a
// long-lived knowledge table is one of the queries the DO isolate
// memory limit can trip. Cap rows + content preview keep the surface
// bounded; the inspector only needs an overview, not the full
// verbatim corpus.
export function getMemoryLayersFree(host: MemoryReadHost): { soul: string; knowledge: { key: string; content: string }[]; lastMessage: string } {
  const KNOWLEDGE_INSPECT_ROW_CAP = 100;
  const knowledge = host.sql<{ key: string; content: string }>`
      SELECT key, substr(content, 1, 4000) AS content FROM memory_knowledge
      ORDER BY key
      LIMIT ${KNOWLEDGE_INSPECT_ROW_CAP}
    `;
  return { soul: SOUL, knowledge, lastMessage: host.getLastAssistantText() };
}

// ──  — listMemoriesEntries ───────────────────────────────────
export function listMemoriesEntriesFree(host: MemoryReadHost, input: { type?: MemoryType; activeOnly?: boolean; limit?: number }): { items: MemoryEntry[] } {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 100);
  const activeOnly = input.activeOnly !== false; // default true
  type Row = { id: number; type: string; key: string | null; content: string; source: string; confidence: number | null; active: number; supersedes_id: number | null; created_at: number; updated_at: number };
  let rows: Row[];
  if (input.type && activeOnly) {
    rows = host.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE type = ${input.type} AND active = 1 ORDER BY created_at DESC LIMIT ${limit}`;
  } else if (input.type && !activeOnly) {
    rows = host.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE type = ${input.type} ORDER BY created_at DESC LIMIT ${limit}`;
  } else if (!input.type && activeOnly) {
    rows = host.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE active = 1 ORDER BY created_at DESC LIMIT ${limit}`;
  } else {
    rows = host.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories ORDER BY created_at DESC LIMIT ${limit}`;
  }
  const items: MemoryEntry[] = rows.map(r => ({
    id: r.id,
    type: r.type as MemoryType,
    key: r.key,
    content: r.content,
    source: r.source,
    confidence: r.confidence,
    active: r.active === 1,
    supersedesId: r.supersedes_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  host.logEvent("tool.memory.list", { type: input.type ?? "all", activeOnly, returned: items.length });
  return { items };
}

// ──  — listMemoryCandidates ──────────────────────────────────
/**
 * read-only memory candidate inspect.
 *
 * Walks `conversation_archive` (SELECT only) + recent message log
 * + active `agent_memories` (read-only for dedupe hints) and surfaces
 * heuristic candidates that *might* be worth promoting to long-term
 * memory. **Never writes** to `agent_memories`; never invokes
 * `tool.memory.remember`. Failure-safe: any internal throw collapses
 * to `{ ok:true, blockedReason:"...", items:[] }` so it can never
 * break `/api/workspace` or other inspect surfaces.
 */
export function listMemoryCandidatesFree(host: MemoryReadHost, input?: { limit?: number }): MemoryCandidatesResult {
  const generatedAt = Date.now();
  try {
    const cap = Math.max(1, Math.min(50, Math.floor(input?.limit ?? 20)));
    const candidates = buildMemoryCandidatesV1Free(host, cap);
    return {
      ok: true,
      blockedReason: candidates.length === 0 ? "no candidates above threshold" : null,
      items: candidates,
      generatedAt,
    };
  } catch (e) {
    // Failure-safe: never break the inspect surface. Log so we can
    // diagnose; return empty list with reason.
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    return {
      ok: true,
      blockedReason: `internal: ${msg}`,
      items: [],
      generatedAt,
    };
  }
}

// ──  — _buildMemoryCandidatesV1 ──────────────────────────────
export function buildMemoryCandidatesV1Free(host: MemoryReadHost, cap: number): MemoryCandidateInspectItem[] {
  const generatedAt = Date.now();
  // Pull a bounded window of archive chunks. Most-recent first so
  // the list reflects what's been talked about lately. We don't
  // cross 50 rows because heuristics scale O(rows × patterns).
  type ArchiveRow = {
    chunk_id: string;
    context_id: string;
    role: string | null;
    text: string;
    archived_at: number | bigint;
  };
  const archiveRows = host.sql<ArchiveRow>`
      SELECT chunk_id, context_id, role, text, archived_at
      FROM conversation_archive
      ORDER BY archived_at DESC
      LIMIT 50
    `;

  // Active memories — read-only, for dedupe hints. Bounded to avoid
  // O(N×M) blowup; recent first.
  type MemRow = { id: number; type: string; key: string | null; content: string };
  const memoryRows = host.sql<MemRow>`
      SELECT id, type, key, content FROM agent_memories
      WHERE active = 1 ORDER BY updated_at DESC LIMIT 200
    `;

  // Recent dialog turns from this DO's message log. Cap at 30 user
  // turns to keep the heuristic loop bounded.
  const recentDialog: Array<{ role: "user" | "assistant"; text: string; index: number }> = [];
  const messages = host.getMessages();
  let idx = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") { idx++; continue; }
    const text = (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    if (text.length > 0) recentDialog.push({ role: m.role, text, index: idx });
    idx++;
  }
  const dialogTail = recentDialog.slice(-60);

  // Build candidates from BOTH archive + recent dialog. We compute
  // a key (lowercased trimmed slice) to dedupe near-identical
  // candidates from the two sources before scoring.
  type Acc = {
    key: string;
    type: MemoryCandidateType;
    text: string;
    reason: string;
    baseConfidence: number;
    sourceRefs: MemoryCandidateSourceRef[];
    occurrences: number;
  };
  const acc = new Map<string, Acc>();

  function pushSignal(
    origin: { kind: "archive" | "dialog"; ref: string; preview: string },
    signal: { type: MemoryCandidateType; text: string; reason: string; baseConfidence: number },
  ) {
    const trimmed = signal.text.trim();
    if (trimmed.length === 0) return;
    const key = trimmed.slice(0, 200).toLowerCase();
    const existing = acc.get(key);
    if (existing) {
      existing.occurrences++;
      existing.sourceRefs.push({ kind: origin.kind, ref: origin.ref, preview: origin.preview.slice(0, 200) });
      // Keep the strongest base; reasons accumulate compactly.
      if (signal.baseConfidence > existing.baseConfidence) {
        existing.baseConfidence = signal.baseConfidence;
        existing.reason = signal.reason;
      }
    } else {
      acc.set(key, {
        key,
        type: signal.type,
        text: trimmed.slice(0, 400),
        reason: signal.reason,
        baseConfidence: signal.baseConfidence,
        sourceRefs: [{ kind: origin.kind, ref: origin.ref, preview: origin.preview.slice(0, 200) }],
        occurrences: 1,
      });
    }
  }

  //  — broader test-harness / verifier noise filter.
  // The first 154a build let `task` candidates surface from
  // verifier-rerun questions ("...那一步是不是有立即 ack（156g1
  // 的关键判据）...") because the explicit-remember regex was too
  // permissive and the noise guard only matched a tiny vocab.
  // This filter rejects any text that smells like test/test-harness
  // / debug-protocol prose.
  const isCandidateNoise = (t: string): boolean => {
    // Test-harness / verifier vocabulary (ASCII + 中文)
    if (/\bverif(?:y|ier|ication)\b/i.test(t)) return true;
    if (/\b(?:runtime\s+smoke|test\s+harness|case[- ]driven)\b/i.test(t)) return true;
    if (/\bStory\s+[A-Z]\b/.test(t)) return true;
    if (/\bCard\s+\d/.test(t)) return true;
    // operator /  /  /  测试侧的判定词
    if (/(?:验收|关键判据|后端证据|用例|跑测|测试用例|测试套件)/.test(t)) return true;
    if (/\b(?:PASS|FAIL|N-A|N\/A)\b/.test(t)) return true;
    // 系统/路由/调度专用词典（dialog-noise typical of small-c orchestration）
    if (/(?:summaryStream|recentOutbox|routeSummary|debugTrace|recentToolEvents|lastAssistantSummary|conversation_archive|context_active|Story\s)/i.test(t)) return true;
    // mention to operators ( / operator / channel admins) — mass-distributed ops messages, not user memory intent
    if (/<@!?(?:100000000000000001|100000000000000002|100000000000000003)>/.test(t)) return true;
    // Code fences / jq / curl / shell heredoc — debug protocol, not memory
    if (/```[\s\S]{4,}```|`(?:curl|jq|grep|wrangler|npm)\b/i.test(t)) return true;
    if (/\bcurl\s+-[sS]?\b|\bjq\s+['"]/.test(t)) return true;
    // Channel ingest metadata header (defense-in-depth — should be
    // stripped pre-archive but we guard regardless)
    if (/\[discord channel message|provider_message_id:/i.test(t)) return true;
    // Tool payload field names — never expected in user dialog
    if (/\binputPreview\b|\boutputPreview\b/.test(t)) return true;
    // Existing minimal vocab (kept for backward compat)
    if (/validation-marker|playwright|verifier rerun/i.test(t)) return true;
    return false;
  };

  const detect = (text: string): { type: MemoryCandidateType; text: string; reason: string; baseConfidence: number } | null => {
    const t = text.trim();
    if (t.length < 6 || t.length > 800) return null;

    //  — try explicit-remember extraction FIRST. The
    // archived `text` for a real Discord user prompt usually starts
    // with `<@_id>` (the bot mention). 154a1 demanded `[\n.!?]`
    // immediately before `帮我记` AND ran `isCandidateNoise(t)` over
    // the whole row first, so any verifier-flavored neighbor token
    // in the same archived chunk killed the legit slot. Now: allow
    // an optional small d mention prefix (`<@100000000000000004>`
    // or its `<@!…>` form) before the imperative, extract the slot,
    // and only filter the slot itself.
    const explicit = /(?:^|[\n。！？\.!\?]\s*)(?:<@!?100000000000000004>\s*)?(?:帮我记一?下|请记一?下|麻烦记一?下|remember\s+(?:that|this|the\s+following)|please\s+remember)\s*[:：]\s*(.{6,400})/iu.exec(t);
    if (explicit) {
      const slot = explicit[1].trim();
      if (isCandidateNoise(slot)) return null;
      const isMeeting = /\d{1,2}[:：]\d{2}|周[一二三四五六日天]|下周|今晚|明早/.test(slot)
        && /(跟|与|和|with)\s*[\p{L}\w]+/u.test(slot);
      return {
        type: isMeeting ? "task" : "fact",
        text: slot,
        reason: "explicit `请记/帮我记/remember` request",
        baseConfidence: 0.85,
      };
    }

    // For non-explicit signals (preference / decision) the whole
    // utterance IS the candidate text, so the outer noise filter
    // still applies — a verifier discussion that happens to begin
    // with `决定` shouldn't surface as a decision candidate.
    if (isCandidateNoise(t)) return null;

    if (/^(?:以后|之后|默认|从现在起|from now on|always)\b/.test(t)) {
      return {
        type: "instruction",
        text: t,
        reason: "preference / standing-instruction phrase",
        baseConfidence: 0.6,
      };
    }
    if (/(?:我倾向|我建议|决定|拍板|let's go with|going with)/i.test(t)) {
      return {
        type: "decision",
        text: t,
        reason: "decision-shaped phrasing",
        baseConfidence: 0.55,
      };
    }
    return null;
  };

  for (const r of archiveRows) {
    const sig = detect(r.text);
    if (!sig) continue;
    pushSignal(
      { kind: "archive", ref: r.chunk_id, preview: r.text },
      sig,
    );
  }
  for (const d of dialogTail) {
    const sig = detect(d.text);
    if (!sig) continue;
    pushSignal(
      { kind: "dialog", ref: String(d.index), preview: d.text },
      sig,
    );
  }

  // Score = base + repetition bonus, capped at 1.0.
  // Build dedupe hints from existing memories by substring overlap.
  const items: MemoryCandidateInspectItem[] = [];
  let cidSeq = 0;
  for (const c of acc.values()) {
    // Repetition bonus: each extra occurrence adds 0.05 up to +0.20.
    const repetitionBonus = Math.min(0.20, Math.max(0, c.occurrences - 1) * 0.05);
    const confidence = Math.min(1, c.baseConfidence + repetitionBonus);
    let dedupeHint: { maybeExistingMemoryId?: string; similarityReason?: string } | null = null;
    const candLower = c.text.toLowerCase();
    const candKeyTokens = candLower.split(/\s+/).filter((w) => w.length >= 4).slice(0, 4);
    for (const m of memoryRows) {
      const ml = m.content.toLowerCase();
      // Substring or shared-token overlap
      if (ml.length > 0 && candLower.length >= 12 && (
        ml.includes(candLower.slice(0, 24)) ||
        candLower.includes(ml.slice(0, 24)) ||
        (candKeyTokens.length >= 2 && candKeyTokens.every((tok) => ml.includes(tok)))
      )) {
        dedupeHint = {
          maybeExistingMemoryId: String(m.id),
          similarityReason: m.key
            ? `key=${m.key} content overlap`
            : `content overlap (memory ${m.type})`,
        };
        break;
      }
    }
    cidSeq++;
    items.push({
      candidateId: `cand_${generatedAt.toString(36)}_${cidSeq.toString(36)}`,
      type: c.type,
      text: c.text,
      sourceRefs: c.sourceRefs.slice(0, 6),
      reason: c.occurrences > 1 ? `${c.reason} (×${c.occurrences})` : c.reason,
      confidence,
      dedupeHint,
    });
  }
  // Sort: highest confidence first, ties broken by source count
  // (more refs = stronger signal).
  items.sort((a, b) => (b.confidence - a.confidence) || (b.sourceRefs.length - a.sourceRefs.length));
  return items.slice(0, cap);
}

// ──  — getMemorySnapshot ─────────────────────────────────────
export function getMemorySnapshotFree(host: MemoryReadHost): MemorySnapshot {
  type CountRow = { type: string; n: number };
  const counts = host.sql<CountRow>`SELECT type, COUNT(*) as n FROM agent_memories WHERE active = 1 GROUP BY type`;
  const inactive = Number((host.sql<{ n: number }>`SELECT COUNT(*) as n FROM agent_memories WHERE active = 0`)[0]?.n ?? 0);
  const byType: Record<MemoryType, number> = { fact: 0, instruction: 0, event: 0, task: 0 };
  for (const c of counts) {
    if (c.type === "fact" || c.type === "instruction" || c.type === "event" || c.type === "task") {
      byType[c.type] = Number(c.n);
    }
  }
  const recent = (t: MemoryType, limit: number): MemoryEntry[] => {
    type Row = { id: number; type: string; key: string | null; content: string; source: string; confidence: number | null; active: number; supersedes_id: number | null; created_at: number; updated_at: number };
    const rows = host.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE active = 1 AND type = ${t} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(r => ({
      id: r.id, type: r.type as MemoryType, key: r.key, content: r.content,
      source: r.source, confidence: r.confidence, active: r.active === 1,
      supersedesId: r.supersedes_id, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  };
  return {
    counts: { ...byType, inactive },
    recentFacts: recent("fact", 3),
    recentInstructions: recent("instruction", 3),
    recentEvents: recent("event", 5),
    recentTasks: recent("task", 5),
  };
}

// ──  — rememberMemory ───────────────────────────────────────
// Agent Memory v1. See
// Profile boundary = the host DO. Body extracted verbatim from
// `AgentThursdayAgent.rememberMemory` (server.ts pre-). SQL strings,
// event name, payload keys, supersede semantics unchanged.
export function rememberMemoryFree(
  host: MemoryWriteHost,
  input: {
    type: MemoryType;
    content: string;
    key?: string | null;
    confidence?: number | null;
    supersedesId?: number | null;
    source?: string;
  },
): { id: number; type: MemoryType; supersededId: number | null } {
  const now = Date.now();
  const source = input.source ?? "agent";
  const key = input.key && input.key.length > 0 ? input.key : null;
  const confidence = typeof input.confidence === "number" ? input.confidence : null;

  let supersededId: number | null = null;
  if (typeof input.supersedesId === "number") {
    // Explicit supersede: deactivate the named row (if present + active).
    const target = host.sql<{ id: number }>`SELECT id FROM agent_memories WHERE id = ${input.supersedesId} AND active = 1`;
    if (target.length > 0) {
      host.sql`UPDATE agent_memories SET active = 0, updated_at = ${now} WHERE id = ${input.supersedesId}`;
      supersededId = input.supersedesId;
    }
  } else if (key !== null) {
    // Implicit auto-supersede on (type, key) collision among active rows.
    const prior = host.sql<{ id: number }>`
        SELECT id FROM agent_memories
        WHERE type = ${input.type} AND active = 1 AND key IS NOT NULL AND lower(key) = lower(${key})
        ORDER BY created_at DESC LIMIT 1
      `;
    if (prior.length > 0) {
      supersededId = prior[0].id;
      host.sql`UPDATE agent_memories SET active = 0, updated_at = ${now} WHERE id = ${supersededId}`;
    }
  }

  const inserted = host.sql<{ id: number }>`
      INSERT INTO agent_memories (type, key, content, source, confidence, active, supersedes_id, created_at, updated_at)
      VALUES (${input.type}, ${key}, ${input.content}, ${source}, ${confidence}, 1, ${supersededId}, ${now}, ${now})
      RETURNING id
    `;
  const id = inserted[0]?.id ?? 0;
  host.logEvent("tool.memory.remember", { id, type: input.type, key, supersededId, source });
  return { id, type: input.type, supersededId };
}

// ──  — recallMemory ─────────────────────────────────────────
// Three-channel scoring: exact key match (1.0) / per-token LIKE on
// content (0.4 + recency boost) / recency-only fallback (0.2). Limit
// clamped to [1, 20]. Body extracted verbatim from server.ts.
export function recallMemoryFree(
  host: MemoryWriteHost,
  input: { query: string; types?: MemoryType[]; limit?: number },
): { matches: MemoryRecallMatch[] } {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 5)), 20);
  const types = input.types && input.types.length > 0 ? input.types : (["fact", "instruction", "event", "task"] as MemoryType[]);
  const queryRaw = (input.query ?? "").trim();

  type Row = { id: number; type: string; key: string | null; content: string; created_at: number };
  const seen = new Map<number, { row: Row; score: number }>();

  const accept = (row: Row, score: number) => {
    const prev = seen.get(row.id);
    if (!prev || prev.score < score) seen.set(row.id, { row, score });
  };

  // Channel 1: exact key match (highest weight)
  if (queryRaw.length > 0) {
    const placeholders = types.map((_t, i) => `?${i + 1}`).join(",");
    // SQLite tagged template doesn't take arrays; spell out type list as alternation.
    for (const t of types) {
      const rows = host.sql<Row>`
          SELECT id, type, key, content, created_at FROM agent_memories
          WHERE active = 1 AND type = ${t} AND key IS NOT NULL AND lower(key) = lower(${queryRaw})
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      for (const r of rows) accept(r, 1.0);
    }
    void placeholders; // silence unused
  }

  // Channel 2: keyword LIKE on content (per token, max 5 tokens)
  const tokens = queryRaw.split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
  if (tokens.length > 0) {
    for (const t of types) {
      for (const tok of tokens) {
        const pat = `%${tok.replace(/[%_\\]/g, m => `\\${m}`)}%`;
        const rows = host.sql<Row>`
            SELECT id, type, key, content, created_at FROM agent_memories
            WHERE active = 1 AND type = ${t} AND content LIKE ${pat} ESCAPE '\\'
            ORDER BY created_at DESC LIMIT ${limit}
          `;
        for (const r of rows) {
          const recencyBoost = Math.max(0, 0.1 - (Date.now() - r.created_at) / (1000 * 60 * 60 * 24 * 365)); // small
          accept(r, 0.4 + recencyBoost);
        }
      }
    }
  }

  // Channel 3: recency fallback if nothing matched
  if (seen.size === 0) {
    for (const t of types) {
      const rows = host.sql<Row>`
          SELECT id, type, key, content, created_at FROM agent_memories
          WHERE active = 1 AND type = ${t}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      for (const r of rows) accept(r, 0.2);
    }
  }

  const matches: MemoryRecallMatch[] = [...seen.values()]
    .sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at)
    .slice(0, limit)
    .map(({ row, score }) => ({
      id: row.id,
      type: row.type as MemoryType,
      key: row.key,
      content: row.content,
      score: Math.round(score * 1000) / 1000,
      createdAt: row.created_at,
    }));

  host.logEvent("tool.memory.recall", { query: queryRaw.slice(0, 200), matches: matches.length });
  return { matches };
}

// ──  — forgetMemory ─────────────────────────────────────────
// Soft-delete: sets `active = 0`, never physical delete. Three
// branches: not-found / already-inactive / active soft-delete. Body
// extracted verbatim from server.ts.
export function forgetMemoryFree(
  host: MemoryWriteHost,
  input: { id: number; reason?: string },
): { ok: boolean; id: number } {
  const target = host.sql<{ id: number; active: number }>`SELECT id, active FROM agent_memories WHERE id = ${input.id}`;
  if (target.length === 0) {
    host.logEvent("tool.memory.forget", { id: input.id, ok: false, reason: "not-found" });
    return { ok: false, id: input.id };
  }
  if (target[0].active === 0) {
    host.logEvent("tool.memory.forget", { id: input.id, ok: true, reason: "already-inactive" });
    return { ok: true, id: input.id };
  }
  host.sql`UPDATE agent_memories SET active = 0, updated_at = ${Date.now()} WHERE id = ${input.id}`;
  host.logEvent("tool.memory.forget", { id: input.id, ok: true, reason: (input.reason ?? "").slice(0, 200) });
  return { ok: true, id: input.id };
}
