/**
 * conversation_search trigger reliability classifier.
 *
 * Pure heuristic module that flags whether a user query is "history-
 * shaped" — i.e. asks about something the agent or user said earlier
 * (Chinese "之前 / 历史 / 记得 / 会议 / 说过" + English equivalents).
 * 178 §7 commits  to either deterministic firing **or** a clear
 * reason; this module owns the "clear reason" half: callers (inspect
 * surface, QA harness) compare the classifier's verdict against the
 * task's actual tool events and surface a `conversation_search.missed`
 * warning when a history-shaped query did not trigger the tool.
 *
 * 实际的 dispatch 修复（让模型必触发 search）属  truthfulness
 * scope refinement / SOUL hardening 范畴，不在本卡。
 */

export const HISTORY_KEYWORDS_ZH = [
  "之前",
  "上次",
  "上回",
  "刚才",
  "刚刚",
  "曾经",
  "历史",
  "记得",
  "记录",
  "会议",
  "说过",
  "提过",
  "聊过",
  "讨论过",
  "谈过",
  "前面",
  "以前",
  "原来",
] as const;

export const HISTORY_KEYWORDS_EN = [
  "earlier",
  "before",
  "previously",
  "remember",
  "i remember",
  "you mentioned",
  "you said",
  "we discussed",
  "we talked",
  "we said",
  "history",
  "meeting",
  "last time",
  "in the past",
] as const;

export interface QueryShapeReport {
  shouldUseConversationSearch: boolean;
  matchedKeywords: string[];
  language: "zh" | "en" | "mixed" | "neither";
  reason: string;
}

export function classifyQueryShape(rawText: string): QueryShapeReport {
  const text = (rawText ?? "").toString();
  const lower = text.toLowerCase();
  const matched: string[] = [];
  let zhHit = false;
  let enHit = false;

  for (const kw of HISTORY_KEYWORDS_ZH) {
    if (text.includes(kw)) {
      matched.push(kw);
      zhHit = true;
    }
  }
  for (const kw of HISTORY_KEYWORDS_EN) {
    // word-boundary match for English to avoid e.g. "remember" inside "remembering"
    const pattern = new RegExp(`(^|[^a-zA-Z])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z]|$)`, "i");
    if (pattern.test(lower)) {
      matched.push(kw);
      enHit = true;
    }
  }

  const language: QueryShapeReport["language"] =
    zhHit && enHit ? "mixed" : zhHit ? "zh" : enHit ? "en" : "neither";
  const should = matched.length > 0;
  const reason = should
    ? `query is history-shaped; matched keywords [${matched.join(", ")}] suggest the agent should consult conversation history (conversation_search) before answering`
    : "query has no history-shape signal; conversation_search not required";

  return {
    shouldUseConversationSearch: should,
    matchedKeywords: matched,
    language,
    reason,
  };
}

export interface ConversationSearchAuditInput {
  query: string;
  toolEventsToolNames: ReadonlyArray<string>;
}

export interface ConversationSearchAuditReport {
  shape: QueryShapeReport;
  conversationSearchFired: boolean;
  archiveSearchFired: boolean;
  missed: boolean;
  reason: string;
}

const CONVERSATION_SEARCH_NAMES = new Set([
  "conversation_search",
  "tool.conversation_search",
  "tool.conversation_search.dispatch",
  "tool.conversation_search.result",
]);

const ARCHIVE_SEARCH_NAMES = new Set([
  "archive.search",
  "tool.archive.search",
  "tool.archive.search.dispatch",
  "tool.archive.search.result",
]);

export function auditConversationSearchUsage(
  input: ConversationSearchAuditInput,
): ConversationSearchAuditReport {
  const shape = classifyQueryShape(input.query);
  const fired = (set: Set<string>) =>
    input.toolEventsToolNames.some(n => {
      if (typeof n !== "string") return false;
      const trimmed = n.trim();
      if (set.has(trimmed)) return true;
      // tolerate normalized form (without 'tool.' prefix)
      return set.has(`tool.${trimmed}`);
    });
  const conversationSearchFired = fired(CONVERSATION_SEARCH_NAMES);
  const archiveSearchFired = fired(ARCHIVE_SEARCH_NAMES);
  const missed =
    shape.shouldUseConversationSearch && !conversationSearchFired && !archiveSearchFired;
  let reason: string;
  if (!shape.shouldUseConversationSearch) {
    reason = "no history-shape signal in query; tool not expected";
  } else if (conversationSearchFired || archiveSearchFired) {
    reason = `history-shape query and ${conversationSearchFired ? "conversation_search" : "archive.search"} fired — observability consistent`;
  } else {
    reason = `history-shape query (matched: ${shape.matchedKeywords.join(", ")}) but neither conversation_search nor archive.search fired — flag conversation_search.missed`;
  }
  return {
    shape,
    conversationSearchFired,
    archiveSearchFired,
    missed,
    reason,
  };
}
