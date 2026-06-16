/**
 *  — empty-reply visible fallback.
 *
 * When `submitTask` finalizes an assistant turn with empty `replyText`
 * but a draft envelope exists, the prior code wrote only the internal
 * `[envelope: env-…]` marker. `stripDiscordVisibleInternalMarkers` in
 * `src/discordDirect.ts` removes that marker line at the Discord
 * render layer, so the visible reply collapsed to `(empty)` — masking
 * validation failures ( reproduction, task `task-mpal33tl`,
 * envelope `env-mpal33tl-gh8k`).
 *
 * `renderEmptyReplyFallback` builds a short structured summary that
 * survives the marker strip. Output is intentionally non-secret-bearing:
 * envelope id, task id, ring counts, and a `tool output truncated` note
 * when an execution carries `truncated: true` in its output payload.
 */

import type { EvidenceEnvelope } from "./skillset/evidenceEnvelope";

export interface EmptyReplyFallbackInput {
  envelope: EvidenceEnvelope | undefined;
  envelopeId: string;
  taskId: string;
}

export function renderEmptyReplyFallback(input: EmptyReplyFallbackInput): string {
  const { envelope, envelopeId, taskId } = input;
  const execCount = envelope?.execution.length ?? 0;
  const gateLogCount = envelope?.evidence.gate_logs?.length ?? 0;
  const diffCount = envelope?.evidence.diff?.length ?? 0;
  const evidenceCount = gateLogCount + diffCount;
  const hint =
    execCount === 0
      ? "no_execution"
      : evidenceCount === 0
        ? "evidence_missing"
        : "pending";
  const truncated = envelope ? hasTruncatedExecution(envelope) : false;
  const lines = [
    `⚠️ validation failed: ${hint}`,
    `execution=${execCount}, evidence=${evidenceCount}`,
  ];
  if (truncated) {
    lines.push("tool output truncated; cannot verify exact line ranges");
  }
  lines.push(`task: ${taskId}`);
  lines.push(`[envelope: ${envelopeId}]`);
  return lines.join("\n");
}

/**
 * -1 — approval-pending visible reply.
 *
 * When a `needsApproval: true` tool (e.g. `advance_kanban_card`) is called,
 * the AI SDK legitimately pauses the round: the tool-call part is left in
 * `state === "approval-requested"`, `execute()` does not run, and the
 * assistant turn finalizes with empty `replyText`. The  empty
 * fallback then rendered "⚠️ validation failed: no_execution" — which is
 * wrong: the pause is correct, the user just needs to confirm.
 *
 * `renderApprovalPendingReply` is the dedicated render for that case. It
 * names the tool waiting on confirmation and the task/envelope so a
 * reviewer can locate the pending call. No secret content.
 */
export interface ApprovalPendingReplyInput {
  toolName: string;
  toolCallId: string;
  taskId: string;
  envelopeId: string | undefined;
}

export function renderApprovalPendingReply(input: ApprovalPendingReplyInput): string {
  const { toolName, toolCallId, taskId, envelopeId } = input;
  const lines = [
    `⏸ 等待人类确认：${toolName}`,
    `toolCallId: ${toolCallId}`,
    `task: ${taskId}`,
  ];
  if (envelopeId) {
    lines.push(`[envelope: ${envelopeId}]`);
  }
  return lines.join("\n");
}

/**
 *  — read-intent no-execution visible reply.
 *
 *  started sealing envelopes as `read_intent_no_execution`
 * (verdict reason) when the prompt asked for a file read but no
 * envelope-wrapped tool fired. But Case 2 surfaced a second gap: when
 * the model emits a partial progress text like `正在读取文档：` and
 * then `finishReason: "stop"` with **zero tool calls of any kind**
 * (not even an unwrapped ContentHub `content_read`), the existing
 *  empty-fallback path does not run — `replyText.trim().length
 * > 0` — so the dangling progress text reaches Discord with only an
 * `[envelope: …]` marker appended. Production evidence: task
 * `task-mpcpl04p`, envelope `env-mpcpl04p-c11q`, visible reply was
 * literally `正在读取文档：`.
 *
 * `renderReadIntentNoExecutionReply` replaces that partial text with a
 * short, user-facing failure-and-recovery message. It deliberately
 * preserves the model's announced read intent (so the user can match
 * it back to their request) and tells them to retry. It does NOT
 * fabricate execution: the envelope stays `failed` and the marker is
 * appended downstream.
 *
 * The decision to fire this override is in the caller (`submitTask`
 * finally): `promptReadIntentDetectedForSeal && totalToolCalls === 0`.
 * That distinguishes Case 2 (model stalled mid-announce, no tools)
 * from Case 1 (model successfully called an unwrapped `content_read`
 * and produced a real summary reply — Case 1 has totalToolCalls > 0
 * and must not be overridden).
 */
export interface ReadIntentNoExecutionReplyInput {
  envelopeId: string;
  taskId: string;
  /** The pre-override reply text (typically a dangling "正在读取…："). */
  partialText: string;
}

export function renderReadIntentNoExecutionReply(
  input: ReadIntentNoExecutionReplyInput,
): string {
  const { envelopeId, taskId, partialText } = input;
  const trimmedPartial = (partialText ?? "").trim().slice(0, 200);
  const lines = [
    "⚠️ 我说要读文件但没有真正调用工具，无法给你总结。",
    "原因：模型停在了 read-intent announcement，没有发起 repo_read / content_read 调用。",
    "建议：再发一次请求，或确认文件路径是否存在；我会重新尝试调用读取工具。",
  ];
  if (trimmedPartial.length > 0) {
    lines.push(`原回复片段：${trimmedPartial}`);
  }
  lines.push(`task: ${taskId}`);
  lines.push(`[envelope: ${envelopeId}]`);
  return lines.join("\n");
}

/**
 *  — deterministic remember-ack empty-reply fallback.
 *
 * When `submitTask` finalizes an assistant turn with empty `replyText`
 * but a captured `_currentTaskRememberAck` exists, surface the ack as
 * the visible reply so tool-only memory rounds (model fired `remember`
 * but produced no assistant text) still confirm to the user.
 *
 * Extracted from `src/server.ts` so  directed validation can
 * exercise the predicate + replacement deterministically (admin.smoke
 * `remember-ack-empty-fallback`). The predicate and replacement are
 * a verbatim move — do not relax `!replyText || replyText.trim().length === 0`.
 */
export interface RememberAckFallbackInput {
  replyText: string;
  rememberAck: string | null | undefined;
}

export interface RememberAckFallbackResult {
  replyText: string;
  fallbackApplied: boolean;
}

export function applyRememberAckFallback(
  input: RememberAckFallbackInput,
): RememberAckFallbackResult {
  const { replyText, rememberAck } = input;
  if ((!replyText || replyText.trim().length === 0) && rememberAck) {
    return { replyText: rememberAck, fallbackApplied: true };
  }
  return { replyText, fallbackApplied: false };
}

/**
 *  — mutation-intent-unwrapped prepend warning.
 *
 * Case 3 surfaced a third class of envelope drift: the supplier
 * dispatched a Think workspace `write` / `delete` (or `edit`) at the
 * top level of `streamText({tools})`, the file system action actually
 * succeeded, and the model produced a coherent narrative claiming
 * success — but no envelope-wrapped `repo.write` / `repo.delete`
 * execution[] entry was recorded, and `self_verify.verdict_reason`
 * fell to `read_only_no_action_required`. The visible reply then
 * unconditionally declared the mutation done with no audit trail.
 *
 * Unlike `renderReadIntentNoExecutionReply` (), the model
 * narrative here is factually accurate (the mutation really did
 * happen), so we PREPEND a warning rather than override the body
 * (per  hard requirement 2026-05-19): warning must be at the
 * very top, narrative is retained as "model claim / supplier
 * unwrapped tool output" — not as system-validated success.
 *
 * Envelope is sealed `failed` with
 * `verdict_reason="mutation_intent_unwrapped_execution"` upstream;
 * this render only shapes the visible reply.
 */
export interface MutationUnwrappedPrependInput {
  envelopeId: string;
  taskId: string;
  /** Mutation tool names observed in supplier-signal toolCallNames. */
  mutationTools: string[];
  /** The pre-prepend reply body to retain below the warning. */
  modelReply: string;
}

export function renderMutationUnwrappedPrependWarning(
  input: MutationUnwrappedPrependInput,
): string {
  const { envelopeId, taskId, mutationTools, modelReply } = input;
  const toolList = mutationTools.length > 0 ? mutationTools.join(", ") : "write/delete";
  const warningLines = [
    `⚠️ 本次 mutation 未走 envelope-wrapped repo.write / repo.delete 路径（unwrapped supplier tool: ${toolList}）。`,
    "缺可审计写入证据：envelope.execution 为空，self_verify 已 fail。",
    "请勿当作 PASS — 修复前已停止后续 Case 4 / 等待复测。",
    "以下为模型声称 / supplier unwrapped tool 输出，仅供线索，不构成系统验收：",
    "—",
  ];
  const lines = [...warningLines];
  const trimmedModel = (modelReply ?? "").trim();
  if (trimmedModel.length > 0) {
    lines.push(trimmedModel);
  }
  lines.push(`task: ${taskId}`);
  lines.push(`[envelope: ${envelopeId}]`);
  return lines.join("\n");
}

/**
 *  — prompt-mutation-intent no-execution full-override reply.
 *
 *  (prepend) treats the model narrative as advisory because
 * the supplier really did dispatch a tool, even if unwrapped. 295e is
 * different: `totalToolCalls === 0` means the narrative is fabricated
 * end-to-end — the model announced 创建/删除/修改 on a real path, then
 * stopped without invoking any tool. Retaining a fabricated narrative
 * below a warning would still let the false claim reach the user, so
 * the reply is fully replaced (not prepended). The pre-override text
 * is preserved as a short `原回复片段:` line for traceback only.
 *
 * Envelope is sealed `failed` with
 * `verdict_reason="mutation_intent_no_execution"` upstream; this render
 * only shapes the visible reply.
 */
export interface MutationIntentNoExecutionReplyInput {
  envelopeId: string;
  taskId: string;
  /** Mutation verb pattern keys that fired (from matchedPatterns). */
  matchedPatterns: string[];
  /** The pre-override reply text (fabricated mutation narrative). */
  partialText: string;
}

export function renderMutationIntentNoExecutionReply(
  input: MutationIntentNoExecutionReplyInput,
): string {
  const { envelopeId, taskId, matchedPatterns, partialText } = input;
  const trimmedPartial = (partialText ?? "").trim().slice(0, 200);
  const patternList = matchedPatterns.length > 0
    ? matchedPatterns.filter(p => p !== "repo_path_present").join(", ")
    : "write/delete/edit";
  const lines = [
    "⚠️ 我声称已写/删/改文件，但没有调用任何工具，没有可审计写入证据。",
    `检测到 prompt 中的 mutation intent（${patternList}），但 totalToolCalls === 0。`,
    "envelope.execution 为空，self_verify 已 fail (mutation_intent_no_execution)。",
    "请勿当作 PASS — 文件实际未被创建/删除/修改。",
    "建议：再发一次请求；若是 path-deny / 策略拒绝，请明确说明。",
  ];
  if (trimmedPartial.length > 0) {
    lines.push(`原回复片段：${trimmedPartial}`);
  }
  lines.push(`task: ${taskId}`);
  lines.push(`[envelope: ${envelopeId}]`);
  return lines.join("\n");
}

function hasTruncatedExecution(env: EvidenceEnvelope): boolean {
  for (const exec of env.execution) {
    const output = exec.tool_result.output;
    if (
      output !== null &&
      typeof output === "object" &&
      "truncated" in (output as Record<string, unknown>) &&
      (output as Record<string, unknown>).truncated === true
    ) {
      return true;
    }
  }
  return false;
}
