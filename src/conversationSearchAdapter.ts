/**
 * Conversation search adapter spike (compile-safe skeleton).
 *
 * Goal: introduce an adapter boundary so `AgentThursdayAgent.conversationSearch`
 * can in the future choose between local SQL/FTS search and Cloudflare
 * AI Search (vector / hybrid retrieval), without making CF AI Search a
 * hard dependency.
 *
 * **This card is a SPIKE.** The local SQL implementation in
 * `src/server.ts` (`AgentThursdayAgent.conversationSearch`) is **not** rewired
 * through this adapter yet — that's a follow-up implementation card if
 * the spike concludes CF AI Search is a fit. What this file ships:
 *
 *   1. The adapter interface (`ConversationSearchAdapter`) with the
 *      same shape `conversationSearch` already exposes.
 *   2. A `CloudflareAiSearchConversationSearchAdapter` skeleton: typed
 *      against the runtime SDK shapes from `@cloudflare/workers-types`
 *      so we can verify the binding contract compiles. The actual
 *      `search` method throws a structured `AdapterUnavailableError`
 *      when the binding isn't present in `env`.
 *   3. A `chooseConversationSearchAdapter(env)` selector showing the
 *      decision logic: prefer CF AI Search if `env.AI_SEARCH` is bound
 *      (namespace) or `env.CONVERSATION_SEARCH` is bound (single
 *      instance), otherwise leave the `null` slot for the caller to
 *      keep using its local SQL path.
 *
 * Wrangler binding shape (documented but **not** added to wrangler.toml
 * in this card; see `docs/design/2026-05-02-m7.8-cloudflare-ai-search-adapter-spike.md`):
 *
 *   ```toml
 *   # Single-instance binding — ties the worker to ONE preconfigured
 *   # AI Search instance, e.g. an instance named "agent-thursday-conversation".
 *   # Wrangler schema (validated by node_modules/wrangler) requires
 *   # `binding` + `instance_name` (not `instance_id`).
 *   [[ai_search]]
 *   binding = "CONVERSATION_SEARCH"
 *   instance_name = "agent-thursday-conversation"
 *
 *   # Namespace binding — lets the worker dynamically address multiple
 *   # AI Search instances inside a CF account namespace. Useful if we
 *   # ever decide to give each context its own instance, or to run
 *   # tenant-isolated search within one namespace. Wrangler schema
 *   # requires `binding` + `namespace` (not `namespace_id`).
 *   [[ai_search_namespaces]]
 *   binding = "AI_SEARCH"
 *   namespace = "agent-thursday"
 *   ```
 *
 * Items API contract (from `AiSearchItems`):
 *
 *   - `instance.items.upload(name, content, { metadata? })` — upload a
 *     chunk as a named item; idempotent (same name → upsert + reindex).
 *   - `instance.items.list({ ... })` — list items with pagination.
 *   - `instance.items.get(itemId)` — read item info / download / sync /
 *     logs / chunks.
 *   - `instance.items.delete(itemId)` — remove from the instance.
 *
 * Search API contract (from `AiSearchInstance.search`):
 *
 *   - retrieval modes: `"vector" | "keyword" | "hybrid"` (default
 *     hybrid via instance config).
 *   - `match_threshold` (0–1, default 0.4) and `max_num_results`
 *     (1–50, default 10) both fit our existing `topK` cap.
 *   - `filters: VectorizeVectorMetadataFilter` — exact-equality and
 *     range filters keyed by metadata field. We'd serialize our
 *     archive `contextId / messageId / role / archivedAt / trigger` as
 *     metadata at upload time so search-time filters work.
 *
 * **Privacy / safety contract preserved**:
 *
 *   - The adapter uploads sanitized archive chunks (text + index_text
 *     produced by  `stripBoilerplate`); no raw `inputPreview` /
 *     `outputPreview` / SOUL / system prompt text crosses the boundary.
 *   - The adapter NEVER reads or returns tool tier-3+ payload fields.
 *   - Snippet windowing on results stays here (server-side); the
 *     adapter returns chunk text + score, the caller still applies
 *     the `snippetCap` window so user-facing output bounds remain
 *     consistent with the local search path.
 */

import type {
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationSearchHit,
} from "./schema";

/**
 * common adapter contract. The local SQL path in
 * `AgentThursdayAgent.conversationSearch` already produces this exact shape;
 * the future adapter wiring just hands the same `input` to whichever
 * implementation `chooseConversationSearchAdapter` returns.
 */
export interface ConversationSearchAdapter {
  /** Stable name for audit logs / telemetry / inspect tab. */
  readonly id: "local-sql" | "cf-ai-search";
  /** Whether `search()` will be available right now. `false` should
   *  cause the caller to fall back to the local-sql adapter. */
  isReady(): boolean;
  /** Unified search entry point. Result shape mirrors the existing
   *  `conversationSearch` callable — retrievalId / hits / filters /
   *  searchedAt. */
  search(input: ConversationSearchInput): Promise<ConversationSearchResult>;
}

/**
 * Thrown when the selected adapter cannot run (binding missing,
 * remote API down, credentials not provisioned). Caller should fall
 * back to `LocalSqlConversationSearchAdapter` (kept in
 * `AgentThursdayAgent.conversationSearch`).
 */
export class AdapterUnavailableError extends Error {
  readonly adapterId: ConversationSearchAdapter["id"];
  readonly missing: ReadonlyArray<string>;
  constructor(adapterId: ConversationSearchAdapter["id"], missing: ReadonlyArray<string>) {
    super(`conversation search adapter "${adapterId}" unavailable: missing ${missing.join(", ")}`);
    this.adapterId = adapterId;
    this.missing = missing;
  }
}

/**
 * The runtime shape of the Cloudflare AI Search bindings. We keep
 * this loose (structural typing on the methods we actually use) so
 * the adapter compiles even when `@cloudflare/workers-types` isn't
 * adding the namespace/instance globals to the project's `Env`. The
 * production binding would be either an `AiSearchNamespace` or an
 * `AiSearchInstance` from `worker-configuration.d.ts` once the card
 * that wires the binding lands.
 */
type AiSearchBindingShape =
  | {
      readonly kind: "namespace";
      get(name: string): AiSearchInstanceLike;
    }
  | {
      readonly kind: "instance";
      readonly instance: AiSearchInstanceLike;
    };

interface AiSearchInstanceLike {
  search(params: {
    query?: string;
    ai_search_options?: {
      retrieval?: {
        retrieval_type?: "vector" | "keyword" | "hybrid";
        match_threshold?: number;
        max_num_results?: number;
        filters?: Record<string, unknown>;
        metadata_only?: boolean;
        return_on_failure?: boolean;
      };
    };
  }): Promise<{
    search_query: string;
    chunks: ReadonlyArray<{
      id: string;
      type: string;
      score: number;
      text: string;
      item: {
        timestamp?: number;
        key: string;
        metadata?: Record<string, unknown>;
      };
    }>;
  }>;
}

/**
 * Spike-only. Implements the adapter contract against CF AI Search;
 * `search()` requires a working binding. When the binding is missing
 * (the expected outcome for this card — AgentThursday prod doesn't have AI
 * Search provisioned yet), `search()` throws
 * `AdapterUnavailableError` and the caller is expected to fall back
 * to the local SQL adapter.
 *
 * This class is **not** instantiated by `AgentThursdayAgent.conversationSearch`
 * yet; it exists so future cards (implementation) can drop in
 * without re-litigating the binding shape.
 */
export class CloudflareAiSearchConversationSearchAdapter implements ConversationSearchAdapter {
  readonly id = "cf-ai-search" as const;
  private readonly binding: AiSearchBindingShape | null;
  private readonly instanceName: string;
  private readonly missing: ReadonlyArray<string>;

  constructor(opts: {
    binding: AiSearchBindingShape | null;
    instanceName: string;
    /** Any binding pre-flight problems the caller wants surfaced
     *  without throwing — e.g. missing wrangler binding, missing
     *  account configuration, pricing not approved. The adapter
     *  echoes them via `AdapterUnavailableError.missing`. */
    missing?: ReadonlyArray<string>;
  }) {
    this.binding = opts.binding;
    this.instanceName = opts.instanceName;
    this.missing = opts.missing ?? [];
  }

  isReady(): boolean {
    return this.binding !== null && this.missing.length === 0;
  }

  async search(input: ConversationSearchInput): Promise<ConversationSearchResult> {
    if (!this.isReady() || this.binding === null) {
      throw new AdapterUnavailableError(this.id, this.missing.length > 0 ? this.missing : ["binding"]);
    }
    const instance = this.binding.kind === "namespace"
      ? this.binding.get(this.instanceName)
      : this.binding.instance;

    const queryRaw = input.query.trim().slice(0, 500);
    const topK = Math.max(1, Math.min(10, Math.floor(input.topK ?? 3)));
    const snippetCap = Math.max(50, Math.min(2000, Math.floor(input.snippetCap ?? 300)));
    const filters: Record<string, unknown> = {};
    if (typeof input.contextId === "string" && input.contextId.length > 0) {
      filters.contextId = input.contextId;
    }
    if (typeof input.role === "string") {
      filters.role = input.role;
    }
    if (typeof input.fromTimestamp === "number" || typeof input.toTimestamp === "number") {
      const range: Record<string, number> = {};
      if (typeof input.fromTimestamp === "number") range.$gte = Math.floor(input.fromTimestamp);
      if (typeof input.toTimestamp === "number") range.$lte = Math.floor(input.toTimestamp);
      filters.archivedAt = range;
    }

    const remote = await instance.search({
      query: queryRaw,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: topK,
          ...(Object.keys(filters).length > 0 ? { filters: filters } : {}),
        },
      },
    });

    const hits: ConversationSearchHit[] = remote.chunks.map((chunk) => {
      const metadata = chunk.item.metadata ?? {};
      const fullText = chunk.text;
      const matchIdx = fullText.toLowerCase().indexOf(queryRaw.toLowerCase());
      let snippet: string;
      if (matchIdx >= 0) {
        const halfWindow = Math.max(20, Math.floor((snippetCap - queryRaw.length) / 2));
        const start = Math.max(0, matchIdx - halfWindow);
        const end = Math.min(fullText.length, matchIdx + queryRaw.length + halfWindow);
        const head = start > 0 ? "…" : "";
        const tail = end < fullText.length ? "…" : "";
        snippet = `${head}${fullText.slice(start, end)}${tail}`;
      } else {
        snippet = fullText.length > snippetCap ? `${fullText.slice(0, snippetCap)}…` : fullText;
      }
      if (snippet.length > snippetCap) snippet = `${snippet.slice(0, snippetCap)}…`;
      return {
        chunkId: chunk.id,
        contextId: typeof metadata.contextId === "string" ? metadata.contextId : "",
        messageId: typeof metadata.messageId === "string" ? metadata.messageId : null,
        messageIndex: typeof metadata.messageIndex === "number" ? metadata.messageIndex : null,
        role: typeof metadata.role === "string" ? metadata.role : null,
        trigger: typeof metadata.trigger === "string" ? metadata.trigger : "ai-search",
        archivedAt: typeof metadata.archivedAt === "number"
          ? metadata.archivedAt
          : (chunk.item.timestamp ?? 0),
        snippet,
        matchReason: matchIdx >= 0 ? "vector_text_match" : "vector_metadata_match",
        isSyntheticCompaction: metadata.isSyntheticCompaction === true,
      };
    });

    return {
      ok: true,
      retrievalId: `ret_aisearch_${Date.now().toString(36)}`,
      query: queryRaw,
      topK,
      snippetCap,
      hits,
      resultCount: hits.length,
      searchedAt: Date.now(),
      filters: {
        contextId: typeof input.contextId === "string" ? input.contextId : null,
        fromTimestamp: typeof input.fromTimestamp === "number" ? input.fromTimestamp : null,
        toTimestamp: typeof input.toTimestamp === "number" ? input.toTimestamp : null,
        role: input.role ?? null,
      },
    };
  }
}

/**
 * capability/blocked report. Returns the adapter the
 * worker should use today plus a list of blocked items so callers
 * (and the inspect tab) can show "AI Search ready" vs "fall back
 * to local SQL — these are the missing pieces". Returning `null`
 * means "no remote adapter ready; caller should keep its local SQL
 * path". The local SQL path is the fallback (the existing
 * `AgentThursdayAgent.conversationSearch` SQL/LIKE branch); this spike does
 * NOT rewire the call site, only documents how the choice would be
 * made when the wiring lands.
 */
export function chooseConversationSearchAdapter(env: {
  AI_SEARCH?: unknown;
  CONVERSATION_SEARCH?: unknown;
}): {
  remote: CloudflareAiSearchConversationSearchAdapter | null;
  blocked: ReadonlyArray<string>;
} {
  const namespaceBinding = env.AI_SEARCH ?? null;
  const singleInstanceBinding = env.CONVERSATION_SEARCH ?? null;
  const blocked: string[] = [];

  if (singleInstanceBinding && typeof (singleInstanceBinding as { search?: unknown }).search === "function") {
    const remote = new CloudflareAiSearchConversationSearchAdapter({
      binding: { kind: "instance", instance: singleInstanceBinding as AiSearchInstanceLike },
      instanceName: "agent-thursday-conversation",
    });
    return { remote, blocked: [] };
  }
  if (namespaceBinding && typeof (namespaceBinding as { get?: unknown }).get === "function") {
    const remote = new CloudflareAiSearchConversationSearchAdapter({
      binding: {
        kind: "namespace",
        get: (name: string) => (namespaceBinding as { get(n: string): AiSearchInstanceLike }).get(name),
      },
      instanceName: "agent-thursday-conversation",
    });
    return { remote, blocked: [] };
  }
  if (!singleInstanceBinding && !namespaceBinding) {
    blocked.push("wrangler binding (env.AI_SEARCH namespace or env.CONVERSATION_SEARCH instance) not configured");
  }
  return { remote: null, blocked };
}
