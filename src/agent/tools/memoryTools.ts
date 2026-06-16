/**
 *  —  `getTools()` family extraction step 5: memory
 * family E (`remember`, `recall`).
 *
 * Per  preflight §4 split order this is the fifth step — two
 * tools wrapping the `rememberMemory` / `recallMemory` @callable
 * methods on `AgentThursdayAgent`. The wrappers do **not** emit any events of
 * their own — `rememberMemory()` internally emits `tool.memory.remember`
 * and `recall` is a pure passthrough. Behavior must stay byte-equal.
 *
 *  ack identity stays on `AgentThursdayAgent` as
 * `_currentTaskRememberAck`.  §3 risk 2 left two options for
 * how the inline `this._currentTaskRememberAck = ackText` assignment
 * survives the extraction; this card picks **option (b)** — the Host
 * exposes `setRememberAck(ack)` and the agent owns the field. Keeps the
 * model-facing return type unchanged and avoids leaking the field name
 * into the Host surface.
 *
 * Tool names, descriptions, Zod input schemas, `rememberMemory` /
 * `recallMemory` invocation shape, the  ack format (`已记
 * 下：…` + whitespace collapse + 200-char slice), and the
 * `lastActionResult` mutation shape are preserved verbatim from
 * `src/server.ts:1058-1106` (pre-).
 */

import { tool } from "ai";
import { z } from "zod";
import type { AgentThursdayState } from "../../types";
import type { MemoryRecallMatch, MemoryType } from "../../schema";

export interface MemoryToolHost {
  /**
   * Forwards to `AgentThursdayAgent.rememberMemory()` @callable. The callable
   * owns the SQL INSERT into `agent_memories` and emits the
   * `tool.memory.remember` event — the tool wrapper itself does not.
   */
  rememberMemory: (input: {
    type: MemoryType;
    content: string;
    key?: string | null;
    confidence?: number | null;
    supersedesId?: number | null;
    source?: string;
  }) => { id: number; type: MemoryType; supersededId: number | null };
  /**
   * Forwards to `AgentThursdayAgent.recallMemory()` @callable. Pure passthrough
   * — recall is a read-only ranking query.
   */
  recallMemory: (input: {
    query: string;
    types?: MemoryType[];
    limit?: number;
  }) => { matches: MemoryRecallMatch[] };
  /**
   *  ack write-back. The `_currentTaskRememberAck` field
   * lives on `AgentThursdayAgent` and is read by `submitTask`'s reply fallback
   * when the model produced no assistant text. The Host injects a
   * setter so the field stays owned by the agent.
   */
  setRememberAck: (ack: string) => void;
  /**
   * Raw, live `agentthursdayState` reference. Used as the spread base in
   * `setAgentThursdayState({ ...getAgentThursdayState(), <delta> })`. Matches the
   * inline `{ ...stateNow, ... }` pattern verbatim, where
   * `stateNow = this.agentthursdayState`.
   */
  getAgentThursdayState: () => AgentThursdayState;
  setAgentThursdayState: (next: AgentThursdayState) => void;
}

export function buildMemoryTools(host: MemoryToolHost) {
  const { rememberMemory, recallMemory, setRememberAck, getAgentThursdayState, setAgentThursdayState } = host;
  return {
    remember: tool({
      description: "Store a durable memory (fact / instruction / event / task). Use for stable knowledge worth recalling later (e.g. 'project uses GraphQL', 'when X, do Y'). Provide `key` for facts/instructions to enable supersession on update. DO NOT store secrets or transient noise. See ",
      inputSchema: z.object({
        type: z.enum(["fact", "instruction", "event", "task"]),
        content: z.string().min(1).max(4000),
        key: z.string().min(1).max(200).optional(),
        confidence: z.number().min(0).max(1).optional(),
        supersedesId: z.number().int().optional(),
      }),
      execute: async (input) => {
        const result = await rememberMemory(input);
        //  — deterministic ack for tool-only memory round.
        // SOUL prompt () asks the model to follow up with a
        // confirmation, but production showed it's not always reliable.
        // Capture an ack here so submitTask can fall back when the
        // model produced no assistant text, and write the same string
        // to `lastActionResult.summary` so `buildWorkspaceSnapshot`'s
        // 2b fallback surfaces an AGT row in the dialog as well.
        // Single-line trim of the agent's stored content keeps the
        // ack short and prevents tool-payload leakage (the content
        // is the user-visible text the agent chose to remember; the
        // 200-char slice + whitespace collapse caps blast radius).
        const ackText = `已记下：${input.content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
        setRememberAck(ackText);
        const stateNow = getAgentThursdayState();
        setAgentThursdayState({
          ...stateNow,
          lastActionResult: {
            actionType: "memory.remember",
            outcome: "success",
            summary: ackText,
            recordedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
        return result;
      },
    }),
    recall: tool({
      description: "Retrieve durable memories matching a query. Call BEFORE answering questions that depend on prior project context. Returns ranked matches by exact-key > keyword > recency.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        types: z.array(z.enum(["fact", "instruction", "event", "task"])).max(4).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async (input) => {
        return recallMemory(input);
      },
    }),
  };
}
