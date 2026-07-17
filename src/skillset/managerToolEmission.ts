/**
 * manager tool emission enrichment.
 *
 * `agentDynamicTools.ts` emits a thin `{tool, status}` payload for
 * every dispatched skill tool. For known `manager.*` tool ids we
 * want enough safe context in the event payload that the action UI
 * intent mapper can build a useful lifecycle card without re-deriving
 * data the handler already has on hand.
 *
 * Scope is intentionally narrow:
 *  - Only widens the payload for tools whose canonical id matches
 *    one of the four manager families.
 *  - Whitelist-extracts: agent_id / task_id / envelope_id / status /
 *    counts / config fields (name / model / skillset) / bounded
 *    redacted previews of user-supplied free-form text (`text`,
 *    `reply`, `error.message`).
 *  - Never copies raw payloads, full prompts, or provider responses.
 *
 * The functions mutate the provided `target` map (the same one
 * agentDynamicTools.ts already passes to `onDispatch` / `onResult`)
 * so the existing emission flow stays the same shape.
 */

import { previewText } from "../safeTextPreview";

const PREVIEW_CAP = 160;
const ERROR_MESSAGE_CAP = 200;

const UPDATEABLE_FIELDS = ["name", "model", "skillset", "persona", "status"] as const;

export function enrichManagerInputSummary(
  canonical: string,
  inputObj: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  if (canonical === "manager.agent_message") {
    if (typeof inputObj.agent_id === "string") {
      target.agent_id = inputObj.agent_id;
    }
    if (typeof inputObj.conversation_id === "string") {
      target.conversation_id = inputObj.conversation_id;
    }
    if (typeof inputObj.source === "string") {
      target.source = inputObj.source;
    }
    if (typeof inputObj.text === "string") {
      const text = inputObj.text;
      const pv = previewText(text, PREVIEW_CAP);
      target.text_preview = pv.text;
      target.text_truncated = pv.truncated;
      target.text_bytes = text.length;
    }
    return;
  }
  if (canonical === "manager.agent_list") {
    if (typeof inputObj.include_archived === "boolean") {
      target.include_archived = inputObj.include_archived;
    }
    return;
  }
  if (canonical === "manager.agent_create") {
    if (typeof inputObj.name === "string") target.name = inputObj.name;
    if (typeof inputObj.model === "string") target.model = inputObj.model;
    if (typeof inputObj.skillset === "string") target.skillset = inputObj.skillset;
    if (typeof inputObj.status === "string") target.agent_status = inputObj.status;
    return;
  }
  if (canonical === "manager.agent_update") {
    if (typeof inputObj.agent_id === "string") target.agent_id = inputObj.agent_id;
    const changed: string[] = [];
    for (const k of UPDATEABLE_FIELDS) {
      if (typeof inputObj[k] === "string") changed.push(k);
    }
    if (changed.length > 0) target.changed_fields = changed;
    return;
  }
}

export function enrichManagerResultSummary(
  canonical: string,
  resultRow: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  if (canonical === "manager.agent_message") {
    if (typeof resultRow.agent_id === "string") target.agent_id = resultRow.agent_id;
    if (typeof resultRow.task_id === "string") target.task_id = resultRow.task_id;
    if (typeof resultRow.envelope_id === "string") target.envelope_id = resultRow.envelope_id;
    if (typeof resultRow.conversation_id === "string") {
      target.conversation_id = resultRow.conversation_id;
    }
    if (typeof resultRow.loop_triggered === "boolean") {
      target.loop_triggered = resultRow.loop_triggered;
    }
    if (typeof resultRow.reply === "string") {
      const reply = resultRow.reply;
      const pv = previewText(reply, PREVIEW_CAP);
      target.reply_preview = pv.text;
      target.reply_truncated = pv.truncated;
      target.reply_length = reply.length;
    }
    mergeErrorObject(resultRow.error, target);
    return;
  }
  if (canonical === "manager.agent_list") {
    if (typeof resultRow.count === "number") target.count = resultRow.count;
    if (Array.isArray(resultRow.agents)) target.agent_count = resultRow.agents.length;
    return;
  }
  if (canonical === "manager.agent_create" || canonical === "manager.agent_update") {
    const agent = resultRow.agent;
    if (agent && typeof agent === "object" && !Array.isArray(agent)) {
      const a = agent as Record<string, unknown>;
      if (typeof a.agent_id === "string") target.agent_id = a.agent_id;
      if (typeof a.name === "string") target.name = a.name;
      if (typeof a.model === "string") target.model = a.model;
      if (typeof a.skillset === "string") target.skillset = a.skillset;
      if (typeof a.status === "string") target.agent_status = a.status;
    }
    mergeErrorObject(resultRow.error, target);
    return;
  }
}

function mergeErrorObject(err: unknown, target: Record<string, unknown>): void {
  if (!err || typeof err !== "object" || Array.isArray(err)) return;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string") target.error_code = e.code;
  if (typeof e.message === "string") {
    const pv = previewText(e.message, ERROR_MESSAGE_CAP);
    target.message_snippet = pv.text;
  }
}
