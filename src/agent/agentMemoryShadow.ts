/**
 * 双路记忆 v1: Cloudflare Agent Memory HTTP client (shadow path).
 *
 * The SECOND memory path next to the native one (agent_memories +
 * conversation_archive). Operator-only dogfood in v1; everything here is
 * fail-soft and tool-level so the dependency on the private-beta service is
 * removable at any time (an earlier revision pilot report is the decision record).
 *
 * Pilot-measured constraints honored here:
 * - ingest is a SYNCHRONOUS LLM extraction upstream: keep batches tiny
 *   (a single turn = 2 messages) and never block a turn on it.
 * - recall takes 5–15s: callers pass a hard timeout budget; on timeout the
 *   dual-recall tool degrades to local-only.
 * - extraction can confabulate: recall output is labeled as the UNVERIFIED
 *   source; the corroboration judgment stays with the agent (tool layer), and
 *   nothing from this path is written into native memory.
 */

export const AGENT_MEMORY_ACCOUNT = "4c704e48a0ee2d6cad0d21a16e9d174a";
export const AGENT_MEMORY_NAMESPACE = "agentthursday-shadow";
/** The operator's shadow profile (matches the an earlier revision pilot corpus). */
export const AGENT_MEMORY_OPERATOR_PROFILE = "operator";

const API_BASE = "https://api.cloudflare.com/client/v4";
/** CF limit: 32 KB per message content; clamp defensively. */
const MESSAGE_CONTENT_MAX_BYTES = 32_000;
/** CF limit: 1 KB recall query. */
const RECALL_QUERY_MAX_BYTES = 1_000;

export interface AgentMemoryTurnMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface AgentMemoryRecallCandidate {
  id: string;
  summary: string;
  sessionId: string | null;
  score: number;
}

export interface AgentMemoryRecallResult {
  count: number;
  answer: string;
  candidates: AgentMemoryRecallCandidate[];
}

function profileUrl(profile: string, tail: string): string {
  return `${API_BASE}/accounts/${AGENT_MEMORY_ACCOUNT}/agent-memory/namespaces/${AGENT_MEMORY_NAMESPACE}/profiles/${encodeURIComponent(profile)}/${tail}`;
}

function clampUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.length <= maxBytes) return s;
  return new TextDecoder("utf-8").decode(enc.slice(0, maxBytes)).replace(/�+$/, "");
}

/**
 * Fire-and-forget turn ingest (caller wraps in waitUntil). Never throws:
 * returns {ok:false, error} on ANY failure so the caller can logEvent it.
 */
export async function cfMemoryIngestTurn(
  token: string,
  profile: string,
  messages: AgentMemoryTurnMessage[],
  sessionId: string | undefined,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = {
      messages: messages
        .filter(m => m.content.trim().length > 0)
        .map(m => ({ ...m, content: clampUtf8(m.content, MESSAGE_CONTENT_MAX_BYTES) })),
      ...(sessionId ? { sessionId: sessionId.slice(0, 64) } : {}),
    };
    if (body.messages.length === 0) return { ok: true };
    const resp = await fetch(profileUrl(profile, "ingest"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
    const json = await resp.json<{ success?: boolean }>();
    return json?.success === true ? { ok: true } : { ok: false, error: "api_success_false" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

/** Recall with a hard timeout budget. Never throws. */
export async function cfMemoryRecall(
  token: string,
  profile: string,
  query: string,
  timeoutMs = 12_000,
): Promise<{ ok: true; result: AgentMemoryRecallResult } | { ok: false; error: string }> {
  try {
    const resp = await fetch(profileUrl(profile, "recall"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: clampUtf8(query, RECALL_QUERY_MAX_BYTES),
        thinkingLevel: "medium",
        responseLength: "medium",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
    const json = await resp.json<{ success?: boolean; result?: Partial<AgentMemoryRecallResult> }>();
    if (json?.success !== true || !json.result) return { ok: false, error: "api_success_false" };
    return {
      ok: true,
      result: {
        count: typeof json.result.count === "number" ? json.result.count : 0,
        answer: typeof json.result.answer === "string" ? json.result.answer : "",
        candidates: Array.isArray(json.result.candidates)
          ? json.result.candidates.slice(0, 10).map(c => ({
              id: String(c.id ?? ""),
              summary: String(c.summary ?? ""),
              sessionId: c.sessionId == null ? null : String(c.sessionId),
              score: typeof c.score === "number" ? c.score : 0,
            }))
          : [],
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

/**
 * Compose the dual-recall tool payload: both paths side-by-side, labeled by
 * source, with the honesty framing baked in (the agent judges corroboration).
 */
export function composeDualRecallPayload(args: {
  query: string;
  cf: { ok: true; result: AgentMemoryRecallResult } | { ok: false; error: string };
  localArchive: Array<{ snippet: string; chunkId?: string }>;
  localMemories: Array<{ id: number; type: string; content: string }>;
}): {
  query: string;
  local_archive_hits: Array<{ snippet: string; chunkId?: string }>;
  local_memories: Array<{ id: number; type: string; content: string }>;
  cf_shadow: { status: "ok"; answer: string; candidates: AgentMemoryRecallCandidate[] } | { status: "unavailable"; error: string };
  corroboration_note: string;
} {
  return {
    query: args.query,
    local_archive_hits: args.localArchive.slice(0, 8),
    local_memories: args.localMemories.slice(0, 8),
    cf_shadow: args.cf.ok
      ? { status: "ok", answer: args.cf.result.answer, candidates: args.cf.result.candidates }
      : { status: "unavailable", error: args.cf.error },
    corroboration_note:
      "双路互证：local_* 来自本地归档/记忆（关键词检索，可靠但召回窄）；cf_shadow 来自外部影子记忆（NL 召回强但抽取可能缝合失真）。两路一致的信息可信度高；仅 cf_shadow 单源的结论需在采信前用 conversation_search 或原始记录复核。",
  };
}

// list recent shadow memories (console memory-layers side-by-side
// view). Read-only, bounded, fail-soft: no token / HTTP error / bad JSON →
// null (the panel shows "unavailable", never breaks the native layers).
export interface CfShadowMemory {
  id: string;
  type: string;
  summary: string;
  createdAt: string | null;
}

export async function cfMemoryListRecent(
  profile: string,
  token: string | undefined,
  limit = 20,
): Promise<CfShadowMemory[] | null> {
  if (!token) return null;
  try {
    const resp = await fetch(profileUrl(profile, `memories?per_page=${Math.max(1, Math.min(50, limit))}`), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { result?: unknown };
    const rows = Array.isArray(body.result) ? body.result : [];
    return rows
      .map((r) => {
        const m = r as Record<string, unknown>;
        return {
          id: typeof m.id === "string" ? m.id : "",
          type: typeof m.type === "string" ? m.type : "unknown",
          summary: typeof m.summary === "string" ? m.summary : "",
          createdAt: typeof m.createdAt === "string" ? m.createdAt : null,
        };
      })
      .filter((m) => m.summary.length > 0)
      .slice(0, limit);
  } catch {
    return null;
  }
}
