/**
 * Structured TaskContext schema + render helper.
 *
 * Defined by ADR §5.1 (manager-workflow-infrastructure-contract). Threaded
 * through manager HTTP message → `manager.agent_message` adapter →
 * subagent first-turn `<task-context>` block → inspect/event payload.
 *
 * Limits (ADR §5.1):
 *   - title ≤ 100
 *   - objective ≤ 500
 *   - verification_hint ≤ 500
 */

import { z } from "zod";

export const ArtifactRefSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  artifact_id: z.string().min(1),
  kind: z.enum(["summary", "file", "diff", "log", "trace"]),
  digest: z.string().optional(),
});

export const TaskContextSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(100),
  objective: z.string().min(1).max(500),
  source_agent_id: z.string().min(1),
  house_rules: z.array(z.string()).optional(),
  parent_task_id: z.string().nullable().optional(),
  card_id: z.string().nullable().optional(),
  artifact_refs: z.array(ArtifactRefSchema).optional(),
  expected_outputs: z.array(z.string()).optional(),
  non_goals: z.array(z.string()).optional(),
  verification_hint: z.string().max(500).optional(),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;

/**
 * Render a TaskContext as a fenced `<task-context>` block holding
 * pretty-printed JSON. The block is prepended to the subagent's
 * first-turn user message; the original task text is preserved
 * verbatim after the block (ADR §5.3).
 */
export function renderTaskContextBlock(ctx: TaskContext): string {
  return `<task-context>\n${JSON.stringify(ctx, null, 2)}\n</task-context>`;
}

/**
 *  — bounded preview of the rendered `<task-context>` block
 * for inspect/event evidence. Caps by UTF-8 bytes (not JS string length —
 * see UTF-8 byte cap memo); when truncation is required, preserves both
 * the opening and closing tags so verifier grep `<task-context>` and
 * `</task-context>` succeeds.
 */
export function renderTaskContextBlockPreview(
  ctx: TaskContext,
  maxBytes = 2000,
): string {
  const block = renderTaskContextBlock(ctx);
  const enc = new TextEncoder();
  if (enc.encode(block).byteLength <= maxBytes) return block;
  const suffix = "\n…\n</task-context>";
  const suffixBytes = enc.encode(suffix).byteLength;
  const headBudget = Math.max(0, maxBytes - suffixBytes);
  let head = "";
  let used = 0;
  for (const ch of block) {
    const chBytes = enc.encode(ch).byteLength;
    if (used + chBytes > headBudget) break;
    head += ch;
    used += chBytes;
  }
  return head + suffix;
}
