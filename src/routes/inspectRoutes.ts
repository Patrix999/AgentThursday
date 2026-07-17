import { getAgentByName } from "agents";
import { AGENT_MEMORY_OPERATOR_PROFILE, cfMemoryListRecent } from "../agent/agentMemoryShadow";
import { OPERATOR_INSTANCE } from "../demoConstants";
import { json } from "../httpUtil";
import {
  InspectSnapshotSchema,
  type InspectSnapshot,
  type ContentAuditSummary,
} from "../schema";
import type { AgentThursdayAgent } from "../server";
import type { ChannelHubAgent } from "../channelHub";
import type { ContentHubAgent } from "../contentHub";
import { resolveAgentLifecycle } from "../agent/agentLifecycleView";
// registry workflow feed rows → intents merge.
import { buildActionUiIntents } from "../actionUiIntents";
// named workflow descriptor summaries for the inspect list.
import { summarizeDescriptorRow } from "../agent/workflowNamed";
import {
  validateWorkflowDescriptor,
  deriveExecutorRunId,
} from "../agent/workflowDescriptor";

/**
 * `/api/inspect/*` GET routes extracted from `server.ts`.
 *
 * Single entry point: `handleApiInspect(request, url, deps)`.
 *
 * Scope is read-only GET inspect surfaces only:
 *
 *   GET  /api/inspect
 *   GET  /api/inspect/skillset
 *   GET  /api/inspect/skillset/detail
 *   GET  /api/inspect/skillset/agent-tools
 *   GET  /api/inspect/skillset/tools
 *   GET  /api/inspect/tool/<id>
 *   GET  /api/inspect/observability
 *   GET  /api/inspect/evidence
 *   GET  /api/inspect/evidence/<id>
 *   GET  /api/inspect/outbox
 *   GET  /api/inspect/outbox/<id>
 *   GET  /api/inspect/approvals
 *   GET  /api/inspect/approvals/<id>
 *   GET  /api/inspect/patch-artifacts
 *   GET  /api/inspect/patch-artifacts/<id>
 *   GET  /api/inspect/patch-apply-events
 *   GET  /api/inspect/patch-apply-events/<id>
 *   GET  /api/inspect/patch-apply-outbox
 *   GET  /api/inspect/patch-apply-outbox/<id>
 *
 * POST routes under `/api/inspect/*` (write surfaces: approvals/request,
 * approvals/decide, approvals/replay-consume, patch-artifacts/propose,
 * patch-artifacts/apply-dry-run) intentionally stay in `server.ts`; this
 * card's scope is read-only inspect routes only.
 *
 * Returns `null` when no inspect-GET branch matches so `server.ts` can
 * fall through to subsequent route handlers (e.g. POST inspect routes,
 * `/api/dev-shell/write`, etc.).
 *
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `InspectDeps` factories so this module never imports
 * `getCanonicalActiveAgentThursdayAgentStub` / `DEMO_INSTANCE` / `CHANNEL_HUB_INSTANCE`
 * / `CONTENT_HUB_INSTANCE`.
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts`. This handler
 * never re-checks.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;
type ChannelHubAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, ChannelHubAgent>>>;
type ContentHubAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, ContentHubAgent>>>;

export interface InspectDeps {
  env: Env;
  getAgentThursdayStub: () => Promise<AgentThursdayAgentStub>;
  getChannelHubStub: () => Promise<ChannelHubAgentStub>;
  getContentHubStub: () => Promise<ContentHubAgentStub>;
  // `/api/inspect/agents` needs the registry DO (where
  // AgentProfile rows + `manager.task.*` event_log live), distinct
  // from the canonical-active context DO. Composition root injects
  // both stubs so this module never imports `DEMO_INSTANCE`.
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  // the resolved canonical context DO name (== agent_id for
  // per-agent DOs, an earlier revision) so the workflow feed can be scoped to the
  // agent whose snapshot this is.
  getCanonicalContextName: () => Promise<string>;
  // the operator's own DO (A1 Phase 2 migration target),
  // injected at the composition root so this module never imports
  // OPERATOR_INSTANCE.
  getOperatorStub: () => Promise<AgentThursdayAgentStub>;
}

export async function handleApiInspect(
  request: Request,
  url: URL,
  deps: InspectDeps,
): Promise<Response | null> {
  // orchestration-as-code executor trigger. POST a validated
  // descriptor; mint an executor-owned run_id (`wfr-exec-<short-id>`,
  // distinct from an earlier revision's `wfr-<parent_task_id>`); start the
  // WorkflowExecutor CF Workflow (durable run handle). Handled BEFORE the
  // GET-only guard below. Auth: umbrella `requireSecret` in server.ts.
  // trigger a memory consolidation pass (LLM extraction →
  // promote). Operator-only (inspect gate); the agent enforces operator-first
  // WRITE vs scoped-user dry_run. No agent_id → active agent. Must be matched
  // before the `method !== "GET"` short-circuit below.
  if (request.method === "POST" && url.pathname === "/api/inspect/memory/consolidate") {
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    // optional `since_turn` lets an operator exercise the
    // incremental-extraction slice (extract only turns after this index), the same
    // path the end-of-turn auto-trigger uses with the persisted watermark.
    const sinceRaw = url.searchParams.get("since_turn");
    const sinceTurnCount = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    // optional `parent_task_id` (subagent role → PUSH own promoted
    // insights up) / `task_id` (parent role → INGEST subagent insights pushed
    // under it) so the collective-memory promotion path is operator-drivable.
    const parentTaskId = url.searchParams.get("parent_task_id");
    const taskId = url.searchParams.get("task_id");
    const result = await perAgent.consolidateMemories({
      ...(sinceTurnCount !== undefined ? { sinceTurnCount } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(taskId ? { taskId } : {}),
    });
    return json({ generated_at: new Date().toISOString(), since_turn: sinceTurnCount ?? null, ...result });
  }

  // A1 Phase 2 M1: drive the operator archive migration
  // (registry → operator DO). COPY-never-move; idempotent (destination
  // ingest is ON CONFLICT DO NOTHING); resumable (starts from the
  // destination's max chunk_id watermark). Operator-only (inspect gate).
  // Body/query: batch_size (default 200), max_batches (default 5, so one
  // call stays well inside the sync envelope; call repeatedly until
  // done=true). GET /operator-archive-reconcile compares both sides.
  // an earlier revision Phase 0 — FTS5 availability probe (scratch virtual table on the
  // resolved DO; `?agent_id=` targets a specific agent DO). Read-only-ish.
  if (request.method === "GET" && url.pathname === "/api/inspect/fts5-probe") {
    // Canonical-active resolution (honors `?agent_id=` / context headers) —
    // NOT the fixed registry stub, so the probe runs on the DO you target.
    const stub = await deps.getAgentThursdayStub();
    const result = await stub.fts5Probe();
    return json({ ok: true, ...result });
  }

  // drive the FTS backfill on the resolved DO (`?batches=N`,
  // capped server-side). POST because it writes index rows.
  if (request.method === "POST" && url.pathname === "/api/inspect/fts-backfill") {
    const batchesRaw = url.searchParams.get("batches");
    const batches = batchesRaw !== null && /^\d+$/.test(batchesRaw) ? Number(batchesRaw) : 10;
    const stub = await deps.getAgentThursdayStub();
    const result = await stub.ftsBackfillAdvance(batches);
    return json({ ok: true, ...result });
  }

  // operator view of ALL scheduled tasks (unscoped read; the
  // /api/* secret gate already ran). Read-only.
  if (request.method === "GET" && url.pathname === "/api/inspect/schedules") {
    const registry = await deps.getRegistryStub();
    const rows = await registry.listScheduledTaskRows({});
    return json({ ok: true, now: new Date().toISOString(), schedules: rows });
  }

  if (request.method === "POST" && url.pathname === "/api/inspect/operator-archive-migrate") {
    const batchSizeRaw = url.searchParams.get("batch_size");
    const maxBatchesRaw = url.searchParams.get("max_batches");
    const batchSize = batchSizeRaw !== null && /^\d+$/.test(batchSizeRaw) ? Math.min(Number(batchSizeRaw), 500) : 200;
    const maxBatches = maxBatchesRaw !== null && /^\d+$/.test(maxBatchesRaw) ? Math.min(Number(maxBatchesRaw), 50) : 5;
    const registry = await deps.getRegistryStub();
    const operator = await deps.getOperatorStub();
    // Resume from the destination watermark: batches are chunk_id-ordered,
    // so everything <= operator max_chunk_id is already copied.
    const before = await operator.getArchiveReconcileSummary();
    let after: string | null = before.max_chunk_id;
    let batches = 0;
    let sent = 0;
    let done = false;
    for (let i = 0; i < maxBatches; i++) {
      const batch = await registry.readOperatorArchiveBatch({ after_chunk_id: after, limit: batchSize });
      if (batch.length === 0) { done = true; break; }
      await operator.ingestOperatorArchiveBatch({ chunks: batch });
      after = batch[batch.length - 1].chunk_id;
      batches += 1;
      sent += batch.length;
    }
    const operatorSummary = await operator.getArchiveReconcileSummary();
    const registrySummary = await registry.getArchiveReconcileSummary();
    return json({
      generated_at: new Date().toISOString(),
      batch_size: batchSize,
      batches_run: batches,
      chunks_sent: sent,
      done,
      registry: registrySummary,
      operator: operatorSummary,
    });
  }

  // A1 Phase 2 M2: merge one source surface's ACTIVE memories into
  // the operator DO through the an earlier revision dedup pipeline (overlap between the
  // registry DO and the legacy ctx_ DO dedupes instead of duplicating).
  // `?from=<agent_id>` names the source; run once per source. Also compares
  // the two sides' knowledge keys (seeded rows are expected identical).
  if (request.method === "POST" && url.pathname === "/api/inspect/operator-memory-migrate") {
    const from = url.searchParams.get("from");
    if (!from) return json({ ok: false, code: "missing_param", expected: "from=<agent_id>" }, 400);
    const source = await getAgentByName<Env, AgentThursdayAgent>(
      (deps.env as unknown as { AgentThursdayAgent: unknown })
        .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
      from,
    );
    const operator = await deps.getOperatorStub();
    const { items } = await source.listMemoriesEntries({ activeOnly: true, limit: 100 });
    const candidates = items.map(m => ({
      type: m.type,
      content: m.content,
      // Existing rows may carry NULL confidence (pre-448 writes); default to
      // 0.9 so a real memory is never dropped by the promote threshold.
      confidence: m.confidence ?? 0.9,
      reason: "migration",
      source: m.source,
    }));
    const result = await operator.ingestMigratedMemories({ candidates, from_agent_id: from });
    const [srcLayers, opLayers] = await Promise.all([source.getMemoryLayers(), operator.getMemoryLayers()]);
    const srcKeys = srcLayers.knowledge.map(k => k.key).sort();
    const opKeys = opLayers.knowledge.map(k => k.key).sort();
    return json({
      generated_at: new Date().toISOString(),
      from,
      source_active_memories: items.length,
      ...result,
      knowledge: {
        source_keys: srcKeys,
        operator_keys: opKeys,
        keys_covered: srcKeys.every(k => opKeys.includes(k)),
      },
    });
  }

  // operator routing cutover / rollback. Data-only lever: makes
  // `?target=` switch-routable (idempotent history-row insert) then flips the
  // registry's `context_active` pointer via the existing switchContext.
  // Both console header-less and Discord unbound routing follow this pointer,
  // so one call moves both surfaces; calling with the previous ctx_ id is the
  // rollback. Operator-only (inspect gate).
  if (request.method === "POST" && url.pathname === "/api/inspect/operator-route-cutover") {
    const target = url.searchParams.get("target");
    if (!target) return json({ ok: false, code: "missing_param", expected: "target=<context_id>" }, 400);
    const reason = url.searchParams.get("reason") ?? "card451c operator routing cutover";
    const registry = await deps.getRegistryStub();
    await registry.ensureContextHistoryRow({ contextId: target, reason });
    const result = await registry.switchContext({ contextId: target, reason });
    return json({ generated_at: new Date().toISOString(), ...result });
  }

  // one-time lineage backfill (admin maintenance; secret-gated).
  if (request.method === "POST" && url.pathname === "/api/inspect/agent-lineage-backfill") {
    let body: { assignments?: { agent_id: string; parent_agent_id: string }[] };
    try { body = await request.json(); } catch { return json({ ok: false, code: "invalid_json" }, 400); }
    if (!Array.isArray(body.assignments) || body.assignments.length === 0 || body.assignments.length > 200) {
      return json({ ok: false, code: "bad_assignments", expected: "assignments: [{agent_id, parent_agent_id}] (1-200)" }, 400);
    }
    const registry = await deps.getRegistryStub();
    const result = await registry.backfillAgentLineage({ assignments: body.assignments });
    return json({ generated_at: new Date().toISOString(), ...result });
  }

  // spawned-agent lifecycle sweep (archive idle spawned agents).
  // Params: days (default 7), legacy=1 (include pre-472 durable spawned),
  // dry=1 (list only). Secret-gated admin maintenance.
  if (request.method === "POST" && url.pathname === "/api/inspect/agent-lifecycle-sweep") {
    const days = Number(url.searchParams.get("days") ?? "7");
    const includeLegacy = url.searchParams.get("legacy") === "1";
    const dryRun = url.searchParams.get("dry") === "1";
    const excludeIds = (url.searchParams.get("exclude") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const registry = await deps.getRegistryStub();
    const result = await registry.sweepSpawnedAgents({ olderThanDays: days, includeLegacy, dryRun, excludeIds });
    return json({ generated_at: new Date().toISOString(), ...result });
  }

  // read-only archive-chunk pager (the CF Agent Memory shadow
  // pilot's corpus export). Reuses the 451b batch reader; secret-gated like
  // every /api/inspect surface. `agent_id` picks the DO (default: operator).
  if (request.method === "GET" && url.pathname === "/api/inspect/operator-archive-chunks") {
    const agentIdParam = url.searchParams.get("agent_id");
    const stub = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getOperatorStub();
    const after = url.searchParams.get("after");
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 100;
    const chunks = await stub.readOperatorArchiveBatch({ after_chunk_id: after, limit });
    return json({
      generated_at: new Date().toISOString(),
      agent_id: agentIdParam ?? null,
      count: chunks.length,
      next_after: chunks.length > 0 ? chunks[chunks.length - 1].chunk_id : null,
      chunks,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/inspect/operator-archive-reconcile") {
    const registry = await deps.getRegistryStub();
    const operator = await deps.getOperatorStub();
    const registrySummary = await registry.getArchiveReconcileSummary();
    const operatorSummary = await operator.getArchiveReconcileSummary();
    return json({
      generated_at: new Date().toISOString(),
      registry: registrySummary,
      operator: operatorSummary,
      counts_match: registrySummary.total === operatorSummary.total,
    });
  }

  // 2026-06-27 — operator memory-prune lever (the missing counterpart to consolidate,
  // which only ADDs). `?id=<n>` forgets one memory; `?all=1` forgets all active. Soft
  // delete (active=0), auditable. Operator-only (inspect gate). No agent_id → active agent.
  if (request.method === "POST" && url.pathname === "/api/inspect/memory/forget") {
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const allRaw = url.searchParams.get("all");
    if (allRaw === "1" || allRaw === "true") {
      const result = await perAgent.forgetAllMemories({ reason: "operator reset (re-consolidate)" });
      return json({ generated_at: new Date().toISOString(), mode: "all", ...result });
    }
    const idRaw = url.searchParams.get("id");
    if (idRaw !== null && /^\d+$/.test(idRaw)) {
      const result = await perAgent.forgetMemory({ id: Number(idRaw), reason: "operator forget" });
      return json({ generated_at: new Date().toISOString(), mode: "one", ...result });
    }
    return json({ ok: false, code: "missing_param", expected: ["id=<n>", "all=1"] }, 400);
  }

  // DIAGNOSTIC (2026-06-30) — directly run the tool-result truncation pass on an
  // agent's assistant_messages (verifies the mechanism + one-time cleanup).
  if (request.method === "POST" && url.pathname === "/api/inspect/compact-messages") {
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const result = await perAgent.compactToolResults();
    return json({ generated_at: new Date().toISOString(), agent_id: agentIdParam, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/inspect/workflow-runs/execute") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ ok: false, code: "invalid_json", message: "body is not valid JSON" }, 400);
    }
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const validation = validateWorkflowDescriptor(body.descriptor);
    if (!validation.ok) {
      return json({ ok: false, code: "validation_failed", errors: validation.errors }, 400);
    }
    const runId = deriveExecutorRunId(crypto.randomUUID().slice(0, 8));
    const wf = (deps.env as unknown as {
      WORKFLOW_EXECUTOR: { create: (o: { id: string; params: unknown }) => Promise<{ id: string }> };
    }).WORKFLOW_EXECUTOR;
    const instance = await wf.create({
      id: runId,
      params: { run_id: runId, descriptor: validation.descriptor },
    });
    return json(
      {
        ok: true,
        run_id: runId,
        status: "started",
        workflow_instance_id: instance.id,
        descriptor: {
          descriptor_id: validation.descriptor.descriptor_id,
          name: validation.descriptor.name,
          phases: validation.descriptor.phases.length,
          total_agents: validation.total_agents,
          order: validation.order,
        },
        inspect_url: `/api/inspect/workflow-runs/${runId}`,
      },
      202,
    );
  }

  if (request.method !== "GET") return null;

  if (url.pathname === "/api/inspect") {
    // route the AgentThursdayAgent stub through the canonical
    // active context so trace / toolEvents / ladder / memory tabs
    // reflect the same DO that `/api/workspace` and `/cli/status`
    // already read from. Without this, inspect was hardcoded to
    // DEMO_INSTANCE and the user saw a stale registry/bootstrap DO
    // event_log even though their session lived elsewhere.
    // ContentHub (cross-DO) stays as before — it's a separate
    // observability layer with its own audit log.
    const stub = await deps.getAgentThursdayStub();
    const snapshot: InspectSnapshot = await stub.getInspectSnapshot();
    // an earlier revision — best-effort cross-DO fetches against ContentHubAgent.
    // Both `contentAudit` (raw rows) and `contentEvidence` (an earlier revision
    // aggregated summary) are observability layers; failure must not
    // break the AgentThursdayAgent snapshot or each other.
    let contentAudit: Array<{ type: string; at: number; payload: unknown; traceId: string | null }> = [];
    let contentEvidence: ContentAuditSummary | undefined;
    try {
      const hub = await deps.getContentHubStub();
      try { contentAudit = await hub.getRecentAuditEvents({ limit: 100 }); }
      catch { /* ignore — return snapshot without contentAudit */ }
      try { contentEvidence = await hub.getContentEvidence(); }
      catch { /* ignore — return snapshot without contentEvidence */ }
    } catch { /* ignore — DO unreachable */ }
    // workflow-era activity lives on the registry DO
    // (workflow.run.* + executor-dispatched manager.task terminal
    // rows), not the active-context DO. Merge fail-soft so the feed
    // shows runs/subagents alongside the agent's own tool activity.
    let workflowIntents: NonNullable<InspectSnapshot["actionUiIntents"]> = [];
    try {
      const registry = await deps.getRegistryStub();
      // scope the feed to this snapshot's agent. The
      // registry/default context (operator console) keeps the global
      // view; per-agent DO names look like `agent-<uuid>`.
      const ctxName = await deps.getCanonicalContextName();
      const rows = await registry.readRecentWorkflowFeedRows(
        ctxName.startsWith("agent-") ? { agentId: ctxName } : undefined,
      );
      workflowIntents = buildActionUiIntents(rows, { intentLimit: 15 });
    } catch { /* ignore — feed shows local intents only */ }
    const mergedIntents = [...(snapshot.actionUiIntents ?? []), ...workflowIntents]
      .sort((a, b) => b.sourceEventAt - a.sourceEventAt)
      .slice(0, 30);
    const merged: InspectSnapshot = {
      ...snapshot,
      contentAudit,
      ...(contentEvidence ? { contentEvidence } : {}),
      ...(mergedIntents.length > 0 ? { actionUiIntents: mergedIntents } : {}),
    };
    return json(InspectSnapshotSchema.parse(merged));
  }

  // read-only loader state for the static skillset
  // loader. Pure (no DO state); recomputed per request from the
  // embedded manifests so the inspect view always reflects the
  // currently deployed worker's view. V2 (tool_id ∈ contract
  // registry) is checked against the 183 contract registry so
  // `research-stub` is discoverable but reported as `load_rejected`
  // until 183+ lands real web/pdf contracts.
  if (url.pathname === "/api/inspect/skillset") {
    const { loadSkillsets, summarizeLoaderState } = await import("../skillset/loader");
    const { STUB_KNOWN_TOOL_IDS } = await import("../skillset/contractRegistry");
    const { loadMergedManifests } = await import("../agent/agentProfileValidation");
    // Operator console — merge custom skillsets (admin: all, no owner scope) so
    // agent-authored skillsets show alongside embedded, not embedded-only.
    const merged = await loadMergedManifests(await deps.getRegistryStub());
    return json(summarizeLoaderState(loadSkillsets(merged, { knownToolIds: STUB_KNOWN_TOOL_IDS })));
  }

  // per-skill inspect detail. Read-only. Walks every
  // loaded manifest and projects each skill into a provider-neutral
  // shape (id, name, tier, tools, capability_class default
  // "unspecified", prompt_segment_present boolean, pass-through
  // source_ref / evidence_requirements). Auth-gated by the global
  // `/api/*` secret check above; no separate gate, no hardcoded
  // manifest id.
  //
  // capability-class downgrade. Generic: when a skill's
  // `source_ref` declares an `env_binding` (string) and the worker
  // env does not have a non-empty value at that binding, the
  // inspect surface downgrades the skill's `capability_class` to
  // `callable_tool_no_secret`. This keeps the loader pure (no env
  // access there) while letting verifiers see runtime readiness.
  if (url.pathname === "/api/inspect/skillset/detail") {
    const {
      loadSkillsets,
      summarizeLoaderDetail,
      downgradeCapabilityClassByEnvBinding,
    } = await import("../skillset/loader");
    const { STUB_KNOWN_TOOL_IDS } = await import("../skillset/contractRegistry");
    const { loadMergedManifests } = await import("../agent/agentProfileValidation");
    const merged = await loadMergedManifests(await deps.getRegistryStub());
    const detail = summarizeLoaderDetail(
      loadSkillsets(merged, { knownToolIds: STUB_KNOWN_TOOL_IDS }),
    );
    const envRecord = deps.env as unknown as Record<string, unknown>;
    downgradeCapabilityClassByEnvBinding(detail, (binding) => {
      const value = envRecord[binding];
      return typeof value === "string" ? value : undefined;
    });
    return json(detail);
  }

  // agent-facing dynamic tool binding proof. Read-only.
  // Returns the same mapper input the agent's `getTools()` consumes
  // (loaded detail + downgrade) projected to a verifier-readable
  // shape: `ai_sdk_name`, canonical `tool_id`, originating
  // `skillset_id` / `skill_id`, composed `description`, and
  // `has_handler` (true means dispatch registry resolved). Auth-
  // gated via the global `/api/*` requireSecret.
  //
  // when `?agent_id=<id>` is supplied, route through
  // that per-agent DO's `getSkillsetRuntimeSummary()` so verifier
  // evidence can see the per-agent dynamic tool surface (incl.
  // custom-skillset narrowing). Without the param the route keeps
  // its prior behavior: canonical-active stub via `getAgentThursdayStub`,
  // matching the an earlier revision invariant that agent-surface inspect
  // routes through `AgentThursdayAgent.getSkillsetRuntimeSummary()`.
  if (url.pathname === "/api/inspect/skillset/agent-tools") {
    const agentIdParam = url.searchParams.get("agent_id");
    if (agentIdParam !== null && agentIdParam.length > 0) {
      const ns = (deps.env as unknown as { AgentThursdayAgent: unknown })
        .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0];
      const perAgent = await getAgentByName<Env, AgentThursdayAgent>(ns, agentIdParam);
      const [summary, effState] = await Promise.all([
        perAgent.getSkillsetRuntimeSummary(),
        perAgent.getAgentSkillsetEffectiveState(),
      ]);
      // narrow snapshot-wide `agent_tools` to the
      // per-agent effective skillset closure so the response matches
      // what `_buildDynamicSkillTools()` actually exposes to the
      // model. `null` (registry / unset) → no narrowing (legacy).
      const allowed = Array.isArray(effState.effective_skillset_ids)
        ? new Set(effState.effective_skillset_ids)
        : null;
      const bindings = allowed === null
        ? summary.agent_tools
        : summary.agent_tools.filter((b) => allowed.has(b.skillset_id));
      return json({
        generated_at: new Date().toISOString(),
        agent_id: agentIdParam,
        skillset_ids: summary.skillset_ids,
        effective_skillset_ids: effState.effective_skillset_ids,
        fallback_reason: effState.fallback_reason,
        custom_skillset_ids: effState.custom_skillset_ids,
        bindings,
      });
    }
    const stub = await deps.getAgentThursdayStub();
    const summary = await stub.getSkillsetRuntimeSummary();
    return json({ generated_at: new Date().toISOString(), bindings: summary.agent_tools });
  }

  // operator diagnostic: which base SOUL (operator / neutral) is
  // frozen for an agent, the stored `soul_prompt_version`, and the cached owner
  // verdict. Confirms the neutral-SOUL re-render took effect on an EXISTING
  // agent without a behavioral probe (those are confounded by conversation
  // history). agent_id required. Operator-only surface (isOperatorOnlyPath →
  // `/api/inspect/` is admin-gated; never reachable by a scoped user).
  if (url.pathname === "/api/inspect/soul-diagnostic") {
    const agentIdParam = url.searchParams.get("agent_id");
    if (agentIdParam === null || agentIdParam.length === 0) {
      return json({ error: "agent_id query param required" }, 400);
    }
    const ns = (deps.env as unknown as { AgentThursdayAgent: unknown })
      .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0];
    const perAgent = await getAgentByName<Env, AgentThursdayAgent>(ns, agentIdParam);
    const diag = await perAgent.getSoulDiagnostic();
    return json({ generated_at: new Date().toISOString(), agent_id: agentIdParam, ...diag });
  }

  // per-agent live view of all 6 memory layers + 2 cross-cutting.
  // L1-L6 + cross-B come from the agent DO (getMemoryLayers); L6 conversation
  // archive is per-agent post-an earlier revision (drain-to-self); cross-A candidates are
  // registry-canonical (fail-soft). Operator-only via the `/api/inspect/` gate.
  if (url.pathname === "/api/inspect/memory/layers") {
    const agentIdParam = url.searchParams.get("agent_id");
    // No agent_id → the canonical-active agent (same resolution as the Memory
    // tab's /api/memory), so the console panel works without passing an id.
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const agent = await perAgent.getMemoryLayersDiagnostic();
    // Track A: conversation_archive is now per-agent (drain-to-self),
    // so read L6 from the SAME per-agent stub as L1-L5 (was registry-canonical
    // pre-449). For the registry/operator DO this is still the registry table.
    let L6_conversation_archive: unknown = { error: "archive_unreachable" };
    try {
      L6_conversation_archive = await perAgent.getConversationArchiveStats();
    } catch {
      /* keep fail-soft markers */
    }
    // the Card-297 keyword candidate generator is RETIRED from this
    // surface. The live memory-adoption ring runs via LLM extraction
    // (`crossA_consolidation_runs`, an earlier revision); the keyword generator never
    // qualified a candidate in real dialog, so its perpetual empty result read
    // as "the ring is broken" when the ring actually runs. The
    // `listMemoryCandidates` method itself is unchanged (still used by the CLI
    // route); only this diagnostic stops presenting the dead surface.
    const crossA_candidates = {
      retired: true,
      superseded_by: "crossA_consolidation_runs",
      note: "an earlier revision keyword candidate generator retired  — memory adoption runs via LLM consolidation; see crossA_consolidation_runs.",
    };
    // the CF Agent Memory shadow, side-by-side with native layers.
    // The shadow only exists for the operator profile (an earlier revision dogfood);
    // other agents report enabled:false. Fail-soft: fetch trouble → null →
    // the panel shows "unavailable" without touching the native view.
    const isOperatorView = !agentIdParam || agentIdParam === OPERATOR_INSTANCE;
    let cf_shadow: unknown = { enabled: false, note: "CF shadow runs for the operator profile only " };
    if (isOperatorView) {
      const memories = await cfMemoryListRecent(
        AGENT_MEMORY_OPERATOR_PROFILE,
        (deps.env as { CF_AGENT_MEMORY_TOKEN?: string }).CF_AGENT_MEMORY_TOKEN,
        20,
      );
      cf_shadow = memories === null
        ? { enabled: true, error: "shadow_unreachable" }
        : { enabled: true, memories };
    }
    return json({
      generated_at: new Date().toISOString(),
      agent_id: agentIdParam,
      cf_shadow,
      L1_soul: agent.soul,
      L2_compaction: agent.layers.compaction,
      L3_agent_memories: agent.agentMemories,
      L4_knowledge: agent.layers.knowledge,
      L5_checkpoints: agent.layers.checkpoints,
      L5_review_notes: agent.layers.reviewNotes,
      L6_conversation_archive,
      crossA_candidates,
      crossA_consolidation_runs: agent.consolidationRuns,
      crossB_scoping: { agentId: agent.agentId, ownerIsOperator: agent.ownerIsOperator },
    });
  }

  // DIAGNOSTIC (2026-06-30) — per-agent DO storage profile (which table holds the
  // bytes → which load operation can trip the 128 MB isolate limit). Operator-only
  // via the `/api/inspect/` admin gate. No agent_id → canonical active agent.
  if (url.pathname === "/api/inspect/do-storage") {
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const contextIdParam = url.searchParams.get("context_id");
    const profile = await perAgent.getStorageProfile(contextIdParam && contextIdParam.length > 0 ? { contextId: contextIdParam } : undefined);
    return json({ generated_at: new Date().toISOString(), agent_id: agentIdParam, ...profile });
  }

  // DIAGNOSTIC (2026-06-30) — dump the largest assistant_messages rows + per-part
  // byte breakdown (what makes them big). Operator-only. No agent_id → canonical.
  if (url.pathname === "/api/inspect/large-messages") {
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const limit = Number(url.searchParams.get("limit") ?? "5");
    const previewBytes = Number(url.searchParams.get("preview") ?? "1200");
    const result = await perAgent.getLargeAssistantMessages({
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(previewBytes) ? { previewBytes } : {}),
    });
    return json({ generated_at: new Date().toISOString(), agent_id: agentIdParam, ...result });
  }

  // semantic recall probe (operator-only). Runs the agent's recall tool
  // (now embedding-ranked) so the result is inspectable. No agent_id → active.
  if (url.pathname === "/api/inspect/memory/recall") {
    const query = url.searchParams.get("query") ?? "";
    if (query.trim().length === 0) return json({ error: "query param required" }, 400);
    const agentIdParam = url.searchParams.get("agent_id");
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const result = await perAgent.recallMemory({ query, limit: 8 });
    return json({ generated_at: new Date().toISOString(), query, ...result });
  }

  // Track A per-agent conversation_archive search probe. Routes
  // `conversationSearch` to the specified agent's OWN DO (drain-to-self), so
  // verifier evidence can confirm a scoped agent finds its locally-archived
  // rows. `owner` owner-scopes the search (omit = admin / unscoped). Operator-
  // only via the `/api/inspect/` admin gate.
  if (url.pathname === "/api/inspect/conversation-search") {
    const query = url.searchParams.get("query") ?? "";
    if (query.trim().length === 0) return json({ error: "query param required" }, 400);
    const agentIdParam = url.searchParams.get("agent_id");
    const owner = url.searchParams.get("owner") ?? undefined;
    const perAgent = agentIdParam && agentIdParam.length > 0
      ? await getAgentByName<Env, AgentThursdayAgent>(
          (deps.env as unknown as { AgentThursdayAgent: unknown })
            .AgentThursdayAgent as unknown as Parameters<typeof getAgentByName<Env, AgentThursdayAgent>>[0],
          agentIdParam,
        )
      : await deps.getAgentThursdayStub();
    const result = await perAgent.conversationSearch({ query, topK: 10 }, owner);
    return json({ generated_at: new Date().toISOString(), agent_id: agentIdParam, owner: owner ?? null, ...result });
  }

  // generic per-tool capability inspect. Auth-gated via
  // the global `/api/*` requireSecret. Read-only; never changes the
  // runtime decision / loader / agent tool surface. Routes the
  // canonical-active AgentThursdayAgent stub through `getSkillsetRuntimeSummary()`
  // (same contract as `/api/inspect/skillset/agent-tools`) so operator
  // disable state and other runtime mutations are respected — see
  // `feedback_agent_surface_inspect_must_use_active_state`. The
  // classifier projects the contract registry, adapter dispatch
  // registry, and legacy safe-read surface into a five-state
  // `readiness` enum. The response never includes secret values; the
  // only field tied to secrets is `env_binding`, which is the binding
  // NAME (the value is never read here). Unknown tool ids return 404.
  if (url.pathname.startsWith("/api/inspect/tool/")) {
    const raw = url.pathname.slice("/api/inspect/tool/".length);
    const toolId = raw.length > 0 ? decodeURIComponent(raw) : "";
    if (toolId.length === 0) {
      return json({ error: "missing_tool_id" }, 400);
    }
    const { classifyTool } = await import("../skillset/inspectTool");
    const stub = await deps.getAgentThursdayStub();
    const summary = await stub.getSkillsetRuntimeSummary();
    const result = classifyTool(toolId, { summary });
    const status = result.readiness === "unknown_tool" ? 404 : 200;
    return json(result, status);
  }

  // toolEvents observability + conversation_search audit.
  // GET /api/inspect/observability?query=<text>?
  // Returns the gap report (toolEvents vs trace.supplier.signal
  // toolCallNames) + an optional query-shape audit for the conversation
  // search trigger heuristic. `warning: 'toolEvents_gap'` is set when
  // the trace mentions a tool the toolEvents stream is missing.
  if (url.pathname === "/api/inspect/observability") {
    const query = url.searchParams.get("query");
    const stub = await deps.getAgentThursdayStub();
    const result = await stub.devShellObservabilityCheck(query ? { query } : undefined);
    return json(result);
  }

  if (url.pathname.startsWith("/api/inspect/evidence/")) {
    const envelopeId = url.pathname.slice("/api/inspect/evidence/".length);
    const stub = await deps.getAgentThursdayStub();
    const result = await stub.devShellEnvelopeGet({ envelope_id: envelopeId });
    return json(result);
  }
  if (url.pathname === "/api/inspect/evidence") {
    // read-only inspect ergonomics. Param precedence:
    //   1. marker=<text containing [envelope: env-...]> → single envelope
    //   2. latest=terminal                              → single envelope
    //   3. task_id=<taskId>                             → array
    //   4. (no params)                                  → array (existing)
    // Existing no-arg behavior is preserved exactly. Each new path
    // delegates to a dedicated read-only callable; no existing
    // callable shape changed.
    const stub = await deps.getAgentThursdayStub();
    const marker = url.searchParams.get("marker");
    if (marker) {
      const m = marker.match(/\[envelope:\s*(env-[a-z0-9]+-[a-z0-9]+)\s*\]/i);
      if (!m) return json({ error: "marker_not_parseable" }, 400);
      const envelopeId = m[1];
      const result = await stub.devShellEnvelopeGet({ envelope_id: envelopeId });
      return json(result);
    }
    if (url.searchParams.get("latest") === "terminal") {
      const result = await stub.devShellEnvelopeGetLatestTerminal();
      return json(result);
    }
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      const result = await stub.devShellEnvelopeListByTask({ task_id: taskId });
      return json(result);
    }
    const result = await stub.devShellEnvelopeList();
    return json(result);
  }

  // read-only outbox inspect surface. Auth-gated by the
  // global `requireSecret` above. Verifier-only — never exposes raw
  // payload_json (which can carry provider auth headers), bot tokens,
  // or any secret material. Body is preview-only (≤1000 chars) and
  // error is sanitized at write time.
  //
  // Param precedence:
  //   1. /api/inspect/outbox/<outbox_id>      → single row
  //   2. ?marker=[envelope: env-...]          → rows containing marker
  //   3. ?envelope_id=env-...                 → same, by raw id
  //   4. ?conversation_id=<id>                → recent rows for conv
  //   5. (no params)                          → 400 missing-param
  //
  // Input shape is validated at the route boundary (defence-in-depth
  // against LIKE-pattern wildcards leaking past a broken caller). The
  // ChannelHub callable additionally re-validates.
  if (url.pathname.startsWith("/api/inspect/outbox/")) {
    const outboxId = url.pathname.slice("/api/inspect/outbox/".length);
    if (!/^[a-zA-Z0-9_-]+$/.test(outboxId)) {
      return json({ error: "outbox_id_invalid" }, 400);
    }
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectOutbox({ outbox_id: outboxId, limit: 1 });
    return json(result);
  }
  if (url.pathname === "/api/inspect/outbox") {
    const stub = await deps.getChannelHubStub();
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam !== null ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return json({ error: "limit_invalid" }, 400);
    }

    const marker = url.searchParams.get("marker");
    if (marker !== null) {
      const m = marker.match(/\[envelope:\s*(env-[a-z0-9]+-[a-z0-9]+)\s*\]/i);
      if (!m) return json({ error: "marker_not_parseable" }, 400);
      const result = await stub.inspectOutbox({ envelope_id: m[1], limit });
      return json(result);
    }
    const envelopeId = url.searchParams.get("envelope_id");
    if (envelopeId !== null) {
      if (!/^env-[a-z0-9]+-[a-z0-9]+$/i.test(envelopeId)) {
        return json({ error: "envelope_id_invalid" }, 400);
      }
      const result = await stub.inspectOutbox({ envelope_id: envelopeId, limit });
      return json(result);
    }
    const conversationId = url.searchParams.get("conversation_id");
    if (conversationId !== null) {
      if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        return json({ error: "conversation_id_invalid" }, 400);
      }
      const result = await stub.inspectOutbox({ conversation_id: conversationId, limit });
      return json(result);
    }
    return json({ error: "missing_param", expected: ["marker", "envelope_id", "conversation_id", "/<outbox_id>"] }, 400);
  }

  // approval token redacted inspect surface.
  //
  // Read-only. Auth gated by the global `requireSecret` on `/api/*`.
  // Returns rows from `agent_tool_approvals` with the persisted
  // secret column (`token_hash`) dropped at SELECT time and the
  // textual fields (`agent_reason`, `summary`) bounded to a preview.
  // Input is shape-validated at the route boundary; the ChannelHub
  // callable additionally re-validates as defence-in-depth.
  //
  // Routes:
  //   GET /api/inspect/approvals/<token_id>            → single row
  //   GET /api/inspect/approvals?status=pending|all    → list
  //   GET /api/inspect/approvals?status=<other>        → list (filtered)
  //
  // Bad status / bad token_id → 400. Empty result → `{ rows: [] }`.
  if (url.pathname.startsWith("/api/inspect/approvals/")) {
    const tokenId = url.pathname.slice("/api/inspect/approvals/".length);
    if (!/^tok_[a-f0-9]{8,64}$/i.test(tokenId)) {
      return json({ error: "token_id_invalid" }, 400);
    }
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectApprovals({ token_id: tokenId, limit: 1 });
    return json(result);
  }
  if (url.pathname === "/api/inspect/approvals") {
    const stub = await deps.getChannelHubStub();
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam !== null ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return json({ error: "limit_invalid" }, 400);
    }
    const statusRaw = url.searchParams.get("status") ?? "pending";
    const VALID_STATUSES = new Set<string>([
      "pending", "granted", "denied", "expired", "consumed", "replay_rejected", "all",
    ]);
    if (!VALID_STATUSES.has(statusRaw)) {
      return json({ error: "status_invalid", expected: Array.from(VALID_STATUSES) }, 400);
    }
    const status = statusRaw as
      | "pending" | "granted" | "denied" | "expired" | "consumed" | "replay_rejected" | "all";
    const result = await stub.inspectApprovals({ status, limit });
    return json(result);
  }

  // propose-patch artifact inspect surface (reviewer/
  // write-boundary ADR §D4). The propose POST stays in server.ts;
  // the read-only inspect GETs live here.
  //
  // GET /api/inspect/patch-artifacts/<artifact_id>   → single row
  // GET /api/inspect/patch-artifacts?status=proposed|all&limit=N → list
  //
  // Inspect rows strip `patch_text` (only `patch_text_length` returns)
  // so multi-KiB diff bodies never land in inspect responses.
  if (url.pathname.startsWith("/api/inspect/patch-artifacts/")
      && url.pathname !== "/api/inspect/patch-artifacts/propose") {
    const artifactId = url.pathname.slice("/api/inspect/patch-artifacts/".length);
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectPatchArtifacts({ artifact_id: artifactId, limit: 1 });
    if (result.rows.length === 0) {
      return json({ error: "patch_artifact_not_found" }, 404);
    }
    return json({ row: result.rows[0] });
  }
  if (url.pathname === "/api/inspect/patch-artifacts") {
    const stub = await deps.getChannelHubStub();
    const statusRaw = url.searchParams.get("status");
    let status: "proposed" | "all" = "proposed";
    if (statusRaw === "all") status = "all";
    else if (statusRaw === null || statusRaw === "proposed") status = "proposed";
    else return json({ error: "invalid_status" }, 400);

    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) return json({ error: "invalid_limit" }, 400);
      limit = Math.max(1, Math.min(100, Math.floor(n)));
    }
    const result = await stub.inspectPatchArtifacts({ status, limit });
    return json(result);
  }

  // apply skeleton (approval-replay-driven apply).
  // The apply-dry-run POST stays in server.ts; the read-only
  // patch-apply-events GETs live here.
  //
  // GET /api/inspect/patch-apply-events
  //   query: limit?  (1..100, default 20)
  //          artifact_id?  (filter)
  // GET /api/inspect/patch-apply-events/<event_id>  → single row
  if (url.pathname.startsWith("/api/inspect/patch-apply-events/")) {
    const eventId = url.pathname.slice("/api/inspect/patch-apply-events/".length);
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectPatchApplyEvents({ event_id: eventId, limit: 1 });
    if (result.rows.length === 0) {
      return json({ error: "patch_apply_event_not_found" }, 404);
    }
    return json({ row: result.rows[0] });
  }
  if (url.pathname === "/api/inspect/patch-apply-events") {
    const stub = await deps.getChannelHubStub();
    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) return json({ error: "invalid_limit" }, 400);
      limit = Math.max(1, Math.min(100, Math.floor(n)));
    }
    const artifactIdParam = url.searchParams.get("artifact_id");
    const args: { artifact_id?: string; limit: number } = { limit };
    if (artifactIdParam !== null && artifactIdParam.length > 0) {
      args.artifact_id = artifactIdParam;
    }
    const result = await stub.inspectPatchApplyEvents(args);
    return json(result);
  }

  // patch apply outbox/evidence inspect (split from
  // patch_apply_events to separate event-log semantics from
  // redaction-safe evidence/delivery view).
  //
  // GET /api/inspect/patch-apply-outbox/<outbox_id>  → single row
  // GET /api/inspect/patch-apply-outbox
  //   query: limit?      (1..100, default 20)
  //          event_id?   (filter — single match, takes precedence over artifact_id)
  //          artifact_id? (filter — list, latest-first)
  //
  // Auth gated by global `requireSecret` on `/api/*`. Egress contract
  // matches event-log inspect — never exposes raw token / signature /
  // patch body / worker secret; the table itself never stored those.
  if (url.pathname.startsWith("/api/inspect/patch-apply-outbox/")) {
    const outboxId = url.pathname.slice("/api/inspect/patch-apply-outbox/".length);
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectPatchApplyOutbox({ outbox_id: outboxId, limit: 1 });
    if (result.rows.length === 0) {
      return json({ error: "patch_apply_outbox_not_found" }, 404);
    }
    return json({ row: result.rows[0] });
  }
  if (url.pathname === "/api/inspect/patch-apply-outbox") {
    const stub = await deps.getChannelHubStub();
    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) return json({ error: "invalid_limit" }, 400);
      limit = Math.max(1, Math.min(100, Math.floor(n)));
    }
    const eventIdParam = url.searchParams.get("event_id");
    const artifactIdParam = url.searchParams.get("artifact_id");
    const args: { event_id?: string; artifact_id?: string; limit: number } = { limit };
    if (eventIdParam !== null && eventIdParam.length > 0) {
      args.event_id = eventIdParam;
    } else if (artifactIdParam !== null && artifactIdParam.length > 0) {
      args.artifact_id = artifactIdParam;
    }
    const result = await stub.inspectPatchApplyOutbox(args);
    return json(result);
  }

  // read-only `channel_inbox` inspect surface.
  //
  // Routes:
  //   GET /api/inspect/channel-inbox/<inbox_id>              → single row
  //   GET /api/inspect/channel-inbox?provider_message_id=... → list
  //   GET /api/inspect/channel-inbox?conversation_id=...     → list
  //
  // Auth gated by the global `/api/*` `requireSecret`. Egress is
  // redacted (text → bounded preview + length, attachments collapsed
  // to count+kinds, raw_ref bounded, no payload JSON). Verifier uses
  // this to trace a Discord message id (or ChannelHub conv id) to
  // its `route_action` / `route_reason` / `handoff_task_id` ownership.
  if (url.pathname.startsWith("/api/inspect/channel-inbox/")) {
    const inboxId = url.pathname.slice("/api/inspect/channel-inbox/".length);
    if (!/^[A-Za-z0-9_.:\-]+$/.test(inboxId)) {
      return json({ error: "inbox_id_invalid" }, 400);
    }
    const stub = await deps.getChannelHubStub();
    const result = await stub.inspectChannelInbox({ inbox_id: inboxId, limit: 1 });
    if (result.rows.length === 0) {
      return json({ error: "inbox_row_not_found" }, 404);
    }
    return json({ row: result.rows[0] });
  }
  if (url.pathname === "/api/inspect/channel-inbox") {
    const stub = await deps.getChannelHubStub();
    const limitParam = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) return json({ error: "limit_invalid" }, 400);
      limit = Math.max(1, Math.min(100, Math.floor(n)));
    }
    const providerMessageId = url.searchParams.get("provider_message_id");
    if (providerMessageId !== null && providerMessageId.length > 0) {
      if (!/^[A-Za-z0-9_.:\-]+$/.test(providerMessageId)) {
        return json({ error: "provider_message_id_invalid" }, 400);
      }
      const result = await stub.inspectChannelInbox({ provider_message_id: providerMessageId, limit });
      return json(result);
    }
    const conversationId = url.searchParams.get("conversation_id");
    if (conversationId !== null && conversationId.length > 0) {
      if (!/^[A-Za-z0-9_.:\-]+$/.test(conversationId)) {
        return json({ error: "conversation_id_invalid" }, 400);
      }
      const result = await stub.inspectChannelInbox({ conversation_id: conversationId, limit });
      return json(result);
    }
    return json({ error: "missing_param", expected: ["provider_message_id", "conversation_id", "/<inbox_id>"] }, 400);
  }

  // tool contract registry + tool table view.
  // GET /api/inspect/skillset/tools?skillset=<id> (optional) returns
  // the tool table metadata that fabric dispatcher would inject for
  // the given skillset. Defaults to all loaded skillsets when no
  // `skillset` query param is provided. Read-only.
  if (url.pathname === "/api/inspect/skillset/tools") {
    const { loadSkillsets } = await import("../skillset/loader");
    const { STUB_KNOWN_TOOL_IDS } = await import("../skillset/contractRegistry");
    const { buildToolTable, summarizeToolTable } = await import("../skillset/toolTable");
    const state = loadSkillsets(undefined, { knownToolIds: STUB_KNOWN_TOOL_IDS });
    const skillsetFilter = url.searchParams.get("skillset");
    const out: Record<string, ReturnType<typeof summarizeToolTable>> = {};
    for (const [id, entry] of Object.entries(state.entries)) {
      if (skillsetFilter && skillsetFilter !== id) continue;
      if (entry.status !== "loaded") continue;
      out[id] = summarizeToolTable(buildToolTable(entry.manifest));
    }
    return json({
      loaded_at: state.loaded_at,
      skillsets: out,
    });
  }

  // agent lifecycle evidence. Routes through the registry
  // DO (same substrate as `/api/agent-profiles`) so the inspect badge
  // is provably the same evidence the UI reads — verifier can prove
  // the badge isn't frontend-fabricated by diffing this against the
  // `/api/agent-profiles/<id>.lifecycle` block.
  //
  // Shape:
  //   /api/inspect/agents                          -> {generated_at, agents:[{profile_id, lifecycle, evidence}]}
  //   /api/inspect/agents?agent_id=<id>            -> {generated_at, agent_id, lifecycle, evidence}
  //
  // `evidence` is the raw per-task array fed to the resolver so an
  // operator can spot stuck-task aggregation issues without scraping
  // the manager-task status endpoint per row.
  // observable workflow run model. Read-only `run -> phases
  // -> agents` tree from the structured workflow ledger on the registry
  // DO. Deliberately a SEPARATE route from `/api/manager/tasks/:id` so
  // an earlier revision's status / stale_warning / timed_out derivation is not
  // entangled. The tree comes from the workflow_* ledger rows, never
  // inferred from flat `manager.task.*` events.
  if (url.pathname === "/api/inspect/workflow-runs") {
    const stub = await deps.getRegistryStub();
    const limitRaw = url.searchParams.get("limit");
    const limitNum = limitRaw !== null ? Number(limitRaw) : NaN;
    const runs = await stub.readWorkflowRuns(
      Number.isFinite(limitNum) ? { limit: limitNum } : undefined,
    );
    return json({ generated_at: new Date().toISOString(), runs });
  }
  if (url.pathname.startsWith("/api/inspect/workflow-runs/")) {
    const runId = decodeURIComponent(url.pathname.slice("/api/inspect/workflow-runs/".length));
    if (runId.length === 0) return json({ error: "missing_run_id" }, 400);
    const stub = await deps.getRegistryStub();
    const tree = await stub.readWorkflowRun({ run_id: runId });
    if (tree === null) return json({ error: "not_found", run_id: runId }, 404);
    return json(tree);
  }

  // named workflow descriptor store read surface.
  if (url.pathname === "/api/inspect/workflow-descriptors") {
    const stub = await deps.getRegistryStub();
    const rows = await stub.listWorkflowDescriptors();
    return json({
      generated_at: new Date().toISOString(),
      workflows: rows.map(summarizeDescriptorRow),
    });
  }
  if (url.pathname.startsWith("/api/inspect/workflow-descriptors/")) {
    const name = decodeURIComponent(
      url.pathname.slice("/api/inspect/workflow-descriptors/".length),
    );
    if (name.length === 0) return json({ error: "missing_name" }, 400);
    const stub = await deps.getRegistryStub();
    const row = await stub.readWorkflowDescriptor({ name });
    if (row === null) return json({ error: "not_found", name }, 404);
    let descriptor: unknown = null;
    try {
      descriptor = JSON.parse(row.descriptor_json);
    } catch { /* fail-soft: descriptor stays null, raw json still returned */ }
    return json({ ...row, descriptor });
  }

  if (url.pathname === "/api/inspect/agents") {
    const stub = await deps.getRegistryStub();
    const agentIdParam = url.searchParams.get("agent_id");
    if (agentIdParam !== null && agentIdParam.length > 0) {
      const profile = await stub.readAgentProfile(agentIdParam);
      if (profile === null) {
        return json({ error: "not_found", agent_id: agentIdParam }, 404);
      }
      const evidence = await stub.getAgentLifecycleEvidence(agentIdParam, 500);
      const lifecycle = resolveAgentLifecycle({
        profile: { id: profile.id, status: profile.status, updated_at: profile.updated_at },
        tasks: evidence,
        now: new Date(),
      });
      return json({
        generated_at: new Date().toISOString(),
        agent_id: agentIdParam,
        lifecycle,
        evidence,
      });
    }
    const profiles = await stub.listAgentProfiles({ includeArchived: true });
    const rows = await Promise.all(
      profiles.map(async (p) => {
        try {
          const ev = await stub.getAgentLifecycleEvidence(p.id, 500);
          const lifecycle = resolveAgentLifecycle({
            profile: { id: p.id, status: p.status, updated_at: p.updated_at },
            tasks: ev,
            now: new Date(),
          });
          return { profile_id: p.id, lifecycle, evidence: ev };
        } catch (err) {
          return {
            profile_id: p.id,
            lifecycle: null,
            evidence: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return json({ generated_at: new Date().toISOString(), agents: rows });
  }

  // read-only channel-conversation ownership observability.
  //
  //   GET /api/inspect/channel-conversation-ownership?conversation_id=<id>
  //   GET /api/inspect/channel-conversation-ownership?agent_id=<id>
  //
  // Surfaces agentP's 369a ask: "current workspace agent vs channel route
  // owner mismatch / unbound" without touching the hot-polled
  // /api/workspace payload. Routes through ChannelHub DO (where
  // channel_conversations + channel_inbox live).
  if (url.pathname === "/api/inspect/channel-conversation-ownership") {
    const conversationIdParam = url.searchParams.get("conversation_id");
    const agentIdParam = url.searchParams.get("agent_id");
    if (!conversationIdParam && !agentIdParam) {
      return json({
        error: "missing_param",
        expected: ["conversation_id", "agent_id"],
      }, 400);
    }
    const SAFE_ID_RE = /^[A-Za-z0-9_.:\-]+$/;
    if (conversationIdParam !== null && !SAFE_ID_RE.test(conversationIdParam)) {
      return json({ error: "conversation_id_invalid" }, 400);
    }
    if (agentIdParam !== null && !SAFE_ID_RE.test(agentIdParam)) {
      return json({ error: "agent_id_invalid" }, 400);
    }
    const inboxLimitParam = url.searchParams.get("inbox_limit");
    const inboxLimit = inboxLimitParam !== null ? Number(inboxLimitParam) : undefined;
    const hub = await deps.getChannelHubStub();
    const result = await hub.inspectConversationOwnership({
      ...(conversationIdParam !== null ? { conversation_id: conversationIdParam } : {}),
      ...(agentIdParam !== null ? { agent_id: agentIdParam } : {}),
      ...(inboxLimit !== undefined && Number.isFinite(inboxLimit) ? { inbox_limit: inboxLimit } : {}),
    });
    return json({ generated_at: new Date().toISOString(), ...result });
  }

  return null;
}
