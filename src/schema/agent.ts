import { z } from "zod";

import { ContentAuditEventSchema, ContentAuditSummarySchema } from "./contentHub";
import { DegradationDiagnosticsSchema } from "./degradation";

/**
 * Unified Object Model Schema and Worker Contract
 *
 * Single source of truth for the data the new Web shell (),
 * Current Task View (), and inspect surface () consume.
 * Built so 76 → 77/78 → 79 → 80/81 do not have to invent shapes.
 *
 * Legacy → new mapping (kept here so future readers can navigate):
 *
 *   legacy name                      | source module          | new location
 *   ---------------------------------|------------------------|-------------------------------------
 *   taskObject (TaskObject)          | M2 task lifecycle      | TaskView
 *   cliSession (CliSession)          | M3 cli session         | SessionView
 *   lastActionResult (ActionResult)  |  action result     | ArtifactView (kind="actionResult")
 *   developerLoopReview              | M2 reviewer            | summary text → MessageView (kind="summary")
 *                                    |                        | + traces → TraceEvent[] (inspect)
 *   pendingToolApproval              |  tool approval     | ApprovalView (kind="tool")
 *   pendingKanbanMutations[]         | M2 mutation            | ApprovalView (kind="mutation")
 *   debugTrace.recentToolEvents[]    |  trace             | ToolEvent[] (inspect only)
 *   debugTrace.lastLadderTier        |  ladder            | TaskView.ladderTier + .ladderReason
 *   debugTrace.lastAssistantSummary  |                    | MessageView (kind="assistant")
 *   deliverableGate.deliverable      | M2 deliverable         | ArtifactView (kind="deliverable")
 *
 *  user-layer reads only:
 *   session, currentTask, summaryStream, pendingApproval, replyNeed, latestResult
 *  inspect-layer reads only:
 *   inspectEntry (presence flags) + GET /api/inspect (full data)
 *
 * The /cli/* legacy endpoints stay live for TUI; a follow-up cleanup card
 * will retire them after  ships.
 */

export const SessionViewSchema = z.object({
  sessionId: z.string(),
  instanceName: z.string(),
  agentState: z.enum(["idle", "running", "waiting", "completed"]),
  loopStage: z.string(),
  autoContinue: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const TaskViewSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  lifecycle: z.enum(["draft", "active", "waiting", "review", "completed", "failed"]),
  loopStage: z.string(),
  readyForNextRound: z.boolean(),
  ladderTier: z.number().int().nullable(),
  ladderReason: z.string().nullable(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const MessageViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["system", "assistant", "user", "summary"]),
  text: z.string(),
  at: z.number().int(),
});
export type MessageView = z.infer<typeof MessageViewSchema>;

const ApprovalViewMutationSchema = z.object({
  id: z.string(),
  kind: z.literal("mutation"),
  reason: z.string(),
  diffSnippet: z.string(),
  cardRef: z.string().nullable(),
  mutationId: z.number().int(),
  createdAt: z.number().int(),
});
const ApprovalViewToolSchema = z.object({
  id: z.string(),
  kind: z.literal("tool"),
  reason: z.string(),
  toolName: z.string(),
  toolCallId: z.string(),
  createdAt: z.number().int(),
});
export const ApprovalViewSchema = z.discriminatedUnion("kind", [
  ApprovalViewMutationSchema,
  ApprovalViewToolSchema,
]);
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const ArtifactViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["deliverable", "actionResult", "checkpoint", "note"]),
  title: z.string(),
  textSummary: z.string(),
  createdAt: z.number().int(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ReplyNeedSchema = z.object({
  question: z.string(),
  sinceAt: z.number().int(),
});
export type ReplyNeed = z.infer<typeof ReplyNeedSchema>;

export const InspectEntrySchema = z.object({
  hasLadder: z.boolean(),
  hasTrace: z.boolean(),
  hasToolEvents: z.boolean(),
});
export type InspectEntry = z.infer<typeof InspectEntrySchema>;

/**
 * Inspect surface shapes — the real data producer arrives in .
 *  only declares the contract and ships a stub returning empty arrays.
 */

export const TraceEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  at: z.number().int(),
  traceId: z.string().nullable(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const LadderTierEntrySchema = z.object({
  tier: z.number().int(),
  toolName: z.string(),
  reason: z.string(),
  at: z.number().int(),
});
export type LadderTierEntry = z.infer<typeof LadderTierEntrySchema>;

export const ToolEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["call", "result"]),
  toolName: z.string(),
  payload: z.unknown(),
  at: z.number().int(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

// Action UI Intent backend view-model schemas. Mirror
// the types in `src/actionUiIntents.ts`; both kept in sync. The
// component.props field is `z.unknown()` because each component name
// has its own loose shape (DegradationCard sees a different prop set
// than PauseCard); v1 trusts the backend builder and renders defensively.
export const ActionUiIntentSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  sourceEventType: z.string(),
  sourceEventAt: z.number().int(),
  //  — added 3 tool-specific intent types alongside 's
  // 4 baseline types. The new types upgrade specific tool families
  // (content_search / content_read / execute / sandbox_exec) from the
  // generic chrome to dedicated panels with whitelisted props.
  //  — added `tool.workspace_mutation` for write/edit-shaped
  // events (checkpoint writes and future tool.workspace.* prefix).
  //  — added `tool.lifecycle` for manager tool dispatch /
  // result / error rows (agent_list / agent_message / agent_create /
  // agent_update) with whitelisted safe lifecycle fields.
  type: z.enum([
    "agent.degradation",
    "agent.pause",
    "generic.tool_event",
    "generic.event",
    "tool.search_results",
    "tool.file_read",
    "tool.execution_result",
    "tool.workspace_mutation",
    "tool.lifecycle",
    //  — workflow-era activity (run started/terminal +
    // executor-dispatched subagent terminal).
    "workflow.run",
  ]),
  priority: z.enum(["primary", "secondary", "debug"]),
  title: z.string(),
  summary: z.string().optional(),
  component: z.object({
    name: z.enum([
      "DegradationCard",
      "PauseCard",
      "GenericToolEventCard",
      "GenericEventCard",
      "SearchResultsPanel",
      "FilePreviewPanel",
      "ExecutionResultPanel",
      "WorkspaceChangePanel",
      "ManagerLifecyclePanel",
      "WorkflowRunPanel",
    ]),
    props: z.unknown(),
  }),
  placementHint: z.object({
    region: z.enum(["top", "feed", "debug"]),
    size: z.enum(["compact", "medium", "large"]),
    focusPath: z.string().nullable().optional(),
  }),
  safety: z.object({
    rawPayloadHidden: z.boolean(),
    truncated: z.boolean(),
  }),
  createdAt: z.number().int(),
});
export type ActionUiIntent = z.infer<typeof ActionUiIntentSchema>;

export const InspectSnapshotSchema = z.object({
  ladder: z.array(LadderTierEntrySchema),
  trace: z.array(TraceEventSchema),
  toolEvents: z.array(ToolEventSchema),
  debugRaw: z.unknown(),
  //  — most-recent ContentHub audit events. Newest-first. Empty
  // array when ContentHub has not been touched in the visible window.
  contentAudit: z.array(ContentAuditEventSchema).optional(),
  //  — aggregated evidence-pack view computed by ContentHubAgent
  // over the same audit rows. Best-effort: cross-DO fetch failures leave
  // this field undefined without breaking the rest of the snapshot.
  contentEvidence: ContentAuditSummarySchema.optional(),
  // read-only degradation diagnostics. Indexed view of
  // events Cards 117/119/102 already log into event_log. Optional so a DO
  // with no degradation events yet returns clean.
  degradationDiagnostics: DegradationDiagnosticsSchema.optional(),
  // Action UI Intent index for Action-aware Gen UI.
  // Derived on read from event_log; capped at 30 newest-first. Optional
  // so older clients ignore the field;  frontend will consume.
  actionUiIntents: z.array(ActionUiIntentSchema).optional(),
});
export type InspectSnapshot = z.infer<typeof InspectSnapshotSchema>;

/**
 * Agent Memory v1.
 * See  for the full design.
 *
 * Taxonomy mirrors Cloudflare's Agent Memory blog (2026-04-17): facts,
 * instructions, events, tasks. Profile boundary = DO instance (single
 * `agentthursday-dev` today). No vector / RRF / ingest in v1.
 */

export const MemoryTypeSchema = z.enum(["fact", "instruction", "event", "task"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryEntrySchema = z.object({
  id: z.number().int(),
  type: MemoryTypeSchema,
  key: z.string().nullable(),
  content: z.string(),
  source: z.string(),
  confidence: z.number().nullable(),
  active: z.boolean(),
  supersedesId: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MemoryRecallMatchSchema = z.object({
  id: z.number().int(),
  type: MemoryTypeSchema,
  key: z.string().nullable(),
  content: z.string(),
  score: z.number(),
  createdAt: z.number().int(),
});
export type MemoryRecallMatch = z.infer<typeof MemoryRecallMatchSchema>;

/**
 * GET /api/memory snapshot. Compact, leak-free shape for Web user layer.
 * Counts by type + recent active facts/instructions/events/tasks.
 *  §F-18: "show active facts/instructions and recent events/tasks".
 */
export const MemorySnapshotSchema = z.object({
  counts: z.object({
    fact: z.number().int(),
    instruction: z.number().int(),
    event: z.number().int(),
    task: z.number().int(),
    inactive: z.number().int(),
  }),
  recentFacts: z.array(MemoryEntrySchema),
  recentInstructions: z.array(MemoryEntrySchema),
  recentEvents: z.array(MemoryEntrySchema),
  recentTasks: z.array(MemoryEntrySchema),
});
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

//  —  AgentProfile shape (per design doc §4). Closed-list
// validation for `model` and `skillset` happens at the route layer
// (registry / yaml-manifest lookups) — kept out of this schema so it
// stays import-cycle-free.
//  —  lifecycle consensus rewrite. Four-layer model:
//   lifecycle persisted: initialized | archived | deleted_marker
//   runtime derived:       healthy | running | stale
//   policy flags:           accepts_tasks | dispatch_priority | retention_policy
//   origin:                 user_created | spawned
export const AgentProfileStatusSchema = z.enum(["initialized", "archived", "deleted_marker"]);
export type AgentProfileStatus = z.infer<typeof AgentProfileStatusSchema>;

export const AgentOriginSchema = z.enum(["user_created", "spawned"]);
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

export const RetentionPolicySchema = z.enum(["durable", "task_scoped", "ephemeral"]);
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  model: z.string().min(1),
  channel: z.string().min(1),
  skillset: z.string().min(1),
  persona: z.string().max(2000),
  status: AgentProfileStatusSchema,
  origin: AgentOriginSchema.default("user_created"),
  parent_agent_id: z.string().nullable().default(null),
  parent_task_id: z.string().nullable().default(null),
  accepts_tasks: z.boolean().default(true),
  retention_policy: RetentionPolicySchema.default("durable"),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 *  —  agent-centric naming correction. The user-facing
 * concept is **Agent** (a cloud agent instance), not "profile". The
 * underlying persisted row schema is unchanged; new code that wants to
 * speak the corrected vocabulary should import `Agent`.
 *
 * Legacy `AgentProfile` remains the persistence schema (column names
 * `agent_profiles.*`, route family `/api/agent-profiles/*`) — see
 * `` for the
 * compatibility boundary.
 */
export type Agent = AgentProfile;

export const AgentProfileCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  model: z.string().min(1),
  channel: z.string().min(1),
  skillset: z.string().min(1),
  persona: z.string().max(2000).default(""),
  status: AgentProfileStatusSchema.default("initialized"),
  origin: AgentOriginSchema.default("user_created"),
  parent_agent_id: z.string().nullable().optional().default(null),
  parent_task_id: z.string().nullable().optional().default(null),
  accepts_tasks: z.boolean().optional().default(true),
  retention_policy: RetentionPolicySchema.optional().default("durable"),
});
export type AgentProfileCreateInput = z.input<typeof AgentProfileCreateInputSchema>;
