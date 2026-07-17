/**
 * M8.9 `getTools()` family extraction step 2: conversation
 * family H (`conversation_search`).
 *
 * M9.4 Track A (per-agent archive drain-to-self): the archive
 * search now reads the caller's OWN per-agent DO instead of RPC-ing the
 * registry (DEMO_INSTANCE). Each agent's `conversation_archive` lives on
 * its own DO (drain-to-self), so the DO injects `searchArchive` bound to its
 * local `conversationSearch` callable (which reads `this.sql`). For the
 * operator/registry DO, local == the registry table it always read, so its
 * behavior is unchanged. `callerContextId` is still forwarded for the audit
 * row (it now equals the executing DO, so attribution is trivially correct).
 *
 * Tool name, description, Zod input schema, the single dispatch event
 * (`tool.conversation_search`), and the call payload shape are preserved
 * verbatim from the pre-449 registry-RPC implementation — only the search
 * destination (registry stub → injected local `searchArchive`) changed.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ConversationSearchInput, ConversationSearchResult } from "../../schema/archive";
import { scopeOwnerIdFor, type RequestIdentity } from "../requestIdentity";
import { emptyConversationSearchResult } from "../archiveOps";

export interface ConversationToolHost {
  /**
   * LOCAL archive search on THIS agent's own DO. Track A moved
   * each agent's `conversation_archive` onto its own per-agent DO
   * (drain-to-self), so the tool reads local instead of RPC-ing the registry.
   * The DO injects its own `conversationSearch` callable (which reads
   * `this.sql`). For the operator/registry DO (DEMO_INSTANCE) local == the
   * registry table it always searched, so its behavior is unchanged.
   */
  searchArchive: (input: ConversationSearchInput, scopeOwnerId?: string) => Promise<ConversationSearchResult>;
  /**
   * Value of `AgentThursdayAgent.name` captured at the time `getTools()` ran.
   * Forwarded into the archive audit row so a search invoked from agent X is
   * attributed to X. Post-449 the search runs on X's own DO, so this equals
   * the executing DO.
   */
  callerContextId: string;
  /**
   * Current task id (if any) at execute-time. Lifted to a getter
   * because `currentTaskObject` changes over the agent's lifetime;
   * capturing once at Host construction would freeze a stale id.
   */
  getTraceId: () => string | undefined;
  logEvent: (type: string, payload: unknown) => void;
  /**
   * Multi-tenancy — resolve THIS caller's owner identity for owner-scoping the
   * local archive search. Returns `null` when the owner can't be resolved (the
   * tool then FAILS CLOSED to empty results). The DO injects an impl that
   * special-cases `this.name === DEMO_INSTANCE` (the registry / operator agent
   * has no profile of its own) to admin, so the operator's cross-context
   * search is never starved.
   */
  resolveOwner: () => Promise<RequestIdentity | null>;
}

export function buildConversationTools(host: ConversationToolHost) {
  const { searchArchive, callerContextId, getTraceId, logEvent, resolveOwner } = host;
  return {
    // ── agent-facing conversation archive search ────
    // The `conversationSearch()` callable + `/cli/context/conversation/search`
    // route already exist (an earlier revision). Post-449 they read the agent's own
    // per-agent DO (Track A). This wrapper exposes the same retrieval to the
    // model so user questions like "4 月 28 那天我们聊了什么" or "之前 Kimi 模型
    // 那段最后怎么定的" can be answered against archive instead of bouncing off
    // `recall` (which only sees `agent_memories`).
    conversation_search: tool({
      description: "Search this agent's conversation archive (prior sessions / cross-context dialog). Use when the user asks about historical conversation that isn't in the visible dialog or in agent_memories — e.g. \"what did we discuss on 4/28\", \"that Kimi debugging from before\", \"上次/之前/上周聊过 X 吗\". Returns up to `topK` snippets with provenance (chunkId, contextId, archivedAt, role). Distinct from `recall` (which searches `agent_memories`) and `content_search` (which searches external Content Sources). If no hits, say so honestly — do not equate `recall` empty with archive empty.",
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("Literal search keyword(s). Matches against archived user/assistant text."),
        topK: z.number().int().positive().max(10).optional().describe("Max hits to return (default 3, cap 10)."),
        contextId: z.string().optional().describe("Restrict to a single archived contextId. Default: search across all contexts."),
        role: z.enum(["user", "assistant", "system"]).optional().describe("Restrict to one role."),
        fromTimestamp: z.number().int().optional().describe("Unix epoch ms; only hits archived at or after."),
        toTimestamp: z.number().int().optional().describe("Unix epoch ms; only hits archived at or before."),
        snippetCap: z.number().int().positive().max(2000).optional().describe("Max snippet length per hit (default 300)."),
      }),
      execute: async (input) => {
        const traceId = getTraceId();
        logEvent("tool.conversation_search", {
          queryPreview: input.query.slice(0, 80),
          topK: input.topK ?? null,
          contextId: input.contextId ?? null,
          role: input.role ?? null,
        });
        // Multi-tenancy — resolve THIS caller's owner and owner-scope the
        // local archive search. Three states (the fail-open trap is
        // collapsing `null` → unscoped):
        //   · null (owner resolution failed) → return EMPTY directly. Do NOT
        //     pass through scopeOwnerIdFor (undefined = unfiltered = all
        //     tenants). This is the fail-closed point.
        //   · admin → scopeOwnerId undefined (unfiltered; operator unchanged).
        //   · user → scopeOwnerId = own userId (own archives only).
        //
        // The injected `resolveOwner` thunk special-cases the registry/operator
        // agent (DEMO_INSTANCE has no profile of its own) to admin, so the
        // operator's cross-context search is never starved (precedent:
        // `_resolveOwnerKind`'s `this.name === DEMO_INSTANCE → operator`).
        const ownerIdentity = await resolveOwner();
        if (ownerIdentity === null) {
          return emptyConversationSearchResult(input);
        }
        const scopeOwnerId = scopeOwnerIdFor(ownerIdentity);
        return await searchArchive({
          query: input.query,
          topK: input.topK,
          contextId: input.contextId,
          role: input.role,
          fromTimestamp: input.fromTimestamp,
          toTimestamp: input.toTimestamp,
          snippetCap: input.snippetCap,
          callerContextId,
          callerTaskId: traceId,
          traceId,
        }, scopeOwnerId);
      },
    }),
  };
}
