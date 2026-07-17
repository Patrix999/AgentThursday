/**
 * 双路记忆 v1: the `memory_recall_dual` tool (operator dogfood).
 *
 * Queries BOTH memory paths in parallel and returns them side-by-side,
 * labeled by source, so the agent itself performs the corroboration
 * judgment (互相印证):
 *   · local  — this DO's conversation_archive (keyword search) +
 *     agent_memories (recall). Reliable provenance, narrow recall.
 *   · shadow — CF Agent Memory NL recall. Strong natural-language recall,
 *     but extraction can confabulate (an earlier revision pilot), so it is framed as
 *     the UNVERIFIED source and must never be written back into native
 *     memory by this tool.
 *
 * Fail-soft: a missing token / timeout / CF error degrades the payload to
 * local-only (cf_shadow.status = "unavailable"); the tool never throws.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ConversationSearchInput, ConversationSearchResult } from "../../schema/archive";
import {
  AGENT_MEMORY_OPERATOR_PROFILE,
  cfMemoryRecall,
  composeDualRecallPayload,
} from "../agentMemoryShadow";

export interface DualRecallToolHost {
  /** Worker secret at execute-time; undefined → shadow path disabled. */
  getCfToken: () => string | undefined;
  /** Local archive search on THIS DO (operator = unscoped/admin by gate). */
  searchArchive: (input: ConversationSearchInput) => Promise<ConversationSearchResult>;
  /** Local agent_memories recall. */
  recallMemories: (query: string) => { matches: Array<{ id: number; type: string; content: string }> };
  logEvent: (type: string, payload: unknown) => void;
}

export function buildDualRecallTools(host: DualRecallToolHost) {
  return {
    memory_recall_dual: tool({
      description:
        "双路记忆召回（互相印证）：并行查 ①本地归档+agent_memories（关键词检索，来源可靠）和 ②外部影子记忆（自然语言问句召回强，但抽取可能失真）。适合『像人一样问』的历史问题（\"X 是怎么修的\"、\"当时为什么这么定\"）。结果按来源标注：两路一致→可信；仅影子单源→当未证线索，采信前用 conversation_search 复核原文。",
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("自然语言问题或关键词均可；两路各自按所长处理。"),
      }),
      execute: async ({ query }) => {
        const token = host.getCfToken();
        const [cf, archive, memories] = await Promise.all([
          token && token.length > 0
            ? cfMemoryRecall(token, AGENT_MEMORY_OPERATOR_PROFILE, query)
            : Promise.resolve({ ok: false as const, error: "shadow_disabled_no_token" }),
          host.searchArchive({ query, topK: 8, snippetCap: 300 }).catch(() => null),
          Promise.resolve().then(() => host.recallMemories(query)).catch(() => ({ matches: [] })),
        ]);
        const localArchive = (archive?.hits ?? []).map(h => ({
          snippet: (h as { snippet?: string }).snippet ?? "",
          chunkId: (h as { chunkId?: string }).chunkId,
        }));
        const payload = composeDualRecallPayload({
          query,
          cf,
          localArchive,
          localMemories: memories.matches.map(m => ({ id: m.id, type: m.type, content: m.content })),
        });
        host.logEvent("tool.memory_recall_dual", {
          queryPreview: query.slice(0, 80),
          local_archive_hits: localArchive.length,
          local_memories: memories.matches.length,
          cf_status: payload.cf_shadow.status,
        });
        return payload;
      },
    }),
  };
}
