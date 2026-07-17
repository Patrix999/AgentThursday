/**
 * M9.0 manager skillset core. Pure orchestration over the
 * registry-DO stub (and per-agent stubs for `sendAgentMessage`).
 * Both the HTTP route layer (`src/routes/managerRoutes.ts`) and the
 * dispatch adapters (`src/skillset/adapters/manager*.ts` via
 * `src/routes/dispatchManagerRoutes.ts`) call into this module so
 * validation, persistence, and event emission stay in lockstep.
 *
 * Architecture:
 *   - Stub resolution is centralized: `resolveRegistryStub(env)` and
 *     `resolvePerAgentStub(env, agent_id)`. The agent_message path
 *     never falls back to a global active agent (an earlier revision
 *     agent-centric routing invariant).
 *   - Validation calls into `agentProfileValidation.ts` (shared with
 *     `/api/agent-profiles`) and `customSkillsetValidation.ts`.
 *   - Audit events fire on the registry DO via
 *     `stub.recordManagerEvent(name, payload)`. Closed event-name
 *     enum lives in `MANAGER_EVENT_NAMES` below — verifier may grep
 *     for these.
 *   - Custom skillset manifests are wire-shape-projected at the
 *     RPC boundary; `manifestFromWire` reconstructs the structured
 *     manifest for the loader / runtime probe.
 *
 * Every function returns a discriminated union; no thrown errors
 * cross the module boundary except for genuinely unexpected
 * conditions (caller's job to surface those as 500s).
 */
import { getAgentByName } from "agents";

import { DEMO_INSTANCE } from "../demoConstants";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";
import { loadSkillsets } from "../skillset/loader";
import { STUB_KNOWN_TOOL_IDS } from "../skillset/contractRegistry";
import {
  loadMergedManifests,
  validateAgentProfileInput,
  type AgentProfileValidationError,
} from "./agentProfileValidation";
import {
  validateCustomSkillset,
  type CustomSkillsetValidationError,
} from "./customSkillsetValidation";
import {
  manifestFromWire,
  type CreateCustomSkillsetWireResult,
  type CustomSkillsetWireRecord,
  type UpdateCustomSkillsetWireResult,
} from "./customSkillsetOps";
import {
  fanoutCustomSkillsetContentRefresh,
  SKILLSET_CONTENT_REFRESHED_EVENT,
  SKILLSET_CONTENT_REFRESH_FAILED_EVENT,
} from "./managerSkillsetContentFanout";
import {
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./managerTaskStatus";
import { runManagerTaskBackgroundPure } from "./managerTaskBackgroundPure";
import { safePromptPreview } from "./workflowRunModel";
import type { TaskContext } from "./taskContext";
import {
  filterSubagentSummariesForReader,
  SUBAGENT_SUMMARY_EVENT_NAME,
  type SubagentSummary,
  type SubagentSummaryRow,
} from "./subagentSummaryOps";
import {
  emitManagerTaskMerged,
  MANAGER_TASK_MERGED_EVENT_NAME,
  type ManagerTaskMergeInput,
  type ManagerTaskMergeRegistrySurface,
  type ManagerTaskMergeResult,
  type ManagerTaskMergedPayload,
} from "./managerTaskMergeOps";
import {
  emitManagerTaskCompleted,
  MANAGER_TASK_COMPLETED_EVENT_NAME,
  type ManagerTaskCompleteInput,
  type ManagerTaskCompleteRegistrySurface,
  type ManagerTaskCompleteResult,
  type ManagerTaskCompletedPayload,
} from "./managerTaskCompleteOps";
import type { AgentProfile } from "../schema/agent";
import type { ContextInspectResult } from "../schema/context";
import type { SkillsetManifest } from "../skillset/types";
import { looksLikeAgentId } from "./managerAgentIdShape";
import { type RequestIdentity, resolveRequestIdentity, scopeOwnerIdFor, ownerUserIdFor, ADMIN_USER_ID } from "./requestIdentity";
import { checkDispatchOwnership } from "./dispatchOwnership";
// shared local→UTC conversion with the base schedule tools.
import { localFieldsToUtc } from "./tools/scheduleTools";

// ── Closed event-name enum ───────────────────────────────────────────
// Verifier grep target. Names are stable; payload shapes are documented
// inline at each emission site. All events fire on the registry DO so
// the audit trail is co-located with the agent_profile / custom_skillset
// rows they mutate.
export const MANAGER_EVENT_NAMES = {
  agentCreated: "manager.agent.created",
  agentUpdated: "manager.agent.updated",
  skillsetCreated: "manager.skillset.created",
  skillsetUpdated: "manager.skillset.updated",
  // per-agent refresh fan-out after a custom skillset's
  // manifest content was updated (not the agent's `skillset` id).
  // Distinct from 357a's `manager.agent.skillset.refreshed` so
  // audit/trace can attribute the refresh to a content PATCH vs an
  // agent skillset-id change. One event fires per (agent_id,
  // skillset_id) refresh attempt. Names are kept in lockstep with
  // `managerSkillsetContentFanout.ts` constants.
  skillsetContentRefreshed: SKILLSET_CONTENT_REFRESHED_EVENT,
  skillsetContentRefreshFailed: SKILLSET_CONTENT_REFRESH_FAILED_EVENT,
  agentMessageSent: "manager.agent.message.sent",
  agentMessageFailed: "manager.agent.message.failed",
  // async manager task lifecycle bracket events. Keyed by
  // `task_id` via `event_log.trace_id` so /api/manager/tasks/:task_id
  // can derive status without a new SQL table.
  taskReceived: MANAGER_TASK_EVENT_NAMES.received,
  taskStarted: MANAGER_TASK_EVENT_NAMES.started,
  taskWaiting: MANAGER_TASK_EVENT_NAMES.waiting,
  taskReplied: MANAGER_TASK_EVENT_NAMES.replied,
  taskFailed: MANAGER_TASK_EVENT_NAMES.failed,
  // subagent → manager summary PUSH event. Recorded on
  // the registry DO event_log via `pushSubagentArtifactSummary`
  // keyed by `parent_task_id` (event_log.trace_id). Read back via
  // `manager.subagent_summaries` adapter with the calling manager's
  // agent_id enforcing the permission boundary (ADR §6.3).
  subagentSummary: SUBAGENT_SUMMARY_EVENT_NAME,
  // audit-grade manager merge event. Recorded via
  // `recordManagerTaskMerged` on the registry DO; keyed by
  // `event_log.trace_id = parent_task_id` so it sits in the same
  // task-keyed stream as received/started/waiting/replied/failed.
  taskMerged: MANAGER_TASK_MERGED_EVENT_NAME,
  // manager completion report event. Pure report/archive
  // evidence; coexists with `replied` and does NOT change lifecycle
  // terminal derivation. Recorded via `recordManagerTaskCompleted`
  // on the registry DO; keyed by `event_log.trace_id = parent_task_id`.
  taskCompleted: MANAGER_TASK_COMPLETED_EVENT_NAME,
} as const;

// ── Stub narrow surfaces ──────────────────────────────────────────────
// We never `import type { AgentThursdayAgent } from "../server"` inside this
// module: that pull drags server.ts into the script-tsconfig graph for
// any future test that imports managerOps without the workers types.
// Narrow interfaces capture only the @callable methods we need.

interface RegistryStubSurface {
  // multi-tenancy: an optional `identity` scopes these registry
  // reads/writes to one user (matches the @callable signatures from an earlier revision).
  // Omitted ⇒ admin (unchanged behaviour for internal/system callers).
  listAgentProfiles(opts: { includeArchived?: boolean }, identity?: RequestIdentity): Promise<AgentProfile[]>;
  readAgentProfile(id: string, identity?: RequestIdentity): Promise<AgentProfile | null>;
  // turn share links.
  createTurnShare(
    input: { agent_id: string; agent_name?: string | null; title: string; content_md: string },
    identity?: RequestIdentity,
  ): Promise<{ ok: true; share_id: string } | { ok: false; error: string }>;
  readTurnShare(input: { share_id: string }): Promise<{
    share_id: string;
    agent_name: string | null;
    title: string;
    content_md: string;
    created_at: string;
  } | null>;
  // owner-scoped share management.
  listTurnShares(identity?: RequestIdentity): Promise<{
    share_id: string;
    agent_name: string | null;
    title: string;
    created_at: string;
  }[]>;
  deleteTurnShare(input: { share_id: string }, identity?: RequestIdentity): Promise<{ ok: boolean }>;
  // owner-scoped scheduled tasks (see ManagerRoutePreflightSurface).
  createScheduledTaskRow(input: {
    id: string;
    ownerUserId: string;
    agentId: string;
    spec: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ ok: true; row: ScheduledTaskWireRow } | { ok: false; code: string; message: string }>;
  listScheduledTaskRows(opts: { agentId?: string; scopeOwnerId?: string }): Promise<ScheduledTaskWireRow[]>;
  updateScheduledTaskRow(input: {
    id: string;
    scopeOwnerId?: string;
    nowIso: string;
    changes: Record<string, unknown>;
  }): Promise<{ ok: true; row: ScheduledTaskWireRow } | { ok: false; code: string; message: string }>;
  deleteScheduledTaskRow(input: { id: string; scopeOwnerId?: string }): Promise<{ deleted: boolean }>;
  listScheduledTaskRowsWithRuns(opts: { agentId?: string; scopeOwnerId?: string; runLimit?: number }): Promise<
    (ScheduledTaskWireRow & { recent_runs: ScheduledTaskRunWireRow[] })[]
  >;
  createAgentProfile(input: {
    id: string;
    name: string;
    model: string;
    channel: string;
    skillset: string;
    persona: string;
    status: AgentProfile["status"];
    createdAt: string;
    updatedAt: string;
      parentAgentId?: string | null;
  }, identity?: RequestIdentity): Promise<
    | { ok: true; profile: AgentProfile }
    | { ok: false; error: { code: "name_conflict" | "internal"; message: string } }
  >;
  updateAgentProfile(input: {
    id: string;
    name?: string;
    model?: string;
    skillset?: string;
    persona?: string;
    status?: AgentProfile["status"];
    updatedAt: string;
  }, identity?: RequestIdentity): Promise<
    | { ok: true; profile: AgentProfile }
    | {
        ok: false;
        error: {
          code: "not_found" | "name_conflict" | "no_changes" | "internal";
          message: string;
        };
      }
  >;
  listCustomSkillsets(scopeOwnerId?: string): Promise<CustomSkillsetWireRecord[]>;
  readCustomSkillset(id: string, scopeOwnerId?: string): Promise<CustomSkillsetWireRecord | null>;
  createCustomSkillset(input: {
    id: string;
    name: string;
    description: string;
    version: string;
    sourceYaml: string;
    manifest: SkillsetManifest;
    createdAt: string;
    updatedAt: string;
    ownerUserId: string;
  }): Promise<CreateCustomSkillsetWireResult>;
  updateCustomSkillset(input: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    sourceYaml?: string;
    manifest?: SkillsetManifest;
    updatedAt: string;
  }, scopeOwnerId?: string): Promise<UpdateCustomSkillsetWireResult>;
  deleteCustomSkillset(input: { id: string }, scopeOwnerId?: string): Promise<
    { ok: true; id: string } | { ok: false; error: { code: string; message: string } }
  >;
  recordManagerEvent(type: string, payload: unknown): Promise<void> | void;
  // task-keyed event recorder. Mirrors recordManagerEvent
  // but threads `taskId` into `event_log.trace_id` so subsequent
  // readManagerTaskEvents can scope by task_id without a join.
  recordManagerTaskEvent(
    type: string,
    payload: unknown,
    taskId: string,
  ): Promise<void> | void;
  // record one manager→subagent dispatch into the workflow
  // ledger (run/phase/agent). Fail-soft on the DO side; record-only.
  recordWorkflowDispatch(input: {
    parent_task_id: string;
    source_agent_id: string | null;
    subagent_agent_id: string | null;
    subagent_task_id: string;
    prompt_preview: string | null;
    // Multi-tenancy — the dispatching agent's resolved owner (admin sentinel
    // for the operator path). Stamped on the run row for owner-scoped reads.
    owner_user_id?: string | null;
  }): Promise<void> | void;
  // read the an earlier revision workflow run ledger tree (run →
  // phases → agents) by run_id. Null for unknown run_id.
  // Multi-tenancy — `scopeOwnerId` (undefined = admin/unfiltered) scopes the
  // read so a user only sees runs it owns.
  readWorkflowRun(input: { run_id: string }, scopeOwnerId?: string): Promise<unknown | null>;
  // the latest workflow run for an agent (by root_agent_id),
  // owner-scoped, as a run→phases→agents tree. Powers the user-app flowchart.
  readLatestAgentWorkflowRun(input: { agent_id: string }, scopeOwnerId?: string): Promise<unknown | null>;
  // 2026-06-19 — workspace file share (replaces fyimd). Owner-scoped reads
  // (undefined = admin/unfiltered); the user-facing routes pass the caller's
  // scope so a user only sees its own owner's shared files.
  listSharedFiles(scopeOwnerId?: string): Promise<unknown[]>;
  readSharedFile(input: { file_id: string }, scopeOwnerId?: string): Promise<{
    file_id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    content: string;
    note: string | null;
    source_agent_id: string;
    source_agent_name: string | null;
    owner_user_id: string;
    sha256: string;
    created_at: string;
  } | null>;
  // named workflow descriptor store (persistence only;
  // validation happens in managerOps before these calls).
  // Multi-tenancy — `owner_user_id` stamps the row + guards cross-tenant
  // name clobber; reads take `scopeOwnerId` (undefined = admin/unfiltered).
  saveWorkflowDescriptor(input: {
    name: string;
    descriptor_json: string;
    created_by_agent_id: string | null;
    owner_user_id: string;
  }): Promise<{ ok: boolean; name: string; version: number; error?: "name_taken" }>;
  readWorkflowDescriptor(input: {
    name: string;
  }, scopeOwnerId?: string): Promise<import("./workflowNamed").WorkflowDescriptorRow | null>;
  listWorkflowDescriptors(scopeOwnerId?: string): Promise<
    import("./workflowNamed").WorkflowDescriptorRow[]
  >;
  // provider ids that have a stored credential (no secrets).
  // identity scopes to the caller's own configured providers
  // (admin/undefined → global, unchanged).
  listConfiguredProviders(identity?: RequestIdentity): Promise<string[]>;
  // resolve which configured provider lists a (dynamic)
  // model id, from the cached discovery results. Null when none.
  // scoped to the caller's own providers when identity is given.
  resolveProviderForModel(input: { model: string }, identity?: RequestIdentity): Promise<{ provider: string } | null>;
  // returns ascending-by-created_at rows for a given task_id.
  // Empty array for unknown task_id (NOT an error) so the status route
  // can return `status:"unknown"` + `events:[]` per ADR §4.3.
  readManagerTaskEvents(taskId: string): Promise<ManagerTaskEventRow[]>;
  // PUSH v1 subagent summary aggregation. Emitted from the
  // subagent's `task.reply.finalized` path; keyed by `parent_task_id`
  // (event_log.trace_id). Names locked to `manager.subagent.summary`
  // at the DO @callable.
  pushSubagentArtifactSummary(
    parentTaskId: string,
    summary: SubagentSummary,
  ): Promise<void> | void;
  // read raw rows for the orchestrator to permission-filter.
  // Returns rows ordered by created_at DESC; bounded inside the DO at
  // 200 rows so a hot parent never explodes the response.
  readSubagentSummaries(opts: {
    parent_task_id?: string;
  }): Promise<SubagentSummaryRow[]>;
  // audit-grade manager merge event. Writes
  // `manager.task.merged` with `event_log.trace_id = parentTaskId`
  // so the merge sits in the same task-keyed stream as
  // received/started/waiting/replied/failed.
  recordManagerTaskMerged(
    parentTaskId: string,
    payload: ManagerTaskMergedPayload,
  ): Promise<void> | void;
  // read `manager.task.merged` rows keyed by
  // parent_task_id. Rows ORDER BY created_at ASC; payload is null on
  // JSON parse failure (fail-soft). Empty array for unknown
  // parent_task_id (NOT an error).
  readManagerTaskMergedEvents(
    parentTaskId: string,
  ): Promise<Array<{ event_id: number; created_at: string; payload: ManagerTaskMergedPayload | null }>>;
  // record `manager.task.completed` row. Writes to the
  // registry DO event_log with `event_type=manager.task.completed`
  // and `trace_id=parent_task_id`. Event name is locked at the
  // @callable layer so external callers cannot forge a different
  // event_type into the parent_task_id-keyed stream.
  recordManagerTaskCompleted(
    parentTaskId: string,
    payload: ManagerTaskCompletedPayload,
  ): Promise<void> | void;
  // read `manager.task.completed` rows keyed by
  // parent_task_id. Rows ORDER BY created_at ASC; payload is null on
  // JSON parse failure (fail-soft). Empty array for unknown
  // parent_task_id (NOT an error).
  readManagerTaskCompletedEvents(
    parentTaskId: string,
  ): Promise<Array<{ event_id: number; created_at: string; payload: ManagerTaskCompletedPayload | null }>>;
}

interface PerAgentStubSurface {
  submitTask(
    task: string,
    opts?: { displayText?: string; taskContext?: TaskContext },
  ): Promise<{
    ok: boolean;
    taskId: string;
    loopTriggered: boolean;
    replyText: string;
    envelopeId: string | null;
  }>;
  // Recent user/assistant dialog turns from the per-agent DO session history
  // (the conversation-restore source). Owner-check happens in the route before
  // this is RPC'd, so the method itself stays unscoped.
  getDialogTurns(limit: number): Promise<{ userText: string; assistantText: string | null; startedAt: number | null; usage: { in: number; out: number; cached: number | null; model: string | null } | null }[]>;
  // live partial text of the in-flight turn (null = idle). Owner
  // check happens in the route, same as getDialogTurns.
  getLivePartial(): Promise<{ text: string; updatedAt: number } | null>;
  // Sanitized context-window inspect (no SOUL / system prompt / tool payloads —
  // system-role messages are filtered in `buildContextInspect`). Owner-check
  // happens in the route before this is RPC'd, so the method stays unscoped.
  // Powers the user-app context viewer + title-bar token usage.
  inspectContext(input?: { lastN?: number }): Promise<ContextInspectResult>;
  // This agent's recent default-feed `actionUiIntents` (dispatch / browser /
  // file / repo / execution), already filtered + capped server-side. Fanned
  // out by `getUserActivity` for the cross-agent user-app activity feed.
  getActivityIntents(input?: { limit?: number }): Promise<{ id: string; type: string; title: string; sourceEventAt: number; life?: ActivityLifecycle }[]>;
  // per-agent custom-skillset loader sync fan-out.
  // Awaited after `managerUpdateAgent` changes the agent's
  // `skillset` so the next `getTools()` call narrows to the new
  // closure without waiting for the natural session-init refresh.
  refreshCustomSkillsetCache(): Promise<{
    profile_id: string;
    custom_skillset_ids: string[];
    effective_skillset_ids: string[] | null;
    fallback_reason: string | null;
  }>;
  // terminal-event-durable manager turn entrypoint.
  // Wraps `submitTask` and records `manager.task.replied` /
  // `manager.task.failed` from inside the DO so the persistence
  // write outlives the calling worker isolate (HTTP-triggered
  // `ctx.waitUntil` has a ~30s cap; real manager runs exceed it).
  submitManagerTask(
    text: string,
    managerTaskId: string,
    opts?: {
      displayText?: string;
      source?: string;
      conversationId?: string;
      // structured TaskContext for the subagent first turn.
      taskContext?: TaskContext;
    },
  ): Promise<{
    ok: boolean;
    taskId: string;
    loopTriggered: boolean;
    replyText: string;
    envelopeId: string | null;
  }>;
}

type GetAgentByNameNarrowRegistry = (ns: unknown, name: string) => Promise<RegistryStubSurface>;
type GetAgentByNameNarrowPerAgent = (ns: unknown, name: string) => Promise<PerAgentStubSurface>;

const resolveRegistry = getAgentByName as unknown as GetAgentByNameNarrowRegistry;
const resolvePerAgent = getAgentByName as unknown as GetAgentByNameNarrowPerAgent;

export interface ManagerEnv {
  AgentThursdayAgent: unknown;
  // Anthropic key presence gates external-model creation.
  ANTHROPIC_API_KEY?: string;
}

// key-presence check (never returns the value).
export function hasAnthropicKey(env: { ANTHROPIC_API_KEY?: string }): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
}

async function resolveRegistryStub(env: ManagerEnv): Promise<RegistryStubSurface> {
  return resolveRegistry(env.AgentThursdayAgent, DEMO_INSTANCE);
}

/**
 * resolve an agent's OWNER identity for agent-initiated dispatch.
 *
 * Reads the agent's own profile (admin read by exact id) and maps its
 * `owner_user_id`  to a `RequestIdentity`. The dispatcher then uses
 * THIS identity for the target-ownership check, so an agent-initiated dispatch
 * inherits its owner — a scoped agent can only dispatch within its own tenant.
 *
 * Returns `null` when the profile can't be resolved (RPC error / unknown id);
 * callers MUST fail closed (no dispatch), never fall back to admin — that would
 * be the fail-open hole this card exists to close.
 */
export async function resolveAgentOwnerIdentity(
  env: ManagerEnv,
  agentId: string,
): Promise<RequestIdentity | null> {
  try {
    const registry = await resolveRegistryStub(env);
    const profile = await registry.readAgentProfile(agentId);
    if (profile === null) return null;
    const owner = (profile as { owner_user_id?: string }).owner_user_id;
    return resolveRequestIdentity(typeof owner === "string" ? owner : null);
  } catch {
    return null;
  }
}

/**
 * 2026-06-29 — resolve an agent's configured model, for the "subagent defaults to
 * its manager's model" rule in `manager.agent_create` (the operator: 默认使用跟 manager 同源
 * 的模型). Reads the dispatching agent's profile via the registry. Returns null when
 * the profile/model can't be resolved — the adapter then fails closed (refuses the
 * create) rather than silently picking a possibly-wrong default.
 */
export async function resolveAgentModel(
  env: ManagerEnv,
  agentId: string,
): Promise<string | null> {
  try {
    const registry = await resolveRegistryStub(env);
    const profile = await registry.readAgentProfile(agentId);
    const model = profile === null ? null : (profile as { model?: unknown }).model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}


// narrow exported surface for the route layer's
// pre-validation (target_not_found + recordManagerTaskEvent for the
// initial `received` bracket). We do not export the full
// RegistryStubSurface to keep the route blast-radius small.
export interface ManagerRoutePreflightSurface {
  // optional identity scopes the target lookup to the caller.
  readAgentProfile(id: string, identity?: RequestIdentity): Promise<AgentProfile | null>;
  recordManagerTaskEvent(
    type: string,
    payload: unknown,
    taskId: string,
  ): Promise<void> | void;
  // turn share links (create owner-stamped, read by link).
  createTurnShare(
    input: { agent_id: string; agent_name?: string | null; title: string; content_md: string },
    identity?: RequestIdentity,
  ): Promise<{ ok: true; share_id: string } | { ok: false; error: string }>;
  readTurnShare(input: { share_id: string }): Promise<{
    share_id: string;
    agent_name: string | null;
    title: string;
    content_md: string;
    created_at: string;
  } | null>;
  // owner-scoped share management.
  listTurnShares(identity?: RequestIdentity): Promise<{
    share_id: string;
    agent_name: string | null;
    title: string;
    created_at: string;
  }[]>;
  deleteTurnShare(input: { share_id: string }, identity?: RequestIdentity): Promise<{ ok: boolean }>;
  // owner-scoped scheduled tasks (registry-DO table). Wire types
  // structurally match scheduledTaskOps.ts; kept inline so this module stays
  // importable by the node test runner without the ops import.
  createScheduledTaskRow(input: {
    id: string;
    ownerUserId: string;
    agentId: string;
    spec: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ ok: true; row: ScheduledTaskWireRow } | { ok: false; code: string; message: string }>;
  listScheduledTaskRows(opts: { agentId?: string; scopeOwnerId?: string }): Promise<ScheduledTaskWireRow[]>;
  updateScheduledTaskRow(input: {
    id: string;
    scopeOwnerId?: string;
    nowIso: string;
    changes: Record<string, unknown>;
  }): Promise<{ ok: true; row: ScheduledTaskWireRow } | { ok: false; code: string; message: string }>;
  deleteScheduledTaskRow(input: { id: string; scopeOwnerId?: string }): Promise<{ deleted: boolean }>;
  // schedules page read (owner cross-agent + run history).
  listScheduledTaskRowsWithRuns(opts: { agentId?: string; scopeOwnerId?: string; runLimit?: number }): Promise<
    (ScheduledTaskWireRow & { recent_runs: ScheduledTaskRunWireRow[] })[]
  >;
}

/** wire shape of a scheduled_task_run history row. */
export interface ScheduledTaskRunWireRow {
  task_id: string;
  schedule_id: string;
  agent_id: string;
  status: string;
  detail: string | null;
  started_at: string;
  settled_at: string | null;
}

/** wire shape of a scheduled_task row as routes consume it. */
export interface ScheduledTaskWireRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  schedule_kind: string;
  interval_s: number | null;
  at_hour: number | null;
  at_minute: number | null;
  at_weekday: number | null;
  prompt: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  last_status: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export async function resolveRegistryStubForRoute(
  env: ManagerEnv,
): Promise<ManagerRoutePreflightSurface> {
  return resolveRegistryStub(env);
}

/**
 * Owner-scoped conversation restore: returns the agent's recent dialog turns,
 * but ONLY if the caller owns the agent. The owner check runs through
 * `readAgentProfile(id, identity)` (426b — null for a scoped caller who
 * doesn't own it, exactly like a nonexistent agent, so no existence leak);
 * only then do we RPC the per-agent DO's `getDialogTurns`. `ok:false` = not
 * found / not owned (route maps to 404).
 */
/**
 * owner-scoped live partial text of the agent's in-flight turn.
 * Same owner-gate shape as getAgentDialog (404 when not owned = nonexistent).
 * Null partial = idle (no turn streaming right now).
 */
export async function getAgentLivePartial(
  env: ManagerEnv,
  agentId: string,
  identity: RequestIdentity | undefined,
): Promise<{ ok: true; partial: { text: string; updatedAt: number } | null } | { ok: false }> {
  const registry = await resolveRegistryStub(env);
  const profile = await registry.readAgentProfile(agentId, identity);
  if (profile === null) return { ok: false };
  const perAgent = await resolvePerAgent(env.AgentThursdayAgent, agentId);
  const partial = await perAgent.getLivePartial();
  return { ok: true, partial };
}

export async function getAgentDialog(
  env: ManagerEnv,
  agentId: string,
  identity: RequestIdentity | undefined,
  limit: number,
): Promise<{ ok: true; turns: { userText: string; assistantText: string | null; startedAt: number | null; usage: { in: number; out: number; cached: number | null; model: string | null } | null }[] } | { ok: false }> {
  const registry = await resolveRegistryStub(env);
  const profile = await registry.readAgentProfile(agentId, identity);
  if (profile === null) return { ok: false };
  const perAgent = await resolvePerAgent(env.AgentThursdayAgent, agentId);
  const turns = await perAgent.getDialogTurns(limit);
  return { ok: true, turns };
}

/**
 * owner-scoped LATEST workflow run for an agent, as a run→phases→
 * agents tree (or null). Powers the user-app workflow flowchart shown below the
 * activity feed when the session involves a declared workflow. Same owner-gate
 * shape as `getAgentDialog` (the caller must own the agent → 404 otherwise) AND
 * the run read itself is owner-scoped (defense in depth). The ledger lives on
 * the registry DO, so this reads through the registry stub.
 */
export async function getAgentWorkflowRun(
  env: ManagerEnv,
  agentId: string,
  identity: RequestIdentity | undefined,
): Promise<{ ok: true; run: unknown | null } | { ok: false }> {
  const registry = await resolveRegistryStub(env);
  const profile = await registry.readAgentProfile(agentId, identity);
  if (profile === null) return { ok: false };
  const run = await registry.readLatestAgentWorkflowRun({ agent_id: agentId }, scopeOwnerIdFor(identity));
  return { ok: true, run };
}

/**
 * 2026-06-19 — workspace file share (replaces fyimd). Owner-scoped list of the
 * caller's shared-file pool (metadata only). A scoped user sees only its own
 * owner's files; admin (operator console) sees all.
 */
export async function managerListSharedFiles(
  env: ManagerEnv,
  identity: RequestIdentity | undefined,
): Promise<unknown[]> {
  const registry = await resolveRegistryStub(env);
  return registry.listSharedFiles(scopeOwnerIdFor(identity));
}

/**
 * Owner-scoped single shared-file read (with body). Returns null when the file
 * doesn't exist OR isn't owned by the caller (no existence leak). Powers the
 * agent-pasted share link the owner user clicks.
 */
export async function managerReadSharedFile(
  env: ManagerEnv,
  fileId: string,
  identity: RequestIdentity | undefined,
): Promise<{ filename: string; mime: string; content: string; size_bytes: number } | null> {
  const registry = await resolveRegistryStub(env);
  const row = await registry.readSharedFile({ file_id: fileId }, scopeOwnerIdFor(identity));
  if (row === null) return null;
  return { filename: row.filename, mime: row.mime, content: row.content, size_bytes: row.size_bytes };
}

/**
 * Owner-scoped context-window inspect: returns the agent's sanitized context
 * view (visible messages + token usage + budget), but ONLY if the caller owns
 * the agent. Same owner-check shape as `getAgentDialog` (404 when not owned,
 * indistinguishable from nonexistent — no existence leak). The inspect payload
 * is sanitized server-side (`buildContextInspect` drops system-role messages;
 * `sanitizeMessage` drops reasoning + tool input/output), so the SOUL / system
 * prompt the operator hard-required protected is never exposed. `ok:false` → route 404.
 */
export async function getAgentContext(
  env: ManagerEnv,
  agentId: string,
  identity: RequestIdentity | undefined,
  lastN: number,
): Promise<{ ok: true; context: ContextInspectResult } | { ok: false }> {
  const registry = await resolveRegistryStub(env);
  const profile = await registry.readAgentProfile(agentId, identity);
  if (profile === null) return { ok: false };
  const perAgent = await resolvePerAgent(env.AgentThursdayAgent, agentId);
  const context = await perAgent.inspectContext({ lastN });
  return { ok: true, context };
}

export interface ActivityLifecycle {
  family: string;
  phase: string;
  status: string | null;
  agentId: string | null;
  agentName: string | null;
}

export interface ActivityFeedItem {
  id: string;
  type: string;
  title: string;
  created_at: number;
  // structured identity+phase for manager lifecycle intents, so
  // the feed can coalesce a subagent's create/dispatch events into one card.
  life?: ActivityLifecycle;
}

/**
 * Owner-scoped PER-AGENT activity feed (the operator 2026-06-17 — "why is every agent's
 * activity the same?"). The activity panel lives in an agent's workspace, so it
 * shows THAT agent's recent default-feed `actionUiIntents` (console parity — the
 * console's ActivityFeed renders the active context's intents). A subagent's
 * own browser/file work shows in ITS workspace, not the dispatching manager's.
 * Same owner-check shape as `getAgentContext` (404 when not owned). `ok:false`
 * → route 404.
 */
export async function getAgentActivity(
  env: ManagerEnv,
  agentId: string,
  identity: RequestIdentity | undefined,
  limit: number,
): Promise<{ ok: true; activity: ActivityFeedItem[] } | { ok: false }> {
  const registry = await resolveRegistryStub(env);
  const profile = await registry.readAgentProfile(agentId, identity);
  if (profile === null) return { ok: false };
  const perAgent = await resolvePerAgent(env.AgentThursdayAgent, agentId);
  const intents = await perAgent.getActivityIntents({ limit });
  return {
    ok: true,
    activity: intents.map((it) => ({
      id: it.id,
      type: it.type,
      title: it.title,
      created_at: it.sourceEventAt,
      ...(it.life ? { life: it.life } : {}),
    })),
  };
}

export interface UserActivityItem {
  agent_id: string;
  agent_name: string | null;
  id: string;
  type: string;
  title: string;
  created_at: number;
}

/**
 * Owner-scoped cross-agent activity feed (the operator 2026-06-17 — console parity).
 *
 * The user-app Activity panel must show the SAME kinds of events the console
 * surfaces — dispatch + browser + file/repo + execution — across the user's
 * agents. Critically, a subagent's browser/file work lives in the SUBAGENT's
 * DO, not the dispatching manager's, so this MUST aggregate across agents, not
 * read one. We list the caller's own agents (`listAgentProfiles(identity)` —
 * scoped users see only theirs; never another tenant's), cap to the most-
 * recently-updated `maxAgents` to bound the fan-out, RPC each DO's
 * `getActivityIntents` (already default-feed-filtered), then merge newest-first
 * and cap. Per-agent RPC failure degrades to `[]` (fail-soft, never break the
 * whole feed).
 */
export async function getUserActivity(
  env: ManagerEnv,
  identity: RequestIdentity | undefined,
  opts: { limit?: number; perAgent?: number; maxAgents?: number },
): Promise<UserActivityItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const perAgentCap = Math.min(Math.max(opts.perAgent ?? 12, 1), 30);
  const maxAgents = Math.min(Math.max(opts.maxAgents ?? 8, 1), 20);
  const registry = await resolveRegistryStub(env);
  const profiles = await registry.listAgentProfiles({ includeArchived: false }, identity);
  const agents = [...profiles]
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, maxAgents);
  const perAgentResults = await Promise.all(
    agents.map(async (a) => {
      try {
        const stub = await resolvePerAgent(env.AgentThursdayAgent, a.id);
        const intents = await stub.getActivityIntents({ limit: perAgentCap });
        return intents.map((it) => ({
          agent_id: a.id,
          agent_name: a.name,
          id: it.id,
          type: it.type,
          title: it.title,
          created_at: it.sourceEventAt,
        }));
      } catch {
        return [] as UserActivityItem[];
      }
    }),
  );
  return perAgentResults
    .flat()
    .sort((x, y) => y.created_at - x.created_at)
    .slice(0, limit);
}

// ── Helpers ───────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function mintAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

function annotateAgent(p: AgentProfile): AgentProfile & { agent_id: string } {
  return { ...p, agent_id: p.id };
}

// ── manager.agent_list ────────────────────────────────────────────────

export type ManagerListAgentsInput = { include_archived?: boolean };

export interface ManagerListAgentsOk {
  ok: true;
  agents: Array<AgentProfile & { agent_id: string }>;
  count: number;
}

export async function managerListAgents(
  env: ManagerEnv,
  input: ManagerListAgentsInput = {},
  identity?: RequestIdentity,
): Promise<ManagerListAgentsOk> {
  const stub = await resolveRegistryStub(env);
  const rows = await stub.listAgentProfiles({
    includeArchived: input.include_archived === true,
  }, identity);
  const agents = rows.map(annotateAgent);
  return { ok: true, agents, count: agents.length };
}

// ── manager.agent_create ──────────────────────────────────────────────

export type ManagerAgentCreateInput = {
  name: string;
  model: string;
  skillset: string;
  persona?: string;
  channel?: string;
  status?: AgentProfile["status"];
  // the creating AGENT's id (agent-initiated creates only).
  parentAgentId?: string | null;
};

export type ManagerAgentCreateError =
  | { code: "validation_failed"; message: string }
  | { code: "name_conflict"; message: string }
  | { code: AgentProfileValidationError["code"]; message: string }
  | { code: "internal"; message: string };

export type ManagerAgentCreateResult =
  | { ok: true; agent: AgentProfile & { agent_id: string } }
  | { ok: false; error: ManagerAgentCreateError };

export async function managerCreateAgent(
  env: ManagerEnv,
  input: ManagerAgentCreateInput,
  identity?: RequestIdentity,
): Promise<ManagerAgentCreateResult> {
  if (
    typeof input.name !== "string" ||
    input.name.length === 0 ||
    input.name.length > 80
  ) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "name must be a non-empty string ≤ 80 chars" },
    };
  }
  if (typeof input.model !== "string" || input.model.length === 0) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "model is required" },
    };
  }
  if (typeof input.skillset !== "string" || input.skillset.length === 0) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "skillset is required" },
    };
  }
  const stub = await resolveRegistryStub(env);
  // external models are runnable only with a stored credential.
  let configuredProviders: string[] = [];
  try {
    configuredProviders = await stub.listConfiguredProviders(identity);
  } catch { /* fail-soft: empty → external models rejected */ }
  if (hasAnthropicKey(env) && !configuredProviders.includes("anthropic")) {
    configuredProviders = [...configuredProviders, "anthropic"];
  }
  // accept a dynamically-discovered model (one a configured
  // provider's list-models returned, cached) even if it's not in the
  // static runtime registry. Resolved up front so the validator still
  // enforces the skillset rules.
  let dynamicModelOk = false;
  try {
    const dyn = await stub.resolveProviderForModel({ model: input.model }, identity);
    dynamicModelOk = dyn !== null && configuredProviders.includes(dyn.provider);
  } catch { /* fail-soft */ }
  const validation = await validateAgentProfileInput(
    { model: input.model, skillset: input.skillset },
    stub,
    { configuredProviders, dynamicModelOk },
    scopeOwnerIdFor(identity),
  );
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const persona = typeof input.persona === "string" ? input.persona.slice(0, 2000) : "";
  const channel = typeof input.channel === "string" && input.channel.length > 0
    ? input.channel
    : "manager";
  const status: AgentProfile["status"] = input.status ?? "initialized";
  const now = nowIso();
  const result = await stub.createAgentProfile({
    id: mintAgentId(),
    name: input.name,
    model: input.model,
    channel,
    skillset: input.skillset,
    persona,
    status,
    createdAt: now,
    updatedAt: now,
    parentAgentId: input.parentAgentId ?? null,
  }, identity);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const agent = annotateAgent(result.profile);
  await stub.recordManagerEvent(MANAGER_EVENT_NAMES.agentCreated, {
    agent_id: agent.agent_id,
    name: agent.name,
    model: agent.model,
    skillset: agent.skillset,
    status: agent.status,
    created_at: agent.created_at,
  });
  return { ok: true, agent };
}

// ── manager.agent_update ──────────────────────────────────────────────

export type ManagerAgentUpdateInput = {
  agent_id: string;
  name?: string;
  model?: string;
  skillset?: string;
  persona?: string;
  status?: AgentProfile["status"];
};

export type ManagerAgentUpdateError =
  | { code: "validation_failed"; message: string }
  | { code: "not_found"; message: string }
  | { code: "name_conflict"; message: string }
  | { code: "no_changes"; message: string }
  | { code: AgentProfileValidationError["code"]; message: string }
  | { code: "internal"; message: string };

export type ManagerAgentUpdateResult =
  | { ok: true; agent: AgentProfile & { agent_id: string } }
  | { ok: false; error: ManagerAgentUpdateError };

export async function managerUpdateAgent(
  env: ManagerEnv,
  input: ManagerAgentUpdateInput,
  identity?: RequestIdentity,
): Promise<ManagerAgentUpdateResult> {
  if (typeof input.agent_id !== "string" || input.agent_id.length === 0) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "agent_id is required" },
    };
  }
  if (input.name !== undefined && (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 80)) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "name must be a non-empty string ≤ 80 chars" },
    };
  }
  const stub = await resolveRegistryStub(env);
  // capture prior skillset BEFORE the update so we can
  // decide whether to fan out the per-agent refresh RPC. The
  // existing validation block already reads `current` when
  // model/skillset are present; we hoist it so the skillset path
  // sees a non-null value regardless.
  let priorSkillset: string | null = null;
  if (input.model !== undefined || input.skillset !== undefined) {
    const current = await stub.readAgentProfile(input.agent_id, identity);
    if (current === null) {
      return {
        ok: false,
        error: { code: "not_found", message: `agent not found: ${input.agent_id}` },
      };
    }
    priorSkillset = current.skillset;
    // same credential/dynamic-model awareness as create.
    // Without it, even a skillset-only update on an agent running a
    // discovered model re-validates that model and bounces as
    // unknown_model.
    const effectiveModel = input.model ?? current.model;
    let configuredProviders: string[] = [];
    let dynamicModelOk = false;
    try {
      configuredProviders = await stub.listConfiguredProviders(identity);
      const dyn = await stub.resolveProviderForModel({ model: effectiveModel }, identity);
      dynamicModelOk = dyn !== null && configuredProviders.includes(dyn.provider);
    } catch { /* static behavior */ }
    const validation = await validateAgentProfileInput(
      { model: effectiveModel, skillset: input.skillset ?? current.skillset },
      stub,
      { configuredProviders, dynamicModelOk },
      scopeOwnerIdFor(identity),
    );
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
  }
  const now = nowIso();
  const result = await stub.updateAgentProfile({
    id: input.agent_id,
    name: input.name,
    model: input.model,
    skillset: input.skillset,
    persona: input.persona,
    status: input.status,
    updatedAt: now,
  }, identity);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const agent = annotateAgent(result.profile);
  await stub.recordManagerEvent(MANAGER_EVENT_NAMES.agentUpdated, {
    agent_id: agent.agent_id,
    changed_fields: Object.entries({
      name: input.name,
      model: input.model,
      skillset: input.skillset,
      persona: input.persona !== undefined ? "<redacted>" : undefined,
      status: input.status,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k),
    updated_at: agent.updated_at,
  });
  // when the agent's `skillset` changed, push-refresh
  // the per-agent DO's custom-manifest cache + re-resolve effective
  // skillset so the next `getTools()` call narrows to the new
  // closure. Awaited so the manager surface returns AFTER the
  // refresh has happened — verifier evidence can rely on the next
  // inspect probe being up-to-date.
  //
  // Fail-soft: errors during the refresh do not roll back the
  // update (the persisted profile is the source of truth); we log
  // via recordManagerEvent so the audit trail still sees the
  // attempt.
  if (input.skillset !== undefined && input.skillset !== priorSkillset) {
    try {
      const perAgent = await resolvePerAgent(env.AgentThursdayAgent, input.agent_id);
      const refresh = await perAgent.refreshCustomSkillsetCache();
      await stub.recordManagerEvent("manager.agent.skillset.refreshed", {
        agent_id: agent.agent_id,
        prior_skillset: priorSkillset,
        new_skillset: input.skillset,
        custom_skillset_ids: refresh.custom_skillset_ids,
        effective_skillset_ids: refresh.effective_skillset_ids,
        fallback_reason: refresh.fallback_reason,
      });
    } catch (e) {
      await stub.recordManagerEvent("manager.agent.skillset.refresh_failed", {
        agent_id: agent.agent_id,
        prior_skillset: priorSkillset,
        new_skillset: input.skillset,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { ok: true, agent };
}

// ── manager.skillset_list ─────────────────────────────────────────────

export interface ManagerSkillsetListRow {
  id: string;
  name: string;
  description: string;
  version: string;
  source: "embedded" | "custom";
  status: "loaded" | "rejected" | "unknown";
  tool_count: number;
  skill_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface ManagerSkillsetListOk {
  ok: true;
  skillsets: ManagerSkillsetListRow[];
  count: number;
}

function loaderStatusToWireStatus(
  loaderStatus: "loaded" | "load_rejected" | undefined,
): "loaded" | "rejected" | "unknown" {
  if (loaderStatus === "loaded") return "loaded";
  if (loaderStatus === "load_rejected") return "rejected";
  return "unknown";
}

export async function managerListSkillsets(env: ManagerEnv, scopeOwnerId?: string): Promise<ManagerSkillsetListOk> {
  const stub = await resolveRegistryStub(env);
  const merged = await loadMergedManifests(stub, scopeOwnerId);
  const state = loadSkillsets(merged, { knownToolIds: STUB_KNOWN_TOOL_IDS });
  const customsById = new Map<string, CustomSkillsetWireRecord>();
  try {
    const customs = await stub.listCustomSkillsets(scopeOwnerId);
    for (const c of customs) customsById.set(c.id, c);
  } catch {
    // fail-soft; rows will surface as embedded-only
  }
  const rows: ManagerSkillsetListRow[] = merged.map((m) => {
    const entry = state.entries[m.id];
    const isCustom = customsById.has(m.id);
    const wire = customsById.get(m.id);
    return {
      id: m.id,
      name: m.manifest.name,
      description: m.manifest.description,
      version: m.manifest.version,
      source: isCustom ? "custom" : "embedded",
      status: loaderStatusToWireStatus(entry?.status),
      tool_count: m.manifest.tools.length,
      skill_count: m.manifest.skills.length,
      ...(wire ? { created_at: wire.created_at, updated_at: wire.updated_at } : {}),
    };
  });
  return { ok: true, skillsets: rows, count: rows.length };
}

// ── manager.skillset_read ─────────────────────────────────────────────

export type ManagerSkillsetReadInput = { skillset_id: string };

export type ManagerSkillsetReadResult =
  | {
      status: "ok";
      source: "embedded" | "custom";
      loader_status: "loaded" | "rejected" | "unknown";
      rejected_reason?: string;
      skillset: {
        id: string;
        name: string;
        description: string;
        version: string;
        purpose: string;
        tools: string[];
        skill_ids: string[];
        manifest: SkillsetManifest;
        created_at?: string;
        updated_at?: string;
      };
    }
  | { status: "failed"; reason: "not_found" | "invalid_input" | "internal"; message: string };

export async function managerReadSkillset(
  env: ManagerEnv,
  input: ManagerSkillsetReadInput,
  scopeOwnerId?: string,
): Promise<ManagerSkillsetReadResult> {
  if (typeof input.skillset_id !== "string" || input.skillset_id.length === 0) {
    return { status: "failed", reason: "invalid_input", message: "skillset_id is required" };
  }
  const stub = await resolveRegistryStub(env);
  const merged = await loadMergedManifests(stub, scopeOwnerId);
  const target = merged.find((m) => m.id === input.skillset_id);
  if (!target) {
    return {
      status: "failed",
      reason: "not_found",
      message: `skillset not found: ${input.skillset_id}`,
    };
  }
  const isCustom = !EMBEDDED_MANIFESTS.some((m) => m.id === input.skillset_id);
  let wire: CustomSkillsetWireRecord | null = null;
  if (isCustom) {
    try {
      wire = await stub.readCustomSkillset(input.skillset_id, scopeOwnerId);
    } catch {
      // fail-soft; timestamps will be omitted
    }
  }
  const state = loadSkillsets(merged, { knownToolIds: STUB_KNOWN_TOOL_IDS });
  const entry = state.entries[input.skillset_id];
  const loaderStatus = loaderStatusToWireStatus(entry?.status);
  const rejectedReason =
    entry?.status === "load_rejected" && entry.validation_errors.length > 0
      ? entry.validation_errors[0].message
      : undefined;
  return {
    status: "ok",
    source: isCustom ? "custom" : "embedded",
    loader_status: loaderStatus,
    ...(rejectedReason ? { rejected_reason: rejectedReason } : {}),
    skillset: {
      id: target.manifest.id,
      name: target.manifest.name,
      description: target.manifest.description,
      version: target.manifest.version,
      purpose: target.manifest.purpose,
      tools: [...target.manifest.tools],
      skill_ids: target.manifest.skills.map((s) => s.id),
      manifest: target.manifest,
      ...(wire ? { created_at: wire.created_at, updated_at: wire.updated_at } : {}),
    },
  };
}

// ── manager.skillset_create ───────────────────────────────────────────

export type ManagerSkillsetCreateInput = {
  id?: string;
  manifest: unknown;
};

export type ManagerSkillsetCreateError =
  | { code: CustomSkillsetValidationError["code"]; message: string; field?: string; tool_id?: string; id?: string }
  | { code: "id_conflict"; message: string }
  | { code: "internal"; message: string };

export type ManagerSkillsetCreateResult =
  | {
      ok: true;
      skillset: {
        id: string;
        name: string;
        description: string;
        version: string;
        source: "custom";
        tools: string[];
        skill_ids: string[];
        created_at: string;
        updated_at: string;
      };
    }
  | { ok: false; error: ManagerSkillsetCreateError };

export async function managerCreateSkillset(
  env: ManagerEnv,
  input: ManagerSkillsetCreateInput,
  // Owner of the new skillset = the creating agent's tenant (resolved in the
  // adapter from its own agent id). Custom skillsets are owner-scoped.
  ownerUserId: string,
): Promise<ManagerSkillsetCreateResult> {
  const validation = validateCustomSkillset({ id: input.id, manifest: input.manifest });
  if (!validation.ok) {
    const e = validation.error;
    return {
      ok: false,
      error: {
        code: e.code,
        message: e.message,
        ...("field" in e && e.field !== undefined ? { field: e.field } : {}),
        ...("tool_id" in e && e.tool_id !== undefined ? { tool_id: e.tool_id } : {}),
        ...("id" in e && e.id !== undefined ? { id: e.id } : {}),
      },
    };
  }
  const v = validation.value;
  const stub = await resolveRegistryStub(env);
  const now = nowIso();
  const result = await stub.createCustomSkillset({
    id: v.id,
    name: v.name,
    description: v.description,
    version: v.version,
    sourceYaml: "",
    manifest: v.manifest,
    createdAt: now,
    updatedAt: now,
    ownerUserId,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const stored = manifestFromWire(result.record);
  await stub.recordManagerEvent(MANAGER_EVENT_NAMES.skillsetCreated, {
    skillset_id: v.id,
    name: v.name,
    version: v.version,
    tool_count: stored.tools.length,
    skill_count: stored.skills.length,
    created_at: result.record.created_at,
  });
  return {
    ok: true,
    skillset: {
      id: result.record.id,
      name: result.record.name,
      description: result.record.description,
      version: result.record.version,
      source: "custom",
      tools: [...stored.tools],
      skill_ids: stored.skills.map((s) => s.id),
      created_at: result.record.created_at,
      updated_at: result.record.updated_at,
    },
  };
}

// ── manager.skillset_update ───────────────────────────────────────────

export type ManagerSkillsetUpdateInput = {
  skillset_id: string;
  manifest: unknown;
};

export type ManagerSkillsetUpdateError =
  | { code: CustomSkillsetValidationError["code"]; message: string; field?: string; tool_id?: string; id?: string }
  | { code: "not_found"; message: string }
  | { code: "no_changes"; message: string }
  | { code: "internal"; message: string };

export type ManagerSkillsetUpdateResult =
  | {
      ok: true;
      skillset: {
        id: string;
        name: string;
        description: string;
        version: string;
        source: "custom";
        tools: string[];
        skill_ids: string[];
        created_at: string;
        updated_at: string;
      };
    }
  | { ok: false; error: ManagerSkillsetUpdateError };

export async function managerUpdateSkillset(
  env: ManagerEnv,
  input: ManagerSkillsetUpdateInput,
  scopeOwnerId?: string,
): Promise<ManagerSkillsetUpdateResult> {
  if (typeof input.skillset_id !== "string" || input.skillset_id.length === 0) {
    return {
      ok: false,
      error: { code: "manifest_invalid_shape", message: "skillset_id is required" },
    };
  }
  const validation = validateCustomSkillset(
    { manifest: input.manifest },
    { expectedId: input.skillset_id },
  );
  if (!validation.ok) {
    const e = validation.error;
    return {
      ok: false,
      error: {
        code: e.code,
        message: e.message,
        ...("field" in e && e.field !== undefined ? { field: e.field } : {}),
        ...("tool_id" in e && e.tool_id !== undefined ? { tool_id: e.tool_id } : {}),
        ...("id" in e && e.id !== undefined ? { id: e.id } : {}),
      },
    };
  }
  const v = validation.value;
  const stub = await resolveRegistryStub(env);
  const now = nowIso();
  const result = await stub.updateCustomSkillset({
    id: v.id,
    name: v.name,
    description: v.description,
    version: v.version,
    // Omit sourceYaml so the stored row's source_yaml is PRESERVED (the op uses
    // `input.sourceYaml ?? row.source_yaml`). Previously this passed "" which
    // wiped a system skillset's seeded YAML on every edit. The manifest_json is
    // the runtime source of truth; source_yaml is the display/seed view.
    manifest: v.manifest,
    updatedAt: now,
  }, scopeOwnerId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const stored = manifestFromWire(result.record);
  await stub.recordManagerEvent(MANAGER_EVENT_NAMES.skillsetUpdated, {
    skillset_id: v.id,
    name: v.name,
    version: v.version,
    tool_count: stored.tools.length,
    skill_count: stored.skills.length,
    updated_at: result.record.updated_at,
  });
  // fan out a custom-manifest cache refresh to every
  // active agent currently bound to this skillset id. The per-agent
  // DO's `refreshCustomSkillsetCache()` (357a) re-pulls registry
  // customs and re-runs `_persistEffectiveSkillsetFromProfile`; the
  // next `getTools()` call rebuilds the snapshot from the refreshed
  // cache, so callable tool surface reflects the new manifest
  // without any agent skillset-id cycle.
  //
  // Fail-soft: refresh errors NEVER roll back the canonical manifest
  // update. Each per-agent attempt records either
  // `skillsetContentRefreshed` or `skillsetContentRefreshFailed` so
  // verifier audit/trace can distinguish content-update-triggered
  // refresh from 357a's agent-skillset-id-change-triggered refresh.
  // Helper body lives in `managerSkillsetContentFanout.ts` so the
  // suite can test the fan-out without dragging the `agents` DO
  // chain into node:test.
  await fanoutCustomSkillsetContentRefresh({
    stub,
    skillsetId: v.id,
    updatedAt: result.record.updated_at,
    resolvePerAgent: (id) => resolvePerAgent(env.AgentThursdayAgent, id),
  });
  return {
    ok: true,
    skillset: {
      id: result.record.id,
      name: result.record.name,
      description: result.record.description,
      version: result.record.version,
      source: "custom",
      tools: [...stored.tools],
      skill_ids: stored.skills.map((s) => s.id),
      created_at: result.record.created_at,
      updated_at: result.record.updated_at,
    },
  };
}

/**
 * 2026-06-19 — delete a custom skillset row (owner-scoped). Admin (undefined
 * scope) may delete any, including a de-embedded system row (fyimd
 * external-publishing cleanup); a scoped user only its own (mismatch →
 * not_found, no existence leak).
 */
export async function managerDeleteSkillset(
  env: ManagerEnv,
  skillsetId: string,
  scopeOwnerId?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: { code: string; message: string } }> {
  const stub = await resolveRegistryStub(env);
  const result = await stub.deleteCustomSkillset({ id: skillsetId }, scopeOwnerId);
  if (result.ok) {
    await stub.recordManagerEvent("manager.skillset.deleted", { skillset_id: skillsetId });
  }
  return result;
}

// ── manager.agent_message ─────────────────────────────────────────────

export type ManagerAgentMessageInput = {
  agent_id: string;
  text: string;
  conversation_id?: string;
  source?: string;
  // optional structured TaskContext (ADR §5). Carried
  // through the manager dispatch chain; recorded in the
  // `manager.agent_message.sent` event payload and promoted into the
  // subagent's first-turn `<task-context>` block.
  task_context?: TaskContext;
};

export type ManagerAgentMessageError =
  | { code: "invalid_input"; message: string }
  | { code: "target_not_found"; message: string }
  // an earlier revision D — distinct from `target_not_found`: input doesn't even
  // match the canonical `agent-<uuid>` shape, so the caller almost
  // certainly passed a display name / skillset name instead of the
  // real agent_id (the M9.1 manager-bug shape from an earlier revision).
  | { code: "agent_not_found"; message: string }
  | { code: "agent_loop_timeout"; message: string }
  | { code: "internal"; message: string };

export type ManagerAgentMessageResult =
  | {
      ok: true;
      status: "replied" | "accepted";
      agent_id: string;
      task_id: string;
      conversation_id?: string;
      envelope_id?: string;
      reply?: string;
      loop_triggered: boolean;
    }
  | {
      ok: false;
      status: "failed";
      agent_id: string;
      error: ManagerAgentMessageError;
    };

export async function managerSendAgentMessage(
  env: ManagerEnv,
  input: ManagerAgentMessageInput,
  identity?: RequestIdentity,
): Promise<ManagerAgentMessageResult> {
  if (typeof input.agent_id !== "string" || input.agent_id.length === 0) {
    return {
      ok: false,
      status: "failed",
      agent_id: "",
      error: { code: "invalid_input", message: "agent_id is required" },
    };
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    return {
      ok: false,
      status: "failed",
      agent_id: input.agent_id,
      error: { code: "invalid_input", message: "text is required and must be non-empty" },
    };
  }
  // verify the target agent exists on the registry BEFORE
  // touching the per-agent DO. Without this, `submitTask` against a
  // never-created agent_id would lazily instantiate a fresh DO with no
  // profile row, which is the bug an earlier revision explicitly closed.
  const registry = await resolveRegistryStub(env);
  // pass identity so a scoped user that does not own this agent
  // gets target_not_found here, BEFORE any per-agent DO is touched.
  const target = await registry.readAgentProfile(input.agent_id, identity);
  if (target === null) {
    // an earlier revision D — split the missing-target shape. If the caller didn't
    // even pass an `agent-<uuid>`-formatted string, return
    // `agent_not_found` so the manager LLM gets a clearer signal that
    // it passed a display name instead of resolving via
    // `manager.agent_list` first. A correctly-shaped but unregistered
    // id stays on the existing `target_not_found` code.
    const code: ManagerAgentMessageError["code"] = looksLikeAgentId(input.agent_id)
      ? "target_not_found"
      : "agent_not_found";
    const message = code === "agent_not_found"
      ? `agent_id '${input.agent_id}' does not match the canonical 'agent-<uuid>' shape; pass the real agent_id, not a display name`
      : `no agent registered with agent_id: ${input.agent_id}`;
    return {
      ok: false,
      status: "failed",
      agent_id: input.agent_id,
      error: { code, message },
    };
  }

  // submitTask AWAITS the agent loop. On long loops the ~90s CF DO RPC
  // envelope can fire; surface that as agent_loop_timeout (status:failed)
  // rather than masquerading as success or unhandled throw. Task is
  // injected into the target DO regardless — manager should not assume
  // "not delivered" on timeout.
  const perAgent = await resolvePerAgent(env.AgentThursdayAgent, input.agent_id);
  let raw: Awaited<ReturnType<PerAgentStubSurface["submitTask"]>>;
  try {
    raw = await perAgent.submitTask(
      input.text,
      input.task_context !== undefined
        ? { taskContext: input.task_context }
        : undefined,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|exceeded|envelope/i.test(message);
    const errorCode: ManagerAgentMessageError["code"] = isTimeout
      ? "agent_loop_timeout"
      : "internal";
    await registry.recordManagerEvent(MANAGER_EVENT_NAMES.agentMessageFailed, {
      agent_id: input.agent_id,
      reason: errorCode,
      message: message.slice(0, 200),
      source: input.source,
    });
    return {
      ok: false,
      status: "failed",
      agent_id: input.agent_id,
      error: { code: errorCode, message: message.slice(0, 200) },
    };
  }

  const status: "replied" | "accepted" = raw.loopTriggered ? "replied" : "accepted";
  await registry.recordManagerEvent(MANAGER_EVENT_NAMES.agentMessageSent, {
    agent_id: input.agent_id,
    task_id: raw.taskId,
    envelope_id: raw.envelopeId,
    loop_triggered: raw.loopTriggered,
    reply_length: raw.replyText.length,
    source: input.source,
    ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
    // record full TaskContext on the dispatch event so
    // inspect/event payloads surface it (ADR §5.2).
    ...(input.task_context !== undefined ? { task_context: input.task_context } : {}),
  });
  return {
    ok: true,
    status,
    agent_id: input.agent_id,
    task_id: raw.taskId,
    loop_triggered: raw.loopTriggered,
    ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
    ...(raw.envelopeId !== null ? { envelope_id: raw.envelopeId } : {}),
    ...(raw.replyText.length > 0 ? { reply: raw.replyText } : {}),
  };
}

// ── an earlier revision: async manager task helpers ─────────────────────────────

export function mintManagerTaskId(): string {
  return `task-${crypto.randomUUID()}`;
}

// UTF-8 byte cap for failure-message payloads. an earlier revision moved the
// worker-side failure-event emission into `managerTaskBackgroundPure.ts`,
// where it has its own local copy of the byte-cap helper; this file
// no longer needs the duplicate.

export interface ReadManagerTaskEventsSurface {
  readManagerTaskEvents(taskId: string): Promise<ManagerTaskEventRow[]>;
}

export async function readManagerTaskEvents(
  env: ManagerEnv,
  taskId: string,
): Promise<ManagerTaskEventRow[]> {
  const registry = await resolveRegistryStub(env);
  return registry.readManagerTaskEvents(taskId);
}

/**
 * env-resolving wrapper around the @callable
 * `readManagerTaskMergedEvents`. Pure module split keeps the route
 * layer free of DO-stub resolution.
 */
export async function readManagerTaskMergedEvents(
  env: ManagerEnv,
  parentTaskId: string,
): Promise<Array<{ event_id: number; created_at: string; payload: ManagerTaskMergedPayload | null }>> {
  const registry = await resolveRegistryStub(env);
  return registry.readManagerTaskMergedEvents(parentTaskId);
}

/**
 * env-resolving wrapper around the @callable
 * `readManagerTaskCompletedEvents`. Mirrors the an earlier revision merge
 * reader; pure module split keeps the route layer free of DO-stub
 * resolution.
 */
export async function readManagerTaskCompletedEvents(
  env: ManagerEnv,
  parentTaskId: string,
): Promise<Array<{ event_id: number; created_at: string; payload: ManagerTaskCompletedPayload | null }>> {
  const registry = await resolveRegistryStub(env);
  return registry.readManagerTaskCompletedEvents(parentTaskId);
}

/**
 * Background continuation for the manager message path (shared by
 * async waitUntil and sync inline awaits).
 *
 * Invoked from `managerRoutes.ts` via `ctx.waitUntil(...)` on the
 * async path AFTER the HTTP envelope has already returned `{ok,
 * task_id, status:"received"}`; invoked via direct `await` on the
 * sync path so the same bracket events fire on `?sync=1` smoke
 * probes.
 *
 * terminal-event durability fix.
 *
 * an earlier revision ran the full per-agent loop in this worker-side body,
 * recording `manager.task.replied` / `.failed` AFTER the long
 * `managerSendAgentMessage` await returned. Real multi-agent runs
 * (Manager take1.1, 2026-05-25) exceeded the ~30s HTTP-worker
 * `ctx.waitUntil` ceiling — the per-agent DO turn finished
 * (`task.reply.finalized`), but the worker isolate had already
 * been torn down, so terminal events never landed and GET
 * `/api/manager/tasks/:id` derived `timed_out` for what was
 * actually a successful run.
 *
 * 359a rewires the dispatch leg to call the new DO @callable
 * `submitManagerTask`, which records `manager.task.replied` /
 * `.failed` from INSIDE the manager DO context. The DO outlives the
 * calling worker, so the terminal write is durable even when the
 * worker dies mid-RPC.
 *
 * Contract:
 *   - Caller has ALREADY emitted `manager.task.received` via the
 *     shared preflight (so the GET status endpoint shows the task
 *     before this body runs).
 *   - This wrapper emits `manager.task.started` immediately (fast,
 *     worker-side; before any long await).
 *   - Pre-flight `readAgentProfile` for target_not_found (worker-side,
 *     fast). On miss: emit `manager.task.failed` worker-side and
 *     return; the DO is never touched.
 *   - Dispatch via `perAgent.submitManagerTask(text, managerTaskId,
 *     {source, conversationId})`. The DO records the terminal
 *     `manager.task.replied` itself; the worker does NOT double-emit
 *     on success.
 *   - On DO RPC throw: classify timeout-shaped messages as
 *     `agent_loop_timeout` (preserves the an earlier revision failure_class
 *     signal), record `manager.task.failed` worker-side. If the DO
 *     ALSO managed to record a terminal event before the RPC raised,
 *     `deriveManagerTaskStatus` folds events in `created_at ASC`
 *     order so the earlier event wins — no operator regression.
 *   - NEVER throws — `ctx.waitUntil` promises must settle cleanly,
 *     and the sync caller relies on the returned discriminated
 *     union (not on exceptions) to map HTTP status codes.
 *   - Returns the `ManagerAgentMessageResult` so the sync caller can
 *     emit it as the HTTP reply. Returns `null` ONLY if registry
 *     stub resolution itself failed (sync caller maps to 500).
 */
export async function runManagerTaskBackground(
  env: ManagerEnv,
  input: ManagerAgentMessageInput,
  managerTaskId: string,
  identity?: RequestIdentity,
): Promise<ManagerAgentMessageResult | null> {
  let registry: RegistryStubSurface;
  try {
    registry = await resolveRegistryStub(env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[manager.task ${managerTaskId}] registry resolve failed: ${message}`);
    return null;
  }
  // dispatch ownership chokepoint. A scoped dispatcher (the
  // initiating agent's owner, threaded from the adapter / executor) can only
  // dispatch to agents it owns; a cross-tenant target reads as target_not_found.
  // Runs BEFORE the recordWorkflowDispatch ledger write so a blocked dispatch
  // leaves no `workflow_dispatch` row under another tenant's parent_task_id.
  // Admin/undefined skips → byte-identical to pre-426h.
  const ownershipBlock = await checkDispatchOwnership(registry, input.agent_id, identity);
  if (ownershipBlock !== null) return ownershipBlock;
  // observable workflow run model. When this dispatch is a
  // subagent under a manager-led run (`task_context.parent_task_id`
  // present), record run/phase/agent into the workflow ledger BEFORE the
  // long dispatch. v1 run identity = `wfr-<parent_task_id>` (one manager
  // dispatch invocation; see workflowRunModel.ts). Fail-soft + record-only:
  // a ledger error must never break dispatch, and execution is unchanged.
  {
    const tc = input.task_context;
    const parentTaskId = tc && typeof tc.parent_task_id === "string" ? tc.parent_task_id : null;
    if (parentTaskId) {
      try {
        await registry.recordWorkflowDispatch({
          parent_task_id: parentTaskId,
          source_agent_id: typeof tc?.source_agent_id === "string" ? tc.source_agent_id : null,
          subagent_agent_id: input.agent_id,
          subagent_task_id: managerTaskId,
          prompt_preview: safePromptPreview(input.text),
          // Multi-tenancy — stamp the dispatching identity's owner so a scoped
          // user can owner-scope-read its own ad-hoc runs. Admin/undefined →
          // admin sentinel (operator unchanged). The dispatch-ownership block
          // above already ran, so `identity` is the verified dispatcher.
          owner_user_id: identity !== undefined ? ownerUserIdFor(identity) : ADMIN_USER_ID,
        });
      } catch { /* fail-soft: workflow ledger must not break dispatch */ }
    }
  }
  const result = await runManagerTaskBackgroundPure(
    registry,
    (id) => resolvePerAgent(env.AgentThursdayAgent, id),
    {
      agent_id: input.agent_id,
      text: input.text,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.conversation_id !== undefined
        ? { conversation_id: input.conversation_id }
        : {}),
      // propagate structured task_context through to the
      // DO-side `submitManagerTask` call.
      ...(input.task_context !== undefined
        ? { task_context: input.task_context }
        : {}),
    },
    managerTaskId,
  );
  // Map the pure helper's result back to ManagerAgentMessageResult.
  // The two shapes diverge only in TypeScript-level narrowing of the
  // error-code union; the runtime fields are identical.
  return result as ManagerAgentMessageResult;
}

// ── manager.subagent_summaries ────────────────────────────────────────
//
// read surface for the PUSH v1 subagent summary aggregation.
// Returns the calling manager's own subagent summaries only; queries
// from a different manager for someone else's `parent_task_id` get an
// empty list (NOT an error, NOT leaked metadata — ADR §6.3 / card §4).

export interface ManagerSubagentSummariesInput {
  parent_task_id?: string;
  source_agent_id?: string;
  limit?: number;
}

// ── manager cross-agent schedule tools ────────────────────────
// The base schedule tools  are self-only; these manager-surface
// orchestrators take an explicit `agent_id` so a manager can put agents of
// ITS OWN OWNER on a routine. Ownership is the an earlier revision posture: the
// dispatching agent's owner is resolved from itself (never the manager
// ctx), and a scoped owner's cross-tenant target reads as target_not_found.

export interface ManagerScheduleSpecInput {
  agent_id: string;
  kind: "interval" | "daily" | "weekly";
  prompt: string;
  interval_hours?: number;
  at_hour?: number;
  at_minute?: number;
  weekday?: number;
  utc_offset_minutes?: number;
}

export type ManagerScheduleResult =
  | { ok: true; schedule: ScheduledTaskWireRow }
  | { ok: false; error: { code: string; message: string } };

export async function managerScheduleCreate(
  env: ManagerEnv,
  input: ManagerScheduleSpecInput,
  identity: RequestIdentity | null,
): Promise<ManagerScheduleResult> {
  if (identity === null) {
    return { ok: false, error: { code: "internal", message: "cannot resolve dispatching agent's owner" } };
  }
  let registry: RegistryStubSurface;
  try {
    registry = await resolveRegistryStub(env);
  } catch (e) {
    return { ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
  const ownershipBlock = await checkDispatchOwnership(registry, input.agent_id, identity);
  if (ownershipBlock !== null) {
    return { ok: false, error: { code: "target_not_found", message: `no agent registered with agent_id: ${input.agent_id}` } };
  }
  const spec: Record<string, unknown> = { schedule_kind: input.kind, prompt: input.prompt };
  if (input.kind === "interval") {
    if (typeof input.interval_hours !== "number") {
      return { ok: false, error: { code: "validation_failed", message: "interval_hours is required for kind=interval" } };
    }
    spec.interval_s = Math.round(input.interval_hours * 3600);
  } else {
    if (typeof input.at_hour !== "number" || typeof input.utc_offset_minutes !== "number") {
      return {
        ok: false,
        error: { code: "validation_failed", message: "at_hour and utc_offset_minutes are required for daily/weekly (ask the user their timezone if unknown)" },
      };
    }
    if (input.kind === "weekly" && typeof input.weekday !== "number") {
      return { ok: false, error: { code: "validation_failed", message: "weekday (0=Sunday) is required for kind=weekly" } };
    }
    const u = localFieldsToUtc(
      input.at_hour,
      input.at_minute ?? 0,
      input.kind === "weekly" ? (input.weekday ?? 0) : null,
      input.utc_offset_minutes,
    );
    spec.at_hour = u.at_hour;
    spec.at_minute = u.at_minute;
    if (input.kind === "weekly") spec.at_weekday = u.at_weekday;
  }
  const result = await registry.createScheduledTaskRow({
    id: `sched-${crypto.randomUUID()}`,
    ownerUserId: ownerUserIdFor(identity),
    agentId: input.agent_id,
    spec,
    nowIso: new Date().toISOString(),
  });
  if (!result.ok) {
    return { ok: false, error: { code: result.code, message: result.message } };
  }
  return { ok: true, schedule: result.row };
}

export type ManagerScheduleListResult =
  | { ok: true; schedules: ScheduledTaskWireRow[]; count: number }
  | { ok: false; error: { code: string; message: string } };

export async function managerScheduleList(
  env: ManagerEnv,
  input: { agent_id?: string },
  identity: RequestIdentity | null,
): Promise<ManagerScheduleListResult> {
  if (identity === null) {
    return { ok: false, error: { code: "internal", message: "cannot resolve dispatching agent's owner" } };
  }
  try {
    const registry = await resolveRegistryStub(env);
    const rows = await registry.listScheduledTaskRows({
      ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
      scopeOwnerId: scopeOwnerIdFor(identity),
    });
    return { ok: true, schedules: rows, count: rows.length };
  } catch (e) {
    return { ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
}

export type ManagerScheduleCancelResult =
  | { ok: true; deleted: string }
  | { ok: false; error: { code: string; message: string } };

export async function managerScheduleCancel(
  env: ManagerEnv,
  input: { schedule_id: string },
  identity: RequestIdentity | null,
): Promise<ManagerScheduleCancelResult> {
  if (identity === null) {
    return { ok: false, error: { code: "internal", message: "cannot resolve dispatching agent's owner" } };
  }
  try {
    const registry = await resolveRegistryStub(env);
    const r = await registry.deleteScheduledTaskRow({
      id: input.schedule_id,
      scopeOwnerId: scopeOwnerIdFor(identity),
    });
    if (!r.deleted) {
      return { ok: false, error: { code: "not_found", message: `schedule not found: ${input.schedule_id}` } };
    }
    return { ok: true, deleted: input.schedule_id };
  } catch (e) {
    return { ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
}

export interface ManagerSubagentSummariesOk {
  ok: true;
  summaries: SubagentSummary[];
  count: number;
}

export interface ManagerSubagentSummariesErr {
  ok: false;
  error: { code: "validation_failed" | "internal"; message: string };
}

export type ManagerSubagentSummariesResult =
  | ManagerSubagentSummariesOk
  | ManagerSubagentSummariesErr;

export async function managerSubagentSummaries(
  env: ManagerEnv,
  input: ManagerSubagentSummariesInput,
  callingAgentId: string,
): Promise<ManagerSubagentSummariesResult> {
  if (typeof callingAgentId !== "string" || callingAgentId.length === 0) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "calling agent_id is required for permission boundary",
      },
    };
  }
  if (
    input.parent_task_id !== undefined &&
    (typeof input.parent_task_id !== "string" || input.parent_task_id.length === 0)
  ) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "parent_task_id must be a non-empty string when provided",
      },
    };
  }
  if (
    input.source_agent_id !== undefined &&
    (typeof input.source_agent_id !== "string" || input.source_agent_id.length === 0)
  ) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "source_agent_id must be a non-empty string when provided",
      },
    };
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== "number" || !Number.isFinite(input.limit) || input.limit < 1)
  ) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "limit must be a positive integer" },
    };
  }
  const stub = await resolveRegistryStub(env);
  const rows = await stub.readSubagentSummaries({
    ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
  });
  const summaries = filterSubagentSummariesForReader(rows, callingAgentId, {
    ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
    ...(input.source_agent_id !== undefined
      ? { source_agent_id: input.source_agent_id }
      : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  return { ok: true, summaries, count: summaries.length };
}

/**
 * `manager.task_merge` orchestrator. Thin wrapper over the
 * pure `emitManagerTaskMerged` helper (`managerTaskMergeOps.ts`) that
 * resolves the registry stub and adapts the @callable surface to the
 * helper's narrow `ManagerTaskMergeRegistrySurface` shape.
 *
 * Permission boundary is delegated to the pure helper (an earlier revision
 * `filterSubagentSummariesForReader`) — no source_agent_id cross-check
 * lives at the orchestrator layer.
 */
export async function managerTaskMerge(
  env: ManagerEnv,
  input: ManagerTaskMergeInput,
  callingAgentId: string,
): Promise<ManagerTaskMergeResult> {
  const stub = await resolveRegistryStub(env);
  const surface: ManagerTaskMergeRegistrySurface = {
    readSubagentSummaries: (opts) => stub.readSubagentSummaries(opts),
    recordManagerTaskMerged: (parentTaskId, payload) =>
      stub.recordManagerTaskMerged(parentTaskId, payload),
  };
  return emitManagerTaskMerged(surface, input, callingAgentId);
}

export type {
  ManagerTaskMergeInput,
  ManagerTaskMergeResult,
  ManagerTaskMergedPayload,
} from "./managerTaskMergeOps";

/**
 * `manager.task_complete` orchestrator. Thin wrapper over
 * the pure `emitManagerTaskCompleted` helper that resolves the
 * registry stub and adapts the @callable surface to the helper's
 * narrow `ManagerTaskCompleteRegistrySurface` shape.
 *
 * Merge precondition / verdict gating is delegated to the pure helper
 * (which uses the same `readManagerTaskMergedEvents` reader the
 * an earlier revision status side-field already consumes).
 */
export async function managerTaskComplete(
  env: ManagerEnv,
  input: ManagerTaskCompleteInput,
  callingAgentId: string,
): Promise<ManagerTaskCompleteResult> {
  const stub = await resolveRegistryStub(env);
  const surface: ManagerTaskCompleteRegistrySurface = {
    readManagerTaskMergedEvents: (parentTaskId) =>
      stub.readManagerTaskMergedEvents(parentTaskId),
    recordManagerTaskCompleted: (parentTaskId, payload) =>
      stub.recordManagerTaskCompleted(parentTaskId, payload),
  };
  return emitManagerTaskCompleted(surface, input, callingAgentId);
}

export type {
  ManagerTaskCompleteInput,
  ManagerTaskCompleteResult,
  ManagerTaskCompletedPayload,
  CompletionVerdict,
} from "./managerTaskCompleteOps";

// ── agent-side workflow executor entry ───────────────────
// Gives a manager agent the same capability the HTTP
// `/api/inspect/workflow-runs/execute` endpoint has: validate a
// declarative descriptor and start the durable an earlier revision executor.
// Reuses validateWorkflowDescriptor + deriveExecutorRunId verbatim —
// zero new execution semantics, only a new entry surface.

import {
  validateWorkflowDescriptor,
  deriveExecutorRunId,
} from "./workflowDescriptor";

export interface ManagerWorkflowExecuteResult {
  ok: boolean;
  run_id?: string;
  workflow_instance_id?: string;
  order?: string[];
  total_agents?: number;
  errors?: string[];
}

interface WorkflowExecutorBinding {
  create(opts: { id: string; params: unknown }): Promise<{ id: string }>;
}

export async function managerWorkflowExecute(
  env: ManagerEnv,
  input: { descriptor: unknown },
  // originating manager agent_id; threaded into the executor
  // params so the run's terminal status wakes the manager back up.
  callingAgentId?: string | null,
): Promise<ManagerWorkflowExecuteResult> {
  const validation = validateWorkflowDescriptor(input.descriptor);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const wf = (env as unknown as { WORKFLOW_EXECUTOR?: WorkflowExecutorBinding })
    .WORKFLOW_EXECUTOR;
  if (!wf || typeof wf.create !== "function") {
    return { ok: false, errors: ["workflow_executor_binding_missing"] };
  }
  // stamp the run OWNER so every dispatch the executor makes
  // inherits the initiating agent's owner. FAIL CLOSED: if a calling agent is
  // named but its owner can't be resolved, refuse to start the run (never run
  // it as admin). No calling agent (operator path is the separate HTTP trigger,
  // operator-only) → admin (owner_user_id omitted).
  let ownerUserId: string | undefined;
  if (callingAgentId) {
    const ownerIdentity = await resolveAgentOwnerIdentity(env, callingAgentId);
    if (ownerIdentity === null) {
      return { ok: false, errors: ["dispatch_owner_unresolved"] };
    }
    if (ownerIdentity.kind === "user") ownerUserId = ownerIdentity.userId;
  }
  const runId = deriveExecutorRunId(crypto.randomUUID().slice(0, 8));
  const instance = await wf.create({
    id: runId,
    params: {
      run_id: runId,
      descriptor: validation.descriptor,
      ...(callingAgentId ? { origin_agent_id: callingAgentId } : {}),
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
    },
  });
  return {
    ok: true,
    run_id: runId,
    workflow_instance_id: instance.id,
    order: validation.order,
    total_agents: validation.total_agents,
  };
}

export interface ManagerWorkflowStatusResult {
  ok: boolean;
  run?: unknown;
  code?: "not_found" | "owner_unresolved";
}

/**
 * Multi-tenancy — resolve a calling agent's owner into a READ scope id.
 * Returns `{ ok:true, scopeOwnerId }` where `scopeOwnerId` is the user's id
 * (scoped) or `undefined` (admin / no calling agent = unscoped, sees all).
 * FAIL CLOSED: a named-but-unresolvable owner returns `{ ok:false }` so the
 * caller refuses (never falls through to `undefined` = unfiltered = all-tenants).
 */
async function resolveWorkflowReadScope(
  env: ManagerEnv,
  callingAgentId: string | null | undefined,
): Promise<{ ok: true; scopeOwnerId: string | undefined } | { ok: false }> {
  const identity = callingAgentId
    ? await resolveAgentOwnerIdentity(env, callingAgentId)
    : null;
  return decideWorkflowReadScope(callingAgentId, identity);
}

export async function managerWorkflowStatus(
  env: ManagerEnv,
  input: { run_id: string },
  callingAgentId?: string | null,
): Promise<ManagerWorkflowStatusResult> {
  // Multi-tenancy — owner-scope the run read. FAIL CLOSED on unresolved owner.
  const scope = await resolveWorkflowReadScope(env, callingAgentId);
  if (!scope.ok) return { ok: false, code: "owner_unresolved" };
  const stub = await resolveRegistryStub(env);
  const tree = await stub.readWorkflowRun({ run_id: input.run_id }, scope.scopeOwnerId);
  if (tree === null || tree === undefined) {
    return { ok: false, code: "not_found" };
  }
  return { ok: true, run: tree };
}

// ── named workflow store: save / list / run-named ────────
// Validation lives HERE (shape via the an earlier revision validator, name via
// validateWorkflowName, args via substituteWorkflowArgs); the registry
// @callables own persistence only.

import {
  validateWorkflowName,
  substituteWorkflowArgs,
  summarizeDescriptorRow,
  type WorkflowDescriptorSummary,
} from "./workflowNamed";
// Multi-tenancy — pure fail-closed owner-stamp / read-scope decisions.
import {
  decideWorkflowSaveOwner,
  decideWorkflowReadScope,
} from "./workflowStoreOps";

export interface ManagerWorkflowSaveResult {
  ok: boolean;
  name?: string;
  version?: number;
  errors?: string[];
}

export async function managerWorkflowSave(
  env: ManagerEnv,
  input: { name: string; descriptor: unknown },
  callingAgentId: string | null,
): Promise<ManagerWorkflowSaveResult> {
  if (!validateWorkflowName(input.name)) {
    return { ok: false, errors: ["invalid_name: kebab-case, max 64 chars"] };
  }
  const validation = validateWorkflowDescriptor(input.descriptor);
  // Descriptors with {{args.*}} placeholders may fail prompt-level
  // checks only after substitution; the 385 validator is shape-level
  // (ids/deps/caps), so placeholders pass through it unchanged.
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  // Multi-tenancy — stamp the saving agent's OWNER so the row is owner-scoped
  // and the global `name` PRIMARY KEY can't be clobbered cross-tenant. FAIL
  // CLOSED via the pure decision: a named-but-unresolvable owner refuses the
  // save (mirrors dispatch_owner_unresolved); never falls back to admin.
  const ownerIdentity = callingAgentId
    ? await resolveAgentOwnerIdentity(env, callingAgentId)
    : null;
  const ownerDecision = decideWorkflowSaveOwner(callingAgentId, ownerIdentity);
  if (!ownerDecision.ok) {
    return { ok: false, errors: ["dispatch_owner_unresolved"] };
  }
  const stub = await resolveRegistryStub(env);
  const saved = await stub.saveWorkflowDescriptor({
    name: input.name,
    descriptor_json: JSON.stringify(validation.descriptor),
    created_by_agent_id: callingAgentId,
    owner_user_id: ownerDecision.ownerUserId,
  });
  if (!saved.ok) {
    // Cross-tenant name clobber refused at the DO (the name is owned by another
    // tenant the caller can't see).
    return { ok: false, name: saved.name, errors: [saved.error ?? "save_failed"] };
  }
  return { ok: true, name: saved.name, version: saved.version };
}

export interface ManagerWorkflowListResult {
  ok: boolean;
  workflows: WorkflowDescriptorSummary[];
  count: number;
  errors?: string[];
}

export async function managerWorkflowList(
  env: ManagerEnv,
  callingAgentId?: string | null,
): Promise<ManagerWorkflowListResult> {
  // Multi-tenancy — owner-scope the list. FAIL CLOSED on unresolved owner
  // (return an empty list, never the unfiltered all-tenants list).
  const scope = await resolveWorkflowReadScope(env, callingAgentId);
  if (!scope.ok) return { ok: false, workflows: [], count: 0, errors: ["owner_unresolved"] };
  const stub = await resolveRegistryStub(env);
  const rows = await stub.listWorkflowDescriptors(scope.scopeOwnerId);
  const workflows = rows.map(summarizeDescriptorRow);
  return { ok: true, workflows, count: workflows.length };
}

export interface ManagerWorkflowRunNamedResult extends ManagerWorkflowExecuteResult {
  name?: string;
  version?: number;
  missing_args?: string[];
}

export async function managerWorkflowRunNamed(
  env: ManagerEnv,
  input: { name: string; args?: Record<string, string> },
  callingAgentId?: string | null,
): Promise<ManagerWorkflowRunNamedResult> {
  // Multi-tenancy — owner-scope the descriptor read so a scoped user can only
  // run a workflow it owns. FAIL CLOSED on unresolved owner. A cross-tenant /
  // unknown name reads as null → `unknown_workflow` (no existence leak).
  const scope = await resolveWorkflowReadScope(env, callingAgentId);
  if (!scope.ok) return { ok: false, errors: ["owner_unresolved"] };
  const stub = await resolveRegistryStub(env);
  const row = await stub.readWorkflowDescriptor({ name: input.name }, scope.scopeOwnerId);
  if (row === null) {
    return { ok: false, errors: [`unknown_workflow: ${input.name}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.descriptor_json);
  } catch {
    return { ok: false, errors: ["stored_descriptor_unparseable"] };
  }
  const substituted = substituteWorkflowArgs(raw, input.args);
  if (!substituted.ok) {
    return {
      ok: false,
      errors: [`missing_args: ${(substituted.missing ?? []).join(", ")}`],
      missing_args: substituted.missing,
      name: row.name,
      version: row.version,
    };
  }
  const result = await managerWorkflowExecute(
    env,
    { descriptor: substituted.descriptor },
    callingAgentId,
  );
  return { ...result, name: row.name, version: row.version };
}
