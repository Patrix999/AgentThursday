/**
 * `getTools()` family extraction step 4: core
 * lifecycle family C (`review_project_status`, `write_checkpoint`,
 * `review_note`, `advance_kanban_card`).
 *
 * Per an earlier revision preflight §4 split order this is the fourth step — the
 * first family that touches `sql` (3 INSERTs) + `setAgentThursdayState`
 * mutation (4×). `advance_kanban_card` also sets `needsApproval: true`,
 * which gates the tool behind a human-approval prompt — this flag must
 * survive the move unchanged.
 *
 * an earlier revision §3 sketched `CoreToolHost = { sql, logEvent, getSafeState,
 * setAgentThursdayState }`. Implementation adds two read-only callbacks that
 * the inline closures actually need:
 *
 *   - `getAgentThursdayState()` — the `{ ...this.agentthursdayState, ... }` spread
 *     pattern is used in all four tools to merge new fields onto the
 *     live state. `getSafeState()` is *not* a drop-in replacement —
 *     it returns a coerced shape with defaults filled in, and would
 *     change the persisted state if used in the spread.
 *   - `readKnowledge()` — `review_project_status` calls it to attach
 *     the current knowledge digest to the return value.
 *
 * Tool names, descriptions, Zod input schemas, event names + payload
 * shapes, SQL INSERT targets and column ordering, the
 * `needsApproval: true` flag on `advance_kanban_card`, and the
 * `ActionResult` outcomes are preserved verbatim from
 * `src/server.ts:932-983` (pre-an earlier revision).
 */

import { tool } from "ai";
import { z } from "zod";
import type { ActionResult, AgentThursdayState } from "../../types";
import type { AgentSqlTag } from "../migrations";

export interface CoreToolHost {
  sql: AgentSqlTag;
  logEvent: (type: string, payload: unknown) => void;
  /**
   * Coerced "safe" view of the state (defaults filled in). Used by
   * `review_project_status` for the event payload + return value.
   * NOT used for the `setAgentThursdayState` spread base — that path needs
   * the raw `agentthursdayState` so persisted fields don't shift.
   */
  getSafeState: () => AgentThursdayState;
  /**
   * Raw, live `agentthursdayState` reference. Used as the spread base in
   * `setAgentThursdayState({ ...getAgentThursdayState(), <delta> })`. Matches the
   * inline `{ ...this.agentthursdayState, ... }` pattern verbatim.
   */
  getAgentThursdayState: () => AgentThursdayState;
  setAgentThursdayState: (next: AgentThursdayState) => void;
  /**
   * Bounded knowledge digest . Returned by
   * `review_project_status` to the model.
   */
  readKnowledge: () => string;
}

export function buildCoreTools(host: CoreToolHost) {
  const { sql, logEvent, getSafeState, getAgentThursdayState, setAgentThursdayState, readKnowledge } = host;
  return {
    review_project_status: tool({
      description: "读取并汇总当前项目与 agent 状态",
      inputSchema: z.object({}),
      execute: async () => {
        const s = getSafeState();
        const knowledge = readKnowledge();
        const ar: ActionResult = { actionType: "review-project-status", outcome: "success", summary: `task: ${(s.currentTask ?? "none").slice(0, 80)}`, recordedAt: Date.now() };
        setAgentThursdayState({ ...getAgentThursdayState(), lastActionResult: ar, updatedAt: Date.now() });
        logEvent("tool.review_project_status", { task: s.currentTask });
        return { status: s.status, currentTask: s.currentTask, lastCheckpoint: s.lastCheckpoint, knowledge };
      },
    }),
    write_checkpoint: tool({
      description: "写入当前工作 checkpoint，持久化进度",
      inputSchema: z.object({ content: z.string().describe("checkpoint 内容"), key: z.string().optional().describe("可选 key") }),
      execute: async (input) => {
        const k = input.key ?? `checkpoint-${Date.now().toString(36)}`;
        sql`INSERT INTO checkpoints (key, content, source, created_at) VALUES (${k}, ${input.content}, 'tool', ${Date.now()})`;
        const agentthursdayState = getAgentThursdayState();
        const checkpoint = `step:${Date.now()}:${(agentthursdayState.currentTask ?? "task").slice(0, 30).replace(/\s+/g, "-")}`;
        const ar: ActionResult = { actionType: "write-checkpoint", outcome: "success", summary: input.content.slice(0, 120), recordedAt: Date.now() };
        setAgentThursdayState({ ...agentthursdayState, lastCheckpoint: checkpoint, lastActionResult: ar, status: "idle", updatedAt: Date.now() });
        logEvent("tool.write_checkpoint", { key: k, checkpoint });
        return { ok: true, key: k, checkpoint };
      },
    }),
    review_note: tool({
      description: "生成当前推进状态 review note，汇总任务进度与建议",
      inputSchema: z.object({ content: z.string().describe("review note 内容") }),
      execute: async (input) => {
        sql`INSERT INTO review_notes (content, source, created_at) VALUES (${input.content}, 'tool', ${Date.now()})`;
        const ar: ActionResult = { actionType: "review-note", outcome: "success", summary: input.content.slice(0, 120), recordedAt: Date.now() };
        setAgentThursdayState({ ...getAgentThursdayState(), lastActionResult: ar, updatedAt: Date.now() });
        logEvent("tool.review_note", { contentSnippet: input.content.slice(0, 100) });
        return { ok: true };
      },
    }),
    advance_kanban_card: tool({
      description: "推进当前 kanban 卡，记录推进结果（需要人类确认）",
      inputSchema: z.object({
        card_ref: z.string().describe("卡片引用，如 card-55"),
        description: z.string().describe("推进描述"),
        diff_hint: z.string().describe("预期修改提示"),
      }),
      needsApproval: true,
      execute: async (input) => {
        sql`INSERT INTO kanban_mutations (card_ref, mutation_type, description, diff_hint, created_at) VALUES (${input.card_ref}, ${"status-advance"}, ${input.description}, ${input.diff_hint}, ${Date.now()})`;
        const ar: ActionResult = { actionType: "advance-kanban-card", outcome: "success", summary: `kanban mutation recorded — ${input.card_ref}: ${input.description.slice(0, 80)}`, recordedAt: Date.now() };
        setAgentThursdayState({ ...getAgentThursdayState(), lastActionResult: ar, updatedAt: Date.now() });
        logEvent("tool.advance_kanban_card", { cardRef: input.card_ref, descriptionSnippet: input.description.slice(0, 80) });
        return { ok: true, card_ref: input.card_ref };
      },
    }),
  };
}
