import { getAgentByName } from "agents";
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
//  — registry workflow feed rows → intents merge.
import { buildActionUiIntents } from "../actionUiIntents";
//  — named workflow descriptor summaries for the inspect list.
import { summarizeDescriptorRow } from "../agent/workflowNamed";
import {
  validateWorkflowDescriptor,
  deriveExecutorRunId,
} from "../agent/workflowDescriptor";

/**
 *  — `/api/inspect/*` GET routes extracted from `server.ts`.
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
  //  — `/api/inspect/agents` needs the registry DO (where
  // AgentProfile rows + `manager.task.*` event_log live), distinct
  // from the canonical-active context DO. Composition root injects
  // both stubs so this module never imports `DEMO_INSTANCE`.
  getRegistryStub: () => Promise<AgentThursdayAgentStub>;
  //  — the resolved canonical context DO name (== agent_id for
  // per-agent DOs, ) so the workflow feed can be scoped to the
  // agent whose snapshot this is.
  getCanonicalContextName: () => Promise<string>;
}

export async function handleApiInspect(
  request: Request,
  url: URL,
  deps: InspectDeps,
): Promise<Response | null> {
  //  — orchestration-as-code executor trigger. POST a validated
  // descriptor; mint an executor-owned run_id (`wfr-exec-<short-id>`,
  // distinct from 's `wfr-<parent_task_id>`); start the
  // WorkflowExecutor CF Workflow (durable run handle). Handled BEFORE the
  // GET-only guard below. Auth: umbrella `requireSecret` in server.ts.
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
    //  — route the AgentThursdayAgent stub through the canonical
    // active context so trace / toolEvents / ladder / memory tabs
    // reflect the same DO that `/api/workspace` and `/cli/status`
    // already read from. Without this, inspect was hardcoded to
    // DEMO_INSTANCE and the user saw a stale registry/bootstrap DO
    // event_log even though their session lived elsewhere.
    // ContentHub (cross-DO) stays as before — it's a separate
    // observability layer with its own audit log.
    const stub = await deps.getAgentThursdayStub();
    const snapshot: InspectSnapshot = await stub.getInspectSnapshot();
    //  / 114 — best-effort cross-DO fetches against ContentHubAgent.
    // Both `contentAudit` (raw rows) and `contentEvidence` (
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
    //  — workflow-era activity lives on the registry DO
    // (workflow.run.* + executor-dispatched manager.task terminal
    // rows), not the active-context DO. Merge fail-soft so the feed
    // shows runs/subagents alongside the agent's own tool activity.
    let workflowIntents: NonNullable<InspectSnapshot["actionUiIntents"]> = [];
    try {
      const registry = await deps.getRegistryStub();
      //  — scope the feed to this snapshot's agent. The
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

  //  — read-only loader state for the  static skillset
  // loader. Pure (no DO state); recomputed per request from the
  // embedded manifests so the inspect view always reflects the
  // currently deployed worker's view. V2 (tool_id ∈ contract
  // registry) is checked against the 183 contract registry so
  // `research-stub` is discoverable but reported as `load_rejected`
  // until 183+ lands real web/pdf contracts.
  if (url.pathname === "/api/inspect/skillset") {
    const { loadSkillsets, summarizeLoaderState } = await import("../skillset/loader");
    const { STUB_KNOWN_TOOL_IDS } = await import("../skillset/contractRegistry");
    return json(summarizeLoaderState(loadSkillsets(undefined, { knownToolIds: STUB_KNOWN_TOOL_IDS })));
  }

  //  — per-skill inspect detail. Read-only. Walks every
  // loaded manifest and projects each skill into a provider-neutral
  // shape (id, name, tier, tools, capability_class default
  // "unspecified", prompt_segment_present boolean, pass-through
  // source_ref / evidence_requirements). Auth-gated by the global
  // `/api/*` secret check above; no separate gate, no hardcoded
  // manifest id.
  //
  //  — capability-class downgrade. Generic: when a skill's
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
    const detail = summarizeLoaderDetail(
      loadSkillsets(undefined, { knownToolIds: STUB_KNOWN_TOOL_IDS }),
    );
    const envRecord = deps.env as unknown as Record<string, unknown>;
    downgradeCapabilityClassByEnvBinding(detail, (binding) => {
      const value = envRecord[binding];
      return typeof value === "string" ? value : undefined;
    });
    return json(detail);
  }

  //  — agent-facing dynamic tool binding proof. Read-only.
  // Returns the same mapper input the agent's `getTools()` consumes
  // (loaded detail + downgrade) projected to a verifier-readable
  // shape: `ai_sdk_name`, canonical `tool_id`, originating
  // `skillset_id` / `skill_id`, composed `description`, and
  // `has_handler` (true means dispatch registry resolved). Auth-
  // gated via the global `/api/*` requireSecret.
  //
  //  — when `?agent_id=<id>` is supplied, route through
  // that per-agent DO's `getSkillsetRuntimeSummary()` so verifier
  // evidence can see the per-agent dynamic tool surface (incl.
  // custom-skillset narrowing). Without the param the route keeps
  // its prior behavior: canonical-active stub via `getAgentThursdayStub`,
  // matching the  invariant that agent-surface inspect
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
      //  — narrow snapshot-wide `agent_tools` to the
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

  //  — generic per-tool capability inspect. Auth-gated via
  // the global `/api/*` requireSecret. Read-only; never changes the
  // runtime decision / loader / agent tool surface. Routes the
  // canonical-active AgentThursdayAgent stub through `getSkillsetRuntimeSummary()`
  // (same contract as `/api/inspect/skillset/agent-tools`) so operator
  // disable state and other runtime mutations are respected — see
  // `feedback_agent_surface_inspect_must_use_active_state`. The
  // classifier projects the contract registry, adapter dispatch
  // registry, and legacy  safe-read surface into a five-state
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

  //  — toolEvents observability + conversation_search audit.
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
    //  — read-only inspect ergonomics. Param precedence:
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

  //  — read-only outbox inspect surface. Auth-gated by the
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

  //  —  approval token redacted inspect surface.
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

  //  — propose-patch artifact inspect surface ( reviewer/
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

  //  — apply skeleton ( approval-replay-driven apply).
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

  //  — patch apply outbox/evidence inspect (split from
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

  //  — read-only `channel_inbox` inspect surface.
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

  //  — tool contract registry + tool table view.
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

  //  — agent lifecycle evidence. Routes through the registry
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
  //  — observable workflow run model. Read-only `run -> phases
  // -> agents` tree from the structured workflow ledger on the registry
  // DO. Deliberately a SEPARATE route from `/api/manager/tasks/:id` so
  // 's status / stale_warning / timed_out derivation is not
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

  //  — named workflow descriptor store read surface.
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

  //  — read-only channel-conversation ownership observability.
  //
  //   GET /api/inspect/channel-conversation-ownership?conversation_id=<id>
  //   GET /api/inspect/channel-conversation-ownership?agent_id=<id>
  //
  // Surfaces 's 369a ask: "current workspace agent vs channel route
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
