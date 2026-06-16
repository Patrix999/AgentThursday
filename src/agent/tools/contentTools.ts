/**
 *  —  `getTools()` family extraction step 3: content
 * family G (`content_sources`, `content_list`, `content_read`,
 * `content_search`).
 *
 * Per  preflight §4 split order this is the third step — four
 * tools with one shared dance ( per-task read-budget +
 * `read_budget.warning` event on `content_read`). All four tools talk
 * to the ContentHub DO via `getAgentByName(env.ContentHubAgent,
 * CONTENT_HUB_INSTANCE)`; nothing here touches caller-DO state beyond
 * what the Host exposes.
 *
 *  §6 risk 3 — `_currentTaskReadBudget` identity stays on
 * `AgentThursdayAgent`. The Host exposes `recordContentRead(sizeBytes)` which
 * does the per-task reset + increment + returns the current counters
 * back to the tool, so the warning event payload can include them.
 * Returns `null` when there is no current task id, which keeps the
 * original "no taskId → skip accumulation, still emit warning with
 * null counters" semantics from server.ts:1228-1257 (pre-).
 *
 * `SOURCE_READ_LARGE_THRESHOLD_BYTES` is left in `agent/agentConstants.ts`
 * (not moved into this module) because
 * `scripts/-source-read-budget-smoke.ts` reads it by name from
 * that location to keep the YAML/runtime threshold pair from drifting.
 * Moving it would silently break the smoke.  §6 risk 3
 * suggested co-locating but did not require it.
 *
 * Tool names, descriptions, Zod input schemas, event names + payload
 * shapes, the  traceId propagation, and the ContentHub RPC
 * call payloads are preserved verbatim from `src/server.ts:1161-1316`
 * (pre-).
 */

import { tool } from "ai";
import { z } from "zod";
import { getAgentByName } from "agents";
import type { AgentNamespace } from "agents";
import { ContentHubAgent, CONTENT_HUB_INSTANCE } from "../../contentHub";
import { SOURCE_READ_LARGE_THRESHOLD_BYTES } from "../agentConstants";

export interface ContentToolHost {
  env: Env;
  logEvent: (type: string, payload: unknown) => void;
  /**
   * Current task id (if any) at execute-time. Lifted to a getter
   * because `currentTaskObject` changes over the agent's lifetime;
   * capturing once at Host construction would freeze a stale id.
   * Returns `null` (not `undefined`) to match the original
   * `this.agentthursdayState.currentTaskObject?.id ?? null` shape forwarded
   * into the ContentHub callable's `traceId` argument.
   */
  getTraceId: () => string | null;
  /**
   *  budget bookkeeping. The accumulator lives on
   * `AgentThursdayAgent._currentTaskReadBudget`; this callback handles the
   * per-task reset + readCount/readBytes increment and returns the
   * current counters for the warning event payload.
   *
   * Returns `null` when there is no current task id (matches the
   * pre- behavior where the warning event still fires but
   * `readCount`/`readBytes` come through as `null`).
   */
  recordContentRead: (sizeBytes: number) => { readCount: number; readBytes: number } | null;
}

async function resolveContentHub(env: Env) {
  // Return type is `DurableObjectStub<ContentHubAgent>` (RPC stub),
  // not the class itself — left to inference to match the inline
  // `getAgentByName<...>` usage at server.ts route-side call sites.
  return await getAgentByName<Env, ContentHubAgent>(
    env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
    CONTENT_HUB_INSTANCE,
  );
}

export function buildContentTools(host: ContentToolHost) {
  const { env, logEvent, getTraceId, recordContentRead } = host;
  return {
    // ── ContentHub external source tools ──────────────
    // These are NOT Tier 0 workspace tools. They access **external**
    // Content Sources (currently only `agentthursday-github`) via the
    // ContentHubAgent DO.  SOUL prompt covers usage rules;
    //  will add `content_search`.
    content_sources: tool({
      description: "List the external Content Sources currently registered (e.g. agentthursday-github). Use this when you need to discover which sources are available before reading. NOT a Tier 0 workspace tool — for your own scratch files use `read`/`list`.",
      inputSchema: z.object({
        includeHealth: z.boolean().optional().describe("Include each source's health snapshot (default true)."),
      }),
      execute: async (input) => {
        logEvent("tool.content_sources", { includeHealth: input.includeHealth ?? true });
        const stub = await resolveContentHub(env);
        //  — propagate the current task id as audit trace id so
        // ContentHubAgent.audit_log rows can be correlated with the
        // AgentThursdayAgent event_log task.submitted entry that triggered them.
        const traceId = getTraceId();
        return await stub.getSources({ includeHealth: input.includeHealth }, traceId);
      },
    }),
    content_list: tool({
      description: "List a directory in an external Content Source by sourceId + path. Empty path returns the source's allowed top-level entries. Returns ContentRef provenance (sourceId, path, revision). Use this to browse the AgentThursday repo via `agentthursday-github`.",
      inputSchema: z.object({
        sourceId: z.string().describe("Content source id (e.g. 'agentthursday-github')."),
        path: z.string().describe("Path within the source. '' or '/' for the synthetic top-level."),
        ref: z.string().optional().describe("Branch/tag/commit (defaults to source's defaultRef)."),
      }),
      execute: async (input) => {
        logEvent("tool.content_list", { sourceId: input.sourceId, pathPreview: input.path.slice(0, 80) });
        const stub = await resolveContentHub(env);
        const traceId = getTraceId();
        return await stub.list({ sourceId: input.sourceId, path: input.path, ref: input.ref }, traceId);
      },
    }),
    content_read: tool({
      description: "Read one file from an external Content Source by sourceId + path. Returns content + ContentRef (sourceId/path/revision/cacheStatus). Default 256KB cap; truncated:true means you saw a prefix only — narrow the path or raise maxBytes. Always cite the returned revision in summaries.",
      inputSchema: z.object({
        sourceId: z.string().describe("Content source id (e.g. 'agentthursday-github')."),
        path: z.string().describe("File path within the source (e.g. 'src/server.ts')."),
        ref: z.string().optional().describe("Branch/tag/commit (defaults to source's defaultRef)."),
        maxBytes: z.number().int().positive().max(1024 * 1024).optional().describe("Override read cap; default 256KB, hard ceiling 1MB."),
      }),
      execute: async (input) => {
        logEvent("tool.content_read", { sourceId: input.sourceId, pathPreview: input.path.slice(0, 80), maxBytes: input.maxBytes ?? null });
        const stub = await resolveContentHub(env);
        const traceId = getTraceId();
        const response = await stub.read({ sourceId: input.sourceId, path: input.path, ref: input.ref, maxBytes: input.maxBytes }, traceId);
        if (response.ok) {
          const content = response.result.content;
          const sizeBytes = response.result.size;
          const truncated = response.result.truncated === true;
          logEvent("tool.content_read.result", {
            sourceId: input.sourceId,
            pathPreview: input.path.slice(0, 80),
            maxBytes: input.maxBytes ?? null,
            sizeBytes,
            lineCount: content.length === 0 ? 0 : content.split("\n").length,
            truncated,
            truncatedBytes: response.result.truncatedBytes ?? null,
            redactionsCount: response.result.redactions?.length ?? 0,
          });
          //  — per-task accumulator + large/truncated warning.
          // Skip accumulation if no task id (warning still fires).
          const budget = recordContentRead(sizeBytes);
          const isLarge = sizeBytes > SOURCE_READ_LARGE_THRESHOLD_BYTES;
          if (isLarge || truncated) {
            const reason = isLarge && truncated
              ? "large_read_and_truncated"
              : truncated
                ? "truncated"
                : "large_read";
            logEvent("read_budget.warning", {
              sourceId: input.sourceId,
              pathPreview: input.path.slice(0, 80),
              maxBytes: input.maxBytes ?? null,
              sizeBytes,
              truncated,
              readCount: budget?.readCount ?? null,
              readBytes: budget?.readBytes ?? null,
              reason,
            });
          }
        } else {
          logEvent("tool.content_read.result", {
            sourceId: input.sourceId,
            pathPreview: input.path.slice(0, 80),
            maxBytes: input.maxBytes ?? null,
            ok: false,
            errorCode: response.error.code,
          });
        }
        return response;
      },
    }),
    // ── ContentHub literal search ────────────────────
    // Default `api-search` strategy uses GitHub Code Search and is
    // fail-loud on quota exhaustion: error.code="quota-exhausted" with
    // fallbackAvailable=true and a hint to retry with `bounded-local`.
    // The framework MUST NOT auto-degrade per ADR §7.1 — agent opts in
    // explicitly with `strategy:"bounded-local"` if it wants partial
    // coverage from cached/listed content.
    content_search: tool({
      description: "Search Content Source(s) for a literal pattern. Provide EITHER `sourceId` (single source, hits in `result.hits[]`) OR `sourceIds: string[]` ( multi-source fan-out, results grouped in `result.perSource[]` with per-source `ok/hits/errorCode/latencyMs`; top-level `hits` is empty stub in this mode). Sources whose `capabilities.search` is not true (e.g. `local-fs`) return per-source `errorCode:\"capability-not-supported\"` rather than silently skipping. Default strategy `api-search` uses GitHub Code Search (fail-loud on quota — see error.fallbackHint). Pass `strategy:'bounded-local'` for a degraded grep over cached/listed content; the result then carries `searchMode:'degraded-grep'` + `searchCoverage:'partial'` + `searchedPaths` + `omittedReason` and MUST NOT be cited as authoritative. Hits include path, revision, line (when known), and a preview snippet.",
      inputSchema: z.object({
        sourceId: z.string().min(1).optional().describe("Single-source mode: id of the Content Source (e.g. 'agentthursday-github'). Mutually exclusive with `sourceIds`."),
        sourceIds: z.array(z.string().min(1)).min(1).max(10).optional().describe("Multi-source fan-out mode: list of source ids to query in parallel. Mutually exclusive with `sourceId`. Results grouped by source in `result.perSource[]`."),
        query: z.string().min(1).max(500).describe("Literal pattern to search for. v1 is literal, not regex."),
        path: z.string().max(1024).optional().describe("Restrict search to this path prefix (optional)."),
        ref: z.string().min(1).max(200).optional().describe("Branch/tag/commit (defaults to source's defaultRef). Note: GitHub Code Search itself only indexes the default branch in practice; non-default ref affects ContentRef provenance, not search scope."),
        strategy: z.enum(["api-search", "bounded-local"]).optional().describe("Default `api-search`. Use `bounded-local` only when explicitly opting into degraded coverage."),
        maxResults: z.number().int().positive().max(100).optional().describe("Hard cap on hits returned per source; default 30."),
      }).refine(
        d => (d.sourceId !== undefined) !== ((d.sourceIds ?? []).length > 0),
        { message: "must provide exactly one of `sourceId` (single) or `sourceIds` (multi)" },
      ),
      execute: async (input) => {
        logEvent("tool.content_search", {
          mode: input.sourceId !== undefined ? "single" : "multi",
          sourceId: input.sourceId ?? null,
          sourceIdsCount: input.sourceIds?.length ?? null,
          queryPreview: input.query.slice(0, 80),
          pathPreview: input.path?.slice(0, 80) ?? null,
          strategy: input.strategy ?? "api-search",
          maxResults: input.maxResults ?? null,
        });
        const stub = await resolveContentHub(env);
        const traceId = getTraceId();
        return await stub.search({
          sourceId: input.sourceId,
          sourceIds: input.sourceIds,
          query: input.query,
          path: input.path,
          ref: input.ref,
          strategy: input.strategy,
          maxResults: input.maxResults,
        }, traceId);
      },
    }),
  };
}
