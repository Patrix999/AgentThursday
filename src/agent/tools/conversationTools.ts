/**
 *  —  `getTools()` family extraction step 2: conversation
 * family H (`conversation_search`).
 *
 * Per  preflight §4 split order this is the second-lowest-risk
 * family — single tool, but with one delicate semantic: the self-DO
 * call routes through `getAgentByName(env.AgentThursdayAgent, DEMO_INSTANCE)`
 * to the *registry* agent (where the `conversation_archive` table
 * lives,  Cards 151/152), and the *caller* agent's `name` must be
 * passed through as `callerContextId` for audit attribution.
 *
 * Two safety patterns inherited from existing code:
 *
 *   1. `callerContextId` is captured at Host construction time (i.e.
 *      when `AgentThursdayAgent.getTools()` builds this Host) so that
 *      audit-side attribution can NEVER end up pointing at the
 *      callee DO.  §6 risk 4.
 *
 *   2. The cross-DO type boundary is crossed via a local *structural*
 *      `ConversationSearchAgentStub` rather than importing `AgentThursdayAgent`
 *      from `server.ts`. This mirrors the  precedent
 *      (`DemoAgentStub`) and keeps the tool module out of the
 *      composition-root type graph.
 *
 * Tool name, description, Zod input schema, the single dispatch event
 * (`tool.conversation_search`), and the cross-DO call payload shape
 * are preserved verbatim from `src/server.ts:1324-1361` (pre-).
 */

import { tool } from "ai";
import { z } from "zod";
import { getAgentByName } from "agents";
import { DEMO_INSTANCE } from "../../demoConstants";
import type { ConversationSearchInput, ConversationSearchResult } from "../../schema/archive";

type ConversationSearchAgentStub = {
  conversationSearch(input: ConversationSearchInput): Promise<ConversationSearchResult>;
};

export interface ConversationToolHost {
  env: Env;
  /**
   * Value of `AgentThursdayAgent.name` captured at the time `getTools()` ran.
   * Forwarded into the registry-side audit row so a search invoked
   * from agent X is attributed to X, not to the registry DO that
   * actually executes the query.
   */
  callerContextId: string;
  /**
   * Current task id (if any) at execute-time. Lifted to a getter
   * because `currentTaskObject` changes over the agent's lifetime;
   * capturing once at Host construction would freeze a stale id.
   */
  getTraceId: () => string | undefined;
  logEvent: (type: string, payload: unknown) => void;
}

async function resolveRegistryStub(env: Env): Promise<ConversationSearchAgentStub> {
  // Same `as unknown as` cast pattern as  `demoRoutes.ts`:
  // we don't want to pull `AgentNamespace<AgentThursdayAgent>` into the tool
  // module's type graph, but `getAgentByName`'s generic still needs to
  // resolve. Routing through a `unknown`-typed resolver fence keeps
  // both sides honest at the boundary.
  const resolveByName = getAgentByName as unknown as (
    namespace: unknown,
    name: string,
  ) => Promise<ConversationSearchAgentStub>;
  return resolveByName(env.AgentThursdayAgent, DEMO_INSTANCE);
}

export function buildConversationTools(host: ConversationToolHost) {
  const { env, callerContextId, getTraceId, logEvent } = host;
  return {
    // ── agent-facing conversation archive search ────
    // The `conversationSearch()` callable + `/cli/context/conversation/search`
    // route already exist (Cards 151/152) and live on the registry DO
    // (DEMO_INSTANCE) where the `conversation_archive` table lives. This
    // wrapper exposes the same retrieval to the model so user questions
    // like "4 月 28 那天我们聊了什么" or "之前 Kimi 模型那段最后怎么定的"
    // can be answered against archive instead of bouncing off `recall`
    // (which only sees `agent_memories`).
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
        const stub = await resolveRegistryStub(env);
        return await stub.conversationSearch({
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
        });
      },
    }),
  };
}
