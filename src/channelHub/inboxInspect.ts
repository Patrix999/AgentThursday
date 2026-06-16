/**
 *  — read-only `channel_inbox` inspect surface.
 *
 * `inspectChannelInboxImpl(agent, input)` is the pure body the
 * `ChannelHubAgent.inspectChannelInbox` callable delegates to. Lives in
 * its own module (mirroring `patchArtifacts.ts:inspectPatchArtifactsImpl`)
 * so a future pure-helper test can exercise the redaction shape
 * without importing the partyserver / cloudflare:workers chain.
 *
 * Egress contract:
 *   - text → preview-only, capped at 1000 chars; raw `text_length`
 *     surfaces so a verifier can see truncation happened.
 *   - attachments → never returned as raw JSON; the row exposes only
 *     `attachment_count` and a deduped `attachment_kinds[]` list of
 *     `content_type` strings.
 *   - raw_ref → bounded preview (200 chars).
 *   - addressed_signals → parsed array of strings.
 *
 * No write side. Caller (route handler) is auth-gated by the global
 * `/api/*` `requireSecret` umbrella; this helper additionally
 * validates input shape so a broken caller can't smuggle LIKE-pattern
 * wildcards into the SQL.
 */

import type { Agent } from "agents";
import { safeParseArray } from "./mappers";

export type ChannelHubInboxInspectHost = Agent<Env, Record<string, never>>;

export type InspectChannelInboxInput = {
  provider_message_id?: string;
  conversation_id?: string;
  inbox_id?: string;
  limit?: number;
};

export type ChannelInboxInspectRow = {
  id: string;
  provider: string;
  conversation_id: string;
  provider_message_id: string;
  sender_provider_user_id: string;
  chat_type: string;
  addressed_to_agent: boolean;
  addressed_signals: string[];
  status: string;
  route_action: string | null;
  route_reason: string | null;
  routed_at: number | null;
  handoff_task_id: string | null;
  created_at: number;
  updated_at: number;
  text_length: number;
  text_preview: string;
  attachment_count: number;
  attachment_kinds: string[];
  raw_ref_preview: string | null;
};

type InboxQRow = {
  id: string;
  provider: string;
  conversation_id: string;
  provider_message_id: string;
  sender_provider_user_id: string;
  chat_type: string;
  addressed_to_agent: number;
  addressed_signals_json: string;
  text: string;
  text_length: number;
  attachments_json: string;
  raw_ref: string | null;
  status: string;
  route_action: string | null;
  route_reason: string | null;
  routed_at: number | null;
  handoff_task_id: string | null;
  created_at: number;
  updated_at: number;
};

const TEXT_PREVIEW_MAX = 1000;
const RAW_REF_PREVIEW_MAX = 200;
const SAFE_ID_RE = /^[A-Za-z0-9_.:\-]+$/;

export function inspectChannelInboxImpl(
  agent: ChannelHubInboxInspectHost,
  input: InspectChannelInboxInput,
): { rows: ChannelInboxInspectRow[] } {
  const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  let rows: InboxQRow[] = [];

  if (typeof input.inbox_id === "string" && input.inbox_id.length > 0) {
    if (!SAFE_ID_RE.test(input.inbox_id)) return { rows: [] };
    rows = agent.sql<InboxQRow>`
      SELECT id, provider, conversation_id, provider_message_id,
             sender_provider_user_id, chat_type, addressed_to_agent,
             addressed_signals_json,
             substr(text, 1, ${TEXT_PREVIEW_MAX}) AS text,
             length(text) AS text_length,
             attachments_json, raw_ref, status,
             route_action, route_reason, routed_at, handoff_task_id,
             created_at, updated_at
      FROM channel_inbox
      WHERE id = ${input.inbox_id}
      LIMIT ${limit}
    `;
  } else if (typeof input.provider_message_id === "string" && input.provider_message_id.length > 0) {
    if (!SAFE_ID_RE.test(input.provider_message_id)) return { rows: [] };
    rows = agent.sql<InboxQRow>`
      SELECT id, provider, conversation_id, provider_message_id,
             sender_provider_user_id, chat_type, addressed_to_agent,
             addressed_signals_json,
             substr(text, 1, ${TEXT_PREVIEW_MAX}) AS text,
             length(text) AS text_length,
             attachments_json, raw_ref, status,
             route_action, route_reason, routed_at, handoff_task_id,
             created_at, updated_at
      FROM channel_inbox
      WHERE provider_message_id = ${input.provider_message_id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else if (typeof input.conversation_id === "string" && input.conversation_id.length > 0) {
    if (!SAFE_ID_RE.test(input.conversation_id)) return { rows: [] };
    rows = agent.sql<InboxQRow>`
      SELECT id, provider, conversation_id, provider_message_id,
             sender_provider_user_id, chat_type, addressed_to_agent,
             addressed_signals_json,
             substr(text, 1, ${TEXT_PREVIEW_MAX}) AS text,
             length(text) AS text_length,
             attachments_json, raw_ref, status,
             route_action, route_reason, routed_at, handoff_task_id,
             created_at, updated_at
      FROM channel_inbox
      WHERE conversation_id = ${input.conversation_id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    return { rows: [] };
  }

  const inspectRows: ChannelInboxInspectRow[] = rows.map((r) => {
    const signals = safeParseArray<string>(r.addressed_signals_json)
      .filter((s): s is string => typeof s === "string");
    const attachments = safeParseArray<{ contentType?: string | null; content_type?: string | null }>(r.attachments_json);
    const kinds: string[] = [];
    const kindSeen = new Set<string>();
    for (const a of attachments) {
      const ct = (a?.contentType ?? a?.content_type ?? null);
      if (typeof ct === "string" && ct.length > 0 && !kindSeen.has(ct)) {
        kindSeen.add(ct);
        kinds.push(ct);
      }
    }
    const rawRefPreview = typeof r.raw_ref === "string" && r.raw_ref.length > 0
      ? (r.raw_ref.length > RAW_REF_PREVIEW_MAX ? `${r.raw_ref.slice(0, RAW_REF_PREVIEW_MAX)}…` : r.raw_ref)
      : null;
    return {
      id: r.id,
      provider: r.provider,
      conversation_id: r.conversation_id,
      provider_message_id: r.provider_message_id,
      sender_provider_user_id: r.sender_provider_user_id,
      chat_type: r.chat_type,
      addressed_to_agent: r.addressed_to_agent === 1,
      addressed_signals: signals,
      status: r.status,
      route_action: r.route_action,
      route_reason: r.route_reason,
      routed_at: r.routed_at,
      handoff_task_id: r.handoff_task_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      text_length: r.text_length,
      text_preview: r.text,
      attachment_count: attachments.length,
      attachment_kinds: kinds,
      raw_ref_preview: rawRefPreview,
    };
  });
  return { rows: inspectRows };
}
