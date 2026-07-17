import { routeAgentRequest, getAgentByName, unstable_callable as callable } from "agents";
import { AgentSearchProvider, type SessionMessage } from "agents/experimental/memory/session";
import { Think, Session, type StepContext, type StreamableResult, type ChatResponseResult } from "@cloudflare/think";
import { truncateLargeToolResultParts } from "./agent/messageTruncation";
import { buildAgentSafeReadTools, recordGateExecution } from "./skillset/agentToolBinding";
import type { EnvelopeStore as EnvelopeStoreType, EvidenceEnvelope as EvidenceEnvelopeType } from "./skillset/evidenceEnvelope";
import { runCodemodeProbe, type CodemodeProbeResult } from "./agent/codemodeProbe";
import { createWorker } from "@cloudflare/worker-bundler";
import { getSandbox } from "@cloudflare/sandbox";
import { createWorkersAI } from "workers-ai-provider";
// external model providers via Vercel AI SDK providers;
// fetch-based, Workers-compatible.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
// provider list-models discovery.
import { fetchProviderModels, type DiscoveredModel } from "./agent/providerModelList";
// BYO Discord bot registry helpers.
import { tool } from "ai";
import { toolApprovalUpdate, applyToolUpdate } from "agents/chat";
import type { AgentNamespace } from "agents";
import type { AgentThursdayState, ModelProfile, HumanResponse, RuntimeMode, RecoveryPolicy, RecoveryReview, RecoveryTimelineItem, OutcomeVerification, MutationReview, TaskObject, TaskLifecycle, LoopContract, DeliverableConvergence, ApprovalPolicy, DeveloperLoopReview, CliSession } from "./types";
import { getIntelligenceSignal, getProfileAwareness } from "./intelligence";
import {
  type InspectSnapshot,
  type DegradationDiagnostics,
  type WorkspaceFileList,
  type WorkspaceFileContent,
  type MemoryEntry,
  type MemoryRecallMatch,
  type MemorySnapshot,
  type MemoryType,
  type MemoryCandidatesResult,
} from "./schema";
import { requireSecret, CORS_HEADERS } from "./auth";
import { handleHealth } from "./routes/healthRoutes";
import { handleConfig, handleModels } from "./routes/configRoutes";
import { handleDemoRoutes } from "./routes/demoRoutes";
import { handleSandboxExecRoutes } from "./routes/sandboxExecRoutes";
import { handleMemoryRoutes } from "./routes/memoryRoutes";
import { handleAgentProfileRoutes } from "./routes/agentProfileRoutes";
import { handleCredentialRoutes } from "./routes/credentialRoutes";
import { handleDiscordBotRoutes } from "./routes/discordBotRoutes";
import { handleModelProviderRoutes } from "./routes/modelProviderRoutes";
import { handleUserRoutes } from "./routes/userRoutes";
import { handleDocumentRoutes } from "./routes/documentRoutes";
import type { ConverterEnv } from "./agent/documentConverter";
import { isOperatorOnlyPath, isAgentsSdkPath, isScopedSdkRpcForbidden } from "./routes/operatorOnly";
import { handleAgentRunRoutes } from "./routes/agentRunRoutes";
import { AgentRunWorkflow } from "./workflows/AgentRunWorkflow";
import { WorkflowExecutor } from "./workflows/WorkflowExecutor";
import { handleAdminRoutes } from "./routes/adminRoutes";
import { handleBrowserRoutes } from "./routes/browserRoutes";
import {
  handleApiWorkspace,
  handleApiWorkspaceFiles,
  handleApiWorkspaceFile,
} from "./routes/workspaceRoutes";
import { handleApiArtifact } from "./routes/artifactRoutes";
import { handleApiInspect } from "./routes/inspectRoutes";
import { handleCli } from "./routes/cliRoutes";
import { handleDevShell } from "./routes/devShellRoutes";
import { handleChannel } from "./routes/channelRoutes";
import { handleDiscordGateway } from "./routes/discordGatewayRoutes";
import { handleDiagDispatch } from "./routes/diagRoutes";
import { handleApiContent } from "./routes/contentHubRoutes";
import { handleInspectMutations } from "./routes/inspectMutationRoutes";
import { handleSkillsetRuntimeRoutes } from "./routes/skillsetRuntimeRoutes";
import { handleManagerRoutes } from "./routes/managerRoutes";
import { handleDispatchManagerRoutes } from "./routes/dispatchManagerRoutes";
import {
  DEMO_INSTANCE,
  DOGFOOD_TASK,
  OPERATOR_INSTANCE,
  isOperatorSurfaceName,
} from "./demoConstants";
import { listWorkspaceDir, readWorkspaceFile } from "./workspaceFiles";
import { classifyTruthfulness, type TruthfulnessClassification, renderTruthfulnessWarning, renderInlineJsonWarning, renderOrchestrationFabricationWarning, renderTruthfulnessReworkCorrection, decideTruthfulnessRework, TRUTHFULNESS_REWORK_SENTINEL, MANAGER_TIER_WATCHED_TOOL_NAMES, computeManagerTruthfulnessDrift } from "./toolTruthfulness";
import { detectGateIntent, checkGateIntentSatisfied, renderGateIntentViolation, hasExplicitNoToolDirective, renderNoToolGateIntentHonestReply, hasExplicitNoGateDirective, replyMakesGatePassClaim } from "./skillset/gateIntent";
import { detectReadIntent } from "./skillset/readIntent";
import { detectMutationIntent } from "./skillset/mutationIntent";
import type { GateResult } from "./skillset/gateRunner";
import { stripThinkingTagsFromReply } from "./skillset/replySanitizer";
import {
  applyRememberAckFallback,
  renderApprovalPendingReply,
  renderEmptyReplyFallback,
  renderMutationIntentNoExecutionReply,
  renderMutationUnwrappedPrependWarning,
  renderReadIntentNoExecutionReply,
} from "./replyEmptyFallback";
// generic agent-facing dynamic tool mapper (statically
// imported so AgentThursdayAgent.getTools() can synthesize tools without
// `await import(...)`).
import { buildDynamicSkillTools } from "./skillset/agentDynamicTools";
// an earlier revision/c — runtime snapshot / reload / disable types. Builder
// + summary helpers moved into `./agent/skillsetRuntime` by an earlier revision/b;
// only the type re-exports stay on this hot path.
import {
  type SkillsetRuntimeSnapshot,
  type SkillsetRuntimeSummary,
} from "./skillset/runtimeSnapshot";
// an earlier revision/b — read + mutation surface free functions backing the
// thin delegates below.
import {
  buildSkillsetSnapshotNow as buildSkillsetSnapshotNowFree,
  getSkillsetRuntimeSummary as getSkillsetRuntimeSummaryFree,
  runDisableSkillset as runDisableSkillsetFree,
  runEnableSkillset as runEnableSkillsetFree,
  runReloadSkillsetRuntime as runReloadSkillsetRuntimeFree,
  skillsetEnvLookup as skillsetEnvLookupFree,
  type SkillsetRuntimeMutationHost,
  type SkillsetRuntimeReadHost,
} from "./agent/skillsetRuntime";
// status/event view helpers. Thin delegates below keep the
// callable RPC surface; bodies live in `./agent/statusViews`.
import {
  buildLoopContractView,
  getEventLogView,
  getLastResetAtView,
  getLastTraceView,
  getRecentFinalizedReplyEventsView,
  getRecentTaskSubmittedEventsView,
  type StatusViewsHost,
} from "./agent/statusViews";
// inspect/debug view helpers. Thin delegates below keep the
// callable RPC surface; bodies live in `./agent/inspectViews`.
import {
  getDebugTraceView,
  getDegradationDiagnosticsView,
  getInspectSnapshotView,
  getUsageStatsView,
  type InspectViewsHost,
  type DebugTraceView,
  type UsageStatsView,
} from "./agent/inspectViews";
import { isDefaultFeedIntent } from "./actionUiIntents";
// recovery/readiness/review projection helpers. Thin delegates
// below keep the callable RPC surface; bodies live in `./agent/recoveryViews`.
// Mutation surfaces (`confirmKanbanMutation`, `setModelProfile`,
// `acknowledgeHumanResponse`) stay in this file (out of scope per kanban).
import {
  getRecentReviewNotesView,
  getRecentCheckpointsView,
  getRecentKanbanMutationsView,
  getPendingKanbanMutationsView,
  getChannelIngressReadinessView,
  getOutcomeVerificationView,
  getMutationReviewView,
  getRecoveryTimelineView,
  getRecoveryReviewView,
  type RecoveryViewsHost,
} from "./agent/recoveryViews";
// adapter index. Side-effect import; each adapter module
// calls registerDispatchHandler() at top level. Must precede any
// caller of buildDynamicSkillTools() / AGENT_DISPATCH_HANDLERS.
import "./skillset/adapters";
import {
  type ContextSnapshotViewModel,
} from "./contextLifecycle";
import type {
  ContextInspectResult,
  ContextResetResult,
  CompactContextResult,
  CompactionsList,
  ContextAnchorsResult,
  CompactPlanInput,
  CompactPlanResult,
  CompactPlanApplyResult,
  ActiveContext,
  ContextHistoryList,
  NewContextResult,
  SwitchContextResult,
  ArchiveChunkInput,
  ArchiveChunksInput,
  ArchiveFlushResult,
  ArchiveTrigger,
  DrainForArchiveResult,
  ConversationSearchInput,
  ConversationSearchResult,
  ArchiveInspectSummary,
  HygieneRunInput,
  HygieneRunResult,
  AgentProfile,
} from "./schema";

// `newContextId`, `COMPACTION_SUMMARY_PREVIEW_BUDGET`,
// `storedCompactionView`, and `collectFreshPreservedPoints` moved to
// `./agent/contextHelpers` + `./agent/agentConstants`. Imports above.

import {
  detectSupplierDegradation,
  emptySupplierTaskSignals,
  isStreamTruncatedError,
  renderSupplierDegradationWarning,
  type SupplierTaskSignals,
} from "./supplierSignal";
import { deriveTaskDegradationSummary } from "./degradationSummary";
import {
  isPauseEnabled,
  renderPauseMessage,
  shouldPauseForNeedsHuman,
} from "./pauseDecision";
import {
  applyReplyAssemblyChain,
  buildGateIntentAutodispatchPlan,
  buildPromptIntentGuardDecision,
  buildTurnScopeResetPatch,
  buildVisibleReplySafetyDecision,
  decideResumeShortCircuit,
  decideTaskIdentity,
  deriveSubmitTaskSealOpts,
  detectDanglingIntent,
  renderDanglingIntentNote,
  resolveTurnMaxSteps,
} from "./agent/submitTaskOps";
import { CHANNEL_HUB_INSTANCE } from "./channel";
import { ChannelHubAgent } from "./channelHub";
import { ContentHubAgent, CONTENT_HUB_INSTANCE } from "./contentHub";
import { DiscordGatewayAgent, DISCORD_GATEWAY_INSTANCE } from "./discordGatewayAgent";
// pure constants / helpers / types extracted from this
// module into focused `./agent/*` modules. Imports kept verbatim so
// every call site below continues to reference the bare identifier.
import { SOUL, OPERATOR_SOUL, NEUTRAL_SOUL, NEUTRAL_SOUL_GUARDED, selectBaseSoul, SOUL_PROMPT_VERSION } from "./agent/soulPrompt";
import { resolvePromptLeakGuardMode, detectSystemPromptLeak, renderSystemPromptRefusal } from "./agent/systemPromptLeakGuard";
import { sweepStaleDraftEnvelopesFree, envelopeSweeperBackstopFree, type EnvelopeSweeperHost } from "./agent/envelopeSweeperOps";
import { listAgentActivityRows, type AgentActivityRow } from "./agent/agentActivityOps";
import {
  KNOWN_TOOL_NAMES,
  CLI_COMMANDS,
  type EventLogRow,
} from "./agent/agentConstants";
import { readWorkerVersionMetadata } from "./agent/dashboardHelpers";
import {
  type AgentMigrationHost,
  runAgentMigrations,
  seedInitialKnowledgeIfNeeded,
  purgeAgentThursdaySeedKnowledge,
} from "./agent/migrations";
import {
  type ContextPointerHost,
  type ContextReadHost,
  type ContextWriteHost,
  ensureActiveContextFree,
  getActiveContextIdFree,
  inspectContextFree,
  ensureContextHistoryRowFree,
  listContextHistoryFree,
  newContextFree,
  resetContextFree,
  resolveCurrentModelProfileFree,
  runContextHygieneFree,
  switchContextFree,
} from "./agent/contextOps";
import {
  type ArchiveInspectHost,
  type ArchiveSearchHost,
  type ArchiveWriteHost,
  archiveChunksFree,
  conversationSearchFree,
  drainForArchiveFree,
  getArchiveInspectSummaryFree,
  writeArchiveFlushFree,
} from "./agent/archiveOps";
import {
  type MemoryReadHost,
  type MemoryWriteHost,
  forgetMemoryFree,
  getMemoryLayersFree,
  getMemoryLayersSqlFree,
  type MemoryLayersSql,
  buildMemoryExtractionPrompt,
  parseMemoryExtraction,
  consolidateMemoriesFree,
  listConsolidationRunsFree,
  parseEmbeddings,
  semanticDedupFilter,
  rankMemoriesSemanticFree,
  type ConsolidationLedgerEntry,
  type ExtractedMemory,
  getMemorySnapshotFree,
  listMemoriesEntriesFree,
  listMemoryCandidatesFree,
  readKnowledgeFree,
  recallMemoryFree,
  rememberMemoryFree,
} from "./agent/memoryOps";
import {
  type ArtifactOpsHost,
  type ListArtifactsResult,
  type ReadArtifactResult,
  type WriteArtifactResult,
  listArtifactsFree,
  readArtifactFree,
  writeArtifactFree,
} from "./agent/artifactOps";
import {
  type SharedFileRow,
  type SharedFileMeta,
  type SharedFileSqlHost,
  validateShareFileInput,
  insertSharedFileRow,
  listSharedFileRows,
  readSharedFileRow,
} from "./agent/sharedFileOps";
import {
  type DocOpsHost,
  type UploadedDocMeta,
  type UploadedDocRow,
  insertDocument,
  listDocuments,
  listPendingDocuments,
  getDocumentRow,
  deleteDocumentRow,
  markDocumentResolved,
  markDocumentFailed,
} from "./agent/uploadedDocumentOps";
import { fyimdPollOnce } from "./agent/documentConverter";
import { keywordSnippets } from "./agent/documentContent";
import {
  type CompactionReadHost,
  type CompactionWriteHost,
  applyCompactPlanFree,
  classifyContextAnchorsFree,
  compactContextFree,
  compactPlanFree,
  inspectContextSnapshotFree,
  listCompactionsFree,
} from "./agent/compactionOps";
import {
  type AgentProfileHost,
  type CreateAgentProfileResult,
  type UpdateAgentProfileResult,
  createAgentProfile,
  sweepSpawnedAgentRows,
  listAgentProfiles,
  readAgentProfile,
  seedOperatorAgentProfile,
  updateAgentProfile,
} from "./agent/agentProfileOps";
import {
  type ArchiveChunkRow,
  type ArchiveMigrationHost,
  type ArchiveReconcileSummary,
  archiveReconcileSummaryRows,
  ingestArchiveChunkRows,
  readArchiveChunkBatchRows,
} from "./agent/operatorArchiveMigrationOps";
import { AGENT_MEMORY_OPERATOR_PROFILE, cfMemoryIngestTurn } from "./agent/agentMemoryShadow";
import { type TurnShareHost, type TurnSharePublic, type TurnShareListItem, createTurnShareRow, readTurnSharePublicRow, listTurnSharesByOwnerRows, deleteTurnShareRow } from "./agent/turnShareOps";
import { buildDualRecallTools } from "./agent/tools/dualRecallTools";
import {
  type CredentialHost,
  type CredentialListRow,
  saveProviderCredentialRow,
  listProviderCredentialRows,
  deleteProviderCredentialRow,
  getProviderCredentialSecretRow,
  listConfiguredProviderRows,
  listProviderModelsJsonRows,
  cacheDiscoveredModels,
  listEnabledModelsJsonRows,
  setEnabledModels,
  updateCredentialApiKey,
  maskKeyHint,
} from "./agent/providerCredentialOps";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "./agent/credentialCrypto";
import {
  safeJsonStringArray,
  findDiscordBotOwner,
  saveDiscordBotRow,
  listDiscordBotRows,
  deleteDiscordBotRow,
  getDiscordBotSecretRows,
  reencryptDiscordBotTokenRow,
  type DiscordBotHost,
} from "./agent/discordBotOps";
import { type RequestIdentity, resolveRequestIdentity, ownerUserIdFor, scopeOwnerIdFor, USER_ID_HEADER, ADMIN_USER_ID } from "./agent/requestIdentity";
import {
  type AppUser,
  type UserOpsHost,
  userResolve,
  userGetById,
  userListPending,
  userListAll,
  userApprove,
  userSetStatus,
  userDelete,
} from "./agent/userOps";
import {
  type EmailServiceBinding,
  shouldSendWelcomeEmail,
  sendWelcomeEmail,
} from "./agent/welcomeEmail";
import {
  type CustomSkillsetHost,
  type CustomSkillsetWireRecord,
  type CreateCustomSkillsetInput,
  type CreateCustomSkillsetWireResult,
  type UpdateCustomSkillsetInput,
  type UpdateCustomSkillsetWireResult,
  type DeleteCustomSkillsetResult,
  createCustomSkillsetWire,
  listCustomSkillsetsWire,
  manifestFromWire,
  readCustomSkillsetWire,
  updateCustomSkillsetWire,
  deleteCustomSkillset as deleteCustomSkillsetRow,
  seedSystemSkillsets,
} from "./agent/customSkillsetOps";
// scheduled tasks: pure ops for the registry-DO table + the
// dispatch entrypoint reused from the manager message path.
import {
  type ScheduledTaskHost,
  type ScheduledTaskRow,
  type ScheduledTaskWithRuns,
  type ScheduleSpecInput,
  type CreateScheduleResult,
  type UpdateScheduleResult,
  createScheduledTask,
  listScheduledTasks,
  listScheduledTasksWithRuns,
  updateScheduledTask,
  deleteScheduledTask,
  claimDueScheduledTasks,
  recordScheduledRunStart,
  recordScheduledRunResult,
} from "./agent/scheduledTaskOps";
import { runManagerTaskBackground, type ManagerEnv } from "./agent/managerOps";
import { advanceFtsBackfill } from "./agent/archiveFtsOps";
import { composePersonaBlock } from "./agent/personaWeave";
import {
  defaultAgentRuntimeModel,
  resolveAgentRuntimeModel,
  type AgentRuntimeModelEntry,
} from "./agent/agentModelRuntime";
// bounded JSON string-array parse for discord_bot channels.
// 智谱 OpenAI-compatible endpoint. createOpenAI appends /chat/completions etc.
const ZHIPU_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
// xAI Grok (OpenAI-compatible; MUST dispatch via .chat(), see zhipu note).
const GROK_DEFAULT_BASE_URL = "https://api.x.ai/v1";
// periodic consolidation checkpoint: consolidate only once a
// long-lived agent has accumulated this many new dialog turns. the operator 2026-06-25 kept
// this at 8 (not 1) because a complete-enough conversation extracts more meaningful
// memory than per-turn fragments. A separate one-shot fires when a TEMPORARY subagent
// finalizes (see the submitTask trigger) so short subagent tasks aren't missed.
const MEMORY_CONSOLIDATION_TURN_THRESHOLD = 8;
// M9.4 (2026-06-25) — truthfulness rework cap (the operator: "三次然后旧 warning"). When a
// turn fabricates a tool claim but dispatched NO real tool, re-run the model with
// a correction up to this many times before falling back to the warn-append.
// Operationally overridable via env.AGENT_THURSDAY_TRUTHFULNESS_MAX_REWORKS (0 = disable
// reworks, keep pure warn — a kill switch for this new core-loop behavior),
// clamped to [0, 5].
const MAX_TRUTHFULNESS_REWORKS = 3;
import {
  resolveEffectiveSkillset,
  type EffectiveSkillsetResult,
} from "./agent/agentSkillsetRuntime";
import { EMBEDDED_MANIFESTS, type EmbeddedManifest } from "./skillset/manifests";
import {
  type AgentRunHost,
  type AgentRunRow,
  type AgentRunListRow,
  type CreateAgentRunRowInput,
  type ListAgentRunsOptions,
  type MarkAgentRunCompleteInput,
  type MarkAgentRunFailedInput,
  type MarkAgentRunAwaitingEventInput,
  type MarkAgentRunTimedOutInput,
  createAgentRunRow,
  readAgentRunRow,
  listAgentRunRows,
  markAgentRunCompleteRow,
  markAgentRunFailedRow,
  markAgentRunAwaitingEventRow,
  markAgentRunTimedOutRow,
} from "./agent/agentRunOps";
import {
  type DevShellOpsHost,
  type DevShellWriteHost,
  devShellDispatchFree,
  devShellGateRunFree,
  devShellObservabilityCheckFree,
  devShellWriteDispatchFree,
  getGateJobStatusFree,
  startGateJobFree,
} from "./agent/devShellOps";
import {
  type EnvelopeCrudHost,
  type EnvelopeStoreHost,
  ENVELOPE_SWEEPER_ALARM_DELAY_S as ENVELOPE_SWEEPER_ALARM_DELAY_S_VALUE,
  buildEnvelopeReplyMarker,
  devShellEnvelopeAddGateFree,
  devShellEnvelopeAddToolFree,
  devShellEnvelopeGetFree,
  devShellEnvelopeGetLatestTerminalFree,
  devShellEnvelopeListByTaskFree,
  devShellEnvelopeListFree,
  devShellEnvelopeSealFree,
  devShellEnvelopeStartFree,
  ensureEnvelopeStoreFree,
  ensureEnvelopeStoreSyncFree,
  resolveActiveDraftEnvelopeIdFree,
} from "./agent/envelopeOps";
// envelope read-only projections extracted from
// `server.ts`. Free helpers consume a narrow Host (`sql` +
// `ensureEnvelopeStoreSync`); the four private accessors below
// stay byte-equal at the call-site surface so dashboard / status
// / approval-policy derivations are unaffected.
import {
  type EnvelopeStatusViewsHost,
  getCurrentTaskFinalReplyView,
  getNewestEnvelopeForTaskView,
  hasSealedPassEnvelopeForCurrentTaskView,
  isHandledNoToolGateIntentFailView,
} from "./agent/envelopeStatusViews";
// ChannelHub fallback reply helper extracted from
// `server.ts`. Free helper consumes a narrow Host (`getChannelStub`
// + `logEvent`); the DO namespace + instance name resolution stays
// here at the composition root. Two thin call sites in the lazy /
// alarm sweepers preserve the existing `result.sealed &&
// !result.idempotentNoop` guard so ChannelHub-side dedupe ownership
// is unchanged.
import {
  type ChannelHubFallbackStubLike,
  type EnvelopeFallbackReplyHost,
  enqueueChannelHubFallbackReplyFree,
} from "./agent/envelopeFallbackReply";
import {
  clampUtf8Bytes,
  FAILURE_MESSAGE_BYTE_CAP,
} from "./agent/managerTaskBackgroundPure";
import {
  runWithManagerTurnContext,
  getManagerTurnContext,
} from "./agent/managerTurnContext";
import {
  renderTaskContextBlock,
  renderTaskContextBlockPreview,
  TaskContextSchema,
  type TaskContext,
} from "./agent/taskContext";
import {
  buildSubagentSummary,
  SUBAGENT_SUMMARY_EVENT_NAME,
  type SubagentSummary,
  type SubagentSummaryRow,
} from "./agent/subagentSummaryOps";
import {
  SUBAGENT_INSIGHT_EVENT_NAME,
  buildSubagentInsightPayload,
  filterInsightsByOwner,
  insightsToCandidates,
  type SubagentInsightPayload,
} from "./agent/subagentInsightOps";
import {
  deriveManagerTaskStatus,
  MANAGER_TASK_EVENT_NAMES,
  type ManagerTaskEventRow,
} from "./agent/managerTaskStatus";
import {
  safePromptPreview,
  assembleWorkflowRunTree,
  type WorkflowRunRow,
  type WorkflowPhaseRow,
  type WorkflowAgentRow,
  type WorkflowRunTree,
} from "./agent/workflowRunModel";
// named workflow descriptor store row type.
import type { WorkflowDescriptorRow } from "./agent/workflowNamed";
import {
  saveWorkflowDescriptorRow,
  readWorkflowDescriptorRow,
  listWorkflowDescriptorRows,
  recordWorkflowDispatchRows,
  recordWorkflowRunStartRows,
  upsertWorkflowPhaseRow,
  updateWorkflowPhaseStatusRow,
  recordWorkflowAgentRow,
  updateWorkflowAgentStatusRow,
  updateWorkflowRunStatusRow,
  type WorkflowStoreHost,
} from "./agent/workflowStoreOps";
import {
  MANAGER_TASK_MERGED_EVENT_NAME,
  type ManagerTaskMergedPayload,
} from "./agent/managerTaskMergeOps";
import {
  MANAGER_TASK_COMPLETED_EVENT_NAME,
  type ManagerTaskCompletedPayload,
} from "./agent/managerTaskCompleteOps";
import type { LifecycleTaskEvidence } from "./agent/agentLifecycleView";
import { buildBrowserTools } from "./agent/tools/browserTools";
import { buildContentTools } from "./agent/tools/contentTools";
import { buildConversationTools } from "./agent/tools/conversationTools";
import { buildScheduleTools } from "./agent/tools/scheduleTools";
import { buildCoreTools } from "./agent/tools/coreTools";
import { buildExecutionTool } from "./agent/tools/executionTools";
import { buildMemoryTools } from "./agent/tools/memoryTools";
import { buildShareFileTools } from "./agent/tools/shareFileTools";
import { buildDocumentTools } from "./agent/tools/documentTools";

export type { AgentThursdayState };
// preserve external import path `from "../server"` used by
// `src/routes/cliRoutes.ts`. The implementation lives in
// `./agent/dashboardTypes`; this is a type-only re-export erased at
// build time. Other moved identifiers had no external consumers.
export type { DashboardCore, DashboardSection } from "./agent/dashboardTypes";
// `getDashboardCore` body extracted to `./agent/dashboardOps`.
// `server.ts` keeps the `@callable()` decorator on a thin delegate
// (see L~4486) and exposes `_dashboardCoreHost()` so the free function
// reaches DO state through a narrow Host instead of the full agent.
// `buildDashboardSection` route-layer composer body
// extracted to the same module. `server.ts` constructs
// `DashboardSectionDeps` inline at the `/cli/status` route closure;
// `AgentThursdayAgent` / `Env` / `getAgentByName` never leak into the module.
import type { DashboardCoreHost, DashboardSectionDeps } from "./agent/dashboardOps";
import { buildDashboardSectionFree, getDashboardCoreFree } from "./agent/dashboardOps";
export { Sandbox } from "@cloudflare/sandbox";
export { ChannelHubAgent };
export { ContentHubAgent };
export { DiscordGatewayAgent };
// re-export AgentRunWorkflow so wrangler's `[[workflows]]`
// `class_name = "AgentRunWorkflow"` resolves against the worker entry
// module at deploy time. Placeholder workflow; real AgentThursdayAgent
// invocation arrives in the card AFTER 345.
export { AgentRunWorkflow };
export { WorkflowExecutor };

// active-context / DO routing helpers extracted to
// `./routes/contextRouting.ts`. Re-imported here so existing call
// sites stay verbatim. See module docstring for invariants
// (an earlier revision preserved). Only the two helpers the
// composition root actually calls are pulled in; the rest are
// imported by their direct consumers (or remain internal to the
// routing module).
import {
  getCanonicalActiveAgentThursdayAgentStub,
  getCanonicalActiveContextDoName,
  resolveCanonicalActiveContextRoute,
} from "./routes/contextRouting";

// an earlier revision v2 — `DOGFOOD_TASK` moved to `./demoConstants` so the
// Worker entry module (`src/server.ts`) no longer exports a string
// constant. See `./demoConstants.ts`.

// model context window + threshold policy lives in
// `src/contextWindowRegistry.ts` as a typed registry. The previous
// hardcoded 8K/24K absolutes  didn't make sense
// against 256K/1M model windows; ratios scale across model sizes.
// `computeContextBudgetFree` (in `./agent/contextOps`) reads the
// registry; UI receives the already-computed absolute values via
// `contextBudget`.

// `DebugTraceShape`, `PendingMutationRow`,
// `DIALOG_PREVIEW_SUFFIX_RE`, `DIALOG_LOOP_LAST_MSG_RE`, and
// `buildWorkspaceSnapshot` moved to `./workspaceSnapshot.ts` so the
// `/api/workspace` route handler can live in `./routes/workspaceRoutes.ts`
// without re-importing entry-module non-handler exports
// (an earlier revision v2 workerd-startup constraint).


// an earlier revision v2 — `buildCliResultView` / `buildM3CliLoopDemo` /
// `buildM4TuiWorkflowDemo` moved to `./demoConstants` so the Worker
// entry module (`src/server.ts`) only exports Durable Object classes
// and the default `fetch` handler. See `./demoConstants.ts`.

// `DashboardCore`, `DashboardOutboxRow`, `DashboardVersion`,
// `DashboardPatchApplyOutboxRow`, `DashboardSection` moved to
// `./agent/dashboardTypes`; `readWorkerVersionMetadata` moved to
// `./agent/dashboardHelpers`.
// `buildDashboardSection` route-layer composer body
// moved to `./agent/dashboardOps.buildDashboardSectionFree`. The
// `/cli/status` route closure constructs `DashboardSectionDeps`
// inline so the composer reaches the ChannelHub stub + worker
// version metadata through narrow callbacks instead of the full
// `Env`.


// 2026-06-27 (server.ts hygiene ①) — collapse the repeated
// getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, name)
// boilerplate (32 DEMO_INSTANCE sites + the `as unknown as AgentNamespace<AgentThursdayAgent>` cast)
// into one place. Takes `env` so both instance (`this.env`) and composition-root (`env`)
// call sites use it. `getRegistryStub` is the DEMO_INSTANCE registry; `getAgentThursdayStubByName`
// resolves an arbitrary per-agent instance. Explicit return type — the function is hoisted
// above the AgentThursdayAgent class, so inference would otherwise collapse to `never`.
function getAgentThursdayStubByName(env: Env, name: string): ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>> {
  return getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, name);
}
function getRegistryStub(env: Env): ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>> {
  return getAgentThursdayStubByName(env, DEMO_INSTANCE);
}

// per-turn token usage surfaced on dialog turns (cost is computed
// at display time from the frontend pricing table).
export interface TurnUsage {
  in: number;
  out: number;
  cached: number | null;
  model: string | null;
}

export class AgentThursdayAgent extends Think<Env, AgentThursdayState> {
  private readonly defaultAgentThursdayState: AgentThursdayState = {
    agentId: "default",
    project: "AgentThursday",
    status: "idle",
    currentTask: null,
    currentTaskObject: null,
    lastCheckpoint: null,
    modelProfile: { provider: "deterministic", model: "stub-concise" },
    committedAction: null,
    currentObstacle: null,
    pendingHelpRequest: null,
    lastHumanResponse: null,
    waitingForHuman: false,
    resumeTrigger: null,
    recoveryPolicy: { policyMode: "normal", reason: "initial state" },
    lastActionResult: null,
    runtimeMode: { mode: "normal", reason: "initial state" },
    runtimeModelTarget: null,
    updatedAt: Date.now(),
  };

  chatRecovery = true;

  // In-memory token accumulators — reset on DO wake; task-scoped resets when task changes.
  private _sessionTok = { in: 0, out: 0, total: 0, hasData: false };
  private _taskTok = { taskId: null as string | null, in: 0, out: 0, total: 0, cached: 0 };
  // per-task `content_read` budget accumulator. Reset when
  // `currentTaskObject.id` changes; skipped when no task id is set (the
  // warning still fires per-read, just without accumulator context).
  private _currentTaskReadBudget = { taskId: null as string | null, readCount: 0, readBytes: 0 };
  // cached "is this agent the operator/admin?" verdict, resolved once
  // from this agent's own registry profile owner. Gates ContentHub access to
  // operator-internal sources (e.g. `agentthursday-github`). Null = not yet resolved.
  private _ownerIsOperatorCache: boolean | null = null;
  // best-effort guard so the end-of-turn auto-consolidation doesn't
  // pile up overlapping waitUntil runs on a busy DO. A stomp at worst causes one extra
  // run, which semantic dedup absorbs — so an instance field is acceptable here.
  private _consolidationInFlight = false;
  private _lastStepModel: { provider: string; modelId: string } | null = null;
  private _lastStepIn: number | null = null;
  // supplier-side degradation signal collector for the
  // current submitTask round. Reset at the top of submitTask, populated by
  // onStepFinish + onError, read at reply finalization.
  private _currentTaskSupplierSignals: SupplierTaskSignals = emptySupplierTaskSignals();
  // live partial text of the inference step currently streaming.
  // In-memory only (no SQL per chunk): the DO is alive while its own turn
  // runs, and if it restarts the turn died with it. Reset per inference step
  // (tool-call steps carry little text; the final step carries the reply) and
  // at turn start. Read by getLivePartial() for the user-app streaming card.
  private _livePartial: { text: string; updatedAt: number } | null = null;
  // an earlier revision truthfulness verdict for the same round, so
  // the `supplier.signal.summary` event_log row can include
  // `truthfulnessViolationSeen` + `truthfulnessCategory` without changing
  // applyTruthfulnessGate's user-visible behavior. Reset at submitTask top.
  private _currentTaskTruthfulnessVerdict: { violationSeen: boolean; category: string | null } = {
    violationSeen: false, category: null,
  };
  // captured ack from a `tool.memory.remember` call inside
  // the current submitTask round. Used to fall back when the model
  // doesn't synthesize visible assistant text after the tool fires
  // (the "tool-only memory round = silent UI" case the operator hit).
  // Populated by the `remember` tool's execute, consumed at the end of
  // submitTask to populate `replyText` for ChannelHub outbox; the
  // matching `lastActionResult.summary` (also written by the tool
  // execute) lets `buildWorkspaceSnapshot`'s 2b fallback surface the
  // ack on `/api/workspace.summaryStream`. Reset at submitTask top.
  private _currentTaskRememberAck: string | null = null;
  // current agent-turn evidence envelope id + the set of M8.1
  // tool ids that fired during this turn through the agent-facing tool
  // wrappers. Populated at the top of submitTask (createDraft) and by
  // each wrapped tool's `recordWrappedToolId` callback; consumed at the
  // bottom of submitTask to seal the envelope (claimed_tools = wrapped
  // ids, dedup+sort) and to append `[envelope: <id>]` to replyText.
  // Reset at submitTask top and again in the finally block.
  private _currentEnvelopeId: string | null = null;
  private _currentTaskWrappedToolIds: string[] = [];
  // external-provider credential resolved at session init and
  // held in memory only (never persisted to durable state, so the raw
  // key's only durable copy stays in the registry DO). getModel() reads
  // these sync. Constant within an agent DO (one provider per profile),
  // so an instance field is safe here. Repopulated on each session init.
  private _externalProviderKey: string | null = null;
  private _externalProviderBaseUrl: string | null = null;
  // the in-flight manager turn context now lives in an
  // AsyncLocalStorage (see `src/agent/managerTurnContext.ts`), not on
  // DO instance fields. an earlier revision stored it on
  // `_currentManagerTaskId / _Source / _ConversationId`; verifier
  // FAILed 363 because async manager tasks can interleave inside the
  // same DO and stomp those fields during `await`s. ALS gives each
  // `submitManagerTask` call an isolated store that propagates through
  // its own Promise chain only. `getCurrentManagerContext()` now reads
  // from `getManagerTurnContext()`.
  // an earlier revision fix A — pinned per-task fallback for auto-dispatched gates.
  // The auto-dispatch site at submitTask awaits the gate (up to ~10 min);
  // during that await a new submitTask can arrive and reset
  // `_currentTaskWrappedToolIds`. When the gate finally returns we still
  // want to attribute its claim to the ORIGINAL task, not the new one.
  // Keyed by the originating task id; merged into `claimedTools` during
  // `_finalizeTaskTurn` for that task. Cleared at finalize time.
  private _pinnedWrappedToolIdsByTask: Map<string, string[]> = new Map();
  // an earlier revision/c1 — reload counter is the only in-memory piece. Disable
  // state moved to SQL (`skillset_disabled` table) per an earlier revision
  // production fix; snapshot is no longer cached either — it rebuilds
  // on every read so SQL changes are immediately visible.
  // `reload_count` is documented as "since this DO woke up"; it does
  // not need cross-instance survival.
  private _skillsetReloadCount: number = 0;
  // cache of custom-skillset manifests mirrored from the
  // registry DO (`DEMO_INSTANCE`). Refreshed by `composePersonaContext`
  // at session init and by the `refreshCustomSkillsetCache()` RPC
  // when the manager mutates an agent's `skillset`. `null` means the
  // cache has never been populated on this DO; the snapshot then
  // falls back to local-SQL-only (registry DO's own native path).
  private _cachedRegistryCustomManifests: EmbeddedManifest[] | null = null;
  // Tier 2: pre-bundled npm modules for the codemode sandbox. null = not yet initialized.
  // Each value uses the explicit-type Module shape `{ js: source }` so the
  // Workers Loader accepts bare specifier keys like `"zod"` .
  private _bundledModules: Record<string, { js: string }> | null = null;

  // Workers Loader requires module-map keys to either end in
  // `.js`/`.py` (string-form, type inferred by extension) OR be an object
  // that names the type explicitly (`{ js: source }`, `{ cjs: source }`,
  // etc.). Bare string keys with bare-string values fail with TypeError:
  //   "Module name must end with '.js' or '.py' ... Got: zod"
  // Codemode passes `modules` straight through to `loader.get(...)`, so we
  // need the explicit-type form to make `import "zod"` resolvable inside
  // the sandbox without renaming the import specifier in user code.
  private async _initBundledModules(): Promise<Record<string, { js: string }>> {
    const { mainModule, modules } = await createWorker({
      files: {
        "index.ts": `export { z } from 'zod'`,
        "package.json": JSON.stringify({ dependencies: { zod: "*" } }),
      },
    });
    const out: Record<string, { js: string }> = {};
    const mainSrc = modules[mainModule];
    if (typeof mainSrc === "string") out["zod"] = { js: mainSrc };
    return out;
  }

  // 2026-06-30 — truncate-on-persist for large file-read tool results (DO-OOM
  // root-cause fix). The model sees the FULL result during the turn it reads the
  // file; AFTER the turn is persisted, we shrink the stored copy of any oversized
  // tool-result `output` to a tiny re-read marker, so the next wake reload of
  // assistant_messages can't materialise MB-scale rows into the 128MB isolate
  // heap. Pairing/shape preserved (type/toolCallId/toolName/state/input kept,
  // only `output` swapped) so provider replay stays valid. onChatResponse fires
  // after every turn-completion path (chat / sub-agent RPC / auto-continuation),
  // turn lock released, so this.sql UPDATEs are safe here.
  private static readonly _TOOL_RESULT_PART_LIMIT = 8 * 1024;   // per-part output cap
  private static readonly _MSG_ROW_SCAN_GATE = 24 * 1024;       // only scan big rows

  override onChatResponse(_result: ChatResponseResult): void {
    this._livePartial = null; // turn done: final text owns the card
    try { this._truncateLargeToolResults(); }
    catch (e) { this.logEvent("assistant_messages.truncate.error", { error: e instanceof Error ? e.message.slice(0, 150) : String(e) }); }
  }

  private _truncateLargeToolResults(): number {
    let scanned = 0;
    let truncatedCount = 0;
    const rows = this.sql<{ id: string; content: string }>`
      SELECT id, content FROM assistant_messages WHERE length(content) > ${AgentThursdayAgent._MSG_ROW_SCAN_GATE}`;
    for (const row of rows) {
      scanned++;
      const r = truncateLargeToolResultParts(row.content, { partLimitBytes: AgentThursdayAgent._TOOL_RESULT_PART_LIMIT });
      if (!r.changed) continue;
      try { this.sql`UPDATE assistant_messages SET content = ${r.content} WHERE id = ${row.id}`; truncatedCount++; }
      catch { /* fail-soft: skip this row */ }
    }
    if (truncatedCount > 0 || scanned > 0) this.logEvent("assistant_messages.truncated", { rows: truncatedCount, scanned });
    return truncatedCount;
  }

  // DIAGNOSTIC (2026-06-30) — direct trigger to run the truncation pass on demand
  // (verification + one-time cleanup of historical bloat).
  @callable()
  compactToolResults(): { truncated: number } {
    return { truncated: this._truncateLargeToolResults() };
  }

  override onStepFinish(ctx: StepContext): void {
    const u = ctx.usage;
    const inp = u?.inputTokens ?? 0;
    const out = u?.outputTokens ?? 0;
    const tot = u?.totalTokens ?? (inp + out);
    if (inp > 0 || out > 0) {
      this._sessionTok = { in: this._sessionTok.in + inp, out: this._sessionTok.out + out, total: this._sessionTok.total + tot, hasData: true };
      this._lastStepIn = inp;
    }
    const currentTaskId = this.agentthursdayState.currentTaskObject?.id ?? null;
    if (this._taskTok.taskId !== currentTaskId) {
      this._taskTok = { taskId: currentTaskId, in: 0, out: 0, total: 0, cached: 0 };
    }
    if (inp > 0 || out > 0) {
      // cache-read tokens (providers price them at 0.1-0.5x; the
      // per-turn cost estimate needs the split). Missing → contributes 0.
      const cachedStep = (u as { cachedInputTokens?: number } | undefined)?.cachedInputTokens ?? 0;
      this._taskTok = { ...this._taskTok, in: this._taskTok.in + inp, out: this._taskTok.out + out, total: this._taskTok.total + tot, cached: this._taskTok.cached + cachedStep };
    }
    if (ctx.model) {
      this._lastStepModel = { provider: ctx.model.provider, modelId: ctx.model.modelId };
      // also persist the observation so the resolver
      // survives DO hibernation / isolate resets. `_lastStepModel` is
      // an in-memory cache; without persistence, a hibernate cycle
      // wipes it and `contextBudget` falls back to the configured
      // `stub-concise` placeholder, dropping the rail's window from
      // the real model's 256K back to the DEFAULT 128K. We write to
      // the dedicated `lastObservedModel` slot, NOT `modelProfile`,
      // so `setModelProfile` semantics and the configured/observed
      // distinction stay intact.
      const observed: ModelProfile = { provider: ctx.model.provider, model: ctx.model.modelId };
      const prevObserved = this.agentthursdayState.lastObservedModel ?? null;
      if (
        !prevObserved
        || prevObserved.provider !== observed.provider
        || prevObserved.model !== observed.model
      ) {
        try {
          this.setAgentThursdayState({ ...this.agentthursdayState, lastObservedModel: observed });
        } catch { /* fail-soft: state write must never break the step loop */ }
      }
    }

    // capture supplier-side step signal for the current
    // submitTask round. Wrapped in try/catch so a malformed StepContext
    // shape never breaks the main step loop (kanban: fail-soft).
    // an earlier revision extends this with optional tool-call / tool-result names so
    // the persisted summary event has grep-friendly identifiers, not just
    // counts. Names are capped at the call site to keep payload bounded.
    try {
      const c = ctx as unknown as {
        finishReason?: string;
        toolCalls?: ReadonlyArray<{ toolName?: unknown }>;
        toolResults?: ReadonlyArray<{ toolName?: unknown }>;
        content?: ReadonlyArray<{ type?: unknown; toolName?: unknown }>;
      };
      const extractNames = (arr: ReadonlyArray<{ toolName?: unknown }> | undefined): string[] => {
        if (!Array.isArray(arr)) return [];
        const out: string[] = [];
        for (const item of arr) {
          if (out.length >= 16) break;
          const n = item?.toolName;
          if (typeof n === "string" && n.length > 0 && n.length <= 64) out.push(n);
        }
        return out;
      };
      // an earlier revision (2a) — extract `tool-error` parts from step.content.
      // `ctx.toolResults` is the AI SDK getter at ai/dist/index.js:3913
      // that filters `content` to `type === "tool-result"` only;
      // tool-error parts (emitted when a tool's `execute()` throws)
      // are deliberately excluded by that getter. Reading content
      // directly is the only way to see them here.
      const toolErrorParts: Array<{ toolName?: unknown }> = Array.isArray(c.content)
        ? c.content.filter(p => p && (p as { type?: unknown }).type === "tool-error") as Array<{ toolName?: unknown }>
        : [];
      // 1 — count `tool-approval-request` parts in step content.
      // When a tool is declared `needsApproval: true`, the AI SDK builds
      // a `tool-approval-request` content part instead of dispatching
      // `execute()` (see asContent → case "tool-approval-request" in
      // ai/dist/index.js: emits `{ type: "tool-approval-request",
      // approvalId, toolCall }`). The UI-message side uses
      // `state === "approval-requested"` for the same case, but on the
      // per-step content array we get the typed shape.
      //
      // Without this count, supplier-signal flags a legitimate pause as
      // `tool_calls_present_but_not_dispatched` (an earlier revision RCA, prod
      // task `task-mpby4jjw`). `toolName` is read from the nested
      // toolCall so existing `extractNames` works uniformly.
      const toolApprovalPendingParts: Array<{ toolName?: unknown }> = Array.isArray(c.content)
        ? (c.content.filter(p => p && (p as { type?: unknown }).type === "tool-approval-request") as Array<{ toolCall?: { toolName?: unknown } }>)
            .map(p => ({ toolName: p.toolCall?.toolName }))
        : [];
      this._currentTaskSupplierSignals.steps.push({
        finishReason: c.finishReason,
        toolCallCount: Array.isArray(c.toolCalls) ? c.toolCalls.length : 0,
        toolResultCount: Array.isArray(c.toolResults) ? c.toolResults.length : 0,
        toolErrorCount: toolErrorParts.length,
        toolErrorNames: extractNames(toolErrorParts),
        toolApprovalPendingCount: toolApprovalPendingParts.length,
        toolCallNames: extractNames(c.toolCalls),
        toolResultNames: extractNames(c.toolResults),
      });
    } catch { /* fail-soft: never block the step loop on signal collection */ }
  }

  // capture stream-truncated / finish_reason regression
  // errors raised by the model adapter. The saga's specific symptom on
  // the Llama family was workers-ai-provider's flush() rejecting on
  // missing finish_reason. We never store the raw error string in state —
  // only a pattern-matched boolean — to avoid accidentally surfacing
  // provider payload preview in user-facing markers.
  //
  // The Agent base class has two overloaded onError signatures
  // (`(connection, error)` and `(error)`); we accept either by inspecting
  // arity. Detection is fail-soft: on any throw, we just don't flag.
  //
  // Note: the other two degradation reasons captured via onStepFinish
  // (`tool_calls_present_but_not_dispatched`, `finish_reason_missing`)
  // already cover the dominant saga shape, so this hook is additive — if
  // saveMessages throws and never returns, the user wouldn't see a reply
  // marker anyway; this hook helps when error is observed but the round
  // still produces partial text.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override onError(connectionOrError: any, error?: unknown): void | Promise<void> {
    try {
      const actualError = arguments.length >= 2 ? error : connectionOrError;
      if (isStreamTruncatedError(actualError)) {
        this._currentTaskSupplierSignals.streamTruncatedSeen = true;
      }
    } catch { /* fail-soft */ }

    // Preserve Agent/Think default error semantics. an earlier revision detection must
    // be fail-soft, but it must not accidentally swallow unrelated server or
    // websocket errors.
    return arguments.length >= 2
      ? super.onError(connectionOrError, error)
      : super.onError(connectionOrError);
  }

  protected override _transformInferenceResult(result: StreamableResult): StreamableResult {
    const base = super._transformInferenceResult(result);
    const self = this;
    return {
      toUIMessageStream(): AsyncIterable<unknown> {
        const stream = base.toUIMessageStream();
        // each transform call is one inference step; the partial
        // restarts so it always shows what the model is writing RIGHT NOW.
        self._livePartial = { text: "", updatedAt: Date.now() };
        return (async function* () {
          try {
            for await (const chunk of stream) {
              try {
                const c = chunk as { type?: string; delta?: string };
                if (c && c.type === "text-delta" && typeof c.delta === "string" && self._livePartial !== null
                    && self._livePartial.text.length < 65_536) {
                  self._livePartial.text += c.delta;
                  self._livePartial.updatedAt = Date.now();
                }
              } catch { /* fail-soft: never break the real stream */ }
              yield chunk;
            }
          } catch (e) {
            try {
              if (isStreamTruncatedError(e)) {
                self._currentTaskSupplierSignals.streamTruncatedSeen = true;
              }
            } catch { /* fail-soft */ }
            throw e;
          }
        })();
      },
    };
  }

  private get agentthursdayState(): AgentThursdayState { return this.getConfig() ?? this.defaultAgentThursdayState; }
  private setAgentThursdayState(s: AgentThursdayState): void { this.configure(s); }
  // runtime-model resolution.
  // `getModel()` is sync (cf-agents `Think` base hook). The per-profile
  // AgentProfile lookup is async, so we cache the resolved executable
  // target on persistent state (`runtimeModelTarget`) during
  // `composePersonaContext` (which already loads the profile at session
  // init). `getModel()` reads sync from state; fail-soft to the
  // workers-ai-provider Kimi default when:
  //   - target is null (registry DO `DEMO_INSTANCE`, or profile not yet
  //     loaded)
  //   - target is non-workers-ai (legacy profile carrying an external
  //     provider id — route gating prevents new ones)
  // Both cases emit `agent.model.fallback` so the lie is observable.
  //
  // model dispatch discriminator history:
  // - gpt-oss 120b/20b, GLM, Kimi, and Llama Scout can emit raw/inline function JSON.
  // - Fresh DO with Llama Scout still fabricated inline execute JSON instead of framework tool_call.
  // - Test Llama 3.3 70B fast to separate model-specific emission from Workers AI adapter issues.
  // Keep mitigation 1 in place (Kimi K2.6 baseline) for now.
  getModel() {
    // provider-aware. When the active profile resolved to
    // an external target with an in-memory credential, dispatch through
    // the matching AI SDK provider (@ai-sdk/anthropic | @ai-sdk/deepseek);
    // otherwise the unchanged workers-ai path. The in-memory key is set
    // at session init (`_resolveRuntimeModelForProfile`). Any failure to
    // build the external model fail-softs to workers-ai so a
    // misconfiguration can never wedge the hot path (4-28 saga rule).
    const provider = this.agentthursdayState.runtimeModelProvider ?? null;
    const target = this.agentthursdayState.runtimeModelTarget;
    const apiKey = this._externalProviderKey;
    if (
      (provider === "anthropic" || provider === "deepseek" || provider === "openai" || provider === "google" || provider === "zhipu" || provider === "grok")
      && typeof target === "string" && target.length > 0
      && typeof apiKey === "string" && apiKey.length > 0
    ) {
      try {
        if (provider === "anthropic") {
          return createAnthropic({ apiKey })(target);
        }
        if (provider === "grok") {
          // xAI — OpenAI-compatible CHAT-COMPLETIONS only (same class as
          // zhipu): default `provider(id)` would target OpenAI's Responses
          // API and 404. `.chat()` → /chat/completions.
          return createOpenAI({
            apiKey,
            baseURL: this._externalProviderBaseUrl ?? GROK_DEFAULT_BASE_URL,
          }).chat(target);
        }
        if (provider === "zhipu") {
          // 智谱 (Zhipu/BigModel) — OpenAI-compatible CHAT-COMPLETIONS only.
          // Default to the Zhipu base when the credential didn't store one
          // (createOpenAI would otherwise hit api.openai.com). MUST use `.chat()`:
          // @ai-sdk/openai v3's default `provider(id)` targets OpenAI's Responses
          // API (provider "openai.responses"), which Zhipu has no endpoint for —
          // that 404'd and produced empty turns (no_execution). `.chat()` →
          // /chat/completions, which Zhipu supports.
          return createOpenAI({
            apiKey,
            baseURL: this._externalProviderBaseUrl ?? ZHIPU_DEFAULT_BASE_URL,
          }).chat(target);
        }
        if (provider === "openai") {
          return createOpenAI({
            apiKey,
            ...(this._externalProviderBaseUrl ? { baseURL: this._externalProviderBaseUrl } : {}),
          })(target);
        }
        if (provider === "google") {
          // @ai-sdk/google = Gemini via the Generative Language API (API key).
          return createGoogleGenerativeAI({
            apiKey,
            ...(this._externalProviderBaseUrl ? { baseURL: this._externalProviderBaseUrl } : {}),
          })(target);
        }
        return createDeepSeek({
          apiKey,
          ...(this._externalProviderBaseUrl ? { baseURL: this._externalProviderBaseUrl } : {}),
        })(target);
      } catch {
        // fall through to workers-ai default below
      }
    }
    const wat = this._resolveWorkersAITargetWithFallback();
    return createWorkersAI({ binding: this.env.AI })(wat);
  }

  /**
   * derive the workers-ai target string from persistent
   * state. Returns the configured target when the resolved runtime
   * entry is an `available` workers-ai entry; otherwise falls back to
   * the workers-ai default and logs `agent.model.fallback` so the
   * mismatch is visible in event_log.
   */
  private _resolveWorkersAITargetWithFallback(): string {
    const fallback = defaultAgentRuntimeModel();
    if (fallback.provider !== "workers-ai" || fallback.target === null) {
      // Defensive: the resolver guarantees this in its load-time
      // check, but be explicit since getModel is on the hot path.
      throw new Error("agentModelRuntime: default must be a workers-ai entry");
    }
    const stored = this.agentthursdayState.runtimeModelTarget;
    if (typeof stored === "string" && stored.length > 0) {
      // We persisted a workers-ai target during profile load; trust it.
      // Non-workers-ai targets are never persisted (see
      // `_persistRuntimeModelFromProfileModel`).
      return stored;
    }
    return fallback.target;
  }

  /**
   * called during per-profile session init (inside
   * `composePersonaContext`) once the AgentProfile row is loaded.
   * Resolves `profile.model` to a runtime entry; persists the
   * executable target on `AgentThursdayState` when (and only when) it is an
   * `available` workers-ai entry. Otherwise clears the cached target
   * so `getModel()` fail-softs to the default, and logs the reason.
   *
   * Idempotent: only writes state when the resolved target changes,
   * so it doesn't churn `setAgentThursdayState` on every session init.
   */
  // store-aware async resolver. For workers-ai it persists
  // target+provider synchronously; for credential-gated providers
  // (anthropic/deepseek) it cross-reads the registry DO
  // `provider_credential` (env key as fallback source), persists
  // target+provider durable, and holds the raw key in memory only.
  // Fail-soft on every branch — a missing credential or a registry RPC
  // failure leaves getModel() on the workers-ai default.
  private async _resolveRuntimeModelForProfile(
    profileModel: string,
    identity?: RequestIdentity,
  ): Promise<void> {
    const entry: AgentRuntimeModelEntry | null = resolveAgentRuntimeModel(profileModel);
    const fallback = defaultAgentRuntimeModel();
    let nextTarget: string | null = null;
    let nextProvider: "workers-ai" | "anthropic" | "deepseek" | "openai" | "google" | "zhipu" | "grok" | null = null;
    let fallbackReason: string | null = null;
    let externalKey: string | null = null;
    let externalBaseUrl: string | null = null;

    if (entry === null) {
      // not in the static registry: maybe a dynamically
      // discovered model from a configured provider (anthropic/deepseek/openai/
      // google — all dispatch-wired in getModel via their @ai-sdk provider).
      const dyn = await this._resolveDynamicProviderForModel(profileModel, identity);
      if (dyn === "anthropic" || dyn === "deepseek" || dyn === "openai" || dyn === "google" || dyn === "zhipu" || dyn === "grok") {
        const cred = await this._fetchProviderCredential(dyn, identity);
        if (cred !== null) {
          nextTarget = profileModel;
          nextProvider = dyn;
          externalKey = cred.apiKey;
          externalBaseUrl = cred.baseUrl;
        } else {
          fallbackReason = `${dyn}_credential_missing`;
        }
      } else {
        fallbackReason = "unknown_model";
      }
    } else if (entry.target === null) {
      fallbackReason = "not_configured";
    } else if (entry.provider === "workers-ai") {
      if (entry.runtimeStatus !== "available") {
        fallbackReason = "not_configured";
      } else {
        nextTarget = entry.target;
        nextProvider = "workers-ai";
      }
    } else if (entry.provider === "anthropic" || entry.provider === "deepseek") {
      const cred = await this._fetchProviderCredential(entry.provider, identity);
      if (cred !== null) {
        nextTarget = entry.target;
        nextProvider = entry.provider;
        externalKey = cred.apiKey;
        externalBaseUrl = cred.baseUrl;
      } else {
        fallbackReason = `${entry.provider}_credential_missing`;
      }
    } else {
      fallbackReason = "provider_not_supported";
    }

    if (fallbackReason !== null) {
      this.logEvent("agent.model.fallback", {
        profile_id: this.name,
        profile_model: profileModel,
        reason: fallbackReason,
        runtime_status: entry?.runtimeStatus ?? null,
        provider: entry?.provider ?? null,
        fallback_target: fallback.target,
      });
    }
    // In-memory key (never durable). Cleared when not external/keyed.
    this._externalProviderKey = externalKey;
    this._externalProviderBaseUrl = externalBaseUrl;

    const current = this.agentthursdayState.runtimeModelTarget ?? null;
    const currentProvider = this.agentthursdayState.runtimeModelProvider ?? null;
    if (current !== nextTarget || currentProvider !== nextProvider) {
      try {
        this.setAgentThursdayState({
          ...this.agentthursdayState,
          runtimeModelTarget: nextTarget,
          runtimeModelProvider: nextProvider,
        });
      } catch { /* fail-soft: state write must never break session init */ }
    }
  }

  // resolve which configured provider lists a dynamic model
  // id (from the cached discovery results on the registry DO). Returns
  // the provider name, or null when no configured provider lists it.
  private async _resolveDynamicProviderForModel(
    model: string,
    identity?: RequestIdentity,
  ): Promise<string | null> {
    try {
      const registry = await getRegistryStub(this.env);
      // scope the dynamic-model resolution to this agent's owner
      // (admin/undefined → global scan, unchanged).
      const r = await registry.resolveProviderForModel({ model }, identity);
      return r?.provider ?? null;
    } catch {
      return null;
    }
  }

  // fetch a provider credential: registry DO store first,
  // then env key fallback. Returns null when neither is configured.
  private async _fetchProviderCredential(
    provider: "anthropic" | "deepseek" | "openai" | "google" | "zhipu" | "grok",
    identity?: RequestIdentity,
  ): Promise<{ apiKey: string; baseUrl: string | null } | null> {
    try {
      const registry = await getRegistryStub(this.env);
      // a scoped agent reads ONLY its owner's key (no fall-through
      // to the admin's legacy key). Admin/undefined → legacy table, exactly as
      // before. The env fallback below is the platform default for both.
      const row = await registry.getProviderCredentialSecret({ provider }, identity);
      if (row && typeof row.api_key === "string" && row.api_key.length > 0) {
        return { apiKey: row.api_key, baseUrl: row.base_url ?? null };
      }
    } catch { /* fall through to env fallback */ }
    // Env fallback (back-compat with an earlier revision / wrangler secret). openai/google
    // have no env key configured → null → BYO key required (the normal path).
    const envKeyName = {
      anthropic: "ANTHROPIC_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      zhipu: "ZHIPU_API_KEY", // no env default today → BYO credential required
      grok: "GROK_API_KEY", // no env default today → BYO credential required
    }[provider];
    const envKey = (this.env as unknown as Record<string, string | undefined>)[envKeyName];
    if (typeof envKey === "string" && envKey.length > 0) {
      return { apiKey: envKey, baseUrl: null };
    }
    return null;
  }

  /**
   * called during per-profile session init (inside
   * `composePersonaContext`) once the AgentProfile row is loaded.
   * Resolves `profile.skillset` against the current snapshot's
   * loader state + operator-disabled set; persists the effective
   * closure (or empty-set + structured reason) on `AgentThursdayState` so
   * the sync `_buildDynamicSkillTools()` path can read it without
   * re-running the resolver.
   *
   * Always emits `agent.skillset.effective` so verifier evidence
   * sees the same truth as the in-memory state. The event payload
   * mirrors the persisted fields plus the original
   * `profile_skillset` for cross-reference.
   *
   * Idempotent: only writes state when the resolved closure or
   * reason changes, so it doesn't churn `setAgentThursdayState` on every
   * session init.
   */
  private _persistEffectiveSkillsetFromProfile(profileSkillset: string): void {
    const snapshot = this._buildSkillsetSnapshotNow();
    // resolver must see the full embedded ∪ custom set,
    // not just embedded. Source the manifests from the snapshot's
    // own state.entries (loader output), which already includes any
    // local-SQL customs AND any cached registry customs the host
    // exposed via `getExtraCustomManifests()`. Falls back to the
    // embedded set for ids the loader excluded so a malformed custom
    // entry never invalidates an embedded selection.
    const manifestsById = new Map<string, (typeof EMBEDDED_MANIFESTS)[number]["manifest"]>();
    for (const m of EMBEDDED_MANIFESTS) manifestsById.set(m.id, m.manifest);
    for (const [id, entry] of Object.entries(snapshot.state.entries)) {
      if (entry?.manifest) manifestsById.set(id, entry.manifest);
    }
    const disabledMap = new Map<string, unknown>(
      snapshot.skillset_ids.disabled.map(id => [id, true] as const),
    );
    const result: EffectiveSkillsetResult = resolveEffectiveSkillset({
      profileSkillset,
      state: snapshot.state,
      manifestsById,
      disabledMap,
    });
    const nextIds: string[] | null =
      result.status === "ok" ? result.effectiveIds : [];
    const nextReason: string | null = result.status === "ok" ? null : result.status;
    this.logEvent("agent.skillset.effective", {
      profile_id: this.name,
      profile_skillset: profileSkillset,
      effective_skillset_ids: nextIds,
      fallback_reason: nextReason,
      resolver_reason: result.reason,
    });
    const currentIds = this.agentthursdayState.effectiveSkillsetIds ?? null;
    const currentReason = this.agentthursdayState.skillsetFallbackReason ?? null;
    const idsChanged =
      currentIds === null
        ? nextIds !== null
        : nextIds === null ||
          currentIds.length !== nextIds.length ||
          currentIds.some((id, i) => id !== nextIds[i]);
    if (idsChanged || currentReason !== nextReason) {
      try {
        this.setAgentThursdayState({
          ...this.agentthursdayState,
          effectiveSkillsetIds: nextIds,
          skillsetFallbackReason: nextReason,
        });
      } catch { /* fail-soft: state write must never break session init */ }
    }
  }
  configureSession(session: Session): Session {
    return session
      .withContext("soul", { provider: { get: async () => `${await this._resolveBaseSoul()}\n\n${this.readKnowledge()}` } })
      // M9.0 persona-weave. APPEND a `## Persona` block
      // sourced from the per-profile `AgentProfile.persona` .
      // No-op for the registry DO (`DEMO_INSTANCE`) and for any
      // instance whose name does not resolve to an AgentProfile row,
      // which preserves the SOUL-only behavior of pre-348 chat paths.
      // D-2 (agentP 2026-05-22 → option A): provider runs at session init
      // via `ContextBlocks.load()`, then the rendered system prompt is
      // persisted by `Session.freezeSystemPrompt()`'s promptStore and
      // reused across pause/resume and DO eviction. Live UI persona
      // edits become visible on the NEXT session/run, not mid-turn.
      .withContext("persona", { provider: { get: () => this.composePersonaContext() } })
      .withContext("memory", { description: "工作记忆：当前任务进度、临时笔记、下一步计划", maxTokens: 2000 })
      .withContext("history", { provider: new AgentSearchProvider(this) });
  }

  // an earlier revision Phase 1 — read THIS agent's own profile row for identity/owner
  // resolution. The registry/operator DO reads its own table LOCALLY (it must
  // never RPC itself — same rule as `_refreshRegistryCustomManifests`); every
  // other agent goes through the registry stub as before. The operator's row
  // is seeded by Phase 0 but may legitimately be absent (seed defers on an
  // admin name conflict), so callers keep a DEMO_INSTANCE fallback on
  // null/error — a transient failure must never demote the operator.
  private async _readOwnProfileForIdentity() {
    if (this.name === DEMO_INSTANCE) {
      return readAgentProfile(this._agentProfileHost(), this.name);
    }
    const registry = await getRegistryStub(this.env);
    return await registry.readAgentProfile(this.name);
  }

  // Owner-aware base SOUL. Operator / legacy (admin-owned) agents keep the
  // full AgentThursday dev SOUL; every scoped user's agent gets the neutral SOUL, so a
  // plain "who are you?" cannot leak operator / AgentThursday / internal-project
  // identity to an end user. Fail-soft to NEUTRAL (never the AgentThursday SOUL) when
  // the owner can't be resolved — leak-safe default. Reads this agent's OWN
  // profile row (admin context, no cross-tenant concern). Runs once per session
  // (the `soul` context provider is loaded once by `ContextBlocks.load()`).
  // an earlier revision Phase 1 — the operator resolves from its Phase-0 profile row
  // (owner=admin → OPERATOR_SOUL via selectBaseSoul) like any agent; the
  // DEMO_INSTANCE branches below are the row-missing/read-failure fallback,
  // no longer the primary path.
  private async _resolveBaseSoul(): Promise<string> {
    try {
      const profile = await this._readOwnProfileForIdentity();
      if (profile === null && isOperatorSurfaceName(this.name)) return OPERATOR_SOUL;
      return selectBaseSoul(profile?.owner_user_id);
    } catch {
      return isOperatorSurfaceName(this.name) ? OPERATOR_SOUL : NEUTRAL_SOUL;
    }
  }

  // is THIS agent the operator/admin, a scoped user, or unresolved?
  // Resolved from its own registry profile owner: a null/admin-sentinel owner →
  // operator (legacy agents like agentC/agentD keep access); a real user id → user.
  // The registry DO (`DEMO_INSTANCE`) is the operator. Caches only on SUCCESS
  // (owner is immutable per DO); a registry error returns "unknown" WITHOUT
  // caching, so a transient blip neither sticks nor triggers a destructive
  // action. The tri-state matters: the content gate fails CLOSED (unknown →
  // deny), but the seed PURGE must fire ONLY on a confirmed user (never on
  // unknown — else a transient error would delete an operator agent's seeds).
  private async _resolveOwnerKind(): Promise<"operator" | "user" | "unknown"> {
    if (this._ownerIsOperatorCache !== null) return this._ownerIsOperatorCache ? "operator" : "user";
    try {
      const profile = await this._readOwnProfileForIdentity();
      if (profile === null && isOperatorSurfaceName(this.name)) {
        // an earlier revision Phase 1 fallback — row missing (seed deferred): the
        // operator surface is still the operator.
        this._ownerIsOperatorCache = true;
        return "operator";
      }
      const isOperator = resolveRequestIdentity(profile?.owner_user_id).kind === "admin";
      this._ownerIsOperatorCache = isOperator;
      return isOperator ? "operator" : "user";
    } catch {
      // an earlier revision Phase 1 — a read failure on an operator surface must not
      // demote the operator to "unknown" (pre-Phase-1 the DEMO short-circuit
      // could never fail). No caching either way on this path.
      return isOperatorSurfaceName(this.name) ? "operator" : "unknown";
    }
  }

  // Fail-CLOSED owner identity for the ContentHub content-source gate. Reuses
  // `_resolveOwnArchiveOwnerIdentity()` (the archive-read boundary): a resolution
  // failure → null → `{ownerUserId:null, isOperator:false}` (deny everything
  // beyond tenant-public fixtures, no personal sources). DEMO_INSTANCE / admin →
  // `{ownerUserId: ADMIN_USER_ID, isOperator:true}` (sees project sources). A
  // scoped agent → `{ownerUserId: its owner, isOperator:false}` (its own personal
  // sources + fixtures only). Threaded in via `getCallerOwner`.
  private async _resolveCallerOwnerForContent(): Promise<{ ownerUserId: string | null; isOperator: boolean }> {
    const identity = await this._resolveOwnArchiveOwnerIdentity();
    if (identity === null) return { ownerUserId: null, isOperator: false };
    return { ownerUserId: ownerUserIdFor(identity), isOperator: identity.kind === "admin" };
  }

  // Multi-tenancy — resolve THIS agent's own owner id for stamping its archived
  // conversation rows. Best-effort: DEMO_INSTANCE (registry/operator) and any
  // resolution failure fall to the admin sentinel. This is a WRITE stamp, not a
  // security gate — a mis-stamp only hides a row from its own owner, never
  // leaks cross-tenant (the read filter in conversationSearch is the boundary).
  private async _resolveOwnArchiveOwnerId(): Promise<string> {
    // an earlier revision Phase 1 — no DEMO_INSTANCE branch needed: a missing row
    // resolves `resolveRequestIdentity(undefined)` → admin, and the catch
    // already falls to the admin sentinel (this is the WRITE stamp, not a
    // security gate — see above).
    try {
      const profile = await this._readOwnProfileForIdentity();
      return ownerUserIdFor(resolveRequestIdentity(profile?.owner_user_id));
    } catch {
      return ADMIN_USER_ID;
    }
  }

  // Multi-tenancy — resolve THIS agent's owner IDENTITY for owner-scoping the
  // archive READ (conversation_search). Unlike `_resolveOwnArchiveOwnerId` (the
  // write stamp, which fail-soft-defaults to admin), this is the READ boundary,
  // so resolution failure returns `null` and the tool fails CLOSED (empty
  // results) — never falls open to all-tenants. an earlier revision Phase 1 — the
  // operator resolves admin from its Phase-0 profile row; DEMO_INSTANCE keeps
  // an admin fallback on row-missing/read-failure (the operator's cross-context
  // search must survive a deferred seed or a transient local-read error), while
  // every other agent stays fail-closed on both.
  private async _resolveOwnArchiveOwnerIdentity(): Promise<RequestIdentity | null> {
    try {
      const profile = await this._readOwnProfileForIdentity();
      if (profile === null) {
        return isOperatorSurfaceName(this.name) ? { kind: "admin" } : null;
      }
      return resolveRequestIdentity((profile as { owner_user_id?: string }).owner_user_id);
    } catch {
      return isOperatorSurfaceName(this.name) ? { kind: "admin" } : null;
    }
  }

  // M9.0 persona-weave provider. Resolves the per-profile
  // DO's own AgentProfile via the registry DO and composes the
  // `## Persona` block via the pure `composePersonaBlock` helper.
  // Logs `system_prompt.persona.composed` to event_log each time the
  // cf-agents `ContextBlocks.load()` invokes this provider (D-3 — see
  // session/index.js:210-228). Note: load() runs each provider once
  // per session lifetime; `freezeSystemPrompt()` then persists the
  // rendered prompt in promptStore (session/index.js:484-492), so this
  // event fires at session init (or after explicit invalidation), not
  // per-turn. Returns empty string when skipped — cf-agents
  // `Session.toSystemPrompt()` then drops the block entirely.
  private async composePersonaContext(): Promise<string> {
    const instanceName = this.name;
    // Registry DO has no profile of its own — skip without an RPC.
    // the operator DO skips too (full parity with its DEMO-era
    // behavior: persona/model/skillset stay inert → null skillset filter =
    // full dynamic tool surface, kimi default model). Making the operator
    // profile-driven here is a deliberate FUTURE step, not a cutover side
    // effect — its seeded skillset "" would otherwise resolve to
    // empty_selection and collapse the tool surface.
    if (isOperatorSurfaceName(instanceName)) {
      return "";
    }
    let profile: Awaited<ReturnType<AgentThursdayAgent["readAgentProfile"]>> = null;
    try {
      const registry = await getRegistryStub(this.env);
      profile = await registry.readAgentProfile(instanceName);
    } catch (e) {
      this.logEvent("system_prompt.persona.error", {
        profile_id: instanceName,
        message: e instanceof Error ? e.message : String(e),
      });
      return "";
    }
    // same session-init pass also resolves + persists the
    // runtime model target on AgentThursdayState so getModel() can route
    // sync. Runs only when an AgentProfile actually loaded — registry
    // DO and unknown-profile cases fall through to the workers-ai
    // default via `_resolveWorkersAITargetWithFallback`.
    if (profile !== null) {
      // resolve this agent's owner ONCE from the just-loaded
      // profile and thread it into model/credential resolution, so a scoped
      // agent uses only its own provider key (never the admin's). Resolved
      // from the 426a `owner_user_id` column; absent → admin sentinel →
      // identical to pre-426c behavior. No extra RPC (piggybacks the load).
      const ownerIdentity = resolveRequestIdentity(profile.owner_user_id);
      // store-aware async resolution (was sync in an earlier revision).
      await this._resolveRuntimeModelForProfile(profile.model, ownerIdentity);
      // refresh the registry-DO custom-manifest cache
      // BEFORE the effective-skillset resolver runs, so custom
      // skillsets created/updated via the manager API resolve in
      // this session init without redeploy. Fail-soft: on RPC
      // failure the cache stays at its previous value (or null).
      await this._refreshRegistryCustomManifests();
      // adjacent skillset resolution. Same session-init
      // pass, same `profile !== null` gate. Persists the effective
      // skillset closure (or empty-set + structured reason) on
      // AgentThursdayState so the sync `_buildDynamicSkillTools()` path can
      // narrow the dynamic tool surface without re-running the
      // resolver per turn.
      this._persistEffectiveSkillsetFromProfile(profile.skillset);
    }
    const result = composePersonaBlock(profile);
    this.logEvent("system_prompt.persona.composed", {
      profile_id: instanceName,
      persona_bytes: result.personaBytes,
      skip_reason: result.skipReason,
      truncated: result.truncated,
    });
    return result.text;
  }

  /**
   * per-agent custom-skillset loader sync.
   *
   * Mirrors the registry DO's `custom_skillset` rows into this DO's
   * in-memory cache so `buildSkillsetSnapshotNow` sees the full
   * embedded ∪ custom union when the per-agent DO runs the loader.
   *
   * Skipped on the registry DO itself (`this.name === DEMO_INSTANCE`):
   * the registry's own local SQL already feeds `readLocalCustomManifests`
   * and we don't want it to RPC itself.
   *
   * Fail-soft: on RPC failure or parse error we leave the existing
   * cache value in place and emit an event so verifier evidence can
   * show the failure. The session never blocks on a custom-manifest
   * fetch.
   */
  private async _refreshRegistryCustomManifests(): Promise<void> {
    if (this.name === DEMO_INSTANCE) return;
    try {
      const registry = await getRegistryStub(this.env);
      const customs = await registry.listCustomSkillsets();
      const out: EmbeddedManifest[] = [];
      for (const c of customs) {
        try {
          out.push({
            id: c.id,
            source_yaml: c.source_yaml,
            manifest: manifestFromWire(c),
          });
        } catch (err) {
          this.logEvent("agent.skillset.custom_cache.parse_error", {
            profile_id: this.name,
            custom_skillset_id: c.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this._cachedRegistryCustomManifests = out;
      this.logEvent("agent.skillset.custom_cache.refreshed", {
        profile_id: this.name,
        custom_skillset_ids: out.map((m) => m.id),
        count: out.length,
      });
    } catch (e) {
      this.logEvent("agent.skillset.custom_cache.error", {
        profile_id: this.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * RPC fan-out target. Called by `managerUpdateAgent`
   * (after persistence succeeds) when the agent's `skillset` field
   * changes, so the per-agent DO refreshes its cached custom
   * manifests and re-resolves the effective skillset against the
   * latest profile WITHOUT requiring a session restart.
   *
   * Idempotent: safe to call repeatedly. Returns a small summary
   * the manager surface can surface in audit events.
   */
  async refreshCustomSkillsetCache(): Promise<{
    profile_id: string;
    custom_skillset_ids: string[];
    effective_skillset_ids: string[] | null;
    fallback_reason: string | null;
  }> {
    await this._refreshRegistryCustomManifests();
    // Re-resolve effective skillset against the latest persisted
    // profile so the next `_buildDynamicSkillTools()` call (which
    // reads `agentthursdayState.effectiveSkillsetIds` fresh on every
    // `getTools()`) sees the new closure.
    let effectiveIds: string[] | null = this.agentthursdayState.effectiveSkillsetIds ?? null;
    let fallbackReason: string | null = this.agentthursdayState.skillsetFallbackReason ?? null;
    try {
      const registry = await getRegistryStub(this.env);
      const profile = await registry.readAgentProfile(this.name);
      if (profile !== null) {
        this._persistEffectiveSkillsetFromProfile(profile.skillset);
        effectiveIds = this.agentthursdayState.effectiveSkillsetIds ?? null;
        fallbackReason = this.agentthursdayState.skillsetFallbackReason ?? null;
      }
    } catch (e) {
      this.logEvent("agent.skillset.refresh_rpc.error", {
        profile_id: this.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      profile_id: this.name,
      custom_skillset_ids: (this._cachedRegistryCustomManifests ?? []).map((m) => m.id),
      effective_skillset_ids: effectiveIds,
      fallback_reason: fallbackReason,
    };
  }

  /**
   * M8.2 Agent Tool Surface Integration Skeleton.
   *
   * Returns the AI-SDK-compatible tool subset for the M8.1 read /
   * verify tools: repo_read, repo_grep, git_status, git_show,
   * gate_typecheck, evidence_get. Write / commit / push / deploy
   * intentionally omitted — they stay locked behind /api/dev-shell
   * admin endpoints until a future card opens them.
   *
   * Each tool routes through the existing M8.1 dispatcher so
   * denylist + safety + observability are uniform with admin
   * endpoint behavior.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildM81AgentSafeReadTools(): Record<string, any> {
    const ws = this.workspace;
    const env = this.env;
    const agentLogEvent = (type: string, payload: unknown) => this.logEvent(type, payload, null);
    const sandboxExec = async (command: string) => {
      const sb = getSandbox(env.Sandbox, "agentthursday-dev-shell");
      const r = await sb.exec(command);
      return {
        stdout: typeof r.stdout === "string" ? r.stdout : "",
        stderr: typeof r.stderr === "string" ? r.stderr : "",
        exit_code: typeof r.exitCode === "number" ? r.exitCode : 0,
      };
    };
    // 189: lazy repo materialization for agent-runtime tool calls.
    // We can't await here (getTools is sync), so each tool invocation
    // ensures repo as part of its execute path. Cache the resolved
    // baseDir on `this` so subsequent calls within the same DO
    // instance skip the check fast-path.
    //
    // singleton-promise pattern. The previous implementation
    // only checked the resolved cache (`_cachedRepoBaseDir`), so when
    // multiple wrapper executes (gate.typecheck / gate.build / git.log
    // / repo.read) fired concurrently within ~30ms of each other, all
    // observed `_cachedRepoBaseDir = undefined` and each independently
    // invoked ensureRepoCheckout. The non-winners returned an error
    // ("destination exists" or partial state), causing
    // `repoBaseDir = undefined` for those tools, which then fell
    // through to the monolithic gate path and produced exit 127 / phases=[].
    // Cache the in-flight Promise so concurrent callers share one
    // checkout. Cache the resolved baseDir only on success; clear the
    // in-flight slot on failure so the next call can retry.
    const ensureRepoBaseDir = async (): Promise<string | undefined> => {
      if (this._cachedRepoBaseDir) return this._cachedRepoBaseDir;
      if (this._inflightRepoCheckout) return this._inflightRepoCheckout;
      this._inflightRepoCheckout = (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { ensureRepoCheckout } = await import("./skillset/repoMaterialization");
          const checkout = await ensureRepoCheckout(sandboxExec, env as unknown as { AGENT_THURSDAY_REPO_URL?: string; AGENT_THURSDAY_GIT_TOKEN?: string; GITHUB_TOKEN?: string });
          if (!checkout.error) {
            this.logEvent("repo.materialization", {
              baseDir: checkout.baseDir,
              existed: checkout.existed,
              head_sha: checkout.head_sha,
              source_url_redacted: checkout.source_url_redacted,
              token_source: checkout.token_source,
              via: "agent_runtime",
            });
            this._cachedRepoBaseDir = checkout.baseDir;
            return checkout.baseDir;
          }
          this.logEvent("repo.materialization.error", {
            baseDir: checkout.baseDir,
            source_url_redacted: checkout.source_url_redacted,
            token_source: checkout.token_source,
            error_snippet: checkout.error,
            via: "agent_runtime",
          });
          return undefined;
        } catch {
          return undefined;
        } finally {
          // Clear in-flight so a retry is possible if checkout failed.
          // On success the resolved cache makes future calls bypass this.
          this._inflightRepoCheckout = undefined;
        }
      })();
      return this._inflightRepoCheckout;
    };
    return buildAgentSafeReadTools({
      emit: (ev) => agentLogEvent(ev.type, ev.payload),
      workspace: {
        readFile: async (p: string) => ws.readFile(p),
        glob: async (pattern: string) => {
          const entries = await ws.glob(pattern);
          return entries.map((e: { path: string }) => e.path.replace(/^\/+/, ""));
        },
      },
      sandboxExec,
      // an earlier revision — pass a lazy getter (not the cached value) so
      // each wrapper invocation reads the latest store. an earlier revision moves
      // the ensure call to a sync path so the FIRST wrapper call after
      // a DO isolate restart sees a usable store instead of skipping
      // with reason=no_envelope_store while ensure resolves.
      getEnvelopeStore: () => this._ensureEnvelopeStoreSync(),
      ensureRepoBaseDir,
      // an earlier revision — resolve the current agent-turn envelope id at
      // the moment the wrapper fires. Pre-198a this was a direct read
      // of `_currentEnvelopeId` (in-memory class field), which broke
      // when a long gate let the DO hibernate / re-isolate: the field
      // returned to its `null` default before subsequent tool calls
      // reached the wrapper, and the trailing read/git/gate.build
      // recordings were dropped with reason=no_envelope_id (production
      // trace task-mox3l2rq, env-mox3l2rq-hiln). The 198a resolver
      // joins through the durable `envelope_snapshots` table by the
      // active task id and rehydrates a draft into the in-memory map
      // when the cache has been wiped, so addExecution / addGateEvidence
      // continue writing into the SAME envelope across the restart.
      getCurrentEnvelopeId: () => this._resolveActiveDraftEnvelopeId(),
      recordWrappedToolId: (id: string) => { this._currentTaskWrappedToolIds.push(id); },
      // fail-soft diagnostic: if a wrapper fires but its
      // envelope record is dropped (no draft, store missing, sealed
      // envelope, addExecution null), surface the gap so we don't see
      // silent claimed/evidenced mismatches in production again.
      onRecordSkipped: (info) => {
        try {
          this.logEvent("evidence.envelope.add_execution_skipped", {
            envelope_id: info.envelopeId,
            tool_id: info.toolId,
            reason: info.reason,
          });
        } catch {
          // never break tool execution on logging failure
        }
      },
      // an earlier revision B — `repo.prepare` success flips `_repoPrepared`,
      // which is the gate the write dispatcher reads via
      // `DevShellWriteHost.isRepoPrepared`.
      markRepoPrepared: (info) => {
        this._repoPrepared = true;
        this.logEvent("repo.prepared", {
          worktree_path: info.worktree_path,
          head_sha: info.head_sha,
        });
      },
      // an earlier revision B — agent-side write dispatch entry. Routes through the
      // same `devShellWriteDispatchFree` path that the admin /api/dev-shell
      // route uses, so the `no_prepared_worktree` gate, manifest path
      // allow/deny, and approval-token consumption all apply uniformly.
      dispatchWriteTool: (input) =>
        devShellWriteDispatchFree(this._devShellWriteHost(), input),
    });
  }
  private _cachedRepoBaseDir: string | undefined;
  private _inflightRepoCheckout: Promise<string | undefined> | undefined;
  // an earlier revision B — `repo.prepare` success gate. Persists across the DO
  // instance's lifetime; cleared on hibernation/eviction (acceptable
  // per card's non-goal "minimum viable, no per-task isolation").
  private _repoPrepared: boolean = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  beforeTurn(ctx: any): any {
    // Think auto-spreads `createWorkspaceTools(this.workspace)`
    // at the top level of `streamText({tools})` (see
    // node_modules/@cloudflare/think/dist/think.js line 342-348). Any
    // top-level `write` / `read` / `list` / `edit` / `glob` call goes
    // through that path, NOT through the codemode-internal
    // `tools: createWorkspaceTools(...)` parameter we wrapped in 187c.
    //
    // Override `beforeTurn` to instrument those top-level workspace
    // tools so each dispatch fires `tool.<id>.{dispatch,result,error}`
    // into event_log. Without this, supplier.signal.summary records
    // `write` in toolCallNames but toolEvents has no row, which is the
    // 187b production gap.
    //
    // Payload is summary-only (path / size / pattern / status / error
    // reason) — file content is never logged.
    // lift the Think SDK default maxSteps=10 wall: real
    // software-dev turns need far more steps (381 attempt #3 was cut
    // off at exactly 10 with every step finishing `tool-calls`).
    // `baseConfig` is the basis of every return path below, so this
    // covers all turns.
    const baseConfig = {
      toolChoice: "auto" as const,
      maxSteps: resolveTurnMaxSteps(
        (this.env as unknown as Record<string, unknown> | undefined)?.AGENT_THURSDAY_TURN_MAX_STEPS,
      ),
    };
    const tools = ctx?.tools as Record<string, unknown> | undefined;
    if (!tools) return baseConfig;
    // track every tool returned by `createWorkspaceTools`
    // so the 187d instrumentation stays aligned with the Think SDK
    // surface. Earlier the set listed only `read/write/list/edit/glob`,
    // which missed the SDK's `find`, `grep`, and crucially `delete`
    // (added when the supplier surface expanded). The Case 3 envelope
    // gap was rooted in `delete` being dispatched but never reaching
    // the dispatch/result event stream. Regression smoke
    // `scripts/card295d-mutation-envelope-gap-smoke.ts` asserts this
    // set is a superset of every key returned by `createWorkspaceTools`.
    // `glob` is a legacy entry kept defensively — the current Think
    // SDK exposes `find` instead, so the loop never matches `glob`
    // unless the SDK re-introduces it under that name.
    const WORKSPACE_TOOL_NAMES = new Set([
      "read",
      "write",
      "list",
      "edit",
      "glob",
      "find",
      "grep",
      "delete",
    ]);
    const summarizeInput = (toolName: string, input: unknown): Record<string, unknown> => {
      if (!input || typeof input !== "object") return { tool: toolName };
      const i = input as Record<string, unknown>;
      const out: Record<string, unknown> = { tool: toolName };
      if (typeof i.path === "string") out.path = i.path;
      if (typeof i.dir === "string") out.dir = i.dir;
      if (typeof i.pattern === "string") out.pattern = i.pattern;
      if (typeof i.content === "string") out.content_bytes = i.content.length;
      if (typeof i.text === "string") out.text_bytes = i.text.length;
      return out;
    };
    const summarizeError = (e: unknown): { reason: string; message_snippet: string } => {
      const msg = e instanceof Error ? e.message : String(e);
      return { reason: "workspace_tool_error", message_snippet: msg.slice(0, 200) };
    };
    const wrapped: Record<string, unknown> = {};
    let anyWrapped = false;
    for (const [name, raw] of Object.entries(tools)) {
      if (!WORKSPACE_TOOL_NAMES.has(name) || !raw || typeof raw !== "object") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawTool = raw as any;
      if (typeof rawTool.execute !== "function") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrappedExecute = async (input: any, opts: any) => {
        this.logEvent(`tool.${name}.dispatch`, summarizeInput(name, input));
        try {
          const result = await rawTool.execute(input, opts);
          this.logEvent(`tool.${name}.result`, { tool: name, ok: true });
          return result;
        } catch (e) {
          this.logEvent(`tool.${name}.error`, summarizeError(e));
          throw e;
        }
      };
      wrapped[name] = { ...rawTool, execute: wrappedExecute };
      anyWrapped = true;
    }
    if (!anyWrapped) return baseConfig;
    return { ...baseConfig, tools: wrapped };
  }

  /**
   * host adapter exposing the read capabilities the
   * free functions in `./agent/skillsetRuntime` need. `_skillsetReloadCount`
   * stays a private field on this class; the host only exposes a
   * read accessor (write authority belongs to the mutation surface,
   * an earlier revision).
   */
  private _skillsetReadHost(): SkillsetRuntimeReadHost {
    return {
      env: this.env,
      sql: this.sql.bind(this) as SkillsetRuntimeReadHost["sql"],
      getReloadCount: () => this._skillsetReloadCount,
      // surface the registry-DO custom-manifest cache to
      // the loader so per-agent DOs see the same custom skillset
      // set as the registry. `null` = cache not populated yet on
      // this DO (e.g. registry DO itself, or a per-agent DO whose
      // session init hasn't run yet); the loader falls back to
      // local SQL only.
      getExtraCustomManifests: () => this._cachedRegistryCustomManifests ?? [],
    };
  }

  /**
   * host adapter extending the read shape with mutation
   * capabilities. `incrementReloadCount()` is the write authority for
   * the private `_skillsetReloadCount` field; the host wrapper is the
   * only path that exposes it.
   */
  private _skillsetMutationHost(): SkillsetRuntimeMutationHost {
    return {
      ...this._skillsetReadHost(),
      incrementReloadCount: () => { this._skillsetReloadCount += 1; },
      logEvent: this.logEvent.bind(this) as SkillsetRuntimeMutationHost["logEvent"],
    };
  }

  /** an earlier revision → 261a: thin delegate. See `agent/skillsetRuntime.ts`. */
  private _skillsetEnvLookup(binding: string): string | undefined {
    return skillsetEnvLookupFree(this._skillsetReadHost(), binding);
  }

  /** an earlier revision/c/c1 → 261a: thin delegate. See `agent/skillsetRuntime.ts`. */
  private _buildSkillsetSnapshotNow(): SkillsetRuntimeSnapshot {
    return buildSkillsetSnapshotNowFree(this._skillsetReadHost());
  }

  /** an earlier revision → 261b: thin delegate. See `agent/skillsetRuntime.ts`. */
  reloadSkillsetRuntime(): SkillsetRuntimeSummary {
    return runReloadSkillsetRuntimeFree(this._skillsetMutationHost());
  }

  /** an earlier revision/c1 → 261b: thin delegate. See `agent/skillsetRuntime.ts`. */
  disableSkillset(input: { skillset_id: unknown; reason?: unknown }): {
    ok: true; summary: SkillsetRuntimeSummary;
  } | {
    ok: false; error: "missing_skillset_id" | "unknown_skillset_id" | "not_loaded";
  } {
    return runDisableSkillsetFree(this._skillsetMutationHost(), input);
  }

  /** an earlier revision/c1 → 261b: thin delegate. See `agent/skillsetRuntime.ts`. */
  enableSkillset(input: { skillset_id: unknown; reason?: unknown }): {
    ok: true; summary: SkillsetRuntimeSummary; changed: boolean;
  } | {
    ok: false; error: "missing_skillset_id" | "unknown_skillset_id";
  } {
    return runEnableSkillsetFree(this._skillsetMutationHost(), input);
  }

  /**
   * an earlier revision → 261a: thin delegate. an earlier revision entry point — stays
   * a public RPC method so agent-surface inspect routes through the
   * DO's active state. See `agent/skillsetRuntime.ts`.
   */
  getSkillsetRuntimeSummary(): SkillsetRuntimeSummary {
    return getSkillsetRuntimeSummaryFree(this._skillsetReadHost());
  }

  /**
   * operator diagnostic: classify this agent's CURRENT frozen base
   * SOUL (operator vs neutral) WITHOUT dumping the confidential full prompt.
   * Reads the durable `cf_agents_context_blocks._system_prompt*` row that
   * `freezeSystemPrompt` persists. Lets an operator confirm the neutral-SOUL
   * split actually re-rendered on an EXISTING agent — behavioral probes are
   * confounded by conversation-history persona parroting. Admin/inspect-only
   * (operator surface), never reachable by a scoped user.
   */
  @callable()
  async getSoulDiagnostic(): Promise<{
    liveBaseSoulKind: "operator" | "neutral" | "unknown";
    frozenStored: boolean;
    soulPromptVersion: number | null;
    ownerIsOperator: boolean | null;
  }> {
    const version = (await this.ctx.storage.get<number>("soul_prompt_version")) ?? null;
    // The reliable read: render the LIVE base SOUL the provider would emit this
    // turn (the frozen `cf_agents_context_blocks` row is unreliable — the system
    // prompt is re-derived per session, not durably pinned in that table). For a
    // scoped owner this returns NEUTRAL_SOUL deterministically.
    const live = await this._resolveBaseSoul();
    const liveKind: "operator" | "neutral" | "unknown" =
      (live.includes("你是 AgentThursday Agent") || live.includes("推进 AgentThursday 项目"))
        ? "operator"
        : live.includes("cloud-native AI agent running on durable infrastructure")
          ? "neutral"
          : "unknown";
    // `cf_agents_context_blocks` is created lazily by the
    // cf-agents session, so an agent DO that has never had a real turn won't
    // have it yet; a raw SELECT then throws (CF 1101) and the whole diagnostic
    // 500s. Guard with a sqlite_master existence check so the diagnostic
    // degrades to `frozenStored: false` on a cold agent instead of erroring.
    const tableN = Number(
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_context_blocks'
      `[0]?.n ?? 0,
    );
    const frozenN = tableN > 0
      ? Number(
          this.sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM cf_agents_context_blocks WHERE label LIKE '_system_prompt%'
          `[0]?.n ?? 0,
        )
      : 0;
    return {
      liveBaseSoulKind: liveKind,
      frozenStored: frozenN > 0,
      soulPromptVersion: version,
      ownerIsOperator: this._ownerIsOperatorCache,
    };
  }

  /**
   * pure read of the per-agent skillset state used by
   * `_buildDynamicSkillTools()` to narrow the callable tool surface.
   * Inspect routes filter `getSkillsetRuntimeSummary().agent_tools`
   * by `effective_skillset_ids` so verifier evidence reflects what
   * the agent can actually call, not the snapshot's union surface.
   */
  getAgentSkillsetEffectiveState(): {
    profile_id: string;
    effective_skillset_ids: string[] | null;
    fallback_reason: string | null;
    custom_skillset_ids: string[];
  } {
    return {
      profile_id: this.name,
      effective_skillset_ids: this.agentthursdayState.effectiveSkillsetIds ?? null,
      fallback_reason: this.agentthursdayState.skillsetFallbackReason ?? null,
      custom_skillset_ids: (this._cachedRegistryCustomManifests ?? []).map((m) => m.id),
    };
  }

  /**
   * agent-facing dynamic skill tool binding.
   * sources its loader state from the cached runtime
   * snapshot so the agent's tool surface cannot drift from the
   * `/api/skillset/runtime` view between rebuilds.
   */
  private _buildDynamicSkillTools(): Record<string, ReturnType<typeof tool>> {
    // an earlier revision: `ensureSkillsetRuntimeSnapshot` was a no-cache alias
    // after an earlier revision; collapsed to the snapshot builder directly.
    const snapshot = this._buildSkillsetSnapshotNow();
    // per-profile narrow. When `AgentThursdayState.effectiveSkillsetIds`
    // is set (populated during session init by
    // `_persistEffectiveSkillsetFromProfile`), pass it through to the
    // dynamic-tool mapper so only candidates from the resolved
    // closure remain. `null` / unset means: no per-profile filter
    // (registry DO + legacy / unknown profile case), behavior
    // identical to pre-352. An empty array means: the selection
    // resolved to nothing — surface is intentionally empty.
    const persistedIds = this.agentthursdayState.effectiveSkillsetIds;
    const allowedSkillsetIds: ReadonlySet<string> | undefined = Array.isArray(persistedIds)
      ? new Set(persistedIds)
      : undefined;
    // adapters that need DO-side state (artifact.{write,read,list})
    // receive the agent through `agentCtx`. The shared shape is
    // `AgentArtifactCtx` in `src/skillset/adapters/artifactCommon.ts`;
    // we pass `this` and the adapter narrows.
    return buildDynamicSkillTools({
      state: snapshot.state,
      env: this.env,
      envLookup: (b) => this._skillsetEnvLookup(b),
      agentCtx: this,
      allowedSkillsetIds,
      onDispatch: (canonical, payload) =>
        this.logEvent(`tool.${canonical}.dispatch`, payload),
      onResult: (canonical, payload) =>
        this.logEvent(`tool.${canonical}.result`, payload),
      onError: (canonical, payload) =>
        this.logEvent(`tool.${canonical}.error`, payload),
    }) as Record<string, ReturnType<typeof tool>>;
  }

  getTools() {
    // the M8.1 dev-shell tools (repo_read/repo_grep/git_*/repo_prepare/
    // repo_write/repo_patch/gate_*) materialize the PRIVATE operator repo
    // (your-org/AgentThursday) into a SHARED `agentthursday-dev-shell` sandbox via the global
    // GITHUB_TOKEN, and the write variants mutate that shared checkout. They are
    // operator dogfooding tools — a user-owned agent must get NONE of them (code
    // read AND write of the operator's own codebase). Gate the whole surface by
    // the cached owner verdict (resolved in onStart). Fail-CLOSED: an unresolved
    // owner (null) → not operator → no dev tools.
    const isOperator = this._ownerIsOperatorCache === true;
    return {
      ...(isOperator ? this._buildM81AgentSafeReadTools() : {}),
      // 双路记忆 dogfood tool, STRICTLY the operator DO (not the
      // broader isOperator gate: legacy admin-owned agents must not share the
      // operator's shadow profile).
      ...(this.name === OPERATOR_INSTANCE
        ? buildDualRecallTools({
            getCfToken: () => this.env.CF_AGENT_MEMORY_TOKEN,
            searchArchive: async (input) => this.conversationSearch({ ...input, callerContextId: this.name }),
            recallMemories: (query) => recallMemoryFree(this._memoryWriteHost(), { query, limit: 8 }),
            logEvent: (type, payload) => this.logEvent(type, payload),
          })
        : {}),
      ...this._buildDynamicSkillTools(),
      // `buildCoreTools` is the AgentThursday-dev lifecycle family
      // (`review_project_status` / `write_checkpoint` / `review_note` /
      // `advance_kanban_card`): operator project-management tools. A user-product
      // agent must not advertise/own "kanban 推进 / checkpoint / 项目状态"
      // (the operator 2026-06-18). Gate by the cached owner verdict like the M8.1 surface;
      // fail-closed (unresolved owner → not operator → no lifecycle tools).
      ...(isOperator ? buildCoreTools({
        sql: <T = Record<string, string | number | boolean | null>>(
          strings: TemplateStringsArray,
          ...values: (string | number | boolean | null)[]
        ): T[] => this.sql<T>(strings, ...values),
        logEvent: (type, payload) => this.logEvent(type, payload),
        getSafeState: () => this.getSafeState(),
        getAgentThursdayState: () => this.agentthursdayState,
        setAgentThursdayState: (next) => this.setAgentThursdayState(next),
        readKnowledge: () => this.readKnowledge(),
      }) : {}),
      // `execute` IIFE extracted to `src/agent/tools/executionTools.ts`.
      // an earlier revision inner workspace-tool instrumentation, an earlier revision outer
      // `tool.execute.{result,error}` wrapper, and the an earlier revision
      // `sandbox_exec` removed-surface rationale all travel with the
      // tool into the new module. The admin `/api/sandbox/exec` route
      // below stays here — it is auth-gated and not part of the
      // agent's tool surface.
      ...buildExecutionTool({
        workspace: this.workspace,
        loader: this.env.LOADER,
        getBundledModules: () => this._bundledModules,
        logEvent: (type, payload) => this.logEvent(type, payload),
      }),
      // ── Agent Memory v1 (model-facing) ─────────────────────
      // extracted to `src/agent/tools/memoryTools.ts`. The
      // `_currentTaskRememberAck` field stays on this DO; the Host
      // exposes a `setRememberAck` callback so the inline assignment
      // semantics survive the move.
      ...buildMemoryTools({
        rememberMemory: (input) => this.rememberMemory(input),
        recallMemory: (input) => this.recallMemory(input),
        setRememberAck: (ack) => { this._currentTaskRememberAck = ack; },
        getAgentThursdayState: () => this.agentthursdayState,
        setAgentThursdayState: (next) => this.setAgentThursdayState(next),
      }),
      // M7.4 an earlier revision mitigation 1: temporarily hide low-priority
      // memory management tools from the LLM tool spec to test the Kimi
      // tool-count/description-size threshold hypothesis. DO callables
      // remain available for API/inspect paths; only model-facing tools
      // `list_memories` and `forget` are removed here. Keep `recall`.
      ...buildBrowserTools({
        env: this.env,
        logEvent: (type, payload) => this.logEvent(type, payload),
      }),
      ...buildContentTools({
        env: this.env,
        logEvent: (type, payload) => this.logEvent(type, payload),
        getTraceId: () => this.agentthursdayState.currentTaskObject?.id ?? null,
        recordContentRead: (sizeBytes) => {
          const currentTaskId = this.agentthursdayState.currentTaskObject?.id ?? null;
          if (currentTaskId === null) return null;
          if (this._currentTaskReadBudget.taskId !== currentTaskId) {
            this._currentTaskReadBudget = { taskId: currentTaskId, readCount: 0, readBytes: 0 };
          }
          this._currentTaskReadBudget.readCount += 1;
          this._currentTaskReadBudget.readBytes += sizeBytes;
          return { readCount: this._currentTaskReadBudget.readCount, readBytes: this._currentTaskReadBudget.readBytes };
        },
        // an earlier revision + BYO GitHub — owner identity for content-source gating
        // (operator-internal refusal + personal/BYO owner-scoping + per-owner
        // github credential resolution). Fail-closed on unresolved owner.
        getCallerOwner: () => this._resolveCallerOwnerForContent(),
      }),
      ...buildConversationTools({
        // Track A: read THIS agent's own per-agent DO archive
        // (drain-to-self) via the local `conversationSearch` callable, instead
        // of RPC-ing the registry. For the operator/registry DO local == the
        // registry table it always searched.
        searchArchive: async (input, scopeOwnerId) => this.conversationSearch(input, scopeOwnerId),
        callerContextId: this.name,
        getTraceId: () => this.agentthursdayState.currentTaskObject?.id ?? undefined,
        logEvent: (type, payload) => this.logEvent(type, payload),
        // Multi-tenancy — resolve THIS agent's owner for owner-scoping the
        // archive search. DEMO_INSTANCE (registry/operator) → admin (unscoped);
        // a named agent → its profile owner; null on resolution failure (the
        // tool then fails closed to empty results).
        resolveOwner: () => this._resolveOwnArchiveOwnerIdentity(),
      }),
      // self-scheduling for EVERY agent (schedule_create/list/
      // cancel). Base tools target the agent ITSELF only; cross-agent
      // scheduling is a manager-surface power. Owner resolves from the
      // agent's own profile, fail-closed; rows live on the registry DO and
      // inherit every an earlier revision safety valve (cap / min interval / auto-
      // disable). Origin: share e688f483 — an agent with no schedule tool
      // faked one with memory.remember.
      ...buildScheduleTools({
        selfAgentId: this.name,
        resolveOwner: () => this._resolveOwnArchiveOwnerIdentity(),
        createSchedule: async (input) => {
          const registry = await getRegistryStub(this.env);
          return registry.createScheduledTaskRow({
            ...input,
            spec: input.spec as unknown as ScheduleSpecInput,
          });
        },
        listSchedules: async (opts) => {
          const registry = await getRegistryStub(this.env);
          return registry.listScheduledTaskRows(opts);
        },
        deleteSchedule: async (input) => {
          const registry = await getRegistryStub(this.env);
          return registry.deleteScheduledTaskRow(input);
        },
        logEvent: (type, payload) => this.logEvent(type, payload),
      }),
      // 2026-06-19 — global workspace file share (replaces fyimd). Unconditional
      // (every agent, operator or user-owned). The agent shares one of its own
      // workspace files into the owner-scoped registry pool and pastes the
      // returned owner-gated URL into its reply. Reads fail CLOSED on an
      // unresolved owner (never fall open to all tenants).
      ...buildShareFileTools({
        selfAgentId: this.name,
        readWorkspaceFile: (path) => this.workspace.readFile(path),
        recordSharedFile: async (recIn) => {
          const registry = await getRegistryStub(this.env);
          return registry.recordSharedFile(recIn);
        },
        resolveOwnScope: async () => {
          const identity = await this._resolveOwnArchiveOwnerIdentity();
          if (identity === null) return { ok: false as const };
          return { ok: true as const, scopeOwnerId: scopeOwnerIdFor(identity) };
        },
        listSharedFiles: async (scopeOwnerId) => {
          const registry = await getRegistryStub(this.env);
          return registry.listSharedFiles(scopeOwnerId);
        },
        readSharedFile: async (fileId, scopeOwnerId) => {
          const registry = await getRegistryStub(this.env);
          return registry.readSharedFile({ file_id: fileId }, scopeOwnerId);
        },
        // Relative SPA viewer path (no domain) so the link resolves on whatever
        // surface the user is viewing (console secret-auth OR user-app cookie),
        // carrying that surface's session. The `/shared/:id` page fetches the
        // owner-scoped content via the SPA's own authenticated client — a direct
        // `/api/*` link can't work (console needs the secret header; the SPA
        // router would hijack it).
        shareLinkFor: (fileId) => `/shared/${fileId}`,
        logEvent: (type, payload) => this.logEvent(type, payload),
      }),
      // 2026-06-23 — owner-scoped, read-only access to the user's uploaded
      // documents. Results are nonce-framed as untrusted (documentTools.ts);
      // reads fail CLOSED on an unresolved owner — same boundary as share_file.
      ...buildDocumentTools({
        resolveOwnScope: async () => {
          const identity = await this._resolveOwnArchiveOwnerIdentity();
          if (identity === null) return { ok: false as const };
          return { ok: true as const, scopeOwnerId: scopeOwnerIdFor(identity) };
        },
        listDocuments: async (scopeOwnerId) => {
          const registry = await getRegistryStub(this.env);
          return registry.documentList(scopeOwnerId);
        },
        searchDocuments: async (query, scopeOwnerId) => {
          const registry = await getRegistryStub(this.env);
          return registry.documentSearch({ query }, scopeOwnerId);
        },
        readDocument: async (docId, offset, length, scopeOwnerId) => {
          const registry = await getRegistryStub(this.env);
          return registry.documentRead({ doc_id: docId, offset, length }, scopeOwnerId);
        },
        logEvent: (type, payload) => this.logEvent(type, payload),
      }),
    };
  }

  private getSafeState(): AgentThursdayState {
    return {
      ...this.defaultAgentThursdayState,
      ...this.agentthursdayState,
      currentTask: this.agentthursdayState.currentTask ?? null,
      currentTaskObject: this.agentthursdayState.currentTaskObject ?? null,
      lastCheckpoint: this.agentthursdayState.lastCheckpoint ?? null,
      committedAction: this.agentthursdayState.committedAction ?? null,
      currentObstacle: this.agentthursdayState.currentObstacle ?? null,
      pendingHelpRequest: this.agentthursdayState.pendingHelpRequest ?? null,
      lastHumanResponse: this.agentthursdayState.lastHumanResponse ?? null,
      waitingForHuman: this.agentthursdayState.waitingForHuman ?? false,
      resumeTrigger: this.agentthursdayState.resumeTrigger ?? null,
      recoveryPolicy: this.agentthursdayState.recoveryPolicy ?? this.defaultAgentThursdayState.recoveryPolicy,
      lastActionResult: this.agentthursdayState.lastActionResult ?? null,
      runtimeMode: this.agentthursdayState.runtimeMode ?? this.defaultAgentThursdayState.runtimeMode,
      updatedAt: this.agentthursdayState.updatedAt ?? Date.now(),
    };
  }

  async onStart(props?: unknown): Promise<void> {
    await super.onStart(props as Record<string, unknown> | undefined);
    const host: AgentMigrationHost = {
      sql: <T = Record<string, string | number | boolean | null>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): T[] => this.sql<T>(strings, ...values),
    };
    await runAgentMigrations(host);
    // Stage 2 — seed baseline skillsets into the registry DB (system rows) so
    // the loader sources them from data, not code. Registry-DO only, idempotent.
    if (this.name === DEMO_INSTANCE) {
      try {
        const r = seedSystemSkillsets(this._customSkillsetHost());
        this.logEvent("skillset.system.seeded", { system_rows: r.systemRows });
      } catch (e) {
        this.logEvent("skillset.system.seed_error", { error: e instanceof Error ? e.message : String(e) });
      }
      // an earlier revision Phase 0 — seed the operator's own profile row (owner=admin)
      // on the registry. Idempotent; inert until Phase 1 (every DEMO_INSTANCE
      // special-case short-circuits before a profile read, and the roster
      // list excludes this id). Fail-soft: a seed failure must never block
      // registry wake.
      try {
        const seeded = seedOperatorAgentProfile(this._agentProfileHost(), new Date().toISOString());
        this.logEvent("agent_profile.operator.seed", seeded);
      } catch (e) {
        this.logEvent("agent_profile.operator.seed_error", { error: e instanceof Error ? e.message : String(e) });
      }
      // scheduled-task tick, registry DO only. `scheduleEvery` is
      // idempotent (dedup on callback+interval+payload) so every wake is safe;
      // the alarm row persists in DO storage and survives deploys. Fail-soft:
      // a scheduling failure must never block registry wake — the next wake
      // re-arms it.
      try {
        await this.scheduleEvery(AgentThursdayAgent.SCHEDULED_TASK_TICK_S, "scheduledTaskSweep");
      } catch (e) {
        this.logEvent("scheduled_task.tick.arm_error", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    // AgentThursday project knowledge is OPERATOR context. Seed it only for
    // operator agents; for a confirmed user-owned agent, purge any leaked seeds
    // (the bug that made DS Manager believe its job was to advance AgentThursday). On
    // "unknown" (registry blip) do NEITHER — never destructively purge on a
    // false negative.
    const ownerKind = await this._resolveOwnerKind();
    if (ownerKind === "operator") {
      await seedInitialKnowledgeIfNeeded(host, true);
    } else if (ownerKind === "user") {
      const purged = purgeAgentThursdaySeedKnowledge(host);
      if (purged > 0) this.logEvent("knowledge.agentthursday_seed_purged", { rows: purged });
    }
    // repopulate the registry custom-manifest cache on EVERY wake.
    // `_cachedRegistryCustomManifests` is an instance field (reset to null on DO
    // reconstruction); the persona context provider that normally fills it
    // (`composePersonaContext`) does NOT re-run when `super.onStart()` restores a
    // frozen prompt from promptStore — so after eviction a custom skillset (e.g.
    // the Publisher's `external-publishing` → `fyimd`) silently drops out of the
    // snapshot and its tools vanish, even though the durable `effectiveSkillsetIds`
    // still names it. `onStart` shares the cache's lifetime (both reset on
    // reconstruction), so refreshing here aligns them by construction, independent
    // of the frozen-prompt path. Refresh-ONLY: the durable effective-skillset state
    // is already correct, and re-resolving here against a fail-soft-empty cache
    // could overwrite a good selection with `[]`. Fail-soft inside the helper.
    if (this.name !== DEMO_INSTANCE) {
      await this._refreshRegistryCustomManifests();
    }
    // an earlier revision (v4) — the frozen-prompt re-render moved to `submitTask` (per-turn,
    // where `this.session` is present and the in-memory `loaded` flag can be reset
    // to force the providers to re-run). The onStart-only delete was insufficient:
    // `super.onStart()` already loaded the blocks, so the lazy re-render reused the
    // in-memory operator SOUL. The seed gate/purge above stays here (pure SQL).
    const safeState = this.getSafeState();
    if (
      safeState.recoveryPolicy !== this.agentthursdayState.recoveryPolicy ||
      safeState.runtimeMode !== this.agentthursdayState.runtimeMode ||
      safeState.waitingForHuman !== this.agentthursdayState.waitingForHuman ||
      safeState.updatedAt !== this.agentthursdayState.updatedAt
    ) {
      this.setAgentThursdayState(safeState);
    }
    // Tier 2: pre-bundle npm modules for codemode sandbox. Degrade to {} on failure (Tier 1 fallback).
    try {
      this._bundledModules = await this._initBundledModules();
      this.logEvent("agent.bundled_modules_ready", { packages: Object.keys(this._bundledModules) });
    } catch (e) {
      this._bundledModules = {};
      this.logEvent("agent.bundled_modules_failed", { error: e instanceof Error ? e.message : String(e) });
    }
    this.logEvent("agent.woken", { agentId: safeState.agentId });
  }

  private logEvent(type: string, payload: unknown = {}, traceId: string | null = null) {
    this.sql`
      INSERT INTO event_log (event_type, payload, created_at, trace_id)
      VALUES (${type}, ${JSON.stringify(payload)}, ${Date.now()}, ${traceId})
    `;
  }

  private getLastAssistantText(maxLen = 300): string {
    const full = this.getLastAssistantTextFull();
    if (full.length <= maxLen) return full;
    return `${full.slice(0, maxLen)} …(+${full.length - maxLen} chars)`;
  }

  /**
   * an earlier revision → 153z4a — return up to `limit` most recent
   * **user-anchored dialog turns** from the message log. Each turn
   * carries the user's text (aggregated text parts) and the
   * assistant text that followed it before the next user message
   * (also aggregated, with multi-text-parts joined by `\n\n` per
   * 149e3a; multiple consecutive assistant messages between two
   * users are concatenated with `\n\n` too).
   *
   * `assistantText` is `null` when the round produced no usable
   * assistant text — typically a tool-only round (e.g. a silent
   * `remember` followed by no synthesis prose). Callers can choose
   * to surface a fallback (e.g. `lastActionResult.summary`) for
   * those user turns instead of leaving them bare.
   *
   * 153z4 v1 returned only an assistant-only list and pre-/post-
   * paired by index in `buildWorkspaceSnapshot`. That misaligned
   * when `event_log`'s 20-row cap dropped older `task.submitted`
   * events while the message log retained every assistant turn
   * (verifier reproduced this: latest user got AGT[0] = an old
   * round, dropping the latest AGT entirely). 153z4a switches to
   * **turn-aware** pairing — the route handler matches each
   * `task.submitted` event to a turn by `userText` rather than by
   * index, so channel-ingress full-prompt user messages and
   * CLI-origin clean-text user messages both align correctly even
   * with tool-only mid-stream rounds and asymmetric log windows.
   *
   * Tool / dynamic-tool / reasoning / step-start parts are skipped
   * by the `p.type !== "text"` type-guard; `inputPreview` /
   * `outputPreview` never reach the dialog. Reset boundary holds
   * because `clearMessages()` empties the message log, so only
   * post-reset turns appear here.
   */
  // the user-app streaming card polls this while a turn runs.
  // Returns null when idle/stale (>10 min) so callers can't render leftovers.
  @callable()
  getLivePartial(): { text: string; updatedAt: number } | null {
    const p = this._livePartial;
    if (p === null || !p.text || Date.now() - p.updatedAt > 600_000) return null;
    return { text: p.text, updatedAt: p.updatedAt };
  }

  @callable()
  getDialogTurns(limit: number = 30): { userText: string; assistantText: string | null; startedAt: number | null; usage: TurnUsage | null }[] {
    const messages = this.getMessages();
    // per-turn usage joined by the anchoring user message id.
    let usageByMsg = new Map<string, TurnUsage>();
    try {
      const rows = this.sql<{ message_id: string | null; tokens_in: number | bigint; tokens_out: number | bigint; tokens_in_cached: number | bigint | null; model: string | null }>`
        SELECT message_id, tokens_in, tokens_out, tokens_in_cached, model FROM task_usage WHERE message_id IS NOT NULL`;
      usageByMsg = new Map(rows
        .filter((r) => Number(r.tokens_in) > 0 || Number(r.tokens_out) > 0)
        .map((r) => [String(r.message_id), {
          in: Number(r.tokens_in),
          out: Number(r.tokens_out),
          cached: r.tokens_in_cached === null ? null : Number(r.tokens_in_cached),
          model: r.model,
        }]));
    } catch { /* pre-474 DO or table miss — turns carry usage: null */ }
    const turns: { userText: string; assistantText: string | null; startedAt: number | null; usage: TurnUsage | null }[] = [];
    let currentUserText: string | null = null;
    let currentAssistantSegments: string[] = [];
    // turn time from the anchoring user message's metadata
    // (stamped at saveMessages since 2026-07-09; older turns → null).
    let currentStartedAt: number | null = null;
    let currentUsage: TurnUsage | null = null;

    function flush() {
      if (currentUserText === null) return;
      turns.push({
        userText: currentUserText,
        assistantText: currentAssistantSegments.length > 0
          ? currentAssistantSegments.join("\n\n")
          : null,
        startedAt: currentStartedAt,
        usage: currentUsage,
      });
      currentUserText = null;
      currentAssistantSegments = [];
      currentStartedAt = null;
      currentUsage = null;
    }

    function aggregateTextParts(m: { parts: ReadonlyArray<unknown> }): string {
      const segments: string[] = [];
      for (const p of m.parts) {
        const part = p as { type?: unknown; text?: unknown };
        if (part.type !== "text") continue;
        if (typeof part.text !== "string") continue;
        if (part.text.trim().length === 0) continue;
        segments.push(part.text);
      }
      return segments.join("\n\n");
    }

    for (const m of messages) {
      if (m.role === "user") {
        const ut = aggregateTextParts(m);
        // M9.4 — skip a truthfulness-rework CORRECTION: it's an internal reprimand,
        // not real user input, so it must not anchor a dialog turn or reach Track M
        // memory consolidation. The following corrected assistant reply then attaches
        // to the original user task (the prior anchor), which is what we want.
        if (ut.startsWith(TRUTHFULNESS_REWORK_SENTINEL)) continue;
        flush();
        currentUserText = ut;
        const md = (m as { metadata?: { createdAt?: unknown } }).metadata;
        currentStartedAt = md && typeof md.createdAt === "number" ? md.createdAt : null;
        currentUsage = usageByMsg.get((m as { id?: string }).id ?? "") ?? null;
      } else if (m.role === "assistant" && currentUserText !== null) {
        const t = aggregateTextParts(m);
        if (t.length > 0) currentAssistantSegments.push(t);
      }
      // system and other roles: ignored.
      // Assistants before any user are also ignored (no anchor).
    }
    flush();

    const cap = Math.max(1, Math.min(200, limit));
    return turns.slice(-cap);
  }

  // full last-assistant text for outbound delivery. No truncation
  // suffix (would corrupt user-visible Discord reply); an earlier revision's
  // splitForDiscord2000 handles the 2000-char chunk limit downstream.
  //
  // aggregate ALL `text` parts in the last assistant
  // message, joined by `\n\n`, preserving order. The previous
  // implementation only returned the FIRST text part, so an assistant
  // round of shape `text → tool → text` rendered just the prologue
  // and dropped the post-tool conclusion in the workspace dialog
  // (Discord outbox was fine because it goes through
  // `getNewAssistantTextsSince`, which already aggregates).
  //
  // Tool parts are NEVER included — `inputPreview` / `outputPreview`
  // are inspect-tab fields and must not leak into the main dialog
  // (an earlier revision/c privacy contract; an earlier revision forbidden patterns).
  private getLastAssistantTextFull(): string {
    const msgs = this.getMessages();
    const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return "";
    const segments: string[] = [];
    for (const p of lastAssistant.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      segments.push(text);
    }
    return segments.join("\n\n");
  }

  // aggregate ALL new assistant texts produced during this
  // submitTask round, in order. Replaces an earlier revision's "last assistant text"
  // strategy which lost results when the model produced a `progress + tool
  // call` round 1 and didn't synthesize a round 2 — the user-visible reply
  // ended up being stale progress text instead of the actual tool result
  // narrative. Aggregating all rounds means even if the last round is
  // empty / has no synthesis, prior rounds' text still reaches the user.
  // `prevMsgLen` is the message log length captured BEFORE saveMessages, so
  // the slice is exactly "messages added during this submit".
  private getNewAssistantTextsSince(prevMsgLen: number): string {
    const msgs = this.getMessages();
    if (msgs.length <= prevMsgLen) return "";
    const newSlice = msgs.slice(prevMsgLen);
    // diagnostic so verifier can pinpoint the layer that lets
    // reasoning narrative reach the public reply. If the SDK emits
    // `type: "reasoning"` parts (workers-ai-provider does for
    // `delta.reasoning_content`), they show up here and are NOT copied
    // into `collected` (the filter below requires `type === "text"`).
    // If reasoning narrative still leaks, the partType array will only
    // contain "text" — confirming the model is emitting reasoning into
    // the content channel, which is a prompt-level issue.
    try {
      const partTypeSummary = newSlice
        .filter(m => m.role === "assistant")
        .map(m => (m.parts ?? []).map((p: { type?: string }) => p.type ?? "unknown"));
      this.logEvent("assistant.parts.observed", {
        taskId: this.agentthursdayState.currentTaskObject?.id ?? null,
        partTypeSummary,
      });
    } catch { /* fail-soft — diagnostic must never break reply pipeline */ }
    const collected: string[] = [];
    for (const m of newSlice) {
      if (m.role !== "assistant") continue;
      const textsFromThisMessage = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
        .map(p => p.text)
        .join("\n\n");
      if (textsFromThisMessage.trim().length > 0) collected.push(textsFromThisMessage.trim());
    }
    return collected.join("\n\n");
  }

  // System-prompt leak guard — output-side backstop. If the user-visible reply
  // dumps the SOUL near-verbatim, override it wholesale with a refusal. Pairs
  // with the SOUL's "系统提示保密规则" instruction (the broad defense). Mode via
  // `AGENT_THURSDAY_PROMPT_LEAK_GUARD` = off | log-only | block (default block).
  // Scans the SOUL only (the platform-sensitive layer); the user-authored
  // persona is not a leak to its own owner. Detection lives in the pure,
  // unit-tested `systemPromptLeakGuard` module.
  private applySystemPromptLeakGuard(text: string, taskId: string): string {
    const mode = resolvePromptLeakGuardMode(
      (this.env as { AGENT_THURSDAY_PROMPT_LEAK_GUARD?: string }).AGENT_THURSDAY_PROMPT_LEAK_GUARD,
    );
    if (mode === "off" || !text || text.trim().length === 0) return text;
    // Scan the operator SOUL (fully confidential) + the GUARDED subset of the
    // user SOUL (its operational rules) — NOT the user SOUL's shareable
    // identity/intro, so a faithful "who are you / what can you do / how do I
    // set up" answer (which reproduces that intro) isn't mis-flagged as a leak
    // (2026-06-22). The 28-char threshold makes cross-SOUL coincidence
    // implausible, so we don't re-resolve which SOUL this agent carries.
    const scan = detectSystemPromptLeak(text, [SOUL, NEUTRAL_SOUL_GUARDED]);
    if (!scan.leaked) return text;
    this.logEvent("reply.system_prompt_leak_blocked", {
      taskId,
      mode,
      matchedRunLen: scan.matchedRunLen,
      replyTextLen: text.length,
    });
    if (mode === "log-only") return text;
    return renderSystemPromptRefusal();
  }

  // truthfulness gate. Looks at the assistant text, finds
  // tool-call claims, and cross-validates against `tool.*` events emitted
  // during this submitTask round. Returns the (possibly annotated)
  // user-visible reply.
  /**
   * Read the bare tool names that ACTUALLY dispatched in this round
   * (`tool.*` events with created_at >= startTs). `logEvent` uses Date.now()
   * for created_at, so `>= startTs` is the right scope. Extracted so both the
   * gate and the rework loop read dispatch the same way.
   */
  private _dispatchedToolNamesSince(startTs: number): Set<string> {
    const toolEvents = this.sql<{ event_type: string }>`
      SELECT event_type FROM event_log
      WHERE event_type LIKE 'tool.%' AND created_at >= ${startTs}
    `;
    const actualToolNames = new Set<string>();
    for (const row of toolEvents) {
      // event_type shape: "tool.<name>" or "tool.<name>.<sub>" (e.g. "tool.browse.ok").
      // Normalize to the bare tool name so it matches the KNOWN_TOOL_NAMES list.
      const after = row.event_type.slice("tool.".length);
      const segments = after.split(".");
      let bareName = segments[0] ?? "";
      // an earlier revision Track B-1 — `tool.memory.<verb>` events use the "memory"
      // channel prefix but the model-facing tool name is the verb itself.
      // Map back so a real `recall` / `remember` dispatch correlates with
      // the matching claim in KNOWN_TOOL_NAMES.
      if (bareName === "memory" && segments[1]) {
        const memoryAlias: Record<string, string> = {
          remember: "remember",
          recall: "recall",
          list: "list_memories",
          forget: "forget",
        };
        bareName = memoryAlias[segments[1]] ?? bareName;
      }
      if (bareName) actualToolNames.add(bareName);
    }
    return actualToolNames;
  }

  /**
   * Side-effect-free truthfulness detection for THIS round: read the dispatched
   * tools, then run the pure `classifyTruthfulness`. No logging, no state — so
   * the rework loop (the operator: "让 agent 返工") can probe the verdict (and its
   * `actualToolNames.size === 0` rework gate) without firing the violation event.
   */
  // 2026-06-27 — did any ORCHESTRATION_DISPATCH_TOOL_IDS fire in this round?
  // Used by the truthfulness gate to flag a reply that narrates a completed
  // subagent/workflow fan-out (prose, not a named-tool claim) while the trace
  // shows zero orchestration dispatch. The manager `tool.manager.<verb>.<phase>`
  // shape means a prefix match on `tool.manager.<verb>` covers exact + phased.
  private _orchestrationDispatchedSince(startTs: number): boolean {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM event_log
      WHERE created_at >= ${startTs}
        AND ( event_type LIKE 'tool.manager.agent_create%'
           OR event_type LIKE 'tool.manager.agent_message%'
           OR event_type LIKE 'tool.manager.workflow_execute%'
           OR event_type LIKE 'tool.manager.workflow_run_named%' )
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  private _detectTruthfulnessViolation(
    text: string,
    startTs: number,
  ): TruthfulnessClassification & { actualToolNames: Set<string> } {
    const actualToolNames = this._dispatchedToolNamesSince(startTs);
    const orchestrationDispatched = this._orchestrationDispatchedSince(startTs);
    return { ...classifyTruthfulness(text, actualToolNames, KNOWN_TOOL_NAMES, orchestrationDispatched), actualToolNames };
  }

  private applyTruthfulnessGate(text: string, startTs: number, taskId: string): string {
    const mode = (this.env as { AGENT_THURSDAY_TRUTHFULNESS_GATE?: string }).AGENT_THURSDAY_TRUTHFULNESS_GATE;
    const effectiveMode: "warn" | "log-only" | "off" =
      mode === "off" ? "off" : mode === "log-only" ? "log-only" : "warn";
    if (effectiveMode === "off" || !text || text.trim().length === 0) return text;

    const d = this._detectTruthfulnessViolation(text, startTs);
    if (!d.violation) return text;

    const category = d.category as string;
    this.logEvent("tool.truthfulness.violation", {
      taskId,
      // an earlier revision Track B-4 — `category` lets reviewers split fabricated
      // tool-call claims (the original an earlier revision case) from inline-JSON
      // fabrications that slip past claim detection entirely.
      category,
      claimedTools: d.verdict.claims.map(c => c.tool),
      fabricatedTools: d.verdict.fabricated,
      consistentTools: d.verdict.consistent,
      dispatchedToolNames: d.dispatchedToolNames,
      inlineJsonCount: d.inlineJsonCount,
      // an earlier revision v3 — split fenced vs raw schema for diagnosis.
      fencedJsonCount: d.fencedJsonCount,
      rawSchemaCount: d.rawSchemaCount,
      // 2026-06-27 — fabricated subagent/workflow fan-out (prose, no dispatch).
      orchestrationFabricated: d.orchestrationFabricated,
      claimsCount: d.verdict.claims.length,
      replyTextLen: text.length,
      mode: effectiveMode,
    });

    // share verdict with the per-turn supplier summary
    // event without changing user-visible behavior. Set BEFORE the early
    // returns below so log-only mode also persists the cross-link in
    // supplier.signal.summary.
    this._currentTaskTruthfulnessVerdict = { violationSeen: true, category };

    if (effectiveMode === "log-only") return text;
    // 2026-06-27 — fabricated subagent/workflow fan-out → its own marker.
    if (d.category === "fabricated-orchestration") {
      return `${renderOrchestrationFabricationWarning()}\n\n${text}`;
    }
    // M7.6 v3 — inline-JSON-without-dispatch also gets a user-visible
    // marker now (previously log-only). the operator: "这种错误应该抓到 downgrade".
    if (d.verdict.fabricated.length === 0) {
      const inlineWarning = renderInlineJsonWarning();
      return `${inlineWarning}\n\n${text}`;
    }
    // warn mode → prepend a single warning line.
    const warning = renderTruthfulnessWarning(d.verdict.fabricated);
    return `${warning}\n\n${text}`;
  }

  // manager-tier truthfulness drift fail-soft gate.
  // Distinct from an earlier revision `applyTruthfulnessGate`: observation-only,
  // never mutates the reply text, only fires for manager-tier agents,
  // and watches the `manager.*` (+ workspace-write) family that an earlier revision
  // does not cover. Caller passes the raw (pre-assembly) reply so a
  // an earlier revision warning prefix that lists tool names cannot smuggle false
  // claims into this gate's scope.
  private applyManagerTruthfulnessDriftGate(
    rawReplyText: string,
    startTs: number,
    taskId: string,
  ): void {
    try {
      const effectiveIds = this.agentthursdayState.effectiveSkillsetIds;
      const isManager = Array.isArray(effectiveIds) && effectiveIds.includes("manager");
      if (!isManager) return;
      if (!rawReplyText || rawReplyText.trim().length === 0) return;

      const toolEvents = this.sql<{ event_type: string }>`
        SELECT event_type FROM event_log
        WHERE event_type LIKE 'tool.%' AND created_at >= ${startTs}
      `;
      const observed = new Set<string>();
      for (const row of toolEvents) {
        const after = row.event_type.slice("tool.".length);
        const segments = after.split(".");
        if (segments.length === 0) continue;
        // Manager-aware parse: `tool.manager.<verb>.<phase>` → tool id
        // is `manager.<verb>`. an earlier revision's parser takes `segments[0]` and
        // would map every manager event to bare "manager", which is not
        // a watched name. Workspace-write claims (`tool.write.*` /
        // `tool.edit.*`) fall through to the single-segment branch.
        let toolId = "";
        if (segments[0] === "manager" && segments[1]) {
          toolId = `manager.${segments[1]}`;
        } else if (segments[0]) {
          toolId = segments[0];
        }
        if (toolId) observed.add(toolId);
      }

      const drift = computeManagerTruthfulnessDrift(
        rawReplyText,
        MANAGER_TIER_WATCHED_TOOL_NAMES,
        observed,
      );
      if (!drift.has_drift) return;

      this.logEvent("task.reply.truthfulness_drift", {
        task_id: taskId,
        agent_id: this.name,
        agent_skillset: "manager",
        claimed_tool_ids: drift.claimed_tool_ids,
        observed_tool_ids: drift.observed_tool_ids,
        missing_claims: drift.missing_claims,
        extra_observed: drift.extra_observed,
        source: "manager-reply-finalize",
      });
    } catch {
      // Fail-soft per ADR §7: any error in the drift gate must never
      // affect the user-visible reply or the an earlier revision path.
    }
  }

  // supplier-side degradation marker. Reads the per-task
  // signal collector populated by onStepFinish + onError, asks the pure
  // helper for a verdict, prepends a ⚠️ line if degraded. Fail-soft per
  // kanban: any throw inside detection/render returns the input text
  // unchanged so the main reply path can never break.
  private applySupplierDegradationMarker(text: string): string {
    if (!text || text.trim().length === 0) return text;
    try {
      const verdict = detectSupplierDegradation(this._currentTaskSupplierSignals);
      if (!verdict.degraded) return text;
      const warning = renderSupplierDegradationWarning(verdict.reasons);
      return `${warning}\n\n${text}`;
    } catch {
      return text;
    }
  }

  // persist a single per-turn `supplier.signal.summary`
  // event_log row so reviewers can grep / inspect tool-decision path
  // signals after the fact. No prompts, no raw provider payloads, no
  // secrets, no raw error strings — only counts, enums, and bounded
  // identifier names already vetted by the onStepFinish capture path.
  // Fail-soft: any throw inside derivation/log returns silently so the
  // event omission never breaks submitTask.
  private logSupplierSignalSummary(taskId: string): void {
    try {
      const verdict = detectSupplierDegradation(this._currentTaskSupplierSignals);
      // Bound steps so a runaway loop doesn't bloat one row.
      const STEP_CAP = 32;
      const truncated = this._currentTaskSupplierSignals.steps.length > STEP_CAP;
      const steps = this._currentTaskSupplierSignals.steps.slice(0, STEP_CAP).map(s => ({
        finishReason: s.finishReason ?? null,
        toolCallCount: s.toolCallCount,
        toolResultCount: s.toolResultCount,
        // an earlier revision (2a) — surface tool-error parts in the inspect
        // payload so reviewers can distinguish "supplier didn't
        // dispatch" from "tool dispatched and errored".
        toolErrorCount: s.toolErrorCount,
        toolErrorNames: s.toolErrorNames,
        // 1 — surface approval-pending count so reviewers
        // can see the legitimate pause path and confirm the new guard
        // in `detectSupplierDegradation` subtracted it correctly.
        toolApprovalPendingCount: s.toolApprovalPendingCount,
        toolCallNames: s.toolCallNames,
        toolResultNames: s.toolResultNames,
      }));
      this.logEvent("supplier.signal.summary", {
        taskId,
        // M7.5 an earlier revision convention — current task id doubles as cross-DO
        // trace id elsewhere; keep null until a separate carrier exists.
        traceId: null,
        model: this._lastStepModel?.modelId ?? null,
        provider: this._lastStepModel?.provider ?? null,
        // runtime registry enforces workers-ai-only:
        //   - POST /api/agent-profiles rejects non-WA models
        //     (`unsupported_model`, 400)
        //   - getModel() resolves only workers-ai targets, fail-softs
        //     to the WA default for legacy / unknown profiles
        // So this label still matches the actual adapter in M9.0 v1.
        // If a future card opens a non-WA dispatch path,
        // `_resolveWorkersAITargetWithFallback()` and this site both
        // need to learn how to surface the new provider.
        adapter: "workers-ai-provider",
        steps,
        stepsTruncated: truncated,
        streamTruncatedSeen: this._currentTaskSupplierSignals.streamTruncatedSeen,
        degraded: verdict.degraded,
        reasons: verdict.reasons,
        truthfulnessViolationSeen: this._currentTaskTruthfulnessVerdict.violationSeen,
        truthfulnessCategory: this._currentTaskTruthfulnessVerdict.category,
      });
    } catch { /* fail-soft: never block submitTask on summary log */ }
  }

  private readKnowledge(): string {
    // thin delegate. Body extracted to memoryOps; this
    // wrapper preserves closure identity at `withContext("soul")` and
    // `getTools()` (both close over `this.readKnowledge`).
    return readKnowledgeFree(this._memoryReadHost());
  }

  private makeTaskObject(task: string, source: TaskObject["source"]): TaskObject {
    return { id: `task-${Date.now().toString(36)}`, title: task.slice(0, 120), status: "active", source, createdAt: Date.now(), updatedAt: Date.now() };
  }

  @callable()
  async submitTask(
    task: string,
    opts?: {
      displayText?: string;
      taskContext?: TaskContext;
      // manager's own outer task context, injected into the
      // LLM-facing first turn as a `<manager-context>` block so the
      // manager LLM can grep its canonical outer `manager_task_id`
      // (= registry `event_log.trace_id`) directly from its own input.
      managerTaskContext?: {
        manager_task_id: string;
        agent_id: string;
        source?: string;
        conversation_id?: string;
      };
    },
  ): Promise<{ ok: boolean; taskId: string; loopTriggered: boolean; replyText: string; envelopeId: string | null }> {
    // an earlier revision (v4) — force a TRUE neutral-SOUL re-render on a version bump.
    // Earlier attempts failed on warm sessions: plain `refreshSystemPrompt()`
    // no-ops because `super.onStart()` already ran `ContextBlocks.load()`
    // (loaded=true), so it re-serializes the cached OPERATOR-SOUL blocks; and
    // deleting the durable `_system_prompt*` rows in onStart doesn't help either
    // because the in-memory blocks stay loaded. The fix: reset `loaded` so
    // `refreshSystemPrompt()` re-runs the providers (→ `_resolveBaseSoul` →
    // neutral SOUL for a scoped owner) AND drop the durable rows. Runs here
    // (per-turn, `this.session` reliably present), version-gated → fires once on
    // the agent's next turn after deploy. Fail-soft: never break a turn.
    try {
      const v = await this.ctx.storage.get<number>("soul_prompt_version");
      if (v !== SOUL_PROMPT_VERSION && this.session) {
        try {
          this.sql`DELETE FROM cf_agents_context_blocks WHERE label LIKE '_system_prompt%'`;
        } catch { /* table absent — nothing frozen to bust */ }
        const blocks = (this.session as unknown as { context?: { loaded?: boolean } }).context;
        if (blocks) blocks.loaded = false;
        await this.session.refreshSystemPrompt();
        await this.ctx.storage.put("soul_prompt_version", SOUL_PROMPT_VERSION);
        this.logEvent("system_prompt.frozen_busted", { version: SOUL_PROMPT_VERSION });
      }
    } catch { /* fail-soft */ }
    // conversational resume from a prior `needs_human`
    // pause. While paused, only explicit resume intents ("继续" /
    // "proceed" / "resume" / ...) may advance the current loop. Other
    // text receives a reminder and does NOT create a new task or call the
    // model, preserving the operator's "resume via conversation" requirement.
    //
    // `opts.displayText` lets the caller (ChannelHub) split
    // the user-facing display text from the metadata-rich agent prompt.
    // When provided:
    //   - LLM still sees `task` (full prompt, including channel
    //     metadata + safety suffix) via `saveMessages`;
    //   - currentTask / taskObject.title / `task.submitted` event use
    //     `displayText` so the Web/mobile YOU line and TopStatusBar
    //     don't leak `[discord channel message ...]` etc.
    //   - `isResumeIntent` is checked against `displayText` since
    //     resume keywords come from the human-visible content.
    // When omitted, `displayText` defaults to `task` and behavior is
    // identical to pre-149e3.
    const display = opts?.displayText ?? task;
    // ADR §5.3 promotion of structured TaskContext into the
    // subagent's first-turn user message. We re-validate via the zod
    // schema at this DO RPC boundary; on failure we drop the block
    // (fail-soft) and proceed with plain `task`, since the manager
    // preflight is meant to have already rejected invalid input.
    const validatedTaskContext: TaskContext | null = (() => {
      if (opts?.taskContext === undefined) return null;
      const parsed = TaskContextSchema.safeParse(opts.taskContext);
      return parsed.success ? parsed.data : null;
    })();
    // render `<manager-context>` JSON block when the caller
    // (always `submitManagerTask` today) supplied the manager's own
    // outer task context. The block is structured (fenced JSON), not
    // prose, so the LLM can extract `manager_task_id` mechanically.
    // Prepended ahead of any `<task-context>` block so first-turn
    // ordering is: manager-context → task-context → user task text.
    const managerCtxBlock: string | null = opts?.managerTaskContext !== undefined
      ? `<manager-context>\n${JSON.stringify(opts.managerTaskContext, null, 2)}\n</manager-context>`
      : null;
    const taskContextBlock: string | null = validatedTaskContext !== null
      ? renderTaskContextBlock(validatedTaskContext)
      : null;
    const subagentTaskText = [managerCtxBlock, taskContextBlock, task]
      .filter((s): s is string => s !== null)
      .join("\n\n");
    const prevTaskObj = this.agentthursdayState.currentTaskObject;
    // M8.9 Step 10 phase A resume-intent short-circuit. Helper
    // returns either a paused early-return (with the exact log payload +
    // SubmitTaskResult the orchestrator emits/returns verbatim) or a
    // proceed decision carrying `isExplicitResume` for downstream phases.
    const resumeDecision = decideResumeShortCircuit({
      display,
      waitingForHuman: !!this.agentthursdayState.waitingForHuman,
      prevTaskObj,
    });
    if (resumeDecision.paused) {
      this.logEvent("loop.pause.awaiting_resume", resumeDecision.logPayload);
      return resumeDecision.result;
    }
    const isExplicitResume = resumeDecision.isExplicitResume;

    // M8.9 Step 10 phase B task identity decision. Pure helper
    // returns the source / isResubmit / taskObject / nextTaskTitle and the
    // discriminated `nextStatePatchKind` ("resume-or-resubmit" vs
    // "new-task") so the orchestrator below still owns nextState assembly
    // (and the `lastActionResult: null` reset on new-task branch).
    const identity = decideTaskIdentity({
      display,
      task,
      dogfoodTask: DOGFOOD_TASK,
      isExplicitResume,
      prevTaskObj,
      now: Date.now(),
      makeTaskObject: (d, s) => this.makeTaskObject(d, s),
    });
    const isResubmit = identity.isResubmit;
    const taskObject = identity.taskObject;
    const nextTaskTitle = identity.nextTaskTitle;
    // New task: reset lastActionResult so old round's completion state doesn't bleed in.
    // Explicit resume keeps the current paused task identity and does not
    // manufacture a new task titled "继续".
    const nextState = identity.nextStatePatchKind === "resume-or-resubmit"
      ? { ...this.agentthursdayState, currentTask: nextTaskTitle, currentTaskObject: taskObject, status: "running" as const, waitingForHuman: false, updatedAt: Date.now() }
      : { ...this.agentthursdayState, currentTask: display, currentTaskObject: taskObject, status: "running" as const, waitingForHuman: false, lastActionResult: null, updatedAt: Date.now() };
    this.setAgentThursdayState(nextState);
    if (isExplicitResume) {
      this.logEvent("loop.resume.needs_human", {
        taskId: taskObject.id,
        prevTaskId: prevTaskObj?.id ?? null,
        userTextPreview: display.slice(0, 80),
      });
    }
    // `task.submitted.task` drives the YOU line in
    // `summaryStream`; use the clean `display` so the main dialog
    // never shows internal channel metadata. The original full
    // prompt is recorded under `taskPrompt` only when it differs,
    // so inspect/event-log surfaces can still audit the metadata
    // payload that reached the model.
    const taskSubmittedPayload: Record<string, unknown> = { task: display, taskId: taskObject.id, isResubmit };
    if (display !== task) taskSubmittedPayload.taskPrompt = task;
    // surface the structured TaskContext as a top-level
    // event field so inspect/event-log readers can grep on it without
    // re-parsing the `<task-context>` JSON out of the user message.
    // also surface a bounded preview of the rendered
    // `<task-context>` block so inspect/grep can mechanically prove the
    // LLM-facing first-turn user message included the block.
    if (validatedTaskContext !== null) {
      taskSubmittedPayload.taskContext = validatedTaskContext;
      taskSubmittedPayload.task_context_block_preview = renderTaskContextBlockPreview(validatedTaskContext);
    }
    // surface the manager's own outer task context (when
    // present) as a structured field plus a bounded block preview, so
    // inspect/event-log readers can grep the canonical outer
    // `manager_task_id` straight off `task.submitted` without parsing
    // the first-turn user message.
    if (opts?.managerTaskContext !== undefined && managerCtxBlock !== null) {
      taskSubmittedPayload.managerTaskContext = opts.managerTaskContext;
      taskSubmittedPayload.manager_context_block_preview = managerCtxBlock;
    }
    // `subagentTaskText` is what `saveMessages` actually persists
    // for this turn (display + context blocks). When task-context /
    // manager-context blocks are present it diverges from both `display`
    // (clean YOU-line) and `task` (the raw caller string). Surfacing it
    // lets `buildWorkspaceSnapshot` fall back to exact-match against the
    // persisted text when prompt/display fail to match a dialog turn.
    if (subagentTaskText !== display && subagentTaskText !== task) {
      taskSubmittedPayload.subagentTaskText = subagentTaskText;
    }
    this.logEvent("task.submitted", taskSubmittedPayload);
    // snapshot message-log length BEFORE saveMessages so we
    // can collect ALL new assistant texts produced during this round, not
    // just the "last assistant message" (an earlier revision's strategy lost results
    // when the model produced progress + tool call but no synthesis turn).
    const prevMsgLen = this.getMessages().length;
    // truthfulness gate prep: snapshot timestamp BEFORE
    // saveMessages so we can scope the "what tools actually dispatched in
    // THIS round" query to events emitted during the loop.
    const truthfulnessStartTs = Date.now();
    // M8.9 Step 10 phase C turn-scope reset. Helper returns a
    // patch with exactly three keys; orchestrator destructures and assigns
    // so the position (after `truthfulnessStartTs` snapshot, before
    // envelope draft) does not drift.
    //   - supplierSignals: M7.5 an earlier revision collector (populated by
    //     onStepFinish + onError during saveMessages)
    //   - truthfulnessVerdict: M7.5 an earlier revision (prevents stale verdict leak
    //     into supplier summary)
    //   - rememberAck: an earlier revision (fallback path only fires for THIS round)
    const turnReset = buildTurnScopeResetPatch();
    this._currentTaskSupplierSignals = turnReset.supplierSignals;
    this._livePartial = null; // new turn, clear stale partial
    this._currentTaskTruthfulnessVerdict = turnReset.truthfulnessVerdict;
    this._currentTaskRememberAck = turnReset.rememberAck;
    // open this turn's evidence envelope BEFORE saveMessages so
    // the agent-facing read/gate tool wrappers (which capture
    // `getCurrentEnvelopeId` as a closure in getTools) see a non-null id
    // when they fire during the loop. _ensureEnvelopeStore also populates
    // `_envelopeStoreCache`, which the wrappers read. Fail-soft: if init
    // throws we proceed with envelopeId=null and the wrappers no-op the
    // recording side without breaking tool execution.
    let envelopeId: string | null = null;
    try {
      const envStore = await this._ensureEnvelopeStore();
      const draft = envStore.createDraft({
        task_id: taskObject.id,
        // 2026-06-27 — was hardcoded "software-dev" (mislabeled EVERY agent's
        // evidence regardless of its real skillset). Use the agent's resolved
        // effective skillset; "unknown" only if it hasn't resolved yet.
        skillset_id: this.agentthursdayState.effectiveSkillsetIds?.[0] ?? "unknown",
        agent_id: this.name,
        intent: {
          source: "human_directive",
          source_ref: taskObject.id,
          declared_goal: display.slice(0, 1000),
          expected_output: [],
        },
      });
      envelopeId = draft.envelope_id;
      this._currentEnvelopeId = envelopeId;
      this._currentTaskWrappedToolIds = [];
      this.logEvent("evidence.envelope.draft.from_turn", {
        envelope_id: envelopeId,
        task_id: taskObject.id,
      });
      // alarm backstop. If the LLM stream hangs / dies and
      // submitTask's happy-path finally never runs, this fires N
      // seconds later and finalizes the envelope idempotently. The
      // lazy sweeper from /cli/status acts as a faster, poll-driven
      // complement. Scheduling failure is non-fatal — the lazy path
      // still covers the demo even if the alarm row didn't write.
      try {
        await this.schedule(
          AgentThursdayAgent.ENVELOPE_SWEEPER_ALARM_DELAY_S,
          "envelopeSweeperBackstop",
          { envelopeId, taskId: taskObject.id },
        );
      } catch { /* fail-soft */ }
    } catch {
      envelopeId = null;
      this._currentEnvelopeId = null;
      this._currentTaskWrappedToolIds = [];
    }
    // log prompt-side gate-intent decision BEFORE the
    // saveMessages await so the lazy sweeper can classify an orphan
    // draft as read-only-safe even when saveMessages hangs and the
    // in-try gate-intent log (line ~2858, post-saveMessages) never
    // fires. The an earlier revision in-try detect remains authoritative for
    // the happy-path seal contract (it observes the same `display`,
    // so the result is identical when both run); this earlier event
    // is purely the persistence the sweeper consults at finalize
    // time. Fail-soft so a regex glitch can't break submitTask.
    try {
      const earlyGateIntent = detectGateIntent(display);
      this.logEvent("submitTask.prompt.gate_intent_check", {
        taskId: taskObject.id,
        envelopeId: envelopeId ?? null,
        detected: earlyGateIntent.detected,
        autodispatch: earlyGateIntent.autodispatch,
        matchedPatterns: earlyGateIntent.matchedPatterns,
      });
    } catch { /* fail-soft — sweeper falls back to strict ring-presence */ }
    // track whether prompt or raw model reply contains
    // gate intent. Both flags must be false for the seal contract to
    // treat this turn as read-only safe and let an empty-execution
    // envelope pass. Default false; set inside the per-stage try
    // blocks below so a regex glitch on either side falls back to
    // the strict ring-presence path.
    let promptGateIntentDetectedForSeal = false;
    let replyGateIntentDetectedForSeal = false;
    // read-side intent on the human-visible prompt. When
    // true AND the agent dispatched zero tools, the seal contract
    // refuses the read-only-safe pass path and emits the degraded
    // verdict reason `read_intent_no_execution` so reviewers can grep
    // on file-inspection prompts that closed with no evidence.
    let promptReadIntentDetectedForSeal = false;
    // supplier-side unwrapped mutation observation. Same
    // outer-scope hoist as the read-intent flag so the `finally`
    // block can thread it into seal regardless of which inner stage
    // set it. Inner detector lives below where the supplier signal
    // is settled; default false so a regex/state glitch falls back
    // to the strict ring-presence path.
    let mutationIntentObservedUnwrapped = false;
    // prompt-level mutation intent. When true AND
    // `totalToolCalls === 0`, the seal must NOT pass via
    // read_only_no_action_required; emit `mutation_intent_no_execution`
    // and replace the visible reply (narrative is fabricated end-to-end).
    // Mutually exclusive with the 295b read-intent override.
    let promptMutationIntentDetectedForSeal = false;
    let promptMutationIntentMatchedPatterns: string[] = [];
    try {
    // the user message anchors the dialog turn; its id keys the
    // per-turn usage row (seeded here, filled at finalize).
    const turnUserMessageId = crypto.randomUUID();
    const firstResult = await this.saveMessages([{
      id: turnUserMessageId,
      role: "user",
      // turn timestamp: the user message anchors a dialog turn,
      // so its metadata carries the turn's start time (read back by
      // getDialogTurns; the SDK persists messages as JSON so this survives).
      metadata: { createdAt: Date.now() },
      // `subagentTaskText` is `task` verbatim when no
      // TaskContext was supplied; otherwise it carries the
      // `<task-context>` fenced JSON block followed by the original
      // text (ADR §5.3 preserves the original prose).
      parts: [{ type: "text", text: subagentTaskText }],
    }]);
    // seed per-turn usage (task_id ← current task; finalize fills
    // tokens). Fail-soft: usage accounting must never break the turn.
    try {
      const tuTaskId = this.agentthursdayState.currentTaskObject?.id ?? null;
      if (tuTaskId) {
        this.sql`INSERT OR REPLACE INTO task_usage (task_id, message_id, tokens_in, tokens_out, tokens_in_cached, model, provider, created_at)
          VALUES (${tuTaskId}, ${turnUserMessageId}, 0, 0, NULL, NULL, NULL, ${Date.now()})`;
      }
    } catch { /* fail-soft */ }
    // M9.4 (2026-06-25) — truthfulness REWORK loop (the operator: "让 agent 返工，直到给出
    // 符合要求的结果；三次然后旧 warning"). If this round produced NO real tool
    // dispatch but the reply fabricates a tool claim / inline-json result, the
    // model didn't touch the world — so we can safely re-run it with a correction
    // (nothing to re-fire), letting it actually do the thing or drop the claim.
    // The moment an attempt dispatches a real tool (size>0) OR the budget is
    // exhausted, we stop and fall through to the EXISTING warn-append in the
    // reply-assembly chain below. Gated to warn mode; log-only/off keep their
    // exact prior behavior (no rework). `effective*` track the FINAL attempt;
    // `lastNonEmptyReply` holds the latest non-blank leak-guarded reply so a
    // skipped/empty re-run can't blank the user's reply (we keep the prior one).
    let result = firstResult;
    let effectivePrevMsgLen = prevMsgLen;
    let effectiveTruthfulnessStartTs = truthfulnessStartTs;
    let lastNonEmptyReply: string | null = null;
    {
      const reworkMode = (this.env as { AGENT_THURSDAY_TRUTHFULNESS_GATE?: string }).AGENT_THURSDAY_TRUTHFULNESS_GATE;
      const maxReworks = (() => {
        const raw = Number((this.env as { AGENT_THURSDAY_TRUTHFULNESS_MAX_REWORKS?: string }).AGENT_THURSDAY_TRUTHFULNESS_MAX_REWORKS);
        return Number.isFinite(raw) && raw >= 0 ? Math.min(5, Math.floor(raw)) : MAX_TRUTHFULNESS_REWORKS;
      })();
      if (reworkMode !== "off" && reworkMode !== "log-only" && maxReworks > 0) {
        let reworks = 0;
        // while(true): the budget check sits AFTER capturing this attempt so the
        // LAST re-run's output is always surfaced (even when budget then exhausts).
        for (;;) {
          // Only rework a turn that completed cleanly — a skipped (superseded by a
          // newer user turn) or failed turn must not be re-run.
          if (result.status !== "completed") break;
          // Compute leak-guard ONLY on non-empty text so the guard's side effects
          // fire at most once per distinct reply (advisor: don't double-fire it).
          const rawAttempt = stripThinkingTagsFromReply(this.getNewAssistantTextsSince(effectivePrevMsgLen));
          const replyEmpty = !rawAttempt || rawAttempt.trim().length === 0;
          const attemptReply = replyEmpty ? "" : this.applySystemPromptLeakGuard(rawAttempt, taskObject.id);
          if (!replyEmpty) lastNonEmptyReply = attemptReply;
          const detect = replyEmpty
            ? null
            : this._detectTruthfulnessViolation(attemptReply, effectiveTruthfulnessStartTs);
          // Pure decision — the load-bearing safety gate lives here (advisor):
          // re-running re-runs the agent loop WITH tools, which aren't idempotent,
          // so we rework ONLY when this attempt dispatched no real tool (nothing to
          // re-fire; the model can then actually do what it falsely claimed). A turn
          // that touched the world → `warn-fallback` → break to the warn-append.
          const action = decideTruthfulnessRework({
            replyEmpty,
            violation: detect?.violation ?? false,
            dispatchedRealTool: (detect?.actualToolNames.size ?? 0) !== 0,
          });
          if (action !== "rework" || detect === null) break;
          if (reworks >= maxReworks) break; // budget exhausted → keep this reply, warn below
          reworks++;
          this.logEvent("tool.truthfulness.rework", {
            taskId: taskObject.id,
            attempt: reworks,
            maxReworks,
            category: detect.category,
            fabricatedTools: detect.verdict.fabricated,
            inlineJsonCount: detect.inlineJsonCount,
          });
          // Re-scope BEFORE the re-run so the next verdict + the surfaced reply
          // see only the corrected attempt (not the violating one + the correction).
          effectivePrevMsgLen = this.getMessages().length;
          effectiveTruthfulnessStartTs = Date.now();
          result = await this.saveMessages([{
            id: crypto.randomUUID(),
            role: "user",
            // Sentinel-prefixed so `getDialogTurns` skips this synthetic
            // correction (keeps it out of Track M memory consolidation).
            parts: [{ type: "text", text: `${TRUTHFULNESS_REWORK_SENTINEL}\n${renderTruthfulnessReworkCorrection(detect)}` }],
          }]);
        }
      }
    }
    // aggregate all assistant texts produced during this
    // submitTask round (replaces an earlier revision's `getLastAssistantTextFull()`).
    // an earlier revision still in code as a fallback for inspect surfaces.
    // strip `<think>...</think>` residue at the trust
    // boundary between raw model output and the user-facing reply
    // pipeline. Sanitizing here means the truthfulness gate, supplier
    // marker, gate-intent guard, envelope marker, and `task.reply.
    // finalized` log all observe clean text.
    // System-prompt leak guard runs FIRST on the post-think-strip reply (the
    // exact text the user will see), before the truthfulness / degradation /
    // remember-ack assembly chain — so a near-verbatim SOUL dump is replaced
    // wholesale with a refusal that the rest of the chain harmlessly passes through.
    // `lastNonEmptyReply` is the latest non-blank leak-guarded reply the rework
    // loop already computed (so a skipped/empty re-run keeps the prior good reply
    // instead of blanking it, and the leak guard isn't re-run on it). When the loop
    // didn't run (no rework / disabled / no violation produced text) it's null and
    // we fall back to today's exact computation — byte-identical on the happy path.
    const rawReplyText = lastNonEmptyReply ?? this.applySystemPromptLeakGuard(
      stripThinkingTagsFromReply(this.getNewAssistantTextsSince(effectivePrevMsgLen)),
      taskObject.id,
    );
    // tool-truthfulness gate. Detect tool-call claims in the
    // assistant text and cross-validate against `tool.*` events actually
    // logged during this round. Fabricated claims (claim without event) get
    // a warning line prepended to the user-visible reply + a structured
    // `tool.truthfulness.violation` event for inspect. Mode controlled by
    // env.AGENT_THURSDAY_TRUTHFULNESS_GATE: "warn" (default) | "log-only" | "off".
    // M8.9 Step 11 phase H reply assembly chain. Three-step
    // order is load-bearing (see helper docstring): truthfulness gate →
    // supplier degradation marker → remember-ack fallback. The
    // truthfulness gate's side effect on `_currentTaskTruthfulnessVerdict`
    // is preserved because the gate runs inside the host-bound callback.
    const replyAssembly = applyReplyAssemblyChain({
      rawReplyText,
      rememberAck: this._currentTaskRememberAck,
      applyTruthfulnessGate: (text) =>
        // `effectiveTruthfulnessStartTs` scopes to the FINAL rework attempt; equals
        // the original startTs when no rework occurred. If the loop exhausted its
        // budget while still violating, this re-detects + applies the old warn line.
        this.applyTruthfulnessGate(text, effectiveTruthfulnessStartTs, taskObject.id),
      applySupplierDegradationMarker: (text) =>
        this.applySupplierDegradationMarker(text),
      applyRememberAckFallback,
    });
    let replyText = replyAssembly.replyText;
    // manager-tier truthfulness drift fail-soft. Pure
    // observability event; does not mutate `replyText`. Pass the raw
    // pre-assembly reply so a an earlier revision warning prefix that lists tool
    // names cannot smuggle false claims into this gate's scope.
    this.applyManagerTruthfulnessDriftGate(
      rawReplyText,
      truthfulnessStartTs,
      taskObject.id,
    );
    // persist per-turn supplier signal summary into
    // event_log so reviewers can grep / inspect tool-decision path
    // signals later without re-deploying diag endpoints. Fail-soft: the
    // helper swallows any throw so a logging glitch can't break the turn.
    this.logSupplierSignalSummary(taskObject.id);
    // finalize currentTaskObject.status. Without this the
    // object stays "active" forever, an earlier revision readiness reports
    // `lifecycle=active`, ChannelHub auto-route permanently busy-skips.
    // Map: completed/skipped → completed (the call returned cleanly);
    // anything else → failed (conservative; unknown is suspicious).
    const finalLifecycle: TaskLifecycle =
      result.status === "completed" ? "completed"
      : result.status === "skipped" ? "completed"
      : "failed";
    // Re-read latest state — saveMessages can mutate it via tool calls.
    // Only finalize if currentTaskObject is still THIS submit; if another
    // submit raced us and overwrote it, leave the new object alone.
    const latest = this.agentthursdayState;
    const finalTaskObject = latest.currentTaskObject?.id === taskObject.id
      ? { ...latest.currentTaskObject, status: finalLifecycle, updatedAt: Date.now() }
      : latest.currentTaskObject;
    this.setAgentThursdayState({
      ...latest,
      status: "idle",
      currentTaskObject: finalTaskObject,
      updatedAt: Date.now(),
    });
    this.logEvent("task.lifecycle.finalized", {
      taskId: taskObject.id,
      lifecycle: finalLifecycle,
      saveMessagesStatus: result.status,
      stomped: latest.currentTaskObject?.id !== taskObject.id,
    });
    // derive + persist per-task degradation summary.
    // Pure function call + single logEvent. Wrapped in try/catch so a
    // logging glitch can never break submitTask.
    // when summary state === "needs_human" AND the
    // `AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN` runtime gate is enabled, pause the
    // loop conversationally: append the pause message to replyText, set
    // waitingForHuman + lifecycle="waiting" so /status / continueTask
    // (Force continue) honor the pause, and log a structured event for
    // /api/inspect. Resume is driven by user natural-language reply
    // (handled at submitTask top via isResumeIntent).
    try {
      const summary = deriveTaskDegradationSummary({
        taskId: taskObject.id,
        supplierSignals: this._currentTaskSupplierSignals,
        truthfulnessVerdict: this._currentTaskTruthfulnessVerdict,
        modelId: this._lastStepModel?.modelId ?? null,
        provider: this._lastStepModel?.provider ?? null,
        // see comment above the supplier.signal.summary
        // site for the workers-ai-only invariant. Stays accurate
        // for M9.0 v1.
        adapter: "workers-ai-provider",
        finalLifecycle,
        now: Date.now(),
      });
      this.logEvent("degradation.summary", summary);
      // read config at decision time so `wrangler secret put`
      // takes effect on the next turn without redeploying code.
      const pauseEnabled = isPauseEnabled(this.env as { AGENT_THURSDAY_PAUSE_ON_NEEDS_HUMAN?: string });
      if (shouldPauseForNeedsHuman(pauseEnabled, summary, taskObject.id)) {
        const pauseMessage = renderPauseMessage(summary);
        replyText = replyText && replyText.trim().length > 0
          ? `${replyText}\n\n${pauseMessage}`
          : pauseMessage;
        // Reuse existing waitingForHuman + status="waiting" machinery so
        // /status, continueTask (Force continue at line ~1427 checks
        // `!s.waitingForHuman`), and an earlier revision banner all reflect pause
        // coherently. Override the just-finalized lifecycle.
        const stateNow = this.agentthursdayState;
        const pausedTaskObject = stateNow.currentTaskObject?.id === taskObject.id
          ? { ...stateNow.currentTaskObject, status: "waiting" as const, updatedAt: Date.now() }
          : stateNow.currentTaskObject;
        this.setAgentThursdayState({
          ...stateNow,
          status: "waiting",
          waitingForHuman: true,
          currentTaskObject: pausedTaskObject,
          updatedAt: Date.now(),
        });
        this.logEvent("loop.pause.needs_human", {
          taskId: summary.taskId,
          reasons: summary.reasons,
          evidenceRefs: summary.evidenceRefs,
          recommendedAction: summary.recommendedAction,
        });
      }
    } catch { /* fail-soft: never break submitTask on summary/pause log */ }
    // capture reply-side gate-intent BEFORE an earlier revision may
    // prepend the warning string. Reusing `detectGateIntent` on the
    // raw model reply gives a partial check on fabricated gate claims
    // (matches literal `gate.build` / `npm run build` / `npm run
    // typecheck` tokens; pure natural-language "build 通过了" is out
    // of scope per an earlier revision known-limitation §3.1). The flag is read
    // in the finally block to decide whether the seal contract may
    // treat this turn as read-only safe.
    try {
      replyGateIntentDetectedForSeal = detectGateIntent(replyText).detected;
    } catch { /* fail-soft: regex glitch leaves flag false; strict path takes over */ }
    // pre-finalize positive gate-intent dispatch guard. After
    // 207a (SOUL prompt) and 207b (tool description) failed to make the
    // model dispatch `gate_build` on positive build-gate prompts, this
    // deterministic guard fires here: when the user prompt clearly
    // requests build/typecheck verification, the SDK loop ended without
    // dispatching the corresponding gate, AND the prompt does NOT
    // explicitly forbid tool use, run the missing gate via the existing
    // fixed gate runner and record the result into the envelope so
    // `_currentTaskWrappedToolIds` / execution[] / gate_logs reflect
    // real evidence. an earlier revision then runs (below) and finds the gate
    // satisfied — no warning, envelope can seal pass. Negative path
    // (`不要调用任何工具` / `don't call any tools`) is preserved: the
    // guard skips, an earlier revision still warns, envelope still fails. The
    // guard is fail-soft on every branch: any throw is logged but
    // never breaks the turn.
    // M8.9 Step 12 an earlier revision decision/plan computed by helper;
    // long-await + an earlier revision pinned attribution + event emission stay in
    // the orchestrator. Helper purity: no `this`, no `await`, no logEvent.
    // detectGateIntent throw propagates here and the outer catch logs
    // `tool.gate_intent.guard.error` (matches pre-extraction behavior).
    try {
      const autoplan = buildGateIntentAutodispatchPlan({
        display,
        replyText,
        taskId: taskObject.id,
        envelopeId,
        wrappedToolIds: this._currentTaskWrappedToolIds,
        detectGateIntent,
        hasExplicitNoToolDirective,
        hasExplicitNoGateDirective,
        checkGateIntentSatisfied,
        replyMakesGatePassClaim,
        renderNoToolGateIntentHonestReply,
      });
      if (autoplan.kind === "skip_no_tool") {
        // Preserve original interleaving (server.ts pre-Card-313:
        //   log guard.skipped → mutate replyText → log no_tool_reply.*).
        // Helper's `events[0]` is `tool.gate_intent.guard.skipped`;
        // `events[1]` is the conditional `no_tool_reply.replaced` /
        // `no_tool_reply.skipped`. `replyText` mutation lands between.
        this.logEvent(autoplan.events[0].type, autoplan.events[0].payload as Record<string, unknown>);
        replyText = autoplan.replyText;
        if (autoplan.events.length > 1) {
          this.logEvent(autoplan.events[1].type, autoplan.events[1].payload as Record<string, unknown>);
        }
      } else if (
        autoplan.kind === "skip_no_gate" ||
        autoplan.kind === "skip_mention_only"
      ) {
        for (const evt of autoplan.events) {
          this.logEvent(evt.type, evt.payload as Record<string, unknown>);
        }
      } else if (autoplan.kind === "run_gate") {
        const { target } = autoplan;
        // an earlier revision fix A — capture envelopeId + taskId BEFORE the long
        // gate await so the post-await `recordGateExecution` callbacks
        // attribute the addExecution + claim back to the original task,
        // not to whichever task happens to be active when the gate
        // returns. Pre-fix: `getCurrentEnvelopeId: () =>
        // this._resolveActiveDraftEnvelopeId()` re-read
        // `currentTaskObject?.id` after a 10-min await; when a new
        // submitTask had landed in the meantime, addExecution wrote
        // to the wrong envelope and `recordWrappedToolId` pushed
        // onto the (just-reset) shared array, producing the
        // `gate.typecheck` fabricated false-positive seen in trace
        // `/tmp/card244-agentd2-trace.json`.
        const pinnedEnvelopeId = envelopeId;
        const pinnedTaskId = taskObject.id;
        this.logEvent(autoplan.startEvent.type, autoplan.startEvent.payload as Record<string, unknown>);
        try {
          const gateResult = await this.devShellGateRun({ target }) as GateResult;
          await recordGateExecution({
            // an earlier revision fix A — pinned id, not re-resolved.
            getCurrentEnvelopeId: () => pinnedEnvelopeId,
            getEnvelopeStore: () => this._ensureEnvelopeStoreSync(),
            recordWrappedToolId: (id: string) => {
              // an earlier revision fix A — if the current task is still the one
              // that triggered the auto-dispatch, the shared array is
              // correct. Otherwise route into the per-task pinned map
              // so the original task's finalize/seal can still see this
              // gate as a claim, without contaminating the new task's
              // claim set.
              if (this.agentthursdayState.currentTaskObject?.id === pinnedTaskId) {
                this._currentTaskWrappedToolIds.push(id);
              } else {
                const prev = this._pinnedWrappedToolIdsByTask.get(pinnedTaskId) ?? [];
                prev.push(id);
                this._pinnedWrappedToolIdsByTask.set(pinnedTaskId, prev);
                try {
                  this.logEvent("tool.gate_intent.autodispatch.pinned_attribution", {
                    taskId: pinnedTaskId,
                    envelopeId: pinnedEnvelopeId,
                    tool_id: id,
                    current_task_id: this.agentthursdayState.currentTaskObject?.id ?? null,
                  });
                } catch { /* fail-soft */ }
              }
            },
            onRecordSkipped: (info) => {
              try {
                this.logEvent("evidence.envelope.add_execution_skipped", {
                  envelope_id: info.envelopeId,
                  tool_id: info.toolId,
                  reason: info.reason,
                });
              } catch { /* fail-soft */ }
            },
          }, gateResult);
          // an earlier revision §2 — explicit harness_limitation label when the
          // gate timed out (GNU coreutils `timeout` exit code 124) or
          // otherwise failed. With fix A in place the gate is also
          // properly evidenced, so the envelope verdict will be
          // `gate failed: ... exit ...` rather than the fabricated-tool
          // false-positive. This event field gives inspect / UI a
          // single-string handle without re-deriving from exit_code.
          const failedReason: "gate_timeout" | "gate_failure" | null = gateResult.ok
            ? null
            : (gateResult.exit_code === 124 ? "gate_timeout" : "gate_failure");
          this.logEvent("tool.gate_intent.autodispatch.success", {
            taskId: taskObject.id,
            envelopeId,
            target,
            tool_id: gateResult.tool_id,
            ok: gateResult.ok,
            exit_code: gateResult.exit_code,
            duration_ms: gateResult.duration_ms,
            failed_reason: failedReason,
            harness_limitation: failedReason === "gate_timeout",
          });
          // Annotate replyText so the user sees the auto-dispatch
          // happened. Short, factual, references the envelope marker
          // appended later for inspect cross-check.
          const note = gateResult.ok
            ? `(an earlier revision 自动 dispatch \`gate.${target}\`：通过 / exit ${gateResult.exit_code} / ${gateResult.duration_ms}ms)`
            : `(an earlier revision 自动 dispatch \`gate.${target}\`：失败 / exit ${gateResult.exit_code} / ${gateResult.duration_ms}ms)`;
          replyText = replyText && replyText.trim().length > 0
            ? `${replyText}\n\n${note}`
            : note;
        } catch (err) {
          this.logEvent("tool.gate_intent.autodispatch.error", {
            taskId: taskObject.id,
            envelopeId,
            target,
            error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          });
        }
      }
    } catch (err) {
      try {
        this.logEvent("tool.gate_intent.guard.error", {
          taskId: taskObject.id,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        });
      } catch { /* fail-soft: never break submitTask on guard logging */ }
    }
    // M8.9 Step 11 prompt-side intent guard decision
    // . Helper computes a decision
    // record + deferred event list; orchestrator owns logEvent, the
    // outer fail-soft catch, and outer-scope seal flag / replyText
    // assignment. Detection runs over `display` (human-visible prompt;
    // matches resume-intent semantics). Cross-check uses
    // `_currentTaskWrappedToolIds`, the same array an earlier revision
    // truthfulness uses. Fail-soft: any throw leaves `replyText` and
    // the three seal flags untouched so a regex glitch can't break
    // the turn.
    try {
      const promptGuard = buildPromptIntentGuardDecision({
        display,
        replyText,
        taskId: taskObject.id,
        wrappedToolIds: this._currentTaskWrappedToolIds,
        detectGateIntent,
        detectReadIntent,
        detectMutationIntent,
        checkGateIntentSatisfied,
        replyMakesGatePassClaim,
        renderGateIntentViolation,
      });
      replyText = promptGuard.replyText;
      promptGateIntentDetectedForSeal = promptGuard.promptGateIntentDetectedForSeal;
      promptReadIntentDetectedForSeal = promptGuard.promptReadIntentDetectedForSeal;
      promptMutationIntentDetectedForSeal = promptGuard.promptMutationIntentDetectedForSeal;
      promptMutationIntentMatchedPatterns = promptGuard.promptMutationIntentMatchedPatterns;
      for (const ev of promptGuard.events) {
        this.logEvent(ev.type, ev.payload);
      }
    } catch { /* fail-soft: gate-intent guard must not break submitTask */ }
    // dangling-intent detection. Runs AFTER the gate-intent
    // autodispatch (so an auto-dispatched gate counts as action) and
    // over the same `_currentTaskWrappedToolIds` evidence array. On
    // detection: emit `task.dangling_intent.detected` and append an
    // honest system note so the channel sees "announced but did not
    // act" instead of silence. Does NOT re-enter the LLM loop (391b
    // candidate if needed post model-flip). Fail-soft on every branch.
    try {
      const dangling = detectDanglingIntent({
        display,
        replyText,
        wrappedToolCount: this._currentTaskWrappedToolIds.length,
        hasExplicitNoToolDirective,
      });
      if (dangling.detected) {
        this.logEvent("task.dangling_intent.detected", {
          taskId: taskObject.id,
          envelopeId,
          matched_pattern: dangling.matched_pattern,
          reply_length: replyText.length,
        });
        const note = renderDanglingIntentNote();
        replyText = replyText.trim().length > 0
          ? `${replyText}\n\n${note}`
          : note;
      }
    } catch { /* fail-soft: dangling-intent guard must not break submitTask */ }
    // M8.9 Step 11 visible reply safety helper.
    // Extracts an earlier revision/e visible override + an earlier revision unwrapped-mutation
    // prepend into a single pure decision. Helper returns final replyText,
    // the `mutationIntentObservedUnwrapped` flag (consumed downstream by
    // deriveSubmitTaskSealOpts), and a list of deferred events; the per-
    // event fail-soft try/catch around logEvent stays here, mirroring
    // pre-extraction per-emit isolation.
    const visibleReplySafety = buildVisibleReplySafetyDecision({
      replyText,
      envelopeId,
      taskId: taskObject.id,
      promptReadIntentDetectedForSeal,
      promptMutationIntentDetectedForSeal,
      promptMutationIntentMatchedPatterns,
      supplierSignals: this._currentTaskSupplierSignals,
      wrappedToolIds: this._currentTaskWrappedToolIds,
      renderMutationIntentNoExecutionReply,
      renderReadIntentNoExecutionReply,
      renderMutationUnwrappedPrependWarning,
    });
    replyText = visibleReplySafety.replyText;
    mutationIntentObservedUnwrapped = visibleReplySafety.mutationIntentObservedUnwrapped;
    for (const ev of visibleReplySafety.events) {
      try {
        this.logEvent(ev.type, ev.payload);
      } catch { /* fail-soft: log glitch must not break submitTask */ }
    }
    // surface the envelope id to the user-visible reply so the
    // verifier (or any downstream caller of `/api/inspect/evidence/<id>`)
    // can fetch the sealed envelope without scraping event_log. Append
    // after the truthfulness / supplier / pause prepends are settled so
    // the marker sits at the bottom of the rendered reply.
    if (envelopeId) {
      if (replyText && replyText.trim().length > 0) {
        // dedupe before append. Upstream renderers
        // (`renderMutationUnwrappedPrependWarning`, `renderReadIntentNoExecutionReply`,
        // `renderMutationIntentNoExecutionReply`, `renderEmptyReplyFallback`,
        // `renderApprovalPendingReply`) all embed `[envelope: <id>]` as the
        // last line. The previous unconditional append produced
        // `[envelope: …]` twice when one of those paths fired, which
        // confused downstream marker parsers and the verifier eye-grep.
        // Append only when the marker is not already present.
        if (!replyText.includes(buildEnvelopeReplyMarker(envelopeId))) {
          replyText = `${replyText}\n\n${buildEnvelopeReplyMarker(envelopeId)}`;
        }
      } else {
        // 1 — approval-pending guard. A `needsApproval: true`
        // tool (e.g. `advance_kanban_card`) legitimately pauses the round
        // with `state === "approval-requested"` and no execute() result.
        // Without this guard, the an earlier revision empty fallback below would
        // render `⚠️ validation failed: no_execution` for a pause that
        // is correct behaviour. We check for a pending approval first
        // and, if present, render a dedicated waiting-for-confirmation
        // line instead — keeping the empty fallback path for the real
        // empty-reply failure mode.
        let approvalPending: { toolCallId: string; toolName: string } | null = null;
        try {
          approvalPending = this.getPendingToolApproval();
        } catch { /* fail-soft: pending lookup must not break submitTask */ }
        if (approvalPending) {
          replyText = renderApprovalPendingReply({
            toolName: approvalPending.toolName,
            toolCallId: approvalPending.toolCallId,
            taskId: taskObject.id,
            envelopeId,
          });
          try {
            this.logEvent("task.reply.approval_pending_fallback", {
              taskId: taskObject.id,
              envelopeId,
              toolCallId: approvalPending.toolCallId,
              toolName: approvalPending.toolName,
            });
          } catch { /* fail-soft: log glitch must not break submitTask */ }
        } else {
          // without this fallback the only line in `replyText`
          // would be `[envelope: env-…]`, which the Discord render layer
          // (`stripDiscordVisibleInternalMarkers`) removes, leaving a
          // literal `(empty)` and masking validation failures. The fallback
          // surfaces ring counts + a truncation hint so verifier/operator
          // can see what happened without scraping inspect endpoints.
          const envSnap = this._envelopeStoreCache?.get(envelopeId);
          replyText = renderEmptyReplyFallback({
            envelope: envSnap,
            envelopeId,
            taskId: taskObject.id,
          });
          try {
            this.logEvent("task.reply.empty_visible_fallback", {
              taskId: taskObject.id,
              envelopeId,
              executionCount: envSnap?.execution.length ?? 0,
              evidenceCount:
                (envSnap?.evidence.gate_logs?.length ?? 0) +
                (envSnap?.evidence.diff?.length ?? 0),
            });
          } catch { /* fail-soft: log glitch must not break submitTask */ }
        }
      }
    }
    // persist the final user-visible `replyText` (post
    // truthfulness gate, supplier marker, 156g1 memory ack, and 120
    // needs-human pause message) so `buildWorkspaceSnapshot` can
    // surface the same warning-bearing text in the Web `summaryStream`
    // that Discord/CLI receive. Without this, only Discord saw the
    // ⚠️ Truthfulness gate / supplier degradation lines because Web
    // re-paired user/assistant from the SDK message log, which holds
    // the model's raw assistant text (no server-side prepends).
    //
    // We log to event_log rather than write back into the message log
    // so warnings never enter the model's own context (avoiding a
    // feedback loop where the gate's own warning influences the
    // next round). Bounded to 4000 chars for safety; the warning
    // prepend is small relative to the 4000 cap, so almost every
    // reply fits unscathed. Skip empty replies to keep the table
    // sparse.
    try {
      const finalReply = (replyText ?? "").trim();
      if (finalReply.length > 0) {
        const REPLY_CAP_CHARS = 4000;
        const cappedReply = finalReply.length > REPLY_CAP_CHARS
          ? finalReply.slice(0, REPLY_CAP_CHARS)
          : finalReply;
        const warningApplied = replyText !== rawReplyText;
        this.logEvent("task.reply.finalized", {
          taskId: taskObject.id,
          replyText: cappedReply,
          warningApplied,
          source: "submitTask.finalReplyText",
          replyLen: finalReply.length,
        });
      }
    } catch { /* fail-soft: log glitch must not break submitTask */ }
    // end-of-turn memory consolidation. Async (waitUntil, never
    // blocks the reply), watermark-gated, idempotent (semantic dedup), extracts only
    // turns since the persisted watermark. Two triggers (the operator 2026-06-25):
    //   1. periodic — a long-lived agent accumulated >= THRESHOLD new turns (complete
    //      enough conversation to extract meaningful memory, not per-turn fragments);
    //   2. subagent-finalize — a TEMPORARY subagent (parent_task_id present) just
    //      finished its dispatched task; fire once on any new turn so its insights are
    //      captured before it goes idle (it would never reach the periodic threshold).
    // Fully fail-soft: any glitch here must never affect the reply.
    try {
      const totalTurns = this.getDialogTurns(200).length;
      const wmRaw = this._readConsolidationWatermark();
      const last = wmRaw <= totalTurns ? wmRaw : 0; // clamp a stale (post-reset) watermark
      const newTurns = totalTurns - last;
      const isSubagentFinalize = validatedTaskContext !== null
        && typeof validatedTaskContext.parent_task_id === "string"
        && validatedTaskContext.parent_task_id.length > 0;
      const shouldConsolidate = newTurns >= MEMORY_CONSOLIDATION_TURN_THRESHOLD
        || (isSubagentFinalize && newTurns >= 1);
      if (shouldConsolidate && !this._consolidationInFlight) {
        this._consolidationInFlight = true;
        // an earlier revision fan-out fix — INGEST under the EXTERNAL `manager_task_id`, the id
        // a subagent received as its `parent_task_id` (via
        // applyManagerTaskContextFallback → `getCurrentManagerContext().manager_task_id`
        // → `getManagerTurnContext().managerTaskId`) and pushed its insights under.
        // In a real fan-out this differs from the internal `taskObject.id` (submit id),
        // so ingesting by `taskObject.id` never matched the push key and 上浮 silently
        // failed. `submitManagerTask` wraps `submitTask` in `runWithManagerTurnContext`,
        // so the ALS `managerTaskId` is set here for BOTH `/api/manager` AND
        // Discord-routed manager tasks (opts.managerTaskContext alone misses the
        // Discord path — that's why the fan-out still promoted 0). Fallbacks:
        // opts.managerTaskContext, then taskObject.id for a non-manager agent.
        const ingestTaskId = getManagerTurnContext()?.managerTaskId
          ?? opts?.managerTaskContext?.manager_task_id
          ?? taskObject.id;
        this.ctx.waitUntil(
          // 群体记忆: `parentTaskId` (subagent role) → push own promoted
          // insights up; `taskId` (this finalizing task) → ingest subagent insights
          // pushed under it (parent role).
          this.consolidateMemories({
            sinceTurnCount: last,
            parentTaskId: validatedTaskContext?.parent_task_id ?? null,
            taskId: ingestTaskId,
          })
            .then(() => this._writeConsolidationWatermark(totalTurns))
            .catch((e) => this.logEvent("memory.consolidation.auto_error", { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }))
            .finally(() => { this._consolidationInFlight = false; }),
        );
      }
    } catch { /* fail-soft: auto-consolidation must never break submitTask */ }
    // 双路记忆: shadow-ingest this turn into CF Agent Memory
    // (operator DO only, secret present only in prod). Tiny per-turn batch —
    // the pilot showed their synchronous extraction 504s on anything bigger.
    // Fully fail-soft: a shadow failure is logEvent-only, never the turn's.
    try {
      const cfToken = this.env.CF_AGENT_MEMORY_TOKEN;
      if (this.name === OPERATOR_INSTANCE && typeof cfToken === "string" && cfToken.length > 0) {
        const userText = typeof taskObject.title === "string" ? taskObject.title : "";
        const assistantText = this.getLastAssistantTextFull();
        this.ctx.waitUntil(
          (async () => {
            const active = this.ensureActiveContext();
            const r = await cfMemoryIngestTurn(
              cfToken,
              AGENT_MEMORY_OPERATOR_PROFILE,
              [
                { role: "user" as const, content: userText },
                { role: "assistant" as const, content: assistantText },
              ],
              active?.context_id ?? undefined,
            );
            this.logEvent("memory.shadow.ingest", { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
          })().catch((e) => {
            this.logEvent("memory.shadow.ingest", { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
          }),
        );
      }
    } catch { /* fail-soft: the shadow path must never break submitTask */ }
    // PUSH v1 subagent summary aggregation. When the
    // subagent's first turn carried a structured TaskContext with
    // `parent_task_id`, emit a bounded summary on the registry DO
    // keyed by `parent_task_id` (via event_log.trace_id) so the
    // dispatching manager can read it back via
    // `manager.subagent_summaries`. v1 trusts the subagent's
    // self-reported artifact_refs (ADR §6.4) — an earlier revision ships with
    // `artifact_refs: []` since v1 does not auto-derive across DOs;
    // future work can pull from this DO's tool.artifact.write.result
    // events scoped by task start timestamp.
    try {
      if (
        validatedTaskContext !== null &&
        typeof validatedTaskContext.parent_task_id === "string" &&
        validatedTaskContext.parent_task_id.length > 0
      ) {
        const summary = buildSubagentSummary({
          task_id: taskObject.id,
          agent_id: this.name,
          parent_task_id: validatedTaskContext.parent_task_id,
          source_agent_id: validatedTaskContext.source_agent_id,
          artifact_refs: [],
          reply_text: (replyText ?? "").trim(),
          completed_at: new Date().toISOString(),
        });
        try {
          const registry = await getRegistryStub(this.env);
          await registry.pushSubagentArtifactSummary(
            validatedTaskContext.parent_task_id,
            summary,
          );
        } catch (e) {
          // logEvent (local event_log) instead of console.warn so
          // the failure is traceable when logpush is off.
          this.logEvent("submitTask.subagent_artifact_summary.failed", {
            task_id: taskObject.id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch { /* fail-soft: never block submitTask on summary push */ }
    return { ok: true, taskId: taskObject.id, loopTriggered: result.status === "completed", replyText, envelopeId };
    } finally {
      // observability proof that the finally block actually
      // ran. Production trace for `task-moxzk99g` showed only
      // `evidence.envelope.draft.from_turn` then nothing, which left
      // unanswered whether saveMessages threw / hung / the DO got
      // evicted. Log this BEFORE the seal try so a `_finalizeTaskTurn`
      // throw cannot mask the entry signal. Fail-soft so a logging
      // glitch can never block the seal call below.
      try {
        this.logEvent("submitTask.finally.entered", {
          taskId: taskObject.id,
          envelopeId: envelopeId ?? null,
        });
      } catch { /* fail-soft */ }
      // an earlier revision — delegate seal + log to the shared
      // `_finalizeTaskTurn` routine so a sweeper that may have raced
      // ahead sees an idempotent no-op when this happy-path finally
      // runs second. Reset turn-scoped state unconditionally so a
      // stale envelope_id can't leak into the next turn.
      try {
        if (envelopeId) {
          // M8.9 Step 10 phase S seal opts derivation. Pure
          // helper computes wrappedDispatchCount, totalSupplierToolCalls,
          // promptMutationIntentNoExecution, the 6-flag readOnlySafe AND,
          // and the `_finalizeTaskTurn` opts shape (incl. claimedTools
          // dedupe+sort, source literal, threaded intent flags). The
          // envelopeId guard, `_finalizeTaskTurn` invocation, fail-soft
          // try/catch, and turn-state reset below all remain in the
          // orchestrator. See an earlier revision for the
          // individual flag contracts.
          const seal = deriveSubmitTaskSealOpts({
            taskId: taskObject.id,
            envelopeId,
            wrappedToolIds: this._currentTaskWrappedToolIds,
            supplierSignals: this._currentTaskSupplierSignals,
            promptGateIntentDetectedForSeal,
            replyGateIntentDetectedForSeal,
            promptReadIntentDetectedForSeal,
            mutationIntentObservedUnwrapped,
            promptMutationIntentDetectedForSeal,
          });
          this._finalizeTaskTurn(seal.finalizeOpts);
        }
      } catch (e) {
        // surface what would otherwise be a silent swallow.
        try {
          this.logEvent("submitTask.seal.error", {
            taskId: taskObject.id,
            envelopeId: envelopeId ?? null,
            error: e instanceof Error
              ? e.message.slice(0, 200)
              : String(e).slice(0, 200),
          });
        } catch { /* nested fail-soft */ }
      }
      this._currentEnvelopeId = null;
      this._currentTaskWrappedToolIds = [];
    }
  }

  @callable()
  async continueTask(): Promise<{ ok: boolean; status: string }> {
    const result = await this.continueLastTurn();
    return { ok: true, status: result.status };
  }

  // codemode self-probe. Bypasses the model loop entirely;
  // calls the executor directly with a trivial input. Returns ground truth
  // about whether `execute` is registered + actually functional in this
  // deployment, so reviewers don't have to trust the agent's word about
  // "execute is broken" when the agent may have hallucinated the failure.
  @callable()
  async codemodeProbe(): Promise<CodemodeProbeResult> {
    return runCodemodeProbe({
      env: this.env,
      _bundledModules: this._bundledModules,
      getTools: () => this.getTools(),
      logEvent: (type, payload) => this.logEvent(type, payload),
    });
  }

  @callable()
  getStatus(): AgentThursdayState {
    return this.getSafeState();
  }

  @callable()
  getCurrentTaskObject(): TaskObject | null {
    return this.getSafeState().currentTaskObject;
  }

  // thin host for status/event view helpers. Narrow on
  // purpose: `sql` only. `buildLoopContract` is state-input, no host.
  private _statusViewsHost(): StatusViewsHost {
    return { sql: this.sql.bind(this) as StatusViewsHost["sql"] };
  }

  @callable()
  getLoopContract(): LoopContract {
    return buildLoopContractView(this.getSafeState());
  }

  @callable()
  getEventLog(): EventLogRow[] {
    return getEventLogView(this._statusViewsHost());
  }

  @callable()
  getRecentTaskSubmittedEvents(limit: number = 60): EventLogRow[] {
    return getRecentTaskSubmittedEventsView(this._statusViewsHost(), limit);
  }

  @callable()
  getRecentFinalizedReplyEvents(limit: number = 60): EventLogRow[] {
    return getRecentFinalizedReplyEventsView(this._statusViewsHost(), limit);
  }

  @callable()
  getLastResetAt(): number {
    return getLastResetAtView(this._statusViewsHost());
  }

  @callable()
  getLastTrace(): { traceId: string; events: EventLogRow[] } | null {
    return getLastTraceView(this._statusViewsHost());
  }

  // ── M9.0 AgentProfile storage callables ───────────────
  // Pure helpers in `./agent/agentProfileOps`. Routes register on the
  // DEMO_INSTANCE registry DO so AgentProfile rows are global config
  // (visible across contexts), not scoped to a single context DO.
  private _agentProfileHost(): AgentProfileHost {
    return { sql: this.sql.bind(this) as AgentProfileHost["sql"] };
  }

  // same sql-host shape for the owner-scoped credential store.
  private _credentialHost(): CredentialHost {
    return { sql: this.sql.bind(this) as CredentialHost["sql"] };
  }

  private _discordBotHost(): DiscordBotHost {
    return { sql: this.sql.bind(this) as DiscordBotHost["sql"] };
  }

  // multi-tenancy: an optional `identity` arg scopes these
  // registry reads/writes to one user. Omitted ⇒ admin (full access), so
  // every internal/system caller keeps working unchanged; HTTP routes pass
  // the gateway-verified identity resolved from `X-AgentThursday-User-Id`.
  @callable()
  createAgentProfile(input: {
    id: string;
    name: string;
    model: string;
    channel: string;
    skillset: string;
    persona: string;
    status: "initialized" | "archived" | "deleted_marker";
    createdAt: string;
    updatedAt: string;
    parentAgentId?: string | null;
    retentionPolicy?: "durable" | "task_scoped" | "ephemeral";
  }, identity?: RequestIdentity): CreateAgentProfileResult {
    return createAgentProfile(this._agentProfileHost(), input, identity);
  }

  // spawned-agent lifecycle sweep (admin maintenance via
  // /api/inspect/agent-lifecycle-sweep). Archives idle spawned agents;
  // never deletes. dryRun lists candidates without writing.
  @callable()
  sweepSpawnedAgents(input: { olderThanDays?: number; includeLegacy?: boolean; dryRun?: boolean; excludeIds?: string[] }): {
    archived: { id: string; name: string; updated_at: string; retention_policy: string }[];
    dryRun: boolean;
  } {
    const days = Math.max(1, Math.min(90, Math.floor(input?.olderThanDays ?? 7)));
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = sweepSpawnedAgentRows(this._agentProfileHost(), {
      cutoffIso,
      includeLegacy: input?.includeLegacy === true,
      dryRun: input?.dryRun === true,
      nowIso: new Date().toISOString(),
      excludeIds: Array.isArray(input?.excludeIds) ? input.excludeIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    });
    this.logEvent("agent_lifecycle.sweep", { archived: r.archived.length, dryRun: r.dryRun, days });
    return r;
  }

  // one-time admin lineage backfill for pre-465 agents (no
  // creation-time data existed). Secret-gated via /api/inspect only; both
  // ends must exist. Sets origin='spawned' + parent_agent_id.
  @callable()
  backfillAgentLineage(input: { assignments: { agent_id: string; parent_agent_id: string }[] }): {
    updated: number; skipped: { agent_id: string; reason: string }[];
  } {
    const skipped: { agent_id: string; reason: string }[] = [];
    let updated = 0;
    for (const a of input.assignments ?? []) {
      const child = this.sql<{ id: string }>`SELECT id FROM agent_profile WHERE id = ${a.agent_id} LIMIT 1`;
      if (!child.length) { skipped.push({ agent_id: a.agent_id, reason: "child_not_found" }); continue; }
      const parent = this.sql<{ id: string }>`SELECT id FROM agent_profile WHERE id = ${a.parent_agent_id} LIMIT 1`;
      if (!parent.length) { skipped.push({ agent_id: a.agent_id, reason: "parent_not_found" }); continue; }
      if (a.agent_id === a.parent_agent_id) { skipped.push({ agent_id: a.agent_id, reason: "self_parent" }); continue; }
      this.sql`UPDATE agent_profile SET origin = 'spawned', parent_agent_id = ${a.parent_agent_id} WHERE id = ${a.agent_id}`;
      updated++;
    }
    this.logEvent("agent_lineage.backfill", { updated, skipped: skipped.length });
    return { updated, skipped };
  }

  @callable()
  listAgentProfiles(opts: { includeArchived?: boolean } = {}, identity?: RequestIdentity): AgentProfile[] {
    return listAgentProfiles(this._agentProfileHost(), opts, identity);
  }

  @callable()
  readAgentProfile(id: string, identity?: RequestIdentity): AgentProfile | null {
    return readAgentProfile(this._agentProfileHost(), id, identity);
  }

  @callable()
  updateAgentProfile(input: {
    id: string;
    name?: string;
    model?: string;
    skillset?: string;
    persona?: string;
    status?: "initialized" | "archived" | "deleted_marker";
    updatedAt: string;
  }, identity?: RequestIdentity): UpdateAgentProfileResult {
    return updateAgentProfile(this._agentProfileHost(), input, identity);
  }

  // ── P1 end-user accounts (registry DO `app_user`) ─────────
  // Admin-managed account records; the gateway resolves users here at login
  // and the operator approves from the secret-protected console.
  private _userOpsHost(): UserOpsHost {
    return { sql: this.sql.bind(this) as UserOpsHost["sql"] };
  }

  @callable()
  appUserResolve(input: { provider: string; sub: string; email: string }): { user: AppUser; created: boolean } {
    return userResolve(this._userOpsHost(), {
      provider: input.provider,
      sub: input.sub,
      email: input.email,
      userId: `user-${crypto.randomUUID()}`,
      now: new Date().toISOString(),
    });
  }

  @callable()
  appUserGetById(userId: string): AppUser | null {
    return userGetById(this._userOpsHost(), userId);
  }

  @callable()
  appUserListPending(): AppUser[] {
    return userListPending(this._userOpsHost());
  }

  // Console user-management (admin-only via the route gate): list every
  // account, revoke (→ pending) and delete (forget). Approve stays separate
  // because it carries the welcome-email side effect.
  @callable()
  appUserListAll(): AppUser[] {
    return userListAll(this._userOpsHost());
  }

  @callable()
  appUserRevoke(userId: string): AppUser | null {
    return userSetStatus(this._userOpsHost(), userId, "pending", new Date().toISOString());
  }

  @callable()
  appUserDelete(userId: string): { deleted: boolean } {
    return { deleted: userDelete(this._userOpsHost(), userId) };
  }

  @callable()
  async appUserApprove(userId: string): Promise<AppUser | null> {
    const host = this._userOpsHost();
    const before = userGetById(host, userId);
    const user = userApprove(host, userId, new Date().toISOString());
    // 2026-06-22 — one-time welcome email on a real pending→approved transition.
    // The status flip above is already committed, so this can never reverse an
    // approval; awaited inline (an infrequent admin action can afford it, and a
    // dropped welcome would be silent) inside try/catch so a send failure can't
    // block or fail the approve. Logs `user_id` only — never the address.
    if (this.env.EMAIL && shouldSendWelcomeEmail(before, user) && user) {
      try {
        await sendWelcomeEmail(this.env.EMAIL as unknown as EmailServiceBinding, user.email);
        this.logEvent("app_user.welcome_email.sent", { user_id: user.user_id });
      } catch (e) {
        this.logEvent("app_user.welcome_email.failed", {
          user_id: user.user_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return user;
  }

  // ── M9.0 manager custom skillset callables (registry DO) ─
  // Same substrate as agent_profile: SQLite on the registry DO so
  // custom skillset rows are global config. Manager HTTP routes
  // resolve the registry stub via getAgentByName(env.AgentThursdayAgent,
  // DEMO_INSTANCE) and call through these wrappers. Validation
  // (embedded-id collision, unknown tool ids, manifest shape)
  // runs in `customSkillsetValidation.ts` at the route boundary
  // before reaching these helpers.
  private _customSkillsetHost(): CustomSkillsetHost {
    return { sql: this.sql.bind(this) as CustomSkillsetHost["sql"] };
  }

  // Wire shape: manifest as JSON string so CF Rpc.Serializable accepts
  // the return type. Route layer parses via `manifestFromWire`.
  @callable()
  createCustomSkillset(input: CreateCustomSkillsetInput): CreateCustomSkillsetWireResult {
    return createCustomSkillsetWire(this._customSkillsetHost(), input);
  }

  // `scopeOwnerId` (passed by the worker route/op layer, never by an
  // agents-SDK client) scopes custom skillsets to a tenant: undefined = admin
  // (all), a string = that owner only. Embedded/system skillsets live in code,
  // not this table, so they're never owner-filtered here.
  @callable()
  listCustomSkillsets(scopeOwnerId?: string): CustomSkillsetWireRecord[] {
    return listCustomSkillsetsWire(this._customSkillsetHost(), scopeOwnerId);
  }

  @callable()
  readCustomSkillset(id: string, scopeOwnerId?: string): CustomSkillsetWireRecord | null {
    return readCustomSkillsetWire(this._customSkillsetHost(), id, scopeOwnerId);
  }

  @callable()
  updateCustomSkillset(input: UpdateCustomSkillsetInput, scopeOwnerId?: string): UpdateCustomSkillsetWireResult {
    return updateCustomSkillsetWire(this._customSkillsetHost(), input, scopeOwnerId);
  }

  // 2026-06-19 — delete a custom skillset row. Owner-scoped (undefined = admin
  // may delete any, including a de-embedded system row like external-publishing).
  @callable()
  deleteCustomSkillset(input: { id: string }, scopeOwnerId?: string): DeleteCustomSkillsetResult {
    return deleteCustomSkillsetRow(this._customSkillsetHost(), input.id, scopeOwnerId);
  }

  // ── scheduled tasks (registry DO) ─────────────────────────
  // CRUD callables for the owner-scoped `scheduled_task` table. Same wire
  // posture as the custom-skillset callables above: `scopeOwnerId` is passed
  // by the worker route layer only (undefined = admin, unfiltered); the
  // agents-SDK path can't reach scoped rows (an earlier revision chokepoint).
  private _scheduledTaskHost(): ScheduledTaskHost {
    return { sql: this.sql.bind(this) as ScheduledTaskHost["sql"] };
  }

  @callable()
  createScheduledTaskRow(input: {
    id: string;
    ownerUserId: string;
    agentId: string;
    spec: ScheduleSpecInput;
    nowIso: string;
  }): CreateScheduleResult {
    return createScheduledTask(this._scheduledTaskHost(), input);
  }

  @callable()
  listScheduledTaskRows(opts: { agentId?: string; scopeOwnerId?: string }): ScheduledTaskRow[] {
    return listScheduledTasks(this._scheduledTaskHost(), opts);
  }

  @callable()
  updateScheduledTaskRow(input: {
    id: string;
    scopeOwnerId?: string;
    nowIso: string;
    changes: Partial<ScheduleSpecInput> & { enabled?: boolean };
  }): UpdateScheduleResult {
    return updateScheduledTask(this._scheduledTaskHost(), input);
  }

  @callable()
  deleteScheduledTaskRow(input: { id: string; scopeOwnerId?: string }): { deleted: boolean } {
    return { deleted: deleteScheduledTask(this._scheduledTaskHost(), input.id, input.scopeOwnerId) };
  }

  // an earlier revision/b — schedules read with recent execution history; optional
  // agentId narrows to one agent (the per-agent schedules modal).
  @callable()
  listScheduledTaskRowsWithRuns(opts: { agentId?: string; scopeOwnerId?: string; runLimit?: number }): ScheduledTaskWithRuns[] {
    return listScheduledTasksWithRuns(this._scheduledTaskHost(), opts);
  }

  /**
   * minute tick, armed registry-only in `onStart` via
   * `scheduleEvery` (idempotent; alarm persists across deploys). Claims due
   * rows synchronously (next_run_at advances BEFORE dispatch — overlapping
   * ticks can't double-fire) then dispatches each through the normal manager
   * message path under the ROW OWNER's identity, fail-closed: an empty owner
   * marks the run failed and never falls back to admin (an earlier revision posture).
   * Dispatches are parked on `this.ctx.waitUntil` so the alarm callback
   * returns fast; each settlement records ok/failure (auto-disable after
   * MAX_CONSECUTIVE_FAILURES lives in scheduledTaskOps).
   *
   * Public (no underscore) because the agents-SDK scheduler resolves
   * `this[callbackName]` — same convention as `envelopeSweeperBackstop`.
   */
  async scheduledTaskSweep(): Promise<void> {
    if (this.name !== DEMO_INSTANCE) return;
    const nowIso = new Date().toISOString();
    let claimed: ScheduledTaskRow[];
    try {
      claimed = claimDueScheduledTasks(this._scheduledTaskHost(), nowIso);
    } catch (e) {
      this.logEvent("scheduled_task.sweep.claim_error", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (claimed.length === 0) return;
    for (const row of claimed) {
      const managerTaskId = `task-${crypto.randomUUID()}`;
      if (typeof row.owner_user_id !== "string" || row.owner_user_id.length === 0) {
        recordScheduledRunResult(this._scheduledTaskHost(), {
          id: row.id, taskId: null, ok: false, detail: "missing owner", nowIso,
        });
        this.logEvent("scheduled_task.dispatch.blocked_no_owner", { schedule_id: row.id });
        continue;
      }
      const identity: RequestIdentity = row.owner_user_id === ADMIN_USER_ID
        ? { kind: "admin" }
        : { kind: "user", userId: row.owner_user_id };
      // Same bracket event the HTTP preflight records so the scheduled run is
      // a completely normal task for GET /api/manager/tasks/:id.
      try {
        await this.recordManagerTaskEvent(
          "manager.task.received",
          {
            agent_id: row.agent_id,
            source: "scheduled_task",
            schedule_id: row.id,
            accepted_at: nowIso,
          },
          managerTaskId,
        );
      } catch { /* fail-soft: event miss must not block the dispatch */ }
      this.logEvent("scheduled_task.dispatch", {
        schedule_id: row.id,
        agent_id: row.agent_id,
        manager_task_id: managerTaskId,
        owner_user_id: row.owner_user_id,
      });
      // history row (dispatched → settled by the .then/.catch).
      try {
        recordScheduledRunStart(this._scheduledTaskHost(), {
          scheduleId: row.id, taskId: managerTaskId, agentId: row.agent_id, nowIso,
        });
      } catch { /* fail-soft: history must not block dispatch */ }
      this.ctx.waitUntil(
        runManagerTaskBackground(
          this.env as unknown as ManagerEnv,
          { agent_id: row.agent_id, text: row.prompt, source: "scheduled_task" },
          managerTaskId,
          identity,
        )
          .then((result) => {
            const ok = result !== null && (result as { ok?: boolean }).ok !== false;
            const r = recordScheduledRunResult(this._scheduledTaskHost(), {
              id: row.id,
              taskId: managerTaskId,
              ok,
              detail: ok ? undefined : "dispatch returned failure",
              nowIso: new Date().toISOString(),
            });
            if (r.disabled) {
              this.logEvent("scheduled_task.auto_disabled", { schedule_id: row.id });
            }
          })
          .catch((e) => {
            const r = recordScheduledRunResult(this._scheduledTaskHost(), {
              id: row.id,
              taskId: managerTaskId,
              ok: false,
              detail: e instanceof Error ? e.message : String(e),
              nowIso: new Date().toISOString(),
            });
            if (r.disabled) {
              this.logEvent("scheduled_task.auto_disabled", { schedule_id: row.id });
            }
          }),
      );
    }
  }

  /**
   * manager audit-event injection. The manager HTTP routes
   * (`/api/manager/*`) and the manager dispatch adapters
   * (`manager.*` tool ids) record their post-success actions on the
   * registry DO via this @callable so the event_log carries a
   * locatable trail of every manager-routed write. Event names are a
   * closed set produced by `src/agent/managerOps.ts` (e.g.
   * `manager.agent.created`, `manager.skillset.updated`,
   * `manager.agent.message.sent`); the per-agent DO's own
   * task/envelope events still fire on the target DO for
   * `manager.agent_message`. Pure delegate over `this.logEvent`;
   * never echoes shared secrets / env values.
   */
  @callable()
  recordManagerEvent(type: string, payload: unknown): void {
    this.logEvent(type, payload, null);
  }

  /**
   * task-keyed manager bracket event recorder.
   *
   * Identical substrate to `recordManagerEvent` but threads `taskId`
   * into `event_log.trace_id` so the GET status endpoint can scope
   * its query by task_id without a join. Names are restricted to the
   * `manager.task.*` family at the helper-callsite layer in
   * `managerOps.ts`; we do not re-validate here so the registry stays
   * a thin delegate.
   */
  @callable()
  recordManagerTaskEvent(type: string, payload: unknown, taskId: string): void {
    this.logEvent(type, payload, taskId);
    // mirror terminal subagent events into the workflow
    // ledger (status + result/failure). Ordered AFTER the event write
    // and isolated in try/catch so a workflow-table error can never cost
    // a `manager.task.*` row (fail-soft per agentP). No-op when no
    // `workflow_agent` row matches `taskId` (i.e. not a tracked subagent).
    try {
      if (type === "manager.task.replied" || type === "manager.task.failed") {
        this._updateWorkflowAgentTerminal(type, payload, taskId);
      }
    } catch { /* fail-soft: workflow ledger must not break event recording */ }
  }

  /**
   * terminal subagent → `workflow_agent` row update, keyed by
   * the subagent's `task_id`. `result_summary` is a bounded preview of
   * the user-visible reply; `rough_token_count` / `rough_cost` stay null
   * (no precise billing source in v1 — fields exist for a later card).
   */
  private _updateWorkflowAgentTerminal(type: string, payload: unknown, taskId: string): void {
    const now = new Date().toISOString();
    const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    if (type === "manager.task.replied") {
      const reply = typeof p.reply === "string" ? p.reply : null;
      const summary = reply ? safePromptPreview(reply) : null;
      this.sql`
        UPDATE workflow_agent SET status = 'replied', result_summary = ${summary}, updated_at = ${now}
        WHERE task_id = ${taskId}
      `;
    } else {
      const reason =
        typeof p.reason === "string"
          ? p.reason
          : typeof p.message === "string"
            ? p.message
            : "failed";
      this.sql`
        UPDATE workflow_agent SET status = 'failed', failure_reason = ${reason}, updated_at = ${now}
        WHERE task_id = ${taskId}
      `;
    }
  }

  /**
   * record one manager→subagent dispatch into the workflow
   * ledger. Lazily upserts the `workflow_run` + the single explicit
   * default phase, then upserts the `workflow_agent` node — all three
   * created together on the first dispatch under a `parent_task_id`, so
   * a run always has ≥1 phase and ≥1 agent (the explicit phase is
   * WRITTEN here, never inferred by the read layer). Fail-soft.
   */
  @callable()
  recordWorkflowDispatch(input: {
    parent_task_id: string;
    source_agent_id: string | null;
    subagent_agent_id: string | null;
    subagent_task_id: string;
    prompt_preview: string | null;
    // Multi-tenancy — the dispatching agent's resolved owner (admin sentinel for
    // the operator path), so a user can owner-scope-read their own ad-hoc runs.
    // Omitted → admin sentinel. Stamped only on first INSERT of the run row.
    owner_user_id?: string | null;
  }): void {
    try {
      recordWorkflowDispatchRows(this._workflowStoreHost(), {
        parent_task_id: input.parent_task_id,
        source_agent_id: input.source_agent_id,
        subagent_agent_id: input.subagent_agent_id,
        subagent_task_id: input.subagent_task_id,
        prompt_preview: input.prompt_preview,
        owner: input.owner_user_id ?? ADMIN_USER_ID,
        now: new Date().toISOString(),
      });
    } catch (e) {
      try {
        this.logEvent("workflow.ledger.write_error", {
          op: "dispatch",
          error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      } catch { /* nested fail-soft */ }
    }
  }

  /** list recent workflow runs (newest-updated first). */
  @callable()
  readWorkflowRuns(input?: { limit?: number }): WorkflowRunRow[] {
    const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
    return this.sql<WorkflowRunRow>`
      SELECT * FROM workflow_run ORDER BY updated_at DESC LIMIT ${limit}
    `;
  }

  /**
   * one run as a structured `run -> phases -> agents` tree.
   * Built ONLY from the workflow_* ledger rows (never inferred from flat
   * `manager.task.*` events). Returns null for an unknown run_id.
   */
  @callable()
  readWorkflowRun(input: { run_id: string }, scopeOwnerId?: string): WorkflowRunTree | null {
    const runs = this.sql<WorkflowRunRow & { owner_user_id: string }>`SELECT * FROM workflow_run WHERE run_id = ${input.run_id} LIMIT 1`;
    if (runs.length === 0) return null;
    // Owner isolation (strict-own): a scoped caller can only read a run it owns.
    // Mismatch → null (not_found, no existence leak). Children (phases/agents)
    // inherit the run's owner — no separate scope needed. Admin sees any run.
    if (scopeOwnerId !== undefined && runs[0].owner_user_id !== scopeOwnerId) return null;
    const phases = this.sql<WorkflowPhaseRow>`SELECT * FROM workflow_phase WHERE run_id = ${input.run_id}`;
    const agents = this.sql<WorkflowAgentRow>`SELECT * FROM workflow_agent WHERE run_id = ${input.run_id}`;
    return assembleWorkflowRunTree(runs[0], phases, agents);
  }

  // ── turn share links (frozen snapshots, readable by link) ─────
  // Create is owner-stamped from the verified identity (gateway-proxied user);
  // read is by crypto-random id with NO owner filter BY DESIGN — the link is
  // the credential, published explicitly by the owner. Public face = the
  // gateway's /api/public/turn passthrough; this @callable pair stays behind
  // the console secret.
  private _turnShareHost(): TurnShareHost {
    return { sql: this.sql.bind(this) as TurnShareHost["sql"] };
  }

  @callable()
  createTurnShare(
    input: { agent_id: string; agent_name?: string | null; title: string; content_md: string },
    identity?: RequestIdentity,
  ): { ok: true; share_id: string } | { ok: false; error: string } {
    const r = createTurnShareRow(this._turnShareHost(), {
      ownerUserId: ownerUserIdFor(identity ?? { kind: "admin" }),
      agentId: String(input.agent_id || "").slice(0, 80),
      agentName: input.agent_name ?? null,
      title: input.title,
      contentMd: input.content_md,
      nowIso: new Date().toISOString(),
    });
    if (r.ok) this.logEvent("turn_share.created", { share_id: r.share_id, agent_id: input.agent_id });
    return r;
  }

  // owner-scoped share management (list + revoke).
  @callable()
  listTurnShares(identity?: RequestIdentity): TurnShareListItem[] {
    return listTurnSharesByOwnerRows(this._turnShareHost(), ownerUserIdFor(identity ?? { kind: "admin" }));
  }

  @callable()
  deleteTurnShare(input: { share_id: string }, identity?: RequestIdentity): { ok: boolean } {
    const ok = deleteTurnShareRow(
      this._turnShareHost(),
      input?.share_id ?? "",
      ownerUserIdFor(identity ?? { kind: "admin" }),
    );
    if (ok) this.logEvent("turn_share.revoked", { share_id: input.share_id });
    return { ok };
  }

  @callable()
  readTurnShare(input: { share_id: string }): TurnSharePublic | null {
    // public projection only (grok review: identity fields must
    // not ride the by-link path even internally).
    return readTurnSharePublicRow(this._turnShareHost(), input?.share_id ?? "");
  }

  // ── Workspace file share (2026-06-19, replaces fyimd) ──────────────────────
  // Registry-DO chokepoint for the global `share_file` capability. Validation
  // (secret-scan / size / filename) and owner resolution run HERE so no agent
  // path can bypass them. Owner = the sharing agent's profile owner; fail-soft
  // to admin (a mis-stamp only hides the file from its own user, never leaks
  // cross-tenant — the READ filter is the boundary). Operator agents without a
  // profile row share into the admin pool.
  @callable()
  async recordSharedFile(input: {
    source_agent_id: string;
    filename: string;
    content: string;
    note?: string;
  }): Promise<{ ok: true; file_id: string } | { ok: false; code: string; message: string }> {
    const v = validateShareFileInput({
      filename: input.filename,
      content: input.content,
      note: input.note,
    });
    if (!v.ok) return { ok: false, code: v.code, message: v.message };
    // Resolve the share OWNER from the sharing agent's profile. FAIL-CLOSED: a
    // transient read error OR a missing profile row refuses the share rather
    // than dumping the file into the admin pool — that fail-soft was the WRITE
    // analogue of an announce-without-act (the agent reports a link the real
    // owner then 404s on). Every real agent (admin- or user-owned) has a
    // profile row (verified), so this only triggers on an orphaned id / blip.
    let ownerUserId: string;
    let sourceAgentName: string | null = null;
    try {
      const rows = this.sql<{ owner_user_id: string; name: string }>`
        SELECT owner_user_id, name FROM agent_profile WHERE id = ${input.source_agent_id} LIMIT 1`;
      if (rows.length === 0) {
        return { ok: false, code: "owner_unresolved", message: "cannot resolve the sharing agent's owner; share refused" };
      }
      ownerUserId = rows[0].owner_user_id || ADMIN_USER_ID;
      sourceAgentName = rows[0].name ?? null;
    } catch {
      return { ok: false, code: "owner_unresolved", message: "cannot resolve the sharing agent's owner; share refused" };
    }
    const sha256 = await v.sha256Promise;
    const row: SharedFileRow = {
      file_id: `sf-${crypto.randomUUID().slice(0, 12)}`,
      owner_user_id: ownerUserId,
      source_agent_id: input.source_agent_id,
      source_agent_name: sourceAgentName,
      filename: v.filename,
      content: input.content,
      sha256,
      size_bytes: v.sizeBytes,
      mime: v.mime,
      note: v.note,
      created_at: new Date().toISOString(),
    };
    insertSharedFileRow({ sql: this.sql.bind(this) as SharedFileSqlHost["sql"] }, row);
    this.logEvent("shared_file.recorded", {
      file_id: row.file_id,
      owner_user_id: ownerUserId,
      source_agent_id: input.source_agent_id,
      size_bytes: v.sizeBytes,
    });
    return { ok: true, file_id: row.file_id };
  }

  /** Owner-scoped metadata list (no body). `scopeOwnerId` undefined = admin (all). */
  @callable()
  listSharedFiles(scopeOwnerId?: string): SharedFileMeta[] {
    return listSharedFileRows(
      { sql: this.sql.bind(this) as SharedFileSqlHost["sql"] },
      scopeOwnerId,
    );
  }

  /** Owner-scoped single read (body included). Mismatch → null (no existence leak). */
  @callable()
  readSharedFile(input: { file_id: string }, scopeOwnerId?: string): SharedFileRow | null {
    return readSharedFileRow(
      { sql: this.sql.bind(this) as SharedFileSqlHost["sql"] },
      input.file_id,
      scopeOwnerId,
    );
  }

  // ── 2026-06-23 user-uploaded documents (registry DO metadata + R2 markdown) ─
  // Raw files are never stored — only the agent-readable markdown, in R2
  // (DOCS_BUCKET, owner-keyed). `recordDocument` is reached ONLY from the upload
  // ROUTE (admin secret + session-derived owner); an agent has no upload tool,
  // and a scoped agents-SDK RPC to it is barred by the an earlier revision chokepoint. The
  // agent-facing reads (list/search/read) take the dispatching agent's own
  // `scopeOwnerId` (the document.* tool resolves it + fails closed), so an agent
  // only ever sees its own owner's documents — same boundary as shared files.
  private _docOpsHost(): DocOpsHost {
    return { sql: this.sql.bind(this) as DocOpsHost["sql"] };
  }
  private _docR2Key(ownerUserId: string, docId: string): string {
    return `u/${ownerUserId}/doc/${docId}.md`;
  }

  @callable()
  async recordDocument(input: {
    ownerUserId: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    markdown: string;
  }): Promise<{ ok: true; doc_id: string } | { ok: false; code: string; message: string }> {
    const ownerUserId = input.ownerUserId || ADMIN_USER_ID;
    const docId = `doc-${crypto.randomUUID().slice(0, 12)}`;
    const r2Key = this._docR2Key(ownerUserId, docId);
    const markdown = String(input.markdown || "");
    try {
      await this.env.DOCS_BUCKET.put(r2Key, markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
    } catch (e) {
      return { ok: false, code: "storage_failed", message: e instanceof Error ? e.message : String(e) };
    }
    insertDocument(this._docOpsHost(), {
      doc_id: docId,
      owner_user_id: ownerUserId,
      filename: input.filename,
      mime: input.mime,
      size_bytes: input.sizeBytes,
      char_count: markdown.length,
      sha256: input.sha256,
      r2_key: r2Key,
      preview: this._docPreview(markdown),
      status: "done",
      pending_ref: null,
      created_at: new Date().toISOString(),
    });
    this.logEvent("document.recorded", { doc_id: docId, owner_user_id: ownerUserId, size_bytes: input.sizeBytes });
    return { ok: true, doc_id: docId };
  }

  /** Canonical preview derivation — shared by sync record + lazy resolve so a
   * resolved doc is byte-identical to a synchronously-converted one. */
  private _docPreview(markdown: string): string {
    return markdown.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  /**
   * Async upload (the operator: 改异步): record a PDF/office doc whose conversion is still
   * running on fyimd's queue. Metadata-only — NO R2 write yet (the markdown
   * doesn't exist); `pending_ref` is fyimd's poll URL. A later list/read calls
   * `resolvePendingDocuments` / `documentRead`, which polls that URL and fills the
   * markdown when fyimd finishes. Reached only from the upload route (same admin
   * secret + session-owner boundary as recordDocument).
   */
  @callable()
  async recordPendingDocument(input: {
    ownerUserId: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    pendingRef: string;
  }): Promise<{ ok: true; doc_id: string } | { ok: false; code: string; message: string }> {
    const ownerUserId = input.ownerUserId || ADMIN_USER_ID;
    const docId = `doc-${crypto.randomUUID().slice(0, 12)}`;
    insertDocument(this._docOpsHost(), {
      doc_id: docId,
      owner_user_id: ownerUserId,
      filename: input.filename,
      mime: input.mime,
      size_bytes: input.sizeBytes,
      char_count: 0,
      sha256: input.sha256,
      r2_key: this._docR2Key(ownerUserId, docId),
      preview: "",
      status: "processing",
      pending_ref: input.pendingRef,
      created_at: new Date().toISOString(),
    });
    this.logEvent("document.pending", { doc_id: docId, owner_user_id: ownerUserId, size_bytes: input.sizeBytes });
    return { ok: true, doc_id: docId };
  }

  /**
   * Poll a single processing doc's fyimd job once and, if it's done, fetch the
   * markdown → write R2 → flip the row to `done`. Idempotent: the row is re-checked
   * `processing` before the write (overlapping polls are harmless — identical
   * markdown), and `markDocumentResolved`/`markDocumentFailed` only touch a still-
   * processing row. Fail-soft: a transient poll error leaves it processing to retry.
   */
  private async _resolvePendingRow(row: UploadedDocRow): Promise<void> {
    if (row.status !== "processing" || !row.pending_ref) return;
    const res = await fyimdPollOnce(this.env as unknown as ConverterEnv, row.pending_ref);
    if (res.status === "processing") return;
    if (res.status === "failed") {
      markDocumentFailed(this._docOpsHost(), row.doc_id);
      this.logEvent("document.resolve_failed", { doc_id: row.doc_id, owner_user_id: row.owner_user_id });
      return;
    }
    try {
      await this.env.DOCS_BUCKET.put(row.r2_key, res.markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
    } catch {
      return; // storage hiccup → leave processing, retry on the next poll
    }
    markDocumentResolved(this._docOpsHost(), row.doc_id, res.markdown.length, this._docPreview(res.markdown));
    this.logEvent("document.resolved", {
      doc_id: row.doc_id,
      owner_user_id: row.owner_user_id,
      char_count: res.markdown.length,
      provider: res.provider ?? "unknown",
    });
  }

  /** Resolve every processing doc for an owner — driven by the list route (the
   * frontend polls it to animate the upload spinner, which converges the queue). */
  @callable()
  async resolvePendingDocuments(scopeOwnerId?: string): Promise<void> {
    for (const row of listPendingDocuments(this._docOpsHost(), scopeOwnerId)) {
      await this._resolvePendingRow(row);
    }
  }

  @callable()
  documentList(scopeOwnerId?: string): UploadedDocMeta[] {
    return listDocuments(this._docOpsHost(), scopeOwnerId);
  }

  /**
   * Read a doc's markdown from R2. Distinguishes a successful read (including a
   * genuinely empty object) from a STORAGE FAILURE — a missing object despite
   * existing metadata, or a transient/throwing R2 error — so callers don't
   * mistake a failure for an empty document (Codex P2, 2026-06-24).
   */
  private async _readDocMarkdown(r2Key: string): Promise<{ ok: true; text: string } | { ok: false }> {
    try {
      const obj = await this.env.DOCS_BUCKET.get(r2Key);
      if (obj === null) return { ok: false };
      return { ok: true, text: await obj.text() };
    } catch {
      return { ok: false };
    }
  }

  /** Bounded slice of a doc's markdown (RAW — the tool frames it as untrusted). */
  @callable()
  async documentRead(
    input: { doc_id: string; offset?: number; length?: number },
    scopeOwnerId?: string,
  ): Promise<
    | { ok: true; filename: string; content: string; offset: number; total: number }
    | { ok: false; error: "not_found" | "storage_error" | "processing" | "failed" }
  > {
    let row = getDocumentRow(this._docOpsHost(), input.doc_id, scopeOwnerId);
    if (!row) return { ok: false, error: "not_found" };
    // Async upload: a still-converting doc has no R2 object yet. Try to resolve it
    // (the read itself drives convergence — `document_read` is reachable outside
    // the frontend send-guard: server dispatch, a later turn, a prior session),
    // then re-read the row. Still processing → tell the agent to retry shortly.
    if (row.status === "processing") {
      await this._resolvePendingRow(row);
      row = getDocumentRow(this._docOpsHost(), input.doc_id, scopeOwnerId) ?? row;
    }
    if (row.status === "processing") return { ok: false, error: "processing" };
    if (row.status === "failed") return { ok: false, error: "failed" };
    // Codex P2: a failed R2 read must NOT masquerade as an empty document — the
    // agent would confidently treat a real doc as blank. Surface a storage error.
    const md = await this._readDocMarkdown(row.r2_key);
    if (!md.ok) return { ok: false, error: "storage_error" };
    const offset = Math.max(0, Math.floor(input.offset || 0));
    const length = Math.min(Math.max(1, Math.floor(input.length || 8000)), 20000);
    return { ok: true, filename: row.filename, content: md.text.slice(offset, offset + length), offset, total: md.text.length };
  }

  /** Keyword search across the owner's docs → matching snippets (RAW; tool frames). */
  @callable()
  async documentSearch(
    input: { query: string; max_docs?: number },
    scopeOwnerId?: string,
  ): Promise<{ matches: Array<{ doc_id: string; filename: string; snippets: string[] }>; unreadable: number }> {
    const metas = listDocuments(this._docOpsHost(), scopeOwnerId);
    // Codex P2: scan the FULL owner set by default — capping at the newest 20
    // silently missed hits in older documents (false negatives once a library
    // grows). `max_docs` stays as an optional override (absent = scan all). For
    // very large libraries, semantic search (v2 Vectorize) is the scalable path;
    // the keyword scan stays correct here.
    const scanned = input.max_docs && input.max_docs > 0
      ? metas.slice(0, Math.floor(input.max_docs))
      : metas;
    const matches: Array<{ doc_id: string; filename: string; snippets: string[] }> = [];
    let unreadable = 0;
    for (const m of scanned) {
      const row = getDocumentRow(this._docOpsHost(), m.doc_id, scopeOwnerId);
      if (!row) continue;
      // Codex P2: don't fold an R2 read failure into a false "no match" — count
      // it so the caller knows the result may be incomplete.
      const md = await this._readDocMarkdown(row.r2_key);
      if (!md.ok) { unreadable++; continue; }
      const snippets = keywordSnippets(md.text, input.query, 3);
      if (snippets.length) matches.push({ doc_id: m.doc_id, filename: m.filename, snippets });
    }
    return { matches, unreadable };
  }

  @callable()
  async documentDelete(input: { doc_id: string }, scopeOwnerId?: string): Promise<{ deleted: boolean }> {
    const row = deleteDocumentRow(this._docOpsHost(), input.doc_id, scopeOwnerId);
    if (!row) return { deleted: false };
    try {
      await this.env.DOCS_BUCKET.delete(row.r2_key);
    } catch {
      /* metadata already removed; an orphaned blob is harmless + swept later */
    }
    this.logEvent("document.deleted", { doc_id: input.doc_id });
    return { deleted: true };
  }

  /**
   * the LATEST workflow run for an agent (by `root_agent_id`, the
   * dispatching/initiating agent — stamped by both the ad-hoc dispatch ledger
   * and the an earlier revision executor), owner-scoped, as a `run → phases → agents` tree.
   * Powers the user-app workflow flowchart (shown below activity when the
   * session involves a workflow). Strict-own: a scoped caller only sees runs it
   * owns (admin sees any); null when the agent has no run. Lives on the registry
   * DO (where the workflow_* ledger is written).
   */
  @callable()
  readLatestAgentWorkflowRun(input: { agent_id: string }, scopeOwnerId?: string): WorkflowRunTree | null {
    const rows = scopeOwnerId !== undefined
      ? this.sql<{ run_id: string }>`SELECT run_id FROM workflow_run WHERE root_agent_id = ${input.agent_id} AND owner_user_id = ${scopeOwnerId} ORDER BY updated_at DESC LIMIT 1`
      : this.sql<{ run_id: string }>`SELECT run_id FROM workflow_run WHERE root_agent_id = ${input.agent_id} ORDER BY updated_at DESC LIMIT 1`;
    if (rows.length === 0) return null;
    return this.readWorkflowRun({ run_id: rows[0].run_id }, scopeOwnerId);
  }

  // ── executor-owned ledger writes ───────────────────────
  // The executor (WorkflowExecutor CF Workflow) mints its OWN run_id
  // (`wfr-exec-<short-id>`) and drives these writes through the lifecycle
  // pending → running → terminal. All fail-soft: a ledger error never
  // breaks the executor run (errors are logged, not thrown). Distinct
  // from an earlier revision's `recordWorkflowDispatch` (ad-hoc manager dispatch),
  // which is left untouched.

  @callable()
  recordWorkflowRunStart(input: {
    run_id: string;
    source_task_id: string | null;
    root_agent_id: string | null;
    caps_json: string | null;
    // Multi-tenancy — the run owner (resolved at the executor trigger from the
    // initiating agent; admin sentinel for the operator HTTP path). Stamped so
    // workflow_status can owner-scope the run. Omitted → admin sentinel.
    owner_user_id?: string | null;
  }): void {
    try {
      recordWorkflowRunStartRows(this._workflowStoreHost(), {
        run_id: input.run_id, source_task_id: input.source_task_id, root_agent_id: input.root_agent_id,
        caps_json: input.caps_json, owner: input.owner_user_id ?? ADMIN_USER_ID, now: new Date().toISOString(),
      });
      // feed intent source (activity accordion shows runs).
      this.logEvent("workflow.run.started", {
        run_id: input.run_id,
        source_task_id: input.source_task_id,
      });
    } catch (e) { this._logWorkflowLedgerError("run_start", e); }
  }

  @callable()
  upsertWorkflowPhase(input: {
    run_id: string;
    phase_id: string;
    name: string;
    phase_order: number;
    depends_on_phase_ids_json: string | null;
  }): void {
    try {
      upsertWorkflowPhaseRow(this._workflowStoreHost(), {
        phase_id: input.phase_id, run_id: input.run_id, name: input.name,
        phase_order: input.phase_order, depends_on_phase_ids_json: input.depends_on_phase_ids_json, now: new Date().toISOString(),
      });
    } catch (e) { this._logWorkflowLedgerError("phase_upsert", e); }
  }

  @callable()
  updateWorkflowPhaseStatus(input: { phase_id: string; status: string }): void {
    try {
      updateWorkflowPhaseStatusRow(this._workflowStoreHost(), input.phase_id, input.status, new Date().toISOString());
    } catch (e) { this._logWorkflowLedgerError("phase_status", e); }
  }

  @callable()
  recordWorkflowAgent(input: {
    run_id: string;
    phase_id: string;
    agent_node_id: string;
    agent_id: string | null;
    prompt_preview: string | null;
  }): void {
    try {
      recordWorkflowAgentRow(this._workflowStoreHost(), {
        agent_node_id: input.agent_node_id, run_id: input.run_id, phase_id: input.phase_id,
        agent_id: input.agent_id, prompt_preview: input.prompt_preview, now: new Date().toISOString(),
      });
    } catch (e) { this._logWorkflowLedgerError("agent_record", e); }
  }

  @callable()
  updateWorkflowAgentStatus(input: {
    agent_node_id: string;
    status: string;
    task_id?: string | null;
    result_summary?: string | null;
    failure_reason?: string | null;
  }): void {
    try {
      updateWorkflowAgentStatusRow(this._workflowStoreHost(), { ...input, now: new Date().toISOString() });
    } catch (e) { this._logWorkflowLedgerError("agent_status", e); }
  }

  @callable()
  updateWorkflowRunStatus(input: { run_id: string; status: string }): void {
    try {
      updateWorkflowRunStatusRow(this._workflowStoreHost(), input.run_id, input.status, new Date().toISOString());
      // feed intent source for terminal states only.
      if (input.status === "completed" || input.status === "failed") {
        this.logEvent("workflow.run.terminal", {
          run_id: input.run_id,
          status: input.status,
        });
      }
    } catch (e) { this._logWorkflowLedgerError("run_status", e); }
  }

  private _logWorkflowLedgerError(op: string, e: unknown): void {
    try {
      this.logEvent("workflow.ledger.write_error", {
        op,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    } catch { /* nested fail-soft */ }
  }

  // ── named workflow descriptor store ──────────────────────
  // Validation (shape + name) happens in managerOps BEFORE these
  // callables; the DO owns persistence only. Upsert bumps version.

  @callable()
  saveWorkflowDescriptor(input: {
    name: string;
    descriptor_json: string;
    created_by_agent_id: string | null;
    // Multi-tenancy — the resolved owner of the saving agent (admin sentinel
    // 'user-admin' for the operator path). Stamped on the row; the name
    // PRIMARY KEY is GLOBAL, so a scoped owner can only upsert a name it owns.
    owner_user_id: string;
  }): { ok: boolean; name: string; version: number; error?: "name_taken" } {
    // Owner stamp + cross-tenant name-clobber guard live in the pure helper.
    return saveWorkflowDescriptorRow(this._workflowStoreHost(), input, new Date().toISOString());
  }

  @callable()
  readWorkflowDescriptor(input: { name: string }, scopeOwnerId?: string): WorkflowDescriptorRow | null {
    // Owner isolation (strict-own): a scoped caller that doesn't own this
    // workflow reads `null` — indistinguishable from nonexistent (no existence
    // leak). Admin (undefined scope) reads any row.
    return readWorkflowDescriptorRow(this._workflowStoreHost(), input.name, scopeOwnerId);
  }

  // bounded read of workflow-era feed rows for the console
  // activity accordion. The console's active-context DO is not the
  // registry, so /api/inspect merges these in fail-soft (an earlier revision
  // inline-section pattern).
  @callable()
  readRecentWorkflowFeedRows(input?: { agentId?: string }): Array<{
    event_type: string;
    payload: string;
    created_at: number;
    trace_id: string | null;
  }> {
    const rows = this.sql<{
      event_type: string;
      payload: string;
      created_at: number;
      trace_id: string | null;
    }>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type IN ('workflow.run.started', 'workflow.run.terminal')
         OR (event_type IN ('manager.task.replied', 'manager.task.failed') AND trace_id LIKE 'wfr-%')
      ORDER BY id DESC LIMIT 30
    `;
    // per-agent scope. Without it every agent's activity
    // feed showed the registry-global latest runs (a brand-new agent
    // saw day-old workflows it never touched). Keep only rows whose
    // run this agent rooted (workflow_run.root_agent_id) or
    // participated in (workflow_agent.agent_id / task_id).
    const agentId = input?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) return rows;
    try {
      const runIds = new Set<string>([
        ...this.sql<{ run_id: string }>`
          SELECT run_id FROM workflow_run WHERE root_agent_id = ${agentId}
        `.map((r) => r.run_id),
        ...this.sql<{ run_id: string }>`
          SELECT DISTINCT run_id FROM workflow_agent WHERE agent_id = ${agentId}
        `.map((r) => r.run_id),
      ]);
      const taskIds = new Set<string>(
        this.sql<{ task_id: string | null }>`
          SELECT task_id FROM workflow_agent WHERE agent_id = ${agentId} AND task_id IS NOT NULL
        `.map((r) => r.task_id as string),
      );
      return rows.filter((row) => {
        if (row.event_type.startsWith("workflow.run.")) {
          try {
            const runId = (JSON.parse(row.payload) as { run_id?: unknown }).run_id;
            return typeof runId === "string" && runIds.has(runId);
          } catch { return false; }
        }
        return row.trace_id !== null && taskIds.has(row.trace_id);
      });
    } catch {
      // Filtering must never break the snapshot — but leaking the
      // global feed into a per-agent view is the bug this fixes, so
      // the fail-soft direction is an EMPTY per-agent feed.
      return [];
    }
  }

  @callable()
  listWorkflowDescriptors(scopeOwnerId?: string): WorkflowDescriptorRow[] {
    // Owner isolation (strict-own): a scoped caller only sees its OWN workflows.
    // Admin (undefined scope) sees all (operator unchanged).
    return listWorkflowDescriptorRows(this._workflowStoreHost(), scopeOwnerId);
  }

  private _workflowStoreHost(): WorkflowStoreHost {
    return {
      sql: this.sql.bind(this) as WorkflowStoreHost["sql"],
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  // ── BYO-key provider credential store ────────────────────
  // The raw `api_key` NEVER leaves the DO except through
  // `getProviderCredentialSecret`, which only the in-DO getModel
  // resolution calls; the HTTP-facing list returns key_hint only.
  //
  // 2026-06-22 — at rest the value is AES-256-GCM envelope-encrypted with the
  // `CRED_ENC_KEY` wrangler secret (credentialCrypto), so a DB dump yields
  // ciphertext. When the secret is absent it degrades to plaintext (today's
  // behavior) so the worker never hard-fails on a missing master key.

  private _credMasterKey(): string | null {
    const k = (this.env as unknown as { CRED_ENC_KEY?: string }).CRED_ENC_KEY;
    return typeof k === "string" && k.length > 0 ? k : null;
  }

  @callable()
  async saveProviderCredential(input: {
    provider: string;
    api_key: string;
    base_url?: string | null;
    label?: string | null;
  }, identity?: RequestIdentity): Promise<{ ok: boolean; provider: string; key_hint: string }> {
    // owner-scoped store (scoped → user_provider_credential, admin →
    // legacy). Never log the key itself.
    const now = new Date().toISOString();
    // Hint is masked from the PLAINTEXT; the stored value is the encrypted
    // envelope (or plaintext if no master key is configured).
    const hint = maskKeyHint(input.api_key);
    const master = this._credMasterKey();
    let stored = input.api_key;
    if (master !== null) {
      try { stored = await encryptSecret(input.api_key, master); }
      catch (e) {
        // Refuse rather than silently store plaintext when a master key IS set
        // but encryption failed (e.g. malformed key) — better a clear error.
        this.logEvent("provider.credential.encrypt_error", { provider: input.provider, message: e instanceof Error ? e.message : String(e) });
        return { ok: false, provider: input.provider, key_hint: "" };
      }
    }
    saveProviderCredentialRow(this._credentialHost(), { ...input, api_key: stored, key_hint: hint }, now, identity);
    this.logEvent("provider.credential.saved", {
      provider: input.provider,
      key_hint: hint,
      encrypted: master !== null,
      ...(identity?.kind === "user" ? { owner: identity.userId } : {}),
    });
    return { ok: true, provider: input.provider, key_hint: hint };
  }

  @callable()
  listProviderCredentials(identity?: RequestIdentity): CredentialListRow[] {
    // scoped users only ever see their own credential rows (never
    // the admin's key_hint / provider list). api_key omitted (write-only).
    return listProviderCredentialRows(this._credentialHost(), identity);
  }

  @callable()
  deleteProviderCredential(input: { provider: string }, identity?: RequestIdentity): { ok: boolean } {
    // a scoped user can only delete their own row; the admin's
    // global credential is untouchable from a scoped caller.
    deleteProviderCredentialRow(this._credentialHost(), input.provider, identity);
    this.logEvent("provider.credential.deleted", {
      provider: input.provider,
      ...(identity?.kind === "user" ? { owner: identity.userId } : {}),
    });
    return { ok: true };
  }

  @callable()
  async getProviderCredentialSecret(input: { provider: string }, identity?: RequestIdentity): Promise<{
    api_key: string;
    base_url: string | null;
  } | null> {
    // KEY-BYTES BOUNDARY. A scoped agent reads ONLY its owner's
    // key (user_provider_credential), never the admin's legacy key — there is
    // no fallback to legacy here (that table is the admin's personal key, not
    // a platform default). When the user has no key, this returns null and the
    // caller's env fallback (the platform default) applies. Admin/undefined
    // keeps the exact legacy SQL — byte-identical to pre-426c (saga guard).
    const row = getProviderCredentialSecretRow(this._credentialHost(), input.provider, identity);
    if (row === null) return null;
    const master = this._credMasterKey();
    // No master key configured → values are plaintext; return as-is.
    if (master === null) return row;
    if (isEncryptedSecret(row.api_key)) {
      try {
        return { api_key: await decryptSecret(row.api_key, master), base_url: row.base_url };
      } catch (e) {
        // Tampered / wrong master key — FAIL CLOSED (null → env fallback), never
        // return ciphertext as if it were a key.
        this.logEvent("provider.credential.decrypt_error", { provider: input.provider, message: e instanceof Error ? e.message : String(e) });
        return null;
      }
    }
    // Legacy plaintext row + a master key is now configured → lazily migrate it
    // to an encrypted envelope (best-effort; the read still returns the key).
    try {
      const env = await encryptSecret(row.api_key, master);
      updateCredentialApiKey(this._credentialHost(), input.provider, env, identity);
      this.logEvent("provider.credential.reencrypted", { provider: input.provider });
    } catch { /* leave plaintext; next read retries */ }
    return row;
  }

  @callable()
  listConfiguredProviders(identity?: RequestIdentity): string[] {
    // scoped users only see their own configured providers
    // (no existence leak of the admin's providers). Admin/undefined unchanged.
    return listConfiguredProviderRows(this._credentialHost(), identity);
  }

  // model ids per configured provider that feed the agent-create
  // picker. 2026-06-22: the picker shows the user-ENABLED subset
  // (`enabled_models_json`), not the full discovered set — the user curates it
  // via the discover→enable flow. The runtime gate (resolveProviderForModel)
  // still reads the full `models_json`, so enabling/disabling for the picker
  // never strands a live agent on a model it's already using.
  @callable()
  listDiscoveredModels(identity?: RequestIdentity): Array<{ provider: string; models: string[] }> {
    // scoped users only see models under their own credentials.
    const rows = listEnabledModelsJsonRows(this._credentialHost(), identity);
    const out: Array<{ provider: string; models: string[] }> = [];
    for (const r of rows) {
      if (!r.enabled_models_json) continue;
      try {
        const ids = JSON.parse(r.enabled_models_json) as unknown;
        if (Array.isArray(ids)) {
          out.push({ provider: r.provider, models: ids.filter((x): x is string => typeof x === "string") });
        }
      } catch { /* skip bad cache */ }
    }
    return out;
  }

  // 2026-06-22 — the user-enabled picker subset for one provider (for the
  // discover UI's toggle state). Distinct from the full discovered list returned
  // by discoverProviderModels.
  @callable()
  listEnabledProviderModels(input: { provider: string }, identity?: RequestIdentity): { enabled: string[] } {
    const rows = listEnabledModelsJsonRows(this._credentialHost(), identity);
    const row = rows.find((r) => r.provider === input.provider);
    if (!row || !row.enabled_models_json) return { enabled: [] };
    try {
      const ids = JSON.parse(row.enabled_models_json) as unknown;
      return { enabled: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [] };
    } catch { return { enabled: [] }; }
  }

  // 2026-06-22 — set the user-enabled picker subset for one provider. The ids
  // must be a subset of what was discovered (models_json) — we intersect so a
  // stale/forged id can't be enabled. Writes `enabled_models_json`.
  @callable()
  setEnabledProviderModels(input: { provider: string; ids: string[] }, identity?: RequestIdentity): { ok: boolean; enabled: string[] } {
    const requested = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === "string") : [];
    // Intersect with the discovered set for this provider (the runtime-gate cache).
    const discRows = listProviderModelsJsonRows(this._credentialHost(), identity);
    const discRow = discRows.find((r) => r.provider === input.provider);
    let discovered: string[] = [];
    if (discRow?.models_json) {
      try { const a = JSON.parse(discRow.models_json) as unknown; if (Array.isArray(a)) discovered = a.filter((x): x is string => typeof x === "string"); } catch { /* ignore */ }
    }
    const discSet = new Set(discovered);
    const enabled = requested.filter((id) => discSet.has(id));
    setEnabledModels(this._credentialHost(), input.provider, JSON.stringify(enabled), identity);
    this.logEvent("provider.models.enabled_set", { provider: input.provider, count: enabled.length });
    return { ok: true, enabled };
  }

  // ── BYO Discord bot registry ────────────────────────────
  // Token is write-only: list returns token_hint only; the raw token
  // leaves the DO solely via getDiscordBotsSecret, consumed in-worker
  // by the gateway sweep / outbound sender, never over HTTP.

  @callable()
  async saveDiscordBot(input: {
    bot_id: string;
    token: string;
    username: string;
    label?: string | null;
    allowed_channels: string[];
  }, identity?: RequestIdentity): Promise<{ ok: boolean; bot_id: string; token_hint: string; code?: string }> {
    const now = new Date().toISOString();
    const hint = input.token.length <= 4 ? "••••" : `••••${input.token.slice(-4)}`;
    const channels = JSON.stringify(input.allowed_channels);
    // stamp the owner. Admin → 'user-admin' (the column's 426a
    // default, so admin behavior is unchanged). A scoped user cannot overwrite
    // a bot already owned by someone else.
    const owner = ownerUserIdFor(identity ?? { kind: "admin" });
    if (identity?.kind === "user") {
      const existingOwner = findDiscordBotOwner(this._discordBotHost(), input.bot_id);
      if (existingOwner !== null && existingOwner !== owner) {
        return { ok: false, bot_id: input.bot_id, token_hint: hint, code: "owner_conflict" };
      }
    }
    // encrypt the bot token at rest (parity with provider
    // credentials). `hint` is masked from the plaintext above; the stored
    // value is the AES-256-GCM envelope when CRED_ENC_KEY is configured, or
    // plaintext when it is absent (so the worker never hard-fails on a
    // missing master key). Refuse rather than silently store plaintext when a
    // master key IS set but encryption fails.
    const master = this._credMasterKey();
    let storedToken = input.token;
    if (master !== null) {
      try { storedToken = await encryptSecret(input.token, master); }
      catch (e) {
        this.logEvent("discord.bot.encrypt_error", { bot_id: input.bot_id, message: e instanceof Error ? e.message : String(e) });
        return { ok: false, bot_id: input.bot_id, token_hint: hint, code: "encrypt_failed" };
      }
    }
    saveDiscordBotRow(this._discordBotHost(), {
      bot_id: input.bot_id, storedToken, hint, username: input.username,
      label: input.label ?? null, channelsJson: channels, owner, now,
    });
    this.logEvent("discord.bot.saved", { bot_id: input.bot_id, username: input.username, token_hint: hint, channels: input.allowed_channels.length, encrypted: master !== null });
    return { ok: true, bot_id: input.bot_id, token_hint: hint };
  }

  @callable()
  listDiscordBots(identity?: RequestIdentity): Array<{
    bot_id: string;
    token_hint: string;
    username: string;
    label: string | null;
    allowed_channels: string[];
    updated_at: string;
  }> {
    // Intentionally omits token — write-only secret.
    // scoped users only see their own bots; admin/undefined sees all.
    return listDiscordBotRows(this._discordBotHost(), identity);
  }

  @callable()
  deleteDiscordBot(input: { bot_id: string }, identity?: RequestIdentity): { ok: boolean } {
    // a scoped user can only delete their own bot.
    deleteDiscordBotRow(this._discordBotHost(), input.bot_id, identity);
    if (identity?.kind === "user") {
      this.logEvent("discord.bot.deleted", { bot_id: input.bot_id, owner: identity.userId });
    } else {
      this.logEvent("discord.bot.deleted", { bot_id: input.bot_id });
    }
    return { ok: true };
  }

  @callable()
  async getDiscordBotsSecret(): Promise<Array<{ bot_id: string; token: string; allowed_channels: string[] }>> {
    const rows = getDiscordBotSecretRows(this._discordBotHost());
    const master = this._credMasterKey();
    const out: Array<{ bot_id: string; token: string; allowed_channels: string[] }> = [];
    for (const r of rows) {
      const channels = safeJsonStringArray(r.allowed_channels_json);
      // No master key configured → values are plaintext; return as-is.
      if (master === null) {
        out.push({ bot_id: r.bot_id, token: r.token, allowed_channels: channels });
        continue;
      }
      if (isEncryptedSecret(r.token)) {
        try {
          out.push({ bot_id: r.bot_id, token: await decryptSecret(r.token, master), allowed_channels: channels });
        } catch (e) {
          // tampered / wrong master key → FAIL CLOSED: drop the bot
          // rather than hand ciphertext back as if it were a usable token.
          this.logEvent("discord.bot.decrypt_error", { bot_id: r.bot_id, message: e instanceof Error ? e.message : String(e) });
        }
        continue;
      }
      // legacy plaintext row + a master key is now configured →
      // lazily migrate to an encrypted envelope (best-effort; this read still
      // returns the plaintext token).
      try {
        const enc = await encryptSecret(r.token, master);
        reencryptDiscordBotTokenRow(this._discordBotHost(), r.bot_id, enc);
        this.logEvent("discord.bot.reencrypted", { bot_id: r.bot_id });
      } catch { /* leave plaintext; next read retries */ }
      out.push({ bot_id: r.bot_id, token: r.token, allowed_channels: channels });
    }
    return out;
  }

  // discover a provider's live models via its list-models
  // API (server-side fetch; the key never leaves the worker), and cache
  // the id list on the credential row so any listed model is runnable
  // at create time without re-fetching.
  @callable()
  async discoverProviderModels(input: {
    provider: string;
  }, identity?: RequestIdentity): Promise<{ ok: boolean; models?: DiscoveredModel[]; enabled?: string[]; error?: string }> {
    // discovery reads the caller's own credential (scoped → user
    // table) and caches the model list back onto the same row, so a scoped
    // user never reads or mutates the admin's credential cache.
    const cred = await this.getProviderCredentialSecret({ provider: input.provider }, identity);
    if (cred === null) {
      return { ok: false, error: `no credential configured for ${input.provider}` };
    }
    const result = await fetchProviderModels(input.provider, cred.api_key, cred.base_url);
    if (!result.ok) return { ok: false, error: result.error };
    try {
      // `models_json` = full discovered set: the runtime gate
      // (resolveProviderForModel) + the universe the picker subset is chosen from.
      const ids = JSON.stringify(result.models.map((m) => m.id));
      cacheDiscoveredModels(this._credentialHost(), input.provider, ids, identity);
    } catch { /* fail-soft: cache best-effort */ }
    // 2026-06-22 — return the current enabled subset so the UI renders each
    // discovered model with its enable toggle already reflecting saved state.
    const enabled = this.listEnabledProviderModels({ provider: input.provider }, identity).enabled;
    return { ok: true, models: result.models, enabled };
  }

  // for an arbitrary model id, resolve which configured
  // provider lists it (from the cached models_json). Returns null when
  // no configured provider's cache contains it.
  @callable()
  resolveProviderForModel(input: { model: string }, identity?: RequestIdentity): { provider: string } | null {
    // in the getModel resolution path. A scoped agent resolves a
    // dynamic model id only against ITS OWN configured providers; admin/
    // undefined keeps the exact legacy global scan (saga guard).
    const rows = listProviderModelsJsonRows(this._credentialHost(), identity);
    for (const r of rows) {
      if (!r.models_json) continue;
      try {
        const ids = JSON.parse(r.models_json) as unknown;
        if (Array.isArray(ids) && ids.includes(input.model)) {
          return { provider: r.provider };
        }
      } catch { /* skip bad cache */ }
    }
    return null;
  }

  /**
   * read `manager.task.*` events for one task_id.
   *
   * Returns rows ordered by `created_at ASC` so `deriveManagerTaskStatus`
   * can fold them as a stream. Empty array for unknown task_id (NOT
   * an error) so the route can return 200 + `status:"unknown"` +
   * `events:[]` per ADR §4.3.
   *
   * Payload is parsed back from JSON; the status-derivation helper
   * reads `reply` / `envelope_id` / `reason` / `message` /
   * `failure_class` off the payload directly.
   */
  @callable()
  readManagerTaskEvents(
    taskId: string,
  ): Array<{ type: string; ts: string; payload: Record<string, unknown> | null }> {
    if (typeof taskId !== "string" || taskId.length === 0) return [];
    const rows = this.sql<{
      event_type: string;
      payload: string;
      created_at: number;
    }>`
      SELECT event_type, payload, created_at FROM event_log
      WHERE trace_id = ${taskId} AND event_type LIKE 'manager.task.%'
      ORDER BY created_at ASC
    `;
    return rows.map((r) => {
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = null;
      }
      return {
        type: r.event_type,
        ts: new Date(r.created_at).toISOString(),
        payload,
      };
    });
  }

  /**
   * per-agent manager-task evidence for the lifecycle view.
   *
   * Scans the most recent `manager.task.received` events (LIMIT `limit`,
   * default 500) and filters by `payload.agent_id === agentId`. For
   * each matched task, replays its full `manager.task.*` event chain
   * via `deriveManagerTaskStatus` so the caller can run the pure
   * lifecycle resolver (`resolveAgentLifecycle`) without re-implementing
   * the per-task fold.
   *
   * No JSON-LIKE patterns: the `agent_id` field lives inside the JSON
   * payload column, so a SQL-side filter would mean a substring match
   * with false-positive risk. A bounded scan + `JSON.parse` keeps the
   * filter precise; the DO substrate is small enough that 500 rows is
   * trivial work.
   *
   * Empty array on unknown agentId; not an error.
   */
  @callable()
  getAgentLifecycleEvidence(agentId: string, limit: number = 500): LifecycleTaskEvidence[] {
    if (typeof agentId !== "string" || agentId.length === 0) return [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    const recent = this.sql<{ trace_id: string; payload: string; created_at: number }>`
      SELECT trace_id, payload, created_at FROM event_log
      WHERE event_type = ${MANAGER_TASK_EVENT_NAMES.received}
      ORDER BY created_at DESC
      LIMIT ${cap}
    `;
    const matched: Array<{ task_id: string; received_at: string; received_payload: Record<string, unknown> | null }> = [];
    for (const r of recent) {
      if (typeof r.trace_id !== "string" || r.trace_id.length === 0) continue;
      let p: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          p = parsed as Record<string, unknown>;
        }
      } catch {
        p = null;
      }
      if (p === null) continue;
      if (p.agent_id !== agentId) continue;
      matched.push({
        task_id: r.trace_id,
        received_at: new Date(r.created_at).toISOString(),
        received_payload: p,
      });
    }
    if (matched.length === 0) return [];
    const now = new Date();
    const out: LifecycleTaskEvidence[] = [];
    for (const m of matched) {
      const events: ManagerTaskEventRow[] = this.readManagerTaskEvents(m.task_id);
      const derived = deriveManagerTaskStatus(events, now);
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      // activity summary from `task_context.title` (≤100,
      // ADR §5.1) when present, falling back to `task_context.objective`
      // (≤500, trimmed). `manager.task.received` payload has no `text`
      // field — see `recordManagerTaskEvent` call in managerAsyncTaskController.
      let summary: string | null = null;
      const tc = m.received_payload?.task_context as
        | { title?: unknown; objective?: unknown }
        | undefined;
      if (tc !== undefined && tc !== null && typeof tc === "object") {
        const title = tc.title;
        const objective = tc.objective;
        if (typeof title === "string" && title.length > 0) {
          summary = title.length > 80 ? `${title.slice(0, 80)}…` : title;
        } else if (typeof objective === "string" && objective.length > 0) {
          summary = objective.length > 80 ? `${objective.slice(0, 80)}…` : objective;
        }
      }
      out.push({
        task_id: m.task_id,
        status: derived.status,
        received_at: derived.accepted_at ?? m.received_at,
        last_event_at: lastEvent?.ts ?? m.received_at,
        summary,
        error: derived.error,
      });
    }
    return out;
  }

  /**
   * PUSH v1 entry: subagent-emitted summary keyed by
   * `parent_task_id` via `event_log.trace_id`. Mirrors the
   * `recordManagerTaskEvent` pattern; event name is locked to
   * `manager.subagent.summary` at this method (not caller-supplied).
   */
  @callable()
  pushSubagentArtifactSummary(parentTaskId: string, summary: SubagentSummary): void {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    this.logEvent(SUBAGENT_SUMMARY_EVENT_NAME, summary, parentTaskId);
  }

  /**
   * audit-grade `manager.task.merged` event recorder.
   * Mirrors `recordManagerTaskEvent`  but locks the event
   * name to `manager.task.merged` at the @callable boundary so
   * external callers cannot forge a different event_type into the
   * parent_task_id-keyed stream. Trace key is `parent_task_id`
   * (passed through `event_log.trace_id`).
   *
   * The pure helper in `managerTaskMergeOps.ts` is responsible for
   * permission/refs validation; this method assumes a validated,
   * orchestrator-built payload.
   */
  @callable()
  recordManagerTaskMerged(parentTaskId: string, payload: ManagerTaskMergedPayload): void {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    this.logEvent(MANAGER_TASK_MERGED_EVENT_NAME, payload, parentTaskId);
  }

  /**
   * 群体记忆 v1 PUSH: a subagent records its freshly-promoted
   * insights on the registry keyed by `parent_task_id` (via `event_log.trace_id`),
   * so the dispatching parent can ingest them at its own consolidation. Event
   * name locked here (not caller-supplied). Owner is carried in the payload; the
   * parent-side read fail-closes on owner mismatch (`filterInsightsByOwner`).
   */
  @callable()
  pushSubagentInsight(parentTaskId: string, payload: SubagentInsightPayload): void {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    this.logEvent(SUBAGENT_INSIGHT_EVENT_NAME, payload, parentTaskId);
  }

  /**
   * read `manager.subagent.insight` payloads for a `parent_task_id`
   * (via `event_log.trace_id`). Registry-side; the OWNER fail-closed filter is
   * applied by the parent caller (`filterInsightsByOwner`) using its own owner.
   */
  @callable()
  readSubagentInsights(parentTaskId: string): SubagentInsightPayload[] {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return [];
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM event_log
      WHERE event_type = ${SUBAGENT_INSIGHT_EVENT_NAME} AND trace_id = ${parentTaskId}
      ORDER BY created_at DESC LIMIT 200
    `;
    const out: SubagentInsightPayload[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          && Array.isArray((parsed as SubagentInsightPayload).insights)) {
          out.push(parsed as SubagentInsightPayload);
        }
      } catch { /* skip unparseable row */ }
    }
    return out;
  }

  /**
   * read `manager.subagent.summary` rows for a given
   * `parent_task_id` (uses `event_log.trace_id`) OR — when no
   * parent_task_id filter is supplied — across all `manager.subagent.*`
   * rows so the manager-side permission filter can subset by
   * `source_agent_id`. Permission boundary is applied in the
   * managerOps orchestrator using the calling agent_id.
   *
   * Returns rows ordered by `created_at DESC` (most recent first) so
   * the bounded list naturally surfaces the latest subagent activity.
   */
  @callable()
  readSubagentSummaries(opts: {
    parent_task_id?: string;
  } = {}): SubagentSummaryRow[] {
    const parentFilter = typeof opts.parent_task_id === "string" && opts.parent_task_id.length > 0
      ? opts.parent_task_id
      : null;
    // an earlier revision §4 — surface `event_log.id` as `event_id` for the
    // v1→v2 summary_id bridge. Additive: legacy consumers ignore the
    // new field; future readers can address rows by stable PK.
    const rows = parentFilter !== null
      ? this.sql<{ id: number; trace_id: string; payload: string; created_at: number }>`
          SELECT id, trace_id, payload, created_at FROM event_log
          WHERE event_type = ${SUBAGENT_SUMMARY_EVENT_NAME}
            AND trace_id = ${parentFilter}
          ORDER BY created_at DESC
          LIMIT 200
        `
      : this.sql<{ id: number; trace_id: string; payload: string; created_at: number }>`
          SELECT id, trace_id, payload, created_at FROM event_log
          WHERE event_type = ${SUBAGENT_SUMMARY_EVENT_NAME}
          ORDER BY created_at DESC
          LIMIT 200
        `;
    const out: SubagentSummaryRow[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push({
            parent_task_id: r.trace_id,
            payload: parsed as SubagentSummary,
            recorded_at: new Date(r.created_at).toISOString(),
            event_id: r.id,
          });
        }
      } catch { /* skip malformed row */ }
    }
    return out;
  }

  /**
   * read `manager.task.merged` rows for a parent_task_id.
   *
   * SQL keyed by `event_log.trace_id = parentTaskId` per an earlier revision
   * emitter contract (`recordManagerTaskMerged` writes trace_id =
   * parent_task_id). Returns rows ORDER BY created_at ASC so the
   * reader/status helpers in `managerTaskMergeReaderOps.ts` can pick
   * the latest as `rows[length-1]` without re-sorting.
   *
   * Surfaces `event_log.id` as `event_id` so the HTTP `/merge`
   * response can address each row by stable PK (an earlier revision §4 bridge
   * is the same shape the subagent summary reader now exposes).
   *
   * Fail-soft on JSON parse: returns `{event_id, created_at, payload:
   * null}` rather than dropping the row, so a malformed legacy
   * payload still counts toward `merge_count` and surfaces in the
   * `merges[]` list — `deriveMergeSideField` reads each field
   * defensively. Empty array for unknown parent_task_id (NOT an
   * error).
   */
  @callable()
  readManagerTaskMergedEvents(
    parentTaskId: string,
  ): Array<{ event_id: number; created_at: string; payload: ManagerTaskMergedPayload | null }> {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return [];
    const rows = this.sql<{ id: number; payload: string; created_at: number }>`
      SELECT id, payload, created_at FROM event_log
      WHERE event_type = ${MANAGER_TASK_MERGED_EVENT_NAME}
        AND trace_id = ${parentTaskId}
      ORDER BY created_at ASC
      LIMIT 200
    `;
    return rows.map((r) => {
      let payload: ManagerTaskMergedPayload | null = null;
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as ManagerTaskMergedPayload;
        }
      } catch {
        payload = null;
      }
      return {
        event_id: r.id,
        created_at: new Date(r.created_at).toISOString(),
        payload,
      };
    });
  }

  /**
   * manager completion-report event recorder. Mirrors
   * `recordManagerTaskMerged`  but locks the event name to
   * `manager.task.completed` at the @callable boundary so external
   * callers cannot forge a different event_type into the
   * parent_task_id-keyed stream. Trace key is `parent_task_id`.
   *
   * Pure helper in `managerTaskCompleteOps.ts` owns validation,
   * verdict gating, and the merge-precondition probe; this method
   * assumes a validated, orchestrator-built payload.
   */
  @callable()
  recordManagerTaskCompleted(parentTaskId: string, payload: ManagerTaskCompletedPayload): void {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    this.logEvent(MANAGER_TASK_COMPLETED_EVENT_NAME, payload, parentTaskId);
  }

  /**
   * read `manager.task.completed` rows for a parent_task_id.
   *
   * SQL keyed by `event_log.trace_id = parentTaskId` per an earlier revision
   * emitter contract. Returns rows ORDER BY created_at ASC so
   * `managerTaskCompleteReaderOps.deriveCompletionSideField` can pick
   * `rows[length-1]` as latest without re-sorting.
   *
   * Fail-soft on JSON parse: returns `{event_id, created_at, payload:
   * null}` rather than dropping the row, so a malformed legacy
   * payload still counts toward `completion_count` and surfaces in
   * subsequent reader responses. Empty array for unknown
   * parent_task_id (NOT an error).
   */
  @callable()
  readManagerTaskCompletedEvents(
    parentTaskId: string,
  ): Array<{ event_id: number; created_at: string; payload: ManagerTaskCompletedPayload | null }> {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return [];
    const rows = this.sql<{ id: number; payload: string; created_at: number }>`
      SELECT id, payload, created_at FROM event_log
      WHERE event_type = ${MANAGER_TASK_COMPLETED_EVENT_NAME}
        AND trace_id = ${parentTaskId}
      ORDER BY created_at ASC
      LIMIT 200
    `;
    return rows.map((r) => {
      let payload: ManagerTaskCompletedPayload | null = null;
      try {
        const parsed = JSON.parse(r.payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as ManagerTaskCompletedPayload;
        }
      } catch {
        payload = null;
      }
      return {
        event_id: r.id,
        created_at: new Date(r.created_at).toISOString(),
        payload,
      };
    });
  }

  /**
   * terminal-event-durable manager task entrypoint.
   *
   * Background: an earlier revision's `runManagerTaskBackground` ran the long
   * manager turn from within a worker `ctx.waitUntil(...)` block.
   * Real multi-agent runs (Manager take1.1, 2026-05-25) exceeded the
   * ~30s HTTP-worker waitUntil ceiling — the inner `submitTask`
   * finalized (`task.reply.finalized`) but the worker isolate had
   * been torn down by the time `manager.task.replied` / `failed`
   * would have been recorded. GET /api/manager/tasks/:id then
   * incorrectly reported `timed_out` for a successful run.
   *
   * Fix: move terminal event emission INSIDE the DO RPC, so the
   * persistence write happens while the manager DO itself is alive —
   * the DO outlives the calling worker. Worker still emits `started`
   * fast (before the long await) and `failed` for pre-DO failures
   * (target_not_found / RPC throw); both are O(ms).
   *
   * Contract:
   *   - Caller is the worker side of `runManagerTaskBackground`.
   *   - We run `this.submitTask(text)` (the manager DO's own loop).
   *   - On success: record `manager.task.replied` keyed by
   *     `managerTaskId` AND the legacy `manager.agent.message.sent`
   *     event (parity with `managerSendAgentMessage`'s outer-message
   *     emit, so inspect / dashboards reading that event don't lose
   *     the OUTER POST occurrence — INNER subagent fanout still
   *     emits via `managerSendAgentMessage` separately).
   *   - On `submitTask` throw: record `manager.task.failed`
   *     (failure_class:"internal") and re-throw so the worker layer's
   *     timeout-regex classifier can still map RPC envelope timeouts
   *     to `agent_loop_timeout` for the sync HTTP body.
   *   - Terminal event record failure is fail-soft (console.warn);
   *     never poisons the caller's result.
   *   - Returns the raw `submitTask` shape unchanged so the worker
   *     can synthesize `ManagerAgentMessageResult` for the sync HTTP
   *     reply.
   *
   * Note: returns the SAME shape as `submitTask` so the per-agent
   * stub surface in `managerOps.ts` can extend cleanly. We do NOT
   * push the higher-level `ManagerAgentMessageResult` discriminated
   * union into this callable; that mapping belongs to managerOps /
   * managerRoutes.
   */
  /**
   * an earlier revision — narrow read surface for the in-flight manager
   * task context. Returns null when this call is not inside a
   * `submitManagerTask` Promise chain. The `manager.agent_message`
   * adapter calls this via `agentCtx` to default subagent
   * `task_context.parent_task_id` and `task_context.source_agent_id`
   * so the same canonical outer task id keys the manager task,
   * subagent dispatch, and registry `event_log` row.
   *
   * source is now `AsyncLocalStorage`, not DO instance
   * fields. Two `submitManagerTask` calls executing concurrently
   * against the same DO each get an isolated store; one cannot read
   * or clobber the other's outer id. The previous instance-field
   * implementation broke this when async manager tasks interleaved.
   */
  /**
   * this DO's own agent id (`this.name`). The manager-dispatch
   * adapter uses it to resolve the DISPATCHING agent's owner identity so an
   * agent-initiated dispatch inherits its owner (and a scoped agent can only
   * dispatch to its own tenant). Unlike `getCurrentManagerContext()`, this is
   * ALWAYS available — independent of an in-flight `submitManagerTask` round —
   * so the ownership path has no null/admin-fallback (which would be fail-open).
   */
  getOwnAgentId(): string {
    return this.name;
  }

  getCurrentManagerContext(): {
    manager_task_id: string;
    agent_id: string;
    source?: string;
    conversation_id?: string;
  } | null {
    const turn = getManagerTurnContext();
    if (turn === null) return null;
    return {
      manager_task_id: turn.managerTaskId,
      agent_id: this.name,
      ...(turn.source !== null ? { source: turn.source } : {}),
      ...(turn.conversationId !== null
        ? { conversation_id: turn.conversationId }
        : {}),
    };
  }

  @callable()
  async submitManagerTask(
    text: string,
    managerTaskId: string,
    opts?: {
      displayText?: string;
      source?: string;
      conversationId?: string;
      // structured TaskContext (ADR §5) forwarded into the
      // subagent's first-turn user message as a `<task-context>` block.
      taskContext?: TaskContext;
    },
  ): Promise<{
    ok: boolean;
    taskId: string;
    loopTriggered: boolean;
    replyText: string;
    envelopeId: string | null;
  }> {
    const agentId = this.name;
    type RegistryStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;
    let registry: RegistryStub | null = null;
    try {
      registry = await getRegistryStub(this.env);
    } catch (e) {
      // Registry stub resolve failed from inside the DO. Anomalous;
      // proceed with submitTask anyway and let the worker layer
      // surface a `manager.task.failed` if it survives. Operator
      // will see `timed_out` in the GET if worker also dies.
      // logEvent (local event_log) instead of console.warn.
      this.logEvent("manager.task.registry_resolve_failed", {
        manager_task_id: managerTaskId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    let raw: { ok: boolean; taskId: string; loopTriggered: boolean; replyText: string; envelopeId: string | null };
    // run the entire `submitTask` Promise chain inside a
    // per-call AsyncLocalStorage scope so concurrent async manager
    // tasks against the same DO cannot stomp each other's outer task
    // context. No `finally` cleanup needed: ALS scope ends when the
    // wrapped Promise settles. The `manager.agent_message` adapter
    // reads `getCurrentManagerContext()` which now resolves through
    // `getManagerTurnContext()` from the store.
    try {
      raw = await runWithManagerTurnContext(
        {
          managerTaskId,
          agentId,
          source: opts?.source ?? null,
          conversationId: opts?.conversationId ?? null,
        },
        async () => {
          const submitOpts: {
            displayText?: string;
            taskContext?: TaskContext;
            managerTaskContext?: {
              manager_task_id: string;
              agent_id: string;
              source?: string;
              conversation_id?: string;
            };
          } = {};
          if (opts?.displayText !== undefined) submitOpts.displayText = opts.displayText;
          // propagate structured TaskContext into the
          // subagent's first-turn user message (validated by `submitTask`).
          if (opts?.taskContext !== undefined) submitOpts.taskContext = opts.taskContext;
          // inject the manager's own outer task context
          // (canonical `manager_task_id` = registry event_log.trace_id) so
          // the manager LLM's first-turn user message carries a structured
          // `<manager-context>` block. `task.submitted` also surfaces it.
          submitOpts.managerTaskContext = {
            manager_task_id: managerTaskId,
            agent_id: agentId,
            ...(opts?.source !== undefined ? { source: opts.source } : {}),
            ...(opts?.conversationId !== undefined
              ? { conversation_id: opts.conversationId }
              : {}),
          };
          return await this.submitTask(text, submitOpts);
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (registry !== null) {
        try {
          await registry.recordManagerTaskEvent(
            "manager.task.failed",
            {
              task_id: managerTaskId,
              agent_id: agentId,
              reason: "internal",
              message: clampUtf8Bytes(message, FAILURE_MESSAGE_BYTE_CAP),
              failure_class: "internal",
              source: opts?.source,
              ...(opts?.conversationId !== undefined
                ? { conversation_id: opts.conversationId }
                : {}),
            },
            managerTaskId,
          );
        } catch (logErr) {
          console.warn(
            `[submitManagerTask ${managerTaskId}] failed event record also failed: ${
              logErr instanceof Error ? logErr.message : String(logErr)
            }`,
          );
        }
      }
      throw e;
    }
    if (registry !== null) {
      try {
        await registry.recordManagerEvent("manager.agent.message.sent", {
          agent_id: agentId,
          task_id: raw.taskId,
          envelope_id: raw.envelopeId,
          loop_triggered: raw.loopTriggered,
          reply_length: raw.replyText.length,
          source: opts?.source,
          ...(opts?.conversationId !== undefined
            ? { conversation_id: opts.conversationId }
            : {}),
          // record full TaskContext on the DO-side dispatch
          // event (ADR §5.2) so audit + inspect surfaces see it.
          ...(opts?.taskContext !== undefined
            ? { task_context: opts.taskContext }
            : {}),
        });
      } catch (e) {
        // logEvent (local event_log) instead of console.warn.
        this.logEvent("manager.task.legacy_message_sent_record_failed", {
          manager_task_id: managerTaskId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        await registry.recordManagerTaskEvent(
          "manager.task.replied",
          {
            task_id: managerTaskId,
            agent_id: agentId,
            submit_task_id: raw.taskId,
            envelope_id: raw.envelopeId ?? null,
            reply_length: raw.replyText.length,
            loop_triggered: raw.loopTriggered,
            source: opts?.source,
            ...(opts?.conversationId !== undefined
              ? { conversation_id: opts.conversationId }
              : {}),
            ...(raw.replyText.length > 0 ? { reply: raw.replyText } : {}),
          },
          managerTaskId,
        );
      } catch (e) {
        // logEvent (local event_log) instead of console.warn.
        this.logEvent("manager.task.terminal_replied_record_failed", {
          manager_task_id: managerTaskId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return raw;
  }

  // ── M9.0 agent_run row callables (registry DO) ──────────
  // Same substrate as agent_profile: SQLite on the AgentThursdayAgent DO,
  // accessed by AgentRunWorkflow.step.do via the @callable surface so
  // routes / workflows never speak SQL directly. Composition root
  // resolves the registry stub via getAgentByName(env.AgentThursdayAgent,
  // DEMO_INSTANCE) — same pattern as the agent_profile callables.
  private _agentRunHost(): AgentRunHost {
    return { sql: this.sql.bind(this) as AgentRunHost["sql"] };
  }

  @callable()
  createAgentRun(input: CreateAgentRunRowInput): AgentRunRow {
    return createAgentRunRow(this._agentRunHost(), input);
  }

  @callable()
  readAgentRun(runId: string, identity?: RequestIdentity): AgentRunRow | null {
    // scoped → owner-JOIN; admin/undefined → no-JOIN (unchanged).
    return readAgentRunRow(this._agentRunHost(), runId, identity);
  }

  @callable()
  listAgentRuns(opts: ListAgentRunsOptions = {}, identity?: RequestIdentity): AgentRunListRow[] {
    // scoped → only the caller's own agents' runs.
    return listAgentRunRows(this._agentRunHost(), opts, identity);
  }

  @callable()
  listAgentActivity(opts: { limit?: number } = {}, identity?: RequestIdentity): AgentActivityRow[] {
    // Activity feed (model A) — the caller's own agents' dispatched sub-tasks
    // from the an earlier revision workflow_agent ledger. Owner-scoped like listAgentRuns
    // (reuses the same {sql} host). Powers the conversation page Activity panel;
    // `/api/agent-runs` is empty for chat/dispatch so it could not.
    return listAgentActivityRows(this._agentRunHost(), opts, identity);
  }

  @callable()
  markAgentRunComplete(input: MarkAgentRunCompleteInput): void {
    markAgentRunCompleteRow(this._agentRunHost(), input);
  }

  @callable()
  markAgentRunFailed(input: MarkAgentRunFailedInput): void {
    markAgentRunFailedRow(this._agentRunHost(), input);
  }

  @callable()
  markAgentRunAwaitingEvent(input: MarkAgentRunAwaitingEventInput): void {
    markAgentRunAwaitingEventRow(this._agentRunHost(), input);
  }

  @callable()
  markAgentRunTimedOut(input: MarkAgentRunTimedOutInput): void {
    markAgentRunTimedOutRow(this._agentRunHost(), input);
  }

  // ── inspect/debug view delegates ───────────────────────
  // Bodies live in `./agent/inspectViews`. Thin facade only; RPC
  // surface (`getDebugTrace` / `getDegradationDiagnostics` /
  // `getInspectSnapshot` / `getUsageStats`) is unchanged.
  private _inspectViewsHost(): InspectViewsHost {
    return {
      sql: this.sql.bind(this) as InspectViewsHost["sql"],
      getSafeState: () => this.getSafeState(),
      getPendingToolApproval: () => this.getPendingToolApproval(),
      getLastAssistantTextFull: () => this.getLastAssistantTextFull(),
      getMessagesCount: () => this.getMessages().length,
      sessionTok: this._sessionTok,
      taskTok: this._taskTok,
      lastStepInputTokens: this._lastStepIn,
      lastStepModel: this._lastStepModel,
    };
  }

  @callable()
  getDebugTrace(): DebugTraceView {
    return getDebugTraceView(this._inspectViewsHost());
  }

  @callable()
  // see `getDegradationDiagnosticsView` in `./agent/inspectViews`.
  getDegradationDiagnostics(): DegradationDiagnostics {
    return getDegradationDiagnosticsView(this._inspectViewsHost());
  }

  getInspectSnapshot(): InspectSnapshot {
    return getInspectSnapshotView(this._inspectViewsHost());
  }

  /**
   * Owner-scoped user-app activity feed source (the operator 2026-06-17): this
   * agent's recent `actionUiIntents`, filtered to the SAME default-feed set
   * the console's ActivityFeed shows (`isDefaultFeedIntent`) — dispatch,
   * browser/search, file read, file/repo write, execution. `@callable` so
   * `getUserActivity` can fan this out across a tenant's agents (the
   * cross-agent merge that surfaces a subagent's browser/file work, which
   * lives in the SUBAGENT's DO, not the dispatching manager's). Returns the
   * `limit` most-recent feed intents (newest first).
   */
  @callable()
  getActivityIntents(input?: { limit?: number }): {
    id: string; type: string; title: string; sourceEventAt: number;
    life?: { family: string; phase: string; status: string | null; agentId: string | null; agentName: string | null };
  }[] {
    const limit = Math.min(Math.max(input?.limit ?? 20, 1), 50);
    const intents = getInspectSnapshotView(this._inspectViewsHost()).actionUiIntents ?? [];
    return intents
      .filter(isDefaultFeedIntent)
      .sort((a, b) => b.sourceEventAt - a.sourceEventAt)
      .slice(0, limit)
      // Project to a slim, RPC-clean primitive shape (avoids the schema's
      // `props: unknown` tripping Rpc.Serializable).
      // for manager lifecycle intents, also project the structured
      // identity+phase (as primitives) so the feed can COALESCE the four
      // create/dispatch events of one subagent into a single status card.
      .map((it) => {
        const base = { id: it.id, type: it.type, title: it.title, sourceEventAt: it.sourceEventAt };
        if (it.type !== "tool.lifecycle") return base;
        const p = (it as { component?: { props?: Record<string, unknown> } }).component?.props ?? {};
        const s = (k: string): string | null => (typeof p[k] === "string" ? (p[k] as string) : null);
        return {
          ...base,
          life: {
            family: s("family") ?? "",
            phase: s("phase") ?? "",
            status: s("status"),
            agentId: s("agentId"),
            agentName: s("agentName"),
          },
        };
      });
  }

  @callable()
  getUsageStats(): UsageStatsView {
    return getUsageStatsView(this._inspectViewsHost());
  }

  @callable()
  getMemoryLayers(): { soul: string; knowledge: { key: string; content: string }[]; lastMessage: string } {
    // thin delegate.
    return getMemoryLayersFree(this._memoryReadHost());
  }

  // ── Context Lifecycle: inspect + reset ────────────────
  // See docs/milestones/M7.7-context-lifecycle-management.md.
  // `inspectContext` returns a sanitized view (no system prompts / SOUL /
  // secrets / raw tool payloads); `resetContext` clears transient LLM
  // messages while preserving durable state (checkpoints, memory, workspace,
  // event_log, current task metadata, model profile). `context.new` is
  // deferred — Think SDK doesn't yet expose multi-thread session traceability
  // we'd need to honor the "preserve traceability" constraint in the spec.

  /**
   * dev-shell read/gate Host. Narrow capabilities surface
   * for `devShellOps.ts` free functions; exposes `ctx.waitUntil` as
   * a bound method so `startGateJobFree` can fire background gate
   * work without holding `DurableObjectState`.
   */
  private _devShellOpsHost(): DevShellOpsHost {
    return {
      sql: this.sql.bind(this) as DevShellOpsHost["sql"],
      env: this.env,
      workspace: {
        readFile: (p: string) => this.workspace.readFile(p),
        glob: (pattern: string) => this.workspace.glob(pattern),
      },
      logEvent: (type, payload, traceId) => this.logEvent(type, payload, traceId ?? null),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    };
  }

  /**
   * write-side dev-shell Host. Adds the scratch-workspace
   * write surface + agentId + cross-DO approval-consume callback that
   * `devShellWriteDispatchFree` needs. ChannelHubAgent + agentNamespace
   * specifics stay at this composition root so `devShellOps.ts` can
   * remain free of cross-agent imports.
   */
  private _devShellWriteHost(): DevShellWriteHost {
    const env = this.env;
    return {
      env,
      agentId: this.name,
      workspace: {
        readFile: (p: string) => this.workspace.readFile(p),
        writeFile: async (p: string, content: string) => { await this.workspace.writeFile(p, content); },
        deleteFile: async (p: string) => { await this.workspace.deleteFile(p); },
      },
      logEvent: (type, payload, traceId) => this.logEvent(type, payload, traceId ?? null),
      consumeApproval: async (req) => {
        const stub = await getAgentByName<Env, ChannelHubAgent>(
          env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
          CHANNEL_HUB_INSTANCE,
        );
        return stub.consumeApprovalToken({
          token_id: req.token_id,
          token: req.token,
          agent_id: req.agent_id,
          tool_id: req.tool_id,
          input_hash: req.input_hash,
        });
      },
      // an earlier revision B — write dispatcher gates on the per-DO
      // `_repoPrepared` flag flipped by a successful `repo.prepare`.
      isRepoPrepared: () => this._repoPrepared,
    };
  }

  /**
   * an earlier revision + 184a — Developer Shell read + git inspect dispatcher.
   * body moved to `devShellOps.devShellDispatchFree`.
   */
  @callable()
  async devShellDispatch(input: { tool_id: string; input: Record<string, unknown>; traceId?: string | null }): Promise<unknown> {
    return devShellDispatchFree(this._devShellOpsHost(), input);
  }

  /**
   * toolEvents observability + conversation_search trigger
   * audit. body moved to
   * `devShellOps.devShellObservabilityCheckFree`.
   */
  @callable()
  async devShellObservabilityCheck(input?: { query?: string }): Promise<unknown> {
    return devShellObservabilityCheckFree(this._devShellOpsHost(), input);
  }

  /**
   * Gate runner. Sync semantics retained for DO-internal
   * agent/tool path (an earlier revision auto-gate). body moved to
   * `devShellOps.devShellGateRunFree`.
   */
  @callable()
  async devShellGateRun(input: { target: string; traceId?: string | null }): Promise<unknown> {
    return devShellGateRunFree(this._devShellOpsHost(), input);
  }

  /**
   * async gate job entry. Returns `{ job_id }` immediately;
   * the actual gate work runs in the background via the Host's
   * `waitUntil` so the HTTP response is not bound to gate duration.
   * body moved to `devShellOps.startGateJobFree`; the
   * free fn calls `devShellGateRunFree` directly so background work
   * does not re-enter the agent surface.
   */
  @callable()
  async startGateJob(input: { target: string }): Promise<{
    job_id: string;
    target: string;
    status: "started";
    started_at: number;
  }> {
    return startGateJobFree(this._devShellOpsHost(), input);
  }

  /**
   * poll an async gate job. body moved to
   * `devShellOps.getGateJobStatusFree`.
   */
  @callable()
  getGateJobStatus(input: { job_id: string }): {
    job_id: string;
    status: "in_progress" | "done" | "error" | "unknown";
    events: Array<{ event_type: string; payload: unknown; created_at: number }>;
  } {
    return getGateJobStatusFree(this._devShellOpsHost(), input);
  }

  /**
   * Evidence envelope runtime.
   *
   * The envelope store lives on the DO; helpers expose draft / add
   * execution / add gate evidence / add diff evidence / seal /
   * inspect via callables. Each mutation also emits an
   * `evidence.envelope.<verb>` event so cross-DO query can
   * reconstruct envelopes from event_log.
   */
  // envelope store init + active-draft resolution moved to
  // `src/agent/envelopeOps.ts`. The `_envelopeStoreCache` field stays
  // on this class per spec; Host getter/setter wires the cache into
  // the free fns. The four `ENVELOPE_SWEEPER_*` constants are now
  // imported from `./agent/envelopeOps`; the class-static aliases
  // below keep `AgentThursdayAgent.ENVELOPE_SWEEPER_*` references in
  // submitTask main chain / sweeper / retention byte-equal.
  private _envelopeStoreCache: EnvelopeStoreType | null = null;

  private _envelopeStoreHost(): EnvelopeStoreHost {
    return {
      sql: this.sql.bind(this) as EnvelopeStoreHost["sql"],
      logEvent: (type, payload, traceId) => this.logEvent(type, payload, traceId ?? null),
      getCurrentTaskId: () => this.agentthursdayState.currentTaskObject?.id ?? null,
      getEnvelopeStoreCache: () => this._envelopeStoreCache,
      setEnvelopeStoreCache: (store) => { this._envelopeStoreCache = store; },
    };
  }

  private _ensureEnvelopeStoreSync(): EnvelopeStoreType {
    return ensureEnvelopeStoreSyncFree(this._envelopeStoreHost());
  }

  private async _ensureEnvelopeStore(): Promise<EnvelopeStoreType> {
    return ensureEnvelopeStoreFree(this._envelopeStoreHost());
  }

  private _resolveActiveDraftEnvelopeId(): string | null {
    return resolveActiveDraftEnvelopeIdFree(this._envelopeStoreHost());
  }

  /**
   * envelope CRUD Host. Extends `_envelopeStoreHost()` with
   * the `agentId` and the two cross-module capabilities the CRUD free
   * functions need: `runGate` and `dispatchReadTool`. Both capabilities
   * call the corresponding `devShellOps` free function directly (not
   * back through the `@callable()` agent surface) so CRUD never
   * re-enters the agent ABI mid-flight.
   */
  private _envelopeCrudHost(): EnvelopeCrudHost {
    const devShellHost = this._devShellOpsHost();
    return {
      ...this._envelopeStoreHost(),
      agentId: this.name,
      runGate: (target, traceId) => devShellGateRunFree(devShellHost, { target, traceId }),
      dispatchReadTool: (tool_id, input, traceId) =>
        devShellDispatchFree(devShellHost, { tool_id, input, traceId }),
    };
  }

  /**
   * idempotent envelope-finalize routine, extracted from
   * submitTask's finally so a sweeper (alarm or /cli/status lazy
   * trigger) can finalize an envelope whose owning saveMessages
   * never returned. Safe to call multiple times for the same
   * envelope: a sealed/failed envelope short-circuits.
   *
   * `claimedTools` semantics:
   *   - Happy path (submitTask.finally) supplies the wrapped-tool ids
   *     captured during the round so seal can compute fabricated_tools
   *     against the agent's actual dispatch claims.
   *   - Sweeper path supplies undefined; the routine derives claimed=
   *     evidenced from `execution[].tool_call.tool_id`. This makes
   *     `fabricated_tools=[]` by construction — the safe assertion
   *     when the original turn died and we no longer have the
   *     wrapped-id list (DO isolate wiped `_currentTaskWrappedToolIds`).
   */
  private _finalizeTaskTurn(opts: {
    taskId: string;
    envelopeId: string;
    source: string;
    claimedTools?: string[];
    /**
     * when true, the seal contract allows `verdict=pass`
     * for an envelope with empty execution + evidence rings, on the
     * assumption that the caller has already proved the turn is
     * read-only / answer-only (no gate intent on prompt, no gate
     * intent on raw reply, no tools dispatched). Defaults to false
     * so the sweeper and any other caller retain the strict
     * ring-presence contract.
     */
    readOnlySafe?: boolean;
    /**
     * true iff the prompt asked the agent to read a repo
     * file but zero read-side tools were dispatched. Passed into
     * `EvidenceEnvelope.seal` so the strict-ring fail path can emit
     * the dedicated `read_intent_no_execution` reason instead of the
     * generic `envelope missing required ring(s)`. Defaults to false
     * for sweepers / orphan finalize paths where the originating
     * prompt is no longer in scope.
     */
    readIntentObserved?: boolean;
    /**
     * true iff the supplier dispatched a Think workspace
     * mutation tool (`write` / `delete` / `edit`) but no envelope-
     * wrapped `repo.write` / `repo.delete` execution was recorded.
     * Threaded into `EvidenceEnvelope.seal` so the strict-ring fail
     * emits `mutation_intent_unwrapped_execution` and disables the
     * read-only-safe short-circuit. Defaults to false.
     */
    mutationIntentObservedUnwrapped?: boolean;
    /**
     * true iff the prompt declared mutation intent
     * (write/delete/edit on a repo-shaped path) AND
     * `totalToolCalls === 0`. Threaded into
     * `EvidenceEnvelope.seal` so the strict-ring fail emits
     * `mutation_intent_no_execution` and disables the read-only-safe
     * short-circuit. Mutually exclusive with
     * `mutationIntentObservedUnwrapped` by construction (that one
     * requires count > 0). Defaults to false.
     */
    mutationIntentNoExecution?: boolean;
    /**
     * an earlier revision C — true iff the prompt declared mutation intent
     * (write/delete/edit on a repo-shaped path). Threaded into
     * `EvidenceEnvelope.seal` so the strict-ring fail emits the
     * stronger `missing_mutation_evidence` reason whenever execution
     * lacks any `repo.write` / `repo.patch` call (including the
     * "looked but never wrote" shape where read-side tools fired but
     * no mutation tool did). Subsumes 295e's
     * `mutation_intent_no_execution` reason for the empty-execution
     * subcase. Defaults to false.
     */
    mutationToolsExpected?: boolean;
  }): { sealed: boolean; envelopeStatus: "sealed" | "failed" | "draft" | null; verdict?: string; verdictReason?: string; idempotentNoop: boolean } {
    const {
      taskId,
      envelopeId,
      source,
      claimedTools: claimedFromOpts,
      readOnlySafe,
      readIntentObserved,
      mutationIntentObservedUnwrapped,
      mutationIntentNoExecution,
      mutationToolsExpected,
    } = opts;
    // persist this turn's token usage. _taskTok is complete by
    // finalize time; only write when it belongs to THIS task (the sweeper may
    // finalize a task whose in-memory counters were wiped by a DO restart —
    // then the seeded zeros stand, honest "unknown"). Fail-soft.
    try {
      if (this._taskTok.taskId === taskId && (this._taskTok.in > 0 || this._taskTok.out > 0)) {
        const m = this._lastStepModel;
        this.sql`UPDATE task_usage SET
            tokens_in = ${this._taskTok.in},
            tokens_out = ${this._taskTok.out},
            tokens_in_cached = ${this._taskTok.cached > 0 ? this._taskTok.cached : null},
            model = ${m?.modelId ?? null},
            provider = ${m?.provider ?? null}
          WHERE task_id = ${taskId}`;
      }
    } catch { /* fail-soft: usage accounting never blocks the seal */ }
    const store = this._ensureEnvelopeStoreSync();
    let env = store.get(envelopeId);
    if (!env) {
      // Memory miss — pull from SQL so the seal contract doesn't
      // silently drop a finalize because the in-memory map was wiped.
      try {
        const rows = this.sql<{ payload: string }>`
          SELECT payload FROM envelope_snapshots WHERE envelope_id = ${envelopeId} LIMIT 1
        `;
        if (rows.length > 0) {
          try {
            const restored = JSON.parse(rows[0].payload) as EvidenceEnvelopeType;
            store.adopt(restored);
            env = store.get(envelopeId);
          } catch { /* skip unparseable */ }
        }
      } catch { /* fail-soft */ }
    }
    if (!env) return { sealed: false, envelopeStatus: null, idempotentNoop: false };

    // Idempotent — already finalized.
    if (env.envelope_status !== "draft") {
      if (this._currentEnvelopeId === envelopeId) {
        this._currentEnvelopeId = null;
        this._currentTaskWrappedToolIds = [];
      }
      // an earlier revision fix A — clean up any pinned attribution map entry so
      // it doesn't leak across DO lifetime. A leftover here means an
      // auto-dispatched gate returned after this task was already sealed
      // by another route; the extra claim is unrecoverable for the
      // already-sealed envelope, but we still want the map drained.
      if (this._pinnedWrappedToolIdsByTask.has(taskId)) {
        try {
          this.logEvent("tool.gate_intent.autodispatch.pinned_extras_dropped", {
            taskId,
            envelopeId,
            tool_ids: this._pinnedWrappedToolIdsByTask.get(taskId) ?? [],
            reason: "envelope_already_finalized",
          });
        } catch { /* fail-soft */ }
        this._pinnedWrappedToolIdsByTask.delete(taskId);
      }
      return {
        sealed: false,
        envelopeStatus: env.envelope_status,
        verdict: env.self_verify?.verdict,
        verdictReason: env.self_verify?.verdict_reason,
        idempotentNoop: true,
      };
    }

    // an earlier revision fix A — merge any pinned attributions from
    // auto-dispatched gates whose `recordWrappedToolId` callback fired
    // after `currentTaskObject` had switched to a newer task. The
    // map entry, if any, was written under the originating taskId.
    const pinnedExtras = this._pinnedWrappedToolIdsByTask.get(taskId) ?? [];
    const claimedTools = (() => {
      if (Array.isArray(claimedFromOpts)) {
        return Array.from(new Set([...claimedFromOpts, ...pinnedExtras])).sort();
      }
      // Sweeper fallback: claimed = evidenced ∪ pinned (no fabrication
      // detectable from agent text here, but a pinned auto-dispatch
      // attribution is a real claim we want sealed).
      return Array.from(new Set([
        ...env.execution.map(e => e.tool_call.tool_id),
        ...pinnedExtras,
      ])).sort();
    })();

    let sealed: EvidenceEnvelopeType | null = null;
    try {
      sealed = store.seal(envelopeId, claimedTools, {
        readOnlySafe: readOnlySafe === true,
        readIntentObserved: readIntentObserved === true,
        mutationIntentObservedUnwrapped: mutationIntentObservedUnwrapped === true,
        mutationIntentNoExecution: mutationIntentNoExecution === true,
        mutationToolsExpected: mutationToolsExpected === true,
      });
    } catch (e) {
      // make the swallowed seal error observable so an
      // unexpected throw inside `EnvelopeStore.seal` (e.g. malformed
      // envelope shape after rehydrate, persistence-hook re-entry)
      // shows up in event_log instead of leaving the envelope draft
      // forever.
      try {
        this.logEvent("evidence.envelope.seal.error", {
          envelope_id: envelopeId,
          task_id: taskId,
          source,
          error: e instanceof Error
            ? e.message.slice(0, 200)
            : String(e).slice(0, 200),
        });
      } catch { /* nested fail-soft */ }
      // drain the pinned per-task attribution entry on the
      // seal-throw path too. Previously the delete lived only on the
      // success path below, so a seal() throw leaked the entry until DO
      // eviction (hygiene report Agent 0 #4 / Agent 3 #3). `pinnedExtras`
      // was already read above, so draining here is safe.
      this._pinnedWrappedToolIdsByTask.delete(taskId);
      return { sealed: false, envelopeStatus: env.envelope_status, idempotentNoop: false };
    }
    if (!sealed) {
      // same drain for the null-seal early return.
      this._pinnedWrappedToolIdsByTask.delete(taskId);
      return { sealed: false, envelopeStatus: null, idempotentNoop: false };
    }

    try {
      this.logEvent(
        sealed.envelope_status === "sealed"
          ? "evidence.envelope.sealed.from_turn"
          : "evidence.envelope.failed.from_turn",
        {
          envelope_id: sealed.envelope_id,
          task_id: taskId,
          verdict: sealed.self_verify?.verdict,
          fabricated_tools: sealed.self_verify?.fabricated_tools,
          claimed_tools: claimedTools,
          evidenced_tools: sealed.self_verify?.evidenced_tools_dispatched,
          source,
        },
      );
    } catch { /* fail-soft */ }

    if (this._currentEnvelopeId === envelopeId) {
      this._currentEnvelopeId = null;
      this._currentTaskWrappedToolIds = [];
    }
    // an earlier revision fix A — clear the pinned per-task array now that we've
    // sealed. Always-delete (not conditional on having read non-empty)
    // so the map can't grow without bound across many DO turns.
    this._pinnedWrappedToolIdsByTask.delete(taskId);
    return {
      sealed: true,
      envelopeStatus: sealed.envelope_status,
      verdict: sealed.self_verify?.verdict,
      verdictReason: sealed.self_verify?.verdict_reason,
      idempotentNoop: false,
    };
  }

  // constants moved to `./agent/envelopeOps`. These
  // class-static aliases preserve `AgentThursdayAgent.ENVELOPE_SWEEPER_*`
  // references at L1606 (submitTask main chain, must not be touched
  // per an earlier revision §"非目标") and the sweeper call sites. See module
  // docstring in `envelopeOps.ts` for the numeric values and the
  // 198a / 206a rationale.
  //
  // `ENVELOPE_SNAPSHOT_RETENTION_LIMIT` no longer has an
  // alias here because the only consumer (`_cleanupOldEnvelopeSnapshots`)
  // moved into `envelopeOps.ts` and reads the module-local constant
  // directly.
  private static readonly ENVELOPE_SWEEPER_ALARM_DELAY_S = ENVELOPE_SWEEPER_ALARM_DELAY_S_VALUE;

  // scheduled-task tick cadence (registry DO only). Minute-level
  // is the finest granularity v1 needs (min schedule interval is 900s).
  private static readonly SCHEDULED_TASK_TICK_S = 60;

  /**
   * an earlier revision / sweeper-only ChannelHub fallback reply.
   * Called after a sweeper-driven seal (lazy or alarm) so the
   * Discord turn closes with `[envelope: ...]` even when submitTask's
   * saveMessages never returned. The ChannelHub side is idempotent
   * (it checks channel_outbox for an existing marker), so a
   * happy-path reply already on the wire is not duplicated.
   * Fail-soft — must not break the sweeper run.
   *
   * body lives in `./agent/envelopeFallbackReply` as
   * `enqueueChannelHubFallbackReplyFree`. The narrow Host
   * (`getChannelStub` + `logEvent`) keeps DO namespace resolution
   * at the composition root; the helper module never imports
   * `Env` / `ChannelHubAgent` / `AgentNamespace`.
   */
  private _envelopeFallbackReplyHost(): EnvelopeFallbackReplyHost {
    return {
      getChannelStub: async () => {
        const stub = await getAgentByName<Env, ChannelHubAgent>(
          this.env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
          CHANNEL_HUB_INSTANCE,
        );
        // Structural cast — ChannelHubAgent exposes the RPC via
        // proxy dispatch; the narrow `ChannelHubFallbackStubLike`
        // is the only surface the helper consumes. Same cast
        // pattern that was inline in the pre-Card-324 method body.
        return stub as unknown as ChannelHubFallbackStubLike;
      },
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  private async _enqueueChannelHubFallbackReply(
    taskId: string,
    envelopeId: string,
    verdictReason?: string,
  ): Promise<void> {
    return enqueueChannelHubFallbackReplyFree(
      this._envelopeFallbackReplyHost(),
      taskId,
      envelopeId,
      verdictReason,
    );
  }

  // envelope status views Host. Narrow on purpose: only
  // `sql` (for envelope_snapshots / event_log reads) and
  // `ensureEnvelopeStoreSync` (for in-memory union). Bodies live in
  // `./agent/envelopeStatusViews`. All four delegates below keep
  // the original `_<name>` private signature so call sites stay
  // verbatim — `_dashboardCoreHost()` and the direct `this.` reads
  // in status / approval-policy / dashboard derivations are
  // unaffected. an earlier revision invariants are
  // preserved in the helper module's docstrings.
  private _envelopeStatusViewsHost(): EnvelopeStatusViewsHost {
    return {
      sql: this.sql.bind(this) as EnvelopeStatusViewsHost["sql"],
      ensureEnvelopeStoreSync: () => this._ensureEnvelopeStoreSync(),
    };
  }

  private _getNewestEnvelopeForTask(taskId: string): EvidenceEnvelopeType | null {
    return getNewestEnvelopeForTaskView(this._envelopeStatusViewsHost(), taskId);
  }

  private _hasSealedPassEnvelopeForCurrentTask(taskId: string | null | undefined): boolean {
    return hasSealedPassEnvelopeForCurrentTaskView(this._envelopeStatusViewsHost(), taskId);
  }

  private _isHandledNoToolGateIntentFail(taskId: string | null | undefined): boolean {
    return isHandledNoToolGateIntentFailView(this._envelopeStatusViewsHost(), taskId);
  }

  private _getCurrentTaskFinalReply(taskId: string | null | undefined, maxLen = 200): string | null {
    return getCurrentTaskFinalReplyView(this._envelopeStatusViewsHost(), taskId, maxLen);
  }

  /**
   * flip task lifecycle out of `active` if it's still
   * stuck there, mirroring the line that submitTask's happy path
   * normally writes. Safe to call from a sweeper that woke up after
   * the original saveMessages never returned. Idempotent.
   *
   * terminal lifecycle is derived from the envelope's
   * verdict, not a blanket `failed`. `verdict=pass` → `completed`;
   * else → `failed`. This keeps task lifecycle and envelope verdict
   * aligned (no more "sealed pass envelope but task=failed").
   */
  private _finalizeTaskLifecycleIfNeeded(
    taskId: string,
    source: string,
    opts?: { envelopeVerdict?: "pass" | "partial" | "fail" | null },
  ): { changed: boolean; lifecycle: TaskLifecycle | null } {
    try {
      const latest = this.agentthursdayState;
      const cto = latest.currentTaskObject;
      if (!cto || cto.id !== taskId) return { changed: false, lifecycle: null };
      const currentLifecycle = cto.status as TaskLifecycle;
      // Only sweep if the task is still in an in-flight lifecycle
      // (`active` is the typical hang state). Don't touch terminal
      // states or `waiting` (intentional pause from an earlier revision).
      if (currentLifecycle !== "active") return { changed: false, lifecycle: currentLifecycle };
      const nextLifecycle: TaskLifecycle =
        opts?.envelopeVerdict === "pass" ? "completed" : "failed";
      const next = { ...cto, status: nextLifecycle, updatedAt: Date.now() };
      this.setAgentThursdayState({
        ...latest,
        status: "idle",
        currentTaskObject: next,
        updatedAt: Date.now(),
      });
      try {
        this.logEvent("task.lifecycle.finalized", {
          taskId,
          lifecycle: nextLifecycle,
          source,
          stomped: false,
          sweeper: true,
          envelope_verdict: opts?.envelopeVerdict ?? null,
        });
      } catch { /* fail-soft */ }
      return { changed: true, lifecycle: nextLifecycle };
    } catch {
      return { changed: false, lifecycle: null };
    }
  }

  // Host for the extracted envelope-sweeper orchestration
  // (`./agent/envelopeSweeperOps`). Wires the DO's sql + envelope store +
  // finalize/enqueue/schedule/logEvent so the sweeper bodies live outside
  // server.ts. Behavior is identical — this only lifts the I/O wiring.
  private _envelopeSweeperHost(): EnvelopeSweeperHost {
    return {
      sql: this.sql.bind(this) as EnvelopeStoreHost["sql"],
      ensureEnvelopeStore: () => this._ensureEnvelopeStoreSync(),
      finalizeTaskTurn: (opts) => this._finalizeTaskTurn(opts),
      finalizeTaskLifecycleIfNeeded: (taskId, source, opts) =>
        this._finalizeTaskLifecycleIfNeeded(taskId, source, opts),
      enqueueChannelHubFallbackReply: (taskId, envelopeId, verdictReason) =>
        this._enqueueChannelHubFallbackReply(taskId, envelopeId, verdictReason),
      logEvent: (eventType, payload) => this.logEvent(eventType, payload),
      schedule: (seconds, method, payload) => this.schedule(seconds, method as keyof this, payload),
    };
  }

  /**
   * lazy sweeper. Scans `envelope_snapshots` for drafts
   * older than `thresholdMs` and finalizes each via the shared
   * `_finalizeTaskTurn` (idempotent). Called from `/cli/status` so
   * verifier traffic naturally heals stuck demos without waiting on
   * the alarm backstop. The threshold protects in-flight healthy
   * turns from premature seal.
   *
   * Returns a summary so callers can log + assert in tests/smoke.
   * Fail-soft per row — a single broken envelope must not stop the
   * sweep of the rest.
   */
  @callable()
  async sweepStaleDraftEnvelopes(input?: { thresholdMs?: number; source?: string }): Promise<{
    scanned: number;
    finalized: Array<{ envelope_id: string; task_id: string; status: string; verdict: string | null; idempotent: boolean; readOnlySafe: boolean }>;
    threshold_ms: number;
    read_only_threshold_ms: number;
    source: string;
  }> {
    return sweepStaleDraftEnvelopesFree(this._envelopeSweeperHost(), input);
  }

  /**
   * alarm callback, scheduled by submitTask after
   * createDraft via `this.schedule(SECONDS, "envelopeSweeperBackstop", ...)`.
   * Fires only for the specific envelope/task captured at schedule
   * time so we don't accidentally finalize healthy concurrent turns.
   * `_finalizeTaskTurn` is idempotent so a happy-path finalize that
   * already ran is a no-op here.
   *
   * Method name has no leading underscore because the agents-SDK
   * scheduler resolves `this[callbackName]` and rejects unknown
   * properties; keep it public for the framework's lookup but treat
   * it as internal (not part of the agent-facing API surface).
   */
  async envelopeSweeperBackstop(
    payload: { envelopeId: string; taskId: string; extensions?: number } | undefined,
    _schedule: unknown,
  ): Promise<void> {
    return envelopeSweeperBackstopFree(this._envelopeSweeperHost(), payload, _schedule);
  }

  // `_buildBoundedEnvelopeSnapshot` /
  // `_cleanupOldEnvelopeSnapshots` moved to `./agent/envelopeOps` as
  // `buildBoundedEnvelopeSnapshotFree` / `cleanupOldEnvelopeSnapshotsFree`.
  // `EnvelopeStoreHost.onMutate` calls them directly; no thin delegate
  // remains here. Snapshot schema, bounded payload semantics (8KB head
  // + 8KB tail + `truncated:true`), terminal-only cleanup trigger, and
  // retention=500 are preserved byte-equal.

  // devShellEnvelope* CRUD callables. Bodies moved to
  // `src/agent/envelopeOps.ts` free functions. The agent surface keeps
  // identical callable name/signature/return shape; each method is a
  // thin delegate through `_envelopeCrudHost()`. Event names, error
  // reasons, fabricated_tools computation, and the live+snapshot list
  // dedupe semantics are unchanged — confirmed by `git diff`.
  @callable()
  async devShellEnvelopeStart(input: {
    task_id: string;
    intent_source: "task_card" | "plan_step" | "human_directive" | "subagent_delegation";
    intent_source_ref: string;
    intent_declared_goal: string;
    intent_expected_output?: Array<{ type: string; description: string; acceptance_check?: string }>;
    intent_workflow_pattern?: string;
    traceId?: string | null;
  }): Promise<unknown> {
    return devShellEnvelopeStartFree(this._envelopeCrudHost(), { ...input, skillset_id: this.agentthursdayState.effectiveSkillsetIds?.[0] });
  }

  @callable()
  async devShellEnvelopeAddGate(input: {
    envelope_id: string;
    target: string;
    traceId?: string | null;
  }): Promise<unknown> {
    return devShellEnvelopeAddGateFree(this._envelopeCrudHost(), input);
  }

  @callable()
  async devShellEnvelopeAddTool(input: {
    envelope_id: string;
    tool_id: string;
    input: Record<string, unknown>;
    traceId?: string | null;
  }): Promise<unknown> {
    return devShellEnvelopeAddToolFree(this._envelopeCrudHost(), input);
  }

  @callable()
  async devShellEnvelopeSeal(input: {
    envelope_id: string;
    claimed_tools?: string[];
    traceId?: string | null;
  }): Promise<unknown> {
    return devShellEnvelopeSealFree(this._envelopeCrudHost(), input);
  }

  @callable()
  async devShellEnvelopeGet(input: { envelope_id: string }): Promise<unknown> {
    return devShellEnvelopeGetFree(this._envelopeCrudHost(), input);
  }

  @callable()
  async devShellEnvelopeList(): Promise<unknown> {
    return devShellEnvelopeListFree(this._envelopeCrudHost());
  }

  @callable()
  async devShellEnvelopeListByTask(input: { task_id: string }): Promise<unknown> {
    return devShellEnvelopeListByTaskFree(this._envelopeCrudHost(), input);
  }

  @callable()
  async devShellEnvelopeGetLatestTerminal(): Promise<unknown> {
    return devShellEnvelopeGetLatestTerminalFree(this._envelopeCrudHost());
  }

  /**
   * Developer Shell repo patch/write/delete dispatcher.
   * body moved to `devShellOps.devShellWriteDispatchFree`.
   */
  @callable()
  async devShellWriteDispatch(input: {
    tool_id: string;
    input: Record<string, unknown>;
    traceId?: string | null;
    // approval payload required for tier-≥4 tools. The raw
    // `token` rides through this DO callable in-memory only, is forwarded
    // to ChannelHub.consumeApprovalToken, and is NEVER logged / persisted
    // / echoed in any event payload or response.
    approval?: { token_id?: unknown; token?: unknown };
  }): Promise<unknown> {
    return devShellWriteDispatchFree(this._devShellWriteHost(), input);
  }

  @callable()
  inspectContext(input?: { lastN?: number }): ContextInspectResult {
    return inspectContextFree(this._contextReadHost(), input);
  }

  // ── model resolution helper ──────────────────────────
  // Two persisted slots and one in-memory observation feed three semantic
  // layers (configured / lastObserved / effective) and two consumer-side
  // selections (budgetModel / awarenessModel). The four-layer split
  // exists so a future routing policy can land without forking each
  // consumer's own ad-hoc fallback chain.
  //
  //   configured   — `agentthursdayState.modelProfile` (set by defaults +
  //                  `setModelProfile()`; user-intended).
  //   lastObserved — `_lastStepModel` (in-memory) ?? `agentthursdayState.lastObservedModel`
  //                  (persisted by onStepFinish so it survives DO
  //                  hibernation / isolate resets).
  //   effective    — v1: `lastObserved ?? configured`. Future routing
  //                  policy (mid-conversation switch, A/B routing,
  //                  alias resolution) replaces this single line.
  //   budgetModel  — context window / compact thresholds. CONSERVATIVE
  //                  on configured/observed mismatch: when both exist
  //                  and resolve to different registry entries, we
  //                  pick the SMALLER window. Rationale: a mid-task
  //                  switch from a big-window to a small-window model
  //                  must not keep using the older budget, otherwise
  //                  autoCompact won't fire in time.
  //   awarenessModel — `intelligence.signal` / `getProfileAwareness` /
  //                  SOUL profile awareness. v1: prefer `lastObserved`
  //                  so awareness reflects the actual model the user
  //                  just talked to; fall back to `configured`.
  //
  // Invariants (an earlier revision §1):
  //   - `setModelProfile()` only ever writes `agentthursdayState.modelProfile`.
  //   - `onStepFinish()` only ever writes `agentthursdayState.lastObservedModel`.
  //   - The two state slots stay distinct; no path collapses them.

  @callable()
  async resetContext(input?: { reason?: string | null; routedContextId?: string }): Promise<ContextResetResult> {
    return resetContextFree(this._contextWriteHost(), input);
  }

  // ── M7.7v3 an earlier revision — Context history + multi-DO routing ──────
  // an earlier revision introduced `context_history` and an audit-only newContext.
  // an earlier revision promotes the contextId from metadata to a real DO routing
  // key: subsequent /cli/* requests carry an `X-AgentThursday-Context-Id` header
  // so each context owns its own DO. The "active" pointer lives in the
  // `context_active` single-row table on the REGISTRY DO (DEMO_INSTANCE)
  // and is the source of truth for "which DO does a header-less request
  // route to."
  //
  // Bootstrap rule (v2): the very first `context_history` row uses
  // `DEMO_INSTANCE` as its contextId so header-less fallback resolves to
  // the same DO that owns the registry tables. v1 deployments that
  // already have a `ctx_<uuid>` bootstrap row keep it — those v1 rows
  // are read-only audit history (their raw transcripts were cleared
  // during the v1 reset-style fallback and cannot be recovered).

  private _contextPointerHost(): ContextPointerHost {
    return {
      sql: this.sql.bind(this) as ContextPointerHost["sql"],
    };
  }

  // narrow Host for memoryOps read-side helpers. Bundles
  // the four capabilities the extracted free functions need (sql,
  // logEvent, getLastAssistantText, getMessages). Composed fresh per
  // call so binding identity stays trivial.
  private _memoryReadHost(): MemoryReadHost {
    return {
      sql: this.sql.bind(this) as MemoryReadHost["sql"],
      logEvent: (type, payload) => this.logEvent(type, payload),
      getLastAssistantText: (maxLen) => this.getLastAssistantText(maxLen),
      getMessages: this.getMessages.bind(this),
    };
  }

  // narrow write host. Only `sql` + `logEvent`; the read
  // accessors are deliberately omitted so the write callables can't
  // reach into the message store / archive.
  private _memoryWriteHost(): MemoryWriteHost {
    return {
      sql: this.sql.bind(this) as MemoryWriteHost["sql"],
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  // narrow Host for `getDashboardCoreFree`. Eight
  // capabilities, never the full agent: sql + state + cli session +
  // four envelope/marker accessors + flat instance name. Composed
  // fresh per call so binding identity stays trivial.
  private _dashboardCoreHost(): DashboardCoreHost {
    return {
      sql: this.sql.bind(this) as DashboardCoreHost["sql"],
      getSafeState: () => this.getSafeState(),
      getCliSession: () => this.getCliSession(),
      getNewestEnvelopeForTask: (taskId) => this._getNewestEnvelopeForTask(taskId),
      getCurrentTaskFinalReply: (taskId, maxLen) => this._getCurrentTaskFinalReply(taskId, maxLen),
      hasSealedPassEnvelopeForCurrentTask: (taskId) => this._hasSealedPassEnvelopeForCurrentTask(taskId),
      isHandledNoToolGateIntentFail: (taskId) => this._isHandledNoToolGateIntentFail(taskId),
      instanceName: this.name,
    };
  }

  // read-side Host wraps pointer Host with the agent-instance
  // accessors the resolver / budget / inspect surfaces consume.
  private _contextReadHost(): ContextReadHost {
    return {
      sql: this.sql.bind(this) as ContextReadHost["sql"],
      getAgentThursdayState: () => this.agentthursdayState,
      getLastStepModel: () => this._lastStepModel,
      getMessages: this.getMessages.bind(this),
      getSessionTokens: () => ({ ...this._sessionTok }),
      getTaskTokens: () => ({ ...this._taskTok }),
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  // write-side Host adds lifecycle mutation + archive /
  // compaction capabilities. Self-RPC and namespace access stay at the
  // composition root via these wrappers (per preflight §69).
  private _contextWriteHost(): ContextWriteHost {
    return {
      ...this._contextReadHost(),
      isRegistry: (contextId) => contextId === DEMO_INSTANCE,
      resetTurnState: this.resetTurnState.bind(this),
      clearMessages: this.clearMessages.bind(this),
      resetSessionTokens: () => {
        this._sessionTok = { in: 0, out: 0, total: 0, hasData: false };
      },
      resetTaskTokens: () => {
        this._taskTok = { taskId: this._taskTok.taskId, in: 0, out: 0, total: 0, cached: 0 };
      },
      writeArchiveFlushLocal: async (input) => {
        // Track A: stamp THIS DO's own owner on the local archive
        // write so the agent's own owner-scoped `conversation_search` matches
        // its rows. The pushing DO is THIS per-agent DO (`this.name`), so
        // resolve its own owner. Best-effort (admin sentinel on unresolved): the
        // read filter is the security boundary, a mis-stamp only hides a row
        // from its own owner. Registry/operator (DEMO_INSTANCE) → admin → the
        // same admin/unscoped behavior it always had.
        const ownerUserId = await this._resolveOwnArchiveOwnerId();
        return this._writeArchiveFlush({ ...input, ownerUserId });
      },
      drainForArchiveRemote: async (contextId) => {
        const stub = await getAgentThursdayStubByName(this.env, contextId);
        return stub.drainForArchive();
      },
      compactPlan: (input) => this.compactPlan(input),
      applyCompactPlan: (input) => this.applyCompactPlan(input),
      getPendingToolApproval: () => this.getPendingToolApproval(),
      getSafeState: () => this.getSafeState(),
    };
  }

  private _archiveWriteHost(): ArchiveWriteHost {
    return {
      sql: this.sql.bind(this) as ArchiveWriteHost["sql"],
      logEvent: (type, payload) => this.logEvent(type, payload),
      getMessages: this.getMessages.bind(this),
      ensureActiveContext: this.ensureActiveContext.bind(this),
    };
  }

  private _archiveSearchHost(): ArchiveSearchHost {
    return {
      sql: this.sql.bind(this) as ArchiveSearchHost["sql"],
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  // ── A1 Phase 2 M1: operator archive migration ────────────
  // COPY-never-move machinery: the registry DO serves ordered batches of its
  // legacy operator archive; the operator DO ingests them idempotently
  // (ON CONFLICT(chunk_id) DO NOTHING); both sides expose the same reconcile
  // summary so the inspect driver can compare row counts / per-owner bytes.
  // Operator-only surface — reachable only through the secret-gated
  // /api/inspect driver; no identity param by design (same class as the
  // other infra @callables).

  private _archiveMigrationHost(): ArchiveMigrationHost {
    return { sql: this.sql.bind(this) as ArchiveMigrationHost["sql"] };
  }

  @callable()
  readOperatorArchiveBatch(input?: { after_chunk_id?: string | null; limit?: number }): ArchiveChunkRow[] {
    return readArchiveChunkBatchRows(
      this._archiveMigrationHost(),
      input?.after_chunk_id ?? null,
      input?.limit ?? 100,
    );
  }

  @callable()
  ingestOperatorArchiveBatch(input: { chunks: ArchiveChunkRow[] }): { received: number } {
    const chunks = Array.isArray(input?.chunks) ? input.chunks : [];
    const result = ingestArchiveChunkRows(this._archiveMigrationHost(), chunks);
    this.logEvent("operator_archive.migration.ingest", { received: result.received });
    return result;
  }

  @callable()
  getArchiveReconcileSummary(): ArchiveReconcileSummary {
    return archiveReconcileSummaryRows(this._archiveMigrationHost());
  }

  private _archiveInspectHost(): ArchiveInspectHost {
    return {
      sql: this.sql.bind(this) as ArchiveInspectHost["sql"],
    };
  }

  private _compactionReadHost(): CompactionReadHost {
    return {
      getMessages: this.getMessages.bind(this),
      getCompactions: () => this.session.getCompactions(),
      logEvent: (type, payload) => this.logEvent(type, payload),
    };
  }

  private _compactionWriteHost(): CompactionWriteHost {
    return {
      ...this._compactionReadHost(),
      addCompaction: (summary, fromMessageId, toMessageId) =>
        this.session.addCompaction(summary, fromMessageId, toMessageId),
      getHistoryLengthSafe: () => {
        try {
          return this.session.getHistory().length;
        } catch {
          return null;
        }
      },
    };
  }

  private ensureActiveContext(): { context_id: string; reason: string | null; created_at: number } {
    return ensureActiveContextFree(this._contextPointerHost());
  }

  @callable()
  getActiveContextId(): ActiveContext {
    return getActiveContextIdFree(this._contextPointerHost());
  }

  @callable()
  listContextHistory(): ContextHistoryList {
    return listContextHistoryFree(this._contextPointerHost());
  }

  @callable()
  async newContext(input?: { reason?: string | null }): Promise<NewContextResult> {
    return newContextFree(this._contextWriteHost(), input);
  }

  @callable()
  switchContext(input: { contextId: string; reason?: string | null }): SwitchContextResult {
    return switchContextFree(this._contextWriteHost(), input);
  }

  // register a context id in `context_history` so switchContext
  // accepts it (the operator routing cutover targets OPERATOR_INSTANCE, which
  // has no history row of its own). Idempotent; inspect-driver-only surface.
  @callable()
  ensureContextHistoryRow(input: { contextId: string; reason?: string | null }): { ok: true; contextId: string } {
    return ensureContextHistoryRowFree(this._contextWriteHost(), input);
  }

  // ── Conversation Archive ingestion ────────────────────
  // Two callables:
  //   - `drainForArchive` runs on a per-context DO; returns its full
  //     sanitized message log (no `lastN` cap). Used by `newContext` on
  //     the registry to pull the closing context's chunks.
  //   - `archiveChunks` runs on the registry DO; writes pushed chunks
  //     into the canonical `conversation_archive` table + an audit row
  //     in `conversation_archive_flushes`. Used by `resetContext` on
  //     per-context DOs to push their chunks before clearMessages.

  @callable()
  drainForArchive(): DrainForArchiveResult {
    return drainForArchiveFree(this._archiveWriteHost());
  }

  @callable()
  archiveChunks(input: ArchiveChunksInput): ArchiveFlushResult {
    return archiveChunksFree(this._archiveWriteHost(), input);
  }

  // ── `conversation_search` local tool + audit ─────────
  // Searches the registry's `conversation_archive` (canonical source).
  // Default behavior: cross-context (no `contextId` filter) — this is
  // the central product proof of M7.8: from context B, the agent can
  // find archived context A material without switching back. Hits are
  // capped (topK ≤ 10, default 3; snippet ≤ 2000 char hard cap with
  // 300-char default) so search never becomes a backdoor for unbounded
  // prompt expansion.
  //
  // Implementation: SQLite LIKE over `index_text` (boilerplate-stripped
  // by an earlier revision). Snippets come from `text` (audit-quality original)
  // when index_text matches but `text` is more readable. Ranking is
  // deterministic: most recent archivedAt first, ties broken by
  // chunk_id. an earlier revision will aggregate the retrieval log to score
  // memory candidates; an earlier revision may swap LIKE for AI Search.

  @callable()
  conversationSearch(input: ConversationSearchInput, scopeOwnerId?: string): ConversationSearchResult {
    // Multi-tenancy — `scopeOwnerId` is resolved by the caller from its OWN
    // owner (fail-closed before this RPC). undefined = admin (unfiltered);
    // a string = a scoped tenant (own archives only).
    return conversationSearchFree(this._archiveSearchHost(), input, scopeOwnerId);
  }

  // operator backfill driver: advance the FTS backfill up to
  // `batches` batches in one call (big archives would otherwise converge
  // one batch per search). Read-mostly; safe to call repeatedly.
  @callable()
  ftsBackfillAdvance(batches?: number): { ready: boolean; processed: number; watermark: number; maxRowid: number } {
    const n = Math.max(1, Math.min(50, Math.floor(batches ?? 10)));
    const host = this._archiveSearchHost();
    let last = advanceFtsBackfill(host);
    let processed = last.processed;
    for (let i = 1; i < n && !last.ready && last.processed > 0; i++) {
      last = advanceFtsBackfill(host);
      processed += last.processed;
    }
    return { ready: last.ready, processed, watermark: last.watermark, maxRowid: last.maxRowid };
  }

  // an earlier revision Phase 0 — is FTS5 available in this DO's SQLite build?
  // Permanent read-only diagnostic (creates + drops a scratch virtual
  // table); the FTS conversation-search path is gated on this working.
  @callable()
  fts5Probe(): { supported: boolean; match_ok: boolean; error: string | null } {
    try {
      this.sql`CREATE VIRTUAL TABLE IF NOT EXISTS fts5_probe_scratch USING fts5(seg)`;
      this.sql`INSERT INTO fts5_probe_scratch (seg) VALUES (${"你 好 世 界 hello world"})`;
      const rows = this.sql<{ seg: string }>`
        SELECT seg FROM fts5_probe_scratch WHERE fts5_probe_scratch MATCH ${"世"}
      `;
      this.sql`DROP TABLE fts5_probe_scratch`;
      return { supported: true, match_ok: rows.length === 1, error: null };
    } catch (e) {
      try { this.sql`DROP TABLE IF EXISTS fts5_probe_scratch`; } catch { /* scratch cleanup */ }
      return { supported: false, match_ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── archive / retrieval Inspect surface ──────────────
  // Read-only summary the operator inspects to see what the archive
  // pipeline is doing. Hard payload caps so the default response never
  // includes full archive text — Inspect deep-reads (read-by-ref) live
  // in a future card if needed. Registry-only because the canonical
  // archive lives on DEMO_INSTANCE.

  @callable()
  getArchiveInspectSummary(input?: { recentLimit?: number; perContextLimit?: number }): ArchiveInspectSummary {
    return getArchiveInspectSummaryFree(this._archiveInspectHost(), input);
  }

  // ── Continuous Context Hygiene loop v1 ───────────────
  // Manual-trigger hygiene check that bridges an earlier revision archive +
  // an earlier revision plan/apply with explicit risk gates. Auto-apply MUST go
  // through `applyCompactPlan` so an earlier revision hard-anchor + synthetic +
  // overlap pre-flight is automatic. Risk gates that fire produce a
  // proposal-only outcome; the operator sees the would-be plan in
  // the audit but no compaction happens.
  //
  // V1 trigger posture: manual-trigger only. The schema accepts
  // `scheduled` / `pressure-threshold` so a future card can flip
  // without a schema break, but this v1 rejects any trigger other
  // than `manual-check` to keep auto-loops opt-in.

  @callable()
  async runContextHygiene(input?: HygieneRunInput): Promise<HygieneRunResult> {
    return runContextHygieneFree(this._contextWriteHost(), input);
  }

  // Internal helper used by both `archiveChunks` (RPC entry) and
  // `newContext` (when it has chunks pulled from a remote DO and wants
  // to write them to the local archive table without a self-RPC hop).
  // Always idempotent on duplicate flush attempts via flush_id (a
  // freshly-generated UUID per call), and always emits a row in
  // `conversation_archive_flushes` — even on `failed` and `skipped`
  // statuses — so failures are observable without needing to scan
  // event_log.
  private _writeArchiveFlush(input: {
    contextId: string;
    trigger: ArchiveTrigger | string;
    chunks: readonly ArchiveChunkInput[];
    reason: string | null;
    // Track A: owner stamped on each archived chunk (resolved by the
    // `writeArchiveFlushLocal` host from THIS DO's own owner). Omitted → admin
    // sentinel (writeArchiveFlushFree default) for legacy sync callers.
    ownerUserId?: string | null;
  }): ArchiveFlushResult {
    return writeArchiveFlushFree(this._archiveWriteHost(), input);
  }

  // ── Auditable compact MVP ────────────────────────────
  // Replaces a contiguous slice of transient messages with a deterministic
  // (no-LLM) summary overlay via `Session.addCompaction`. The SDK keeps
  // the underlying message tree intact; `getHistory()` substitutes the
  // summary in place of the range when the model loop reads history. We
  // log requested + completed/failed event_log rows for full audit
  // trail. Durable state (memory, checkpoints, workspace, event_log,
  // task metadata, model profile) is untouched — `addCompaction` only
  // writes to the session storage's compactions table.
  //
  // Defaults: keep the most-recent `keepRecent=5` messages outside the
  // compaction range; `lastN` (the number of OLDEST messages to fold
  // into the summary) defaults to `total - keepRecent`. The user can
  // pass an explicit `lastN` to compact a smaller prefix. We refuse if
  // `lastN < 2` or `lastN > total - 1` — compacting fewer than 2 or
  // wiping the entire log buys nothing.

  @callable()
  compactContext(input?: { reason?: string | null; lastN?: number; keepRecent?: number }): CompactContextResult {
    return compactContextFree(this._compactionWriteHost(), input);
  }

  @callable()
  listCompactions(): CompactionsList {
    return listCompactionsFree(this._compactionReadHost());
  }

  // ── M7.7 v2 Context snapshot for anchor-aware planning ────
  // Read-only sanitized projection of `getMessages()` + `getCompactions()`
  // intended as a stable substrate for an earlier revision's anchor classifier and
  // an earlier revision's compact planner. No audit row (cheap polling). Synthetic
  // compaction nodes are flagged so callers can refuse to plan a range
  // that starts on or contains one (an earlier revision spike found the SDK silently
  // stores dead records when this guard is missing).

  @callable()
  inspectContextSnapshot(input?: { lastN?: number }): ContextSnapshotViewModel {
    return inspectContextSnapshotFree(this._compactionReadHost(), input);
  }

  // ── M7.7 v2 Context anchor classifier ─────────────────────
  // Deterministic per-message anchor labels (no LLM, no audit row). Reuses
  // the an earlier revision snapshot as input substrate so SOUL/system/tool payloads
  // stay sanitized. an earlier revision will read this to refuse compact ranges that
  // contain anchors.

  @callable()
  classifyContextAnchors(input?: { lastN?: number; firstK?: number }): ContextAnchorsResult {
    return classifyContextAnchorsFree(this._compactionReadHost(), input);
  }

  // ── M7.7 v2 Compact plan / apply split ────────────────────
  // `compactPlan` produces a read-only ID-based dry-run proposal built from
  // a fresh an earlier revision snapshot + an earlier revision anchors. `applyCompactPlan` takes
  // a plan back and re-runs all pre-flight checks against a fresh snapshot
  // before each `addCompaction` call. No LLM summaries, no auto-compaction,
  // no durable mutation. Existing `compactContext(lastN)` remains the
  // backward-compatible primitive path for an earlier revision callers.

  @callable()
  compactPlan(input?: CompactPlanInput): CompactPlanResult {
    return compactPlanFree(this._compactionReadHost(), input);
  }

  @callable()
  async applyCompactPlan(input: {
    plan: CompactPlanResult;
    // opt-in semantic summary advisor. When true, the
    // optional model-assisted layer runs after the deterministic summary
    // is built. If no client is configured (current state), the
    // advisor records a fallback audit row and the deterministic summary
    // is used. Either way `applyCompactPlan` never blocks compaction
    // on advisor failure.
    semanticAdvisor?: boolean;
    semanticAdvisorTrigger?: "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";
  }): Promise<CompactPlanApplyResult> {
    return applyCompactPlanFree(this._compactionWriteHost(), input);
  }

  @callable()
  getProfileAwareness() {
    // derive awareness from the resolver's `awarenessModel`,
    // which prefers the most recently observed inference model over
    // the persisted-but-stale `modelProfile`. Fallback to the configured
    // profile when no observation exists yet (cold isolate, fresh DO).
    // resolver moved to `./agent/contextOps`; call the free
    // function directly so this consumer stops depending on the moved
    // private method body.
    const resolution = resolveCurrentModelProfileFree(this._contextReadHost());
    const aw = resolution.awarenessModel;
    const mp: ModelProfile = aw && aw.modelId
      ? { provider: aw.provider ?? this.agentthursdayState.modelProfile.provider, model: aw.modelId }
      : this.agentthursdayState.modelProfile;
    return getProfileAwareness(mp);
  }

  @callable()
  getEffectiveIntelligenceSignal() {
    // same selection policy as `getProfileAwareness()`:
    // route through the resolver so `intelligence.signal` reflects the
    // model the agent is actually talking to right now, not the stale
    // configured placeholder. Replaces the old `/demo/status` site
    // that computed signal from `status.modelProfile` directly.
    // direct free-function call (see consumer rewire above).
    const resolution = resolveCurrentModelProfileFree(this._contextReadHost());
    const aw = resolution.awarenessModel;
    const mp: ModelProfile = aw && aw.modelId
      ? { provider: aw.provider ?? this.agentthursdayState.modelProfile.provider, model: aw.modelId }
      : this.agentthursdayState.modelProfile;
    return getIntelligenceSignal(mp);
  }

  @callable()
  getDeveloperLoopReview(): DeveloperLoopReview {
    const s = this.getSafeState();
    const lar = s.lastActionResult;
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;

    // Task-scoped artifact counts: only consider artifacts created after current task started
    const ckptCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const noteCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const appliedMut = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const pendingMut = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    // an earlier revision — newest envelope for current task counts as
    // both artifact and reviewer-accepted execution result, but ONLY
    // when the newest envelope itself is sealed && verdict=pass. A
    // freshly-failed current-turn envelope must NOT inherit acceptance
    // from a same-task historical pass envelope (the 199-FAIL bug).
    const envelopeAccepted = this._hasSealedPassEnvelopeForCurrentTask(s.currentTaskObject?.id);
    // orthogonal "handled no-tool gate-intent fail" signal.
    // Treats a terminal failed/fail envelope (an earlier revision body replaced)
    // as a deliverable for readiness purposes, without claiming pass.
    const handledNoToolFail = this._isHandledNoToolGateIntentFail(s.currentTaskObject?.id);
    const hasArtifact = envelopeAccepted || handledNoToolFail || ckptCount > 0 || noteCount > 0 || appliedMut > 0;

    const reviewerAccepted = envelopeAccepted || handledNoToolFail || lar?.outcome === "success";
    const noBlockers = !s.waitingForHuman && !(s.currentObstacle?.blocked);
    const gateOpen = reviewerAccepted && hasArtifact && noBlockers;

    const activeInterventionCount = [
      s.waitingForHuman,
      !!(s.currentObstacle?.blocked),
      pendingMut > 0,
      !gateOpen,
    ].filter(Boolean).length;

    const readyForNextRound = gateOpen && activeInterventionCount === 0;

    const taskLifecycle = s.currentTaskObject?.status ?? null;

    let stage: DeveloperLoopReview["stage"];
    let summary: string;
    if (!s.currentTaskObject) {
      stage = "no-task";
      summary = "尚未建立 task object。请先运行 doWork。";
    } else if (!lar && !envelopeAccepted && !handledNoToolFail) {
      stage = "task-active";
      summary = `task [${taskLifecycle}] 已建立，等待 executor 完成第一次执行。`;
    } else if (!gateOpen) {
      stage = "awaiting-deliverable";
      summary = `task [${taskLifecycle}] 执行中，deliverable 未满足（${!hasArtifact ? "无 artifact" : (lar && lar.outcome !== "success") ? `outcome: ${lar.outcome}` : "有阻塞"}）。`;
    } else if (activeInterventionCount > 0) {
      stage = "gate-open";
      summary = `gate 已开放，但存在 ${activeInterventionCount} 个干预点（pending mutations 等），需先 confirm 再进入下一轮。`;
    } else {
      stage = "loop-ready";
      summary = `developer loop 就绪：task [${taskLifecycle}]，deliverable confirmed，gate open，无干预点，可进入下一轮。`;
    }

    // bind `[last msg]` to the current task's finalized
    // reply, not the global last assistant text. The previous
    // `getLastAssistantText(200)` call read the SDK message store's
    // last assistant message, which can be from a prior task whenever
    // the current task produced little/no fresh assistant text
    // (e.g. a an earlier revision server-side autodispatch round whose
    // user-visible reply lives in `task.reply.finalized.replyText`
    // rather than in a fresh assistant message). When no finalized
    // reply exists for the current task yet, omit the line entirely
    // — surfacing a previous-task message would mislead readiness.
    const lastMsg = this._getCurrentTaskFinalReply(s.currentTaskObject?.id ?? null, 200);
    if (lastMsg) summary = `${summary}\n[last msg] ${lastMsg}`;

    return { stage, taskLifecycle, reviewerAccepted, gateOpen, activeInterventionCount, readyForNextRound, summary };
  }

  @callable()
  getCliSession(): CliSession {
    const s = this.getSafeState();

    // Inline loop stage derivation (mirrors getDeveloperLoopReview)
    const lar = s.lastActionResult;
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;
    const ckptCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const noteCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const appliedMut = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const pendingMut = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    // an earlier revision — newest envelope binding (see helper docstring).
    const envelopeAccepted = this._hasSealedPassEnvelopeForCurrentTask(s.currentTaskObject?.id);
    // see _isHandledNoToolGateIntentFail docstring.
    const handledNoToolFail = this._isHandledNoToolGateIntentFail(s.currentTaskObject?.id);
    const hasArtifact = envelopeAccepted || handledNoToolFail || ckptCount > 0 || noteCount > 0 || appliedMut > 0;
    const noBlockers = !s.waitingForHuman && !(s.currentObstacle?.blocked);
    const gateOpen = (envelopeAccepted || handledNoToolFail || lar?.outcome === "success") && hasArtifact && noBlockers;
    const activeInterventionCount = [s.waitingForHuman, !!(s.currentObstacle?.blocked), pendingMut > 0, !gateOpen].filter(Boolean).length;
    const readyForNextRound = gateOpen && activeInterventionCount === 0;
    const autoContinue = readyForNextRound;

    let loopStage: string;
    if (!s.currentTaskObject) loopStage = "no-task";
    else if (!lar && !envelopeAccepted && !handledNoToolFail) loopStage = "task-active";
    else if (!gateOpen) loopStage = "awaiting-deliverable";
    else if (activeInterventionCount > 0) loopStage = "gate-open";
    else loopStage = "loop-ready";

    let suggestedNextCommand: string | null;
    if (loopStage === "no-task") suggestedNextCommand = "submit";
    else if (s.waitingForHuman || pendingMut > 0) suggestedNextCommand = "approve";
    else if (loopStage === "awaiting-deliverable" || loopStage === "task-active") suggestedNextCommand = "continue";
    else if (loopStage === "gate-open") suggestedNextCommand = "approve";
    else suggestedNextCommand = "continue";

    // `instanceName` and `sessionId` self-report the
    // actual DO this RPC landed on, not a hardcoded DEMO. The Agent
    // base class exposes `this.name` as the runtime instance name
    // (set when the worker resolved `getAgentByName(ns, name)`). Pre-
    // 149e1a both fields were `DEMO_INSTANCE` regardless of routing,
    // so the verifier saw `activeContextId === ctx_NEW` (correct
    // canonical pointer) but `session.instanceName === DEMO` (lying
    // self-report) on the very same /api/workspace call. Same fix
    // for sessionId fallback so a fresh DO without a current task
    // still reports its own DO name rather than DEMO.
    return {
      sessionId: s.currentTaskObject?.id ?? this.name,
      instanceName: this.name,
      taskId: s.currentTaskObject?.id ?? null,
      taskTitle: s.currentTaskObject?.title ?? s.currentTask,
      taskLifecycle: s.currentTaskObject?.status ?? null,
      loopStage,
      readyForNextRound,
      autoContinue,
      suggestedNextCommand,
      availableCommands: CLI_COMMANDS,
    };
  }

  /**
   * daily dogfood observability dashboard v1 (DO-side core).
   *
   * Read-only aggregator over the M8.4 readiness/marker/envelope
   * derivations. Keeps the M8.4 contract intact: this method only
   * **reads** existing helpers (`getCliSession`, `_getNewestEnvelopeForTask`,
   * `_getCurrentTaskFinalReply`, `_hasSealedPassEnvelopeForCurrentTask`,
   * `_isHandledNoToolGateIntentFail`) and returns a flat snapshot. No
   * persistence, no semantic change to status / readiness / marker /
   * outbox.
   *
   * Outbox lookup is intentionally NOT done here — that requires a
   * cross-DO call to ChannelHub which the worker route does. The
   * dashboard's outbox-derived drift flags (`outbox_missing`,
   * `outbox_provider_error`) are therefore appended at the route layer.
   *
   * Drift-flag whitelist (closed set, never returns flags outside this
   * list — defence against future drift in this method becoming a
   * leak vector):
   *   - ready_false_after_handled_fail
   *   - marker_missing
   *   - envelope_orphan
   *   - marker_mismatch
   *   (route adds: outbox_missing, outbox_provider_error,
   *   patch_apply_outbox_unknown)
   *
   * Never returns secrets / raw payload_json / provider tokens — the
   * shape is defined here, no caller-controlled fields pass through.
   */
  @callable()
  getDashboardCore(): {
    current_task: {
      task_id: string | null;
      task_lifecycle: string | null;
      loop_stage: string;
      ready_for_next_round: boolean;
      active_intervention_count: number;
      last_final_reply_marker: string | null;
    };
    latest_envelope: {
      envelope_id: string;
      task_id: string;
      envelope_status: string;
      verdict: string | null;
      started_at: string;
    } | null;
    drift_flags: string[];
    instance_name: string;
  } {
    // body extracted to `./agent/dashboardOps.getDashboardCoreFree`.
    // Decorator + RPC return type preserved here; payload shape, drift
    // flag names + push order, SQL semantics, and fail-soft behaviour
    // are byte-equivalent (see Host docstring).
    return getDashboardCoreFree(this._dashboardCoreHost());
  }

  @callable()
  getDeliverableGate(): DeliverableConvergence {
    const s = this.getSafeState();
    const lar = s.lastActionResult;
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;

    const ckptCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const noteCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const mutCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    // an earlier revision — newest envelope binding (see helper docstring).
    const envelopeAccepted = this._hasSealedPassEnvelopeForCurrentTask(s.currentTaskObject?.id);
    // see _isHandledNoToolGateIntentFail docstring.
    const handledNoToolFail = this._isHandledNoToolGateIntentFail(s.currentTaskObject?.id);
    const hasArtifact = envelopeAccepted || handledNoToolFail || ckptCount > 0 || noteCount > 0 || mutCount > 0;

    const readyForReview = envelopeAccepted || handledNoToolFail || ((lar?.outcome === "success") && hasArtifact);
    const deliverable = {
      taskId: s.currentTaskObject?.id ?? null,
      taskTitle: s.currentTaskObject?.title ?? s.currentTask,
      resultSummary: this.getLastAssistantText(200) || (lar ? `${lar.actionType} → ${lar.outcome}: ${lar.summary.slice(0, 120)}` : null),
      readyForReview,
      producedAt: lar?.recordedAt ?? null,
    };

    const noBlockers = !s.waitingForHuman && !(s.currentObstacle?.blocked);
    const gateOpen = readyForReview && noBlockers;

    let reason: string;
    if (s.waitingForHuman) {
      reason = "Agent 等待人类响应，gate 关闭。";
    } else if (s.currentObstacle?.blocked) {
      reason = `阻塞未解除: ${s.currentObstacle.reason}`;
    } else if (envelopeAccepted) {
      reason = "deliverable 已确认：current-turn evidence envelope（sealed，verdict=pass），gate 开放。";
    } else if (handledNoToolFail) {
      reason = "deliverable 已确认：no-tool gate-intent 期望失败已收口（envelope failed，已产出 an earlier revision 诚实回复 + an earlier revision warning），gate 开放。";
    } else if (!lar) {
      reason = "尚未产出任何执行结果，gate 等待第一次执行。";
    } else if (!hasArtifact) {
      reason = "尚无真实 artifact（checkpoint / review note / applied kanban mutation），gate 关闭。";
    } else if (lar.outcome !== "success") {
      reason = `最近 action 未成功（${lar.outcome}），gate 关闭。`;
    } else {
      reason = `deliverable 已确认：${lar.actionType} 成功，有真实 artifact，gate 开放。`;
    }

    return {
      deliverable,
      reviewGate: { gate: gateOpen ? "open" : "blocked", reason, allowNextRound: gateOpen },
    };
  }

  @callable()
  getApprovalPolicy(): ApprovalPolicy {
    const s = this.getSafeState();
    const lar = s.lastActionResult;
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;

    const pendingMut  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const ckptCount   = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const noteCount   = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const appliedMut  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    // an earlier revision contract 3 / 199a — fix the review-gate root, not the
    // status face. Newest envelope binding (see helper docstring):
    // current-turn sealed pass envelope short-circuits the gate.
    const envelopeAccepted = this._hasSealedPassEnvelopeForCurrentTask(s.currentTaskObject?.id);
    // see _isHandledNoToolGateIntentFail docstring.
    const handledNoToolFail = this._isHandledNoToolGateIntentFail(s.currentTaskObject?.id);
    const hasArtifact = envelopeAccepted || handledNoToolFail || ckptCount > 0 || noteCount > 0 || appliedMut > 0;
    const reviewerAccepted = envelopeAccepted || handledNoToolFail || lar?.outcome === "success";
    const gateBlocked = !reviewerAccepted || !hasArtifact || s.waitingForHuman || !!(s.currentObstacle?.blocked);

    const pendingToolApproval = (() => {
      const msgs = this.getMessages();
      for (const msg of msgs) {
        for (const p of msg.parts) {
          const part = p as unknown as Record<string, unknown>;
          if (typeof part.toolCallId === "string" && part.state === "approval-requested") return true;
        }
      }
      return false;
    })();

    const interventions: ApprovalPolicy["interventions"] = [
      {
        kind: "tool-approval-required",
        active: pendingToolApproval,
        reason: pendingToolApproval ? "工具调用需要人类确认（advance_kanban_card 或其他需审批工具）" : "无待确认工具",
      },
      {
        kind: "waiting-for-human",
        active: s.waitingForHuman,
        reason: s.waitingForHuman
          ? `等待人类响应: ${s.pendingHelpRequest?.whyBlocked ?? s.currentObstacle?.reason ?? "(unspecified)"}`
          : "无需等待",
      },
      {
        kind: "blocked-obstacle",
        active: !!(s.currentObstacle?.blocked),
        reason: s.currentObstacle?.blocked ? `阻塞: ${s.currentObstacle.reason}` : "无阻塞",
      },
      {
        kind: "mutation-confirm-required",
        active: pendingMut > 0,
        reason: pendingMut > 0 ? `${pendingMut} 条 kanban mutation 待 local executor confirm` : "无待确认 mutation",
      },
      {
        kind: "review-gate-blocked",
        active: gateBlocked,
        reason: gateBlocked
          ? (!reviewerAccepted
              ? (!lar ? "尚未产出可接受的执行结果（无 lar，且当前 turn envelope 不是 sealed pass）" : `最近 action outcome: ${lar.outcome}`)
              : !hasArtifact
                ? "无真实 artifact（无 sealed pass current-turn envelope / checkpoint / review note / applied mutation）"
                : s.waitingForHuman
                  ? "等待人类响应"
                  : `阻塞: ${s.currentObstacle?.reason ?? "(unspecified)"}`)
          : (envelopeAccepted
              ? "review gate 已开放：current-turn evidence envelope（sealed，verdict=pass）已被视作 deliverable"
              : handledNoToolFail
                ? "review gate 已开放：no-tool gate-intent 期望失败已收口（envelope failed，an earlier revision 诚实回复 + an earlier revision warning），不再阻塞。"
                : "review gate 已开放"),
      },
    ];

    const active = interventions.filter(i => i.active);
    const requiresHumanConfirm = active.length > 0;
    return {
      requiresHumanConfirm,
      autoContinue: !requiresHumanConfirm,
      blockReason: active[0]?.reason ?? null,
      interventions,
    };
  }

  @callable()
  getPendingToolApproval(): { toolCallId: string; toolName: string } | null {
    const msgs = this.getMessages();
    for (const msg of msgs) {
      for (const p of msg.parts) {
        const part = p as unknown as Record<string, unknown>;
        if (typeof part.toolCallId === "string" && part.state === "approval-requested") {
          let toolName = "unknown";
          if (typeof part.type === "string" && part.type.startsWith("tool-")) {
            toolName = part.type.slice(5);
          } else if (typeof part.toolName === "string") {
            toolName = part.toolName;
          }
          return { toolCallId: part.toolCallId, toolName };
        }
      }
    }
    return null;
  }

  @callable()
  async approvePendingTool(toolCallId: string, approved: boolean): Promise<{ ok: boolean }> {
    const msgs = this.getMessages();
    const msgWithApproval = msgs.find(m =>
      m.parts.some(p => {
        const part = p as unknown as Record<string, unknown>;
        return part.toolCallId === toolCallId && part.state === "approval-requested";
      })
    );
    if (!msgWithApproval) return { ok: false };

    const update = toolApprovalUpdate(toolCallId, approved);
    const result = applyToolUpdate(
      msgWithApproval.parts as unknown as Array<Record<string, unknown>>,
      update
    );
    if (!result) return { ok: false };

    const sessionMsg: SessionMessage = {
      id: msgWithApproval.id,
      role: msgWithApproval.role,
      parts: result.parts as unknown as SessionMessage["parts"],
    };
    this.session.updateMessage(sessionMsg);
    this.logEvent("tool.approval", { toolCallId, approved });
    await this.continueLastTurn();
    return { ok: true };
  }

  @callable()
  async getWorkspaceInfo(): Promise<{ fileCount: number; directoryCount: number; totalBytes: number; r2FileCount: number }> {
    return this.workspace.getWorkspaceInfo();
  }

  // read-only workspace file API. Bound here because the
  // SDK lives on the DO; src/workspaceFiles.ts holds path safety + filtering.
  @callable()
  async listWorkspaceFiles(rawPath: string | null | undefined): Promise<WorkspaceFileList> {
    return listWorkspaceDir(this.workspace, rawPath);
  }

  @callable()
  async readWorkspaceFileText(rawPath: string | null | undefined): Promise<WorkspaceFileContent> {
    return readWorkspaceFile(this.workspace, rawPath);
  }

  // ── Workspace artifact share API v1 ────────────────────────
  // §6.2 of `docs/design/2026-05-13-m8.8-generic-artifact-delivery-contract.md`.
  // Producers write artifact bodies into the DO's Workspace SDK under
  // `tmp/artifact/<card_id>/<filename>`; the server computes sha256 and
  // size_bytes and writes a sibling `<filename>.envelope.json` so reads /
  // list calls return the envelope without re-hashing every body.
  //
  // All inputs are user-controlled. Validation, secret scan, size caps,
  // denylist, and audit logging are enforced here — the route handlers
  // in `fetch()` only marshal HTTP ↔ DO calls.
  //
  // The body of an artifact is stored as a UTF-8 string in the Workspace;
  // v1 only accepts text content (plain text, .patch, .json) per the 245c
  // 11. recommended scope. Directory bundle (binary) is NOT implemented.

  @callable()
  async writeArtifact(input: {
    cardId: string;
    filename: string;
    type: string;
    sourceAgent: string;
    producerUserId?: string;
    mime?: string;
    notes?: string;
    content: string;
  }): Promise<WriteArtifactResult> {
    // thin delegate. Body extracted to artifactOps; the
    // `@callable()` RPC surface is unchanged.
    return writeArtifactFree(this._artifactOpsHost(), input);
  }

  /**
   * sandboxExec proxy for dynamic-tool adapters.
   *
   * Adapters that need to invoke commands inside the Cloudflare
   * Sandbox container (today: `patch.validate`) reach it through this
   * method on the agentCtx surface. Not `@callable()` — external
   * Worker code never gets arbitrary sandbox exec; only in-Worker
   * adapters that already passed dispatch / tier / allowlist gates
   * can call it.
   */
  async sandboxExec(command: string): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number;
  }> {
    const sb = getSandbox(this.env.Sandbox, "agentthursday-dev-shell");
    const r = await sb.exec(command);
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      exit_code: typeof r.exitCode === "number" ? r.exitCode : 0,
    };
  }

  @callable()
  async readArtifact(input: {
    cardId: string;
    filename: string;
  }): Promise<ReadArtifactResult> {
    // thin delegate. Body extracted to artifactOps.
    return readArtifactFree(this._artifactOpsHost(), input);
  }

  @callable()
  async listArtifacts(input: {
    cardId: string;
  }): Promise<ListArtifactsResult> {
    // thin delegate. Body extracted to artifactOps.
    return listArtifactsFree(this._artifactOpsHost(), input);
  }

  /**
   * narrow ArtifactOpsHost adapter. The artifact callables
   * only need a workspace file binding + logEvent; constructing the
   * host inline keeps the delegate one-line.
   */
  private _artifactOpsHost(): ArtifactOpsHost {
    return {
      workspace: {
        mkdir: (p, o) => this.workspace.mkdir(p, o),
        writeFile: (p, c, m) => this.workspace.writeFile(p, c, m),
        readFile: (p) => this.workspace.readFile(p),
        readDir: async (dir, opts) => {
          const raw = await this.workspace.readDir(dir, opts);
          return raw.map(e => ({ name: e.name, type: e.type }));
        },
      },
      logEvent: (t, p) => this.logEvent(t, p),
    };
  }

  // ── Agent Memory v1 ──────────────────────────────────────
  // See docs/design/agent-memory-v1.md. Profile boundary = this DO.

  @callable()
  rememberMemory(input: {
    type: MemoryType;
    content: string;
    key?: string | null;
    confidence?: number | null;
    supersedesId?: number | null;
    source?: string;
  }): { id: number; type: MemoryType; supersededId: number | null } {
    // thin delegate. Body extracted to memoryOps; the
    // `getTools()` closure at this method's call site keeps the same
    // `() => this.rememberMemory(input)` shape.
    return rememberMemoryFree(this._memoryWriteHost(), input);
  }

  @callable()
  async recallMemory(input: { query: string; types?: MemoryType[]; limit?: number }): Promise<{ matches: MemoryRecallMatch[] }> {
    // M9.4 — semantic recall: embed the query + active memories (bge-m3) and rank
    // by cosine (+ key-exact boost), so an agent recalls relevant memory even
    // without a keyword overlap. Fail-soft to the lexical 3-channel
    // `recallMemoryFree` on any embedding issue (query empty, no memories,
    // embedding error, shape mismatch).
    const queryRaw = (input.query ?? "").trim();
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 5)), 20);
    const types = input.types && input.types.length > 0
      ? input.types
      : (["fact", "instruction", "event", "task"] as MemoryType[]);
    if (queryRaw.length > 0) {
      try {
        const all = this.sql<{ id: number; type: string; key: string | null; content: string; created_at: number }>`
          SELECT id, type, key, content, created_at FROM agent_memories WHERE active = 1`;
        const rows = all.filter(r => (types as string[]).includes(r.type));
        if (rows.length > 0) {
          const ai = this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> };
          const emb = await ai.run("@cf/baai/bge-m3", { text: [queryRaw, ...rows.map(r => r.content)] });
          const vecs = parseEmbeddings(emb);
          if (vecs.length === rows.length + 1) {
            const matches = rankMemoriesSemanticFree(rows, vecs[0], vecs.slice(1), queryRaw, limit);
            this.logEvent("tool.memory.recall", { query: queryRaw.slice(0, 200), matches: matches.length, semantic: true });
            return { matches };
          }
        }
      } catch (e) {
        this.logEvent("memory.recall.embed_error", { error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    return recallMemoryFree(this._memoryWriteHost(), input);
  }

  @callable()
  listMemoriesEntries(input: { type?: MemoryType; activeOnly?: boolean; limit?: number }): { items: MemoryEntry[] } {
    // thin delegate.
    return listMemoriesEntriesFree(this._memoryReadHost(), input);
  }

  /**
   * read-only memory candidate inspect.
   *
   * Walks `conversation_archive` (SELECT only) + recent message log
   * + active `agent_memories` (read-only for dedupe hints) and surfaces
   * heuristic candidates that *might* be worth promoting to long-term
   * memory. **Never writes** to `agent_memories`; never invokes
   * `tool.memory.remember`. Failure-safe: any internal throw collapses
   * to `{ ok:true, blockedReason:"...", items:[] }` so it can never
   * break `/api/workspace` or other inspect surfaces.
   *
   * v1 heuristics are explicit and explainable:
   *   - explicit ask ("帮我记一下..." / "remember ...") → high
   *     confidence, type inferred from slots (time+party+topic →
   *     `task`/`event`).
   *   - preference / instruction ("以后..." / "默认..." / "我倾向...") →
   *     `instruction` / `preference`.
   *   - repetition across archive → confidence boost (more
   *     occurrences = stronger signal).
   *
   * Idle chatter (no signal phrase, single occurrence) is dropped.
   * Tool / system / SOUL content never reaches this surface — input
   * comes from `conversation_archive.text` and `message log` text
   * parts, both already sanitized by an earlier revision.
   */
  @callable()
  listMemoryCandidates(input?: { limit?: number }): MemoryCandidatesResult {
    // thin delegate. Failure-safe semantics + generatedAt
    // capture live in `listMemoryCandidatesFree`.
    return listMemoryCandidatesFree(this._memoryReadHost(), input);
  }

  @callable()
  forgetMemory(input: { id: number; reason?: string }): { ok: boolean; id: number } {
    // thin delegate.
    return forgetMemoryFree(this._memoryWriteHost(), input);
  }

  // 2026-06-27 — operator prune lever. Soft-delete ALL active memories for this
  // agent (sets active=0 per row, auditable). Backs POST /api/inspect/memory/forget?all=1,
  // used to clear stale/contradicted memory before a fresh consolidate. Reuses the
  // per-id forget primitive; high limit so it isn't silently capped.
  @callable()
  forgetAllMemories(input?: { reason?: string }): { ok: boolean; forgotten: number } {
    const { items } = listMemoriesEntriesFree(this._memoryReadHost(), { activeOnly: true, limit: 1000 });
    let forgotten = 0;
    for (const m of items) {
      if (forgetMemoryFree(this._memoryWriteHost(), { id: m.id, reason: input?.reason ?? "operator reset" }).ok) forgotten++;
    }
    return { ok: true, forgotten };
  }

  @callable()
  getMemorySnapshot(): MemorySnapshot {
    // thin delegate.
    return getMemorySnapshotFree(this._memoryReadHost());
  }

  /**
   * per-agent live view of the memory layers that live on THIS
   * agent's DO: L1 SOUL (diagnostic), L3 agent_memories (snapshot), L2 compaction
   * + L4 knowledge + L5 checkpoints/review_notes (SQL layers). L6
   * conversation_archive + the candidate generator are registry-side, so the
   * inspect endpoint enriches this with those. Operator/inspect-only.
   */
  @callable()
  async getMemoryLayersDiagnostic(): Promise<{
    soul: { liveBaseSoulKind: "operator" | "neutral" | "unknown"; frozenStored: boolean; soulPromptVersion: number | null; ownerIsOperator: boolean | null };
    agentMemories: MemorySnapshot;
    layers: MemoryLayersSql;
    consolidationRuns: ConsolidationLedgerEntry[];
    agentId: string;
    ownerIsOperator: boolean | null;
  }> {
    const soul = await this.getSoulDiagnostic();
    return {
      soul,
      agentMemories: getMemorySnapshotFree(this._memoryReadHost()),
      layers: getMemoryLayersSqlFree(this._memoryReadHost()),
      consolidationRuns: listConsolidationRunsFree(this._memoryReadHost(), this.name, 5),
      agentId: this.name,
      ownerIsOperator: this._ownerIsOperatorCache,
    };
  }

  /**
   * L6 conversation_archive stats. Registry-canonical, so call
   * this on the registry stub. Counts total chunks + flushes + recent flush
   * activity; fail-soft to zero if the tables aren't present.
   */
  @callable()
  getConversationArchiveStats(): {
    chunkCount: number;
    flushCount: number;
    recentFlushes: Array<{ trigger: string; chunkCount: number; status: string; createdAt: number }>;
    ownerBreakdown: Array<{ ownerUserId: string; chunkCount: number }>;
  } {
    try {
      const chunkCount = Number((this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_archive`)[0]?.n ?? 0);
      const flushCount = Number((this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_archive_flushes`)[0]?.n ?? 0);
      const recentFlushes = this.sql<{ trigger: string; chunk_count: number; status: string; created_at: number }>`
        SELECT trigger, chunk_count, status, created_at FROM conversation_archive_flushes ORDER BY created_at DESC LIMIT 5`
        .map(r => ({ trigger: r.trigger, chunkCount: r.chunk_count, status: r.status, createdAt: r.created_at }));
      // Track A migration-cost observability: chunk count per owner.
      // Pre-cutover this is ~all `user-admin` (an earlier revision backfill); a non-admin
      // owner with meaningful chunks would mean M1 (leave-in-place) strands that
      // agent's registry history when it switches to reading its own local DO.
      const ownerBreakdown = this.sql<{ owner_user_id: string; n: number }>`
        SELECT owner_user_id, COUNT(*) AS n FROM conversation_archive GROUP BY owner_user_id ORDER BY n DESC LIMIT 20`
        .map(r => ({ ownerUserId: r.owner_user_id, chunkCount: Number(r.n) }));
      return { chunkCount, flushCount, recentFlushes, ownerBreakdown };
    } catch {
      return { chunkCount: 0, flushCount: 0, recentFlushes: [], ownerBreakdown: [] };
    }
  }

  // DIAGNOSTIC (2026-06-30) — DO storage profile. Per-table row count + total
  // text bytes + max single-row bytes, to identify which table/operation
  // dominates the DO isolate's working set (the 128 MB OOM culprit). Uses raw
  // `ctx.storage.sql.exec` so it can introspect any table by name. SAFE: only
  // aggregates (COUNT / SUM(length) / MAX(length)) — these compute in SQLite
  // and return scalars, they never materialise full rows into the JS heap, so
  // this won't itself trip the memory limit even on a bloated DO.
  @callable()
  getStorageProfile(input?: { contextId?: string }): { tables: Array<{ name: string; rows: number; totalBytes: number; maxRowBytes: number; cols: number }>; totalBytes: number; archiveByContext?: Array<{ contextId: string; rows: number; totalBytes: number; maxRowBytes: number }> } {
    const raw = (this.ctx.storage as unknown as { sql: { exec: (q: string) => Iterable<Record<string, unknown>> } }).sql;
    // Archived (NOT deleted) chunks remain queryable. Report conversation_archive
    // grouped by source context_id (top by bytes), so a resetContext flush's real
    // archived size is visible — e.g. a large archive at OOM time. Optional contextId
    // filters to one. Param-bound + aggregate-only (safe).
    let archiveByContext: Array<{ contextId: string; rows: number; totalBytes: number; maxRowBytes: number }> | undefined;
    try {
      const filt = input?.contextId && /^[A-Za-z0-9_-]+$/.test(input.contextId) ? input.contextId : null;
      const rows = filt !== null
        ? this.sql<{ context_id: string; rows: number; total: number; maxrow: number }>`
            SELECT context_id, COUNT(*) AS rows, COALESCE(SUM(length(text)),0) AS total, COALESCE(MAX(length(text)),0) AS maxrow
            FROM conversation_archive WHERE context_id = ${filt} GROUP BY context_id`
        : this.sql<{ context_id: string; rows: number; total: number; maxrow: number }>`
            SELECT context_id, COUNT(*) AS rows, COALESCE(SUM(length(text)),0) AS total, COALESCE(MAX(length(text)),0) AS maxrow
            FROM conversation_archive GROUP BY context_id ORDER BY total DESC LIMIT 10`;
      if (rows.length > 0) {
        archiveByContext = rows.map(r => ({ contextId: r.context_id, rows: Number(r.rows), totalBytes: Number(r.total), maxRowBytes: Number(r.maxrow) }));
      }
    } catch { /* conversation_archive absent on this DO → skip */ }
    const safe = (n: string): boolean => /^[A-Za-z0-9_]+$/.test(n);
    const names = Array.from(raw.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )).map((r) => String(r.name)).filter(safe);
    const tables: Array<{ name: string; rows: number; totalBytes: number; maxRowBytes: number; cols: number }> = [];
    let grand = 0;
    for (const t of names) {
      try {
        const cols = Array.from(raw.exec(`PRAGMA table_info("${t}")`)).map((c) => String(c.name)).filter(safe);
        if (cols.length === 0) continue;
        const lenExpr = cols.map((c) => `COALESCE(length("${c}"),0)`).join("+");
        const row = Array.from(raw.exec(
          `SELECT COUNT(*) AS rows, COALESCE(SUM(${lenExpr}),0) AS total, COALESCE(MAX(${lenExpr}),0) AS maxrow FROM "${t}"`,
        ))[0] as { rows?: number; total?: number; maxrow?: number } | undefined;
        const totalBytes = Number(row?.total ?? 0);
        grand += totalBytes;
        tables.push({ name: t, rows: Number(row?.rows ?? 0), totalBytes, maxRowBytes: Number(row?.maxrow ?? 0), cols: cols.length });
      } catch {
        tables.push({ name: t, rows: -1, totalBytes: -1, maxRowBytes: -1, cols: 0 });
      }
    }
    tables.sort((a, b) => b.totalBytes - a.totalBytes);
    return { tables, totalBytes: grand, ...(archiveByContext ? { archiveByContext } : {}) };
  }

  // DIAGNOSTIC (2026-06-30) — dump the largest assistant_messages rows with a
  // per-part byte breakdown, to see WHAT makes them big (expect: content_read
  // tool-result payloads). Operator-only. Fetches only the top-N rows' content
  // (bounded N), parses parts, returns a bounded preview of the biggest part —
  // never the whole 1MB+ payload.
  @callable()
  getLargeAssistantMessages(input?: { limit?: number; previewBytes?: number }): {
    rows: Array<{ id: string; role: string; bytes: number; parts: Array<{ type: string; tool?: string; bytes: number }>; bigPartType: string; bigPartPreview: string }>;
  } {
    const limit = Math.max(1, Math.min(8, Math.floor(input?.limit ?? 5)));
    const prev = Math.max(100, Math.min(4000, Math.floor(input?.previewBytes ?? 1200)));
    let rows: Array<{ id: string; role: string; content: string }> = [];
    try {
      rows = this.sql<{ id: string; role: string; content: string }>`
        SELECT id, role, content FROM assistant_messages ORDER BY length(content) DESC LIMIT ${limit}`;
    } catch { return { rows: [] }; }
    return {
      rows: rows.map((r) => {
        const bytes = (r.content ?? "").length;
        const parts: Array<{ type: string; tool?: string; bytes: number }> = [];
        let bigPartType = "";
        let bigPartPreview = "";
        try {
          const parsed = JSON.parse(r.content) as { parts?: Array<Record<string, unknown>> };
          const ps = Array.isArray(parsed.parts) ? parsed.parts : [];
          let bigLen = -1;
          for (const p of ps) {
            const pb = JSON.stringify(p).length;
            const type = String((p as { type?: unknown }).type ?? "?");
            const toolName = (p as { toolName?: unknown }).toolName;
            const tool = typeof toolName === "string" ? toolName : (type.startsWith("tool-") ? type.slice(5) : undefined);
            parts.push(tool ? { type, tool, bytes: pb } : { type, bytes: pb });
            if (pb > bigLen) { bigLen = pb; bigPartType = tool ? `tool:${tool}` : type; bigPartPreview = JSON.stringify(p).slice(0, prev); }
          }
        } catch {
          bigPartType = "(unparsed)";
          bigPartPreview = (r.content ?? "").slice(0, prev);
        }
        return { id: r.id, role: r.role, bytes, parts, bigPartType, bigPartPreview };
      }),
    };
  }

  // watermark read/write (single-row table). Returns how many live
  // dialog turns have already been consolidated; the end-of-turn trigger uses it to
  // extract only new turns. Fail-soft to 0 (re-extract window once; dedup absorbs).
  private _readConsolidationWatermark(): number {
    try {
      const row = this.sql<{ last_turn_count: number }>`SELECT last_turn_count FROM memory_consolidation_watermark WHERE id = 1`[0];
      return row ? Number(row.last_turn_count) : 0;
    } catch { return 0; }
  }

  private _writeConsolidationWatermark(turnCount: number): void {
    try {
      this.sql`INSERT OR REPLACE INTO memory_consolidation_watermark (id, last_turn_count, updated_at) VALUES (1, ${Math.max(0, Math.floor(turnCount))}, ${Date.now()})`;
    } catch { /* fail-soft: watermark is an optimization, not correctness */ }
  }

  /**
   * adoption fix. Extract durable memory from THIS agent's
   * conversation_archive with the LLM (≈ MiMo /dream) and promote it into
   * agent_memories. Writes for every owner: scoped real-write was opened
   * 2026-06-25 (the operator — a user owns their own agent; extraction reads only THIS
   * agent's own archive so the blast radius is per-tenant, no cross-tenant leak).
   * Idempotent: dedup vs existing memory holds across runs. Every pass writes a
   * `memory_consolidation_runs` ledger row (rollback by run).
   */
  // A1 Phase 2 M2: ingest memories migrated off another operator
  // surface (registry DO / legacy ctx_ DO) through the an earlier revision dedup/supersede
  // pipeline, NOT a raw copy: the two sources hold overlapping memory sets, so
  // promotion-with-dedup is exactly the merge we want. Provenance (`source`)
  // is preserved from the source row; the run ledger records
  // `migration:<from>` as parse_status. Candidates never carry `supersedes`
  // (a migration must not soft-delete anything already here). Operator-only
  // surface (secret-gated inspect driver).
  @callable()
  ingestMigratedMemories(input: { candidates: ExtractedMemory[]; from_agent_id: string }): ConsolidationLedgerEntry {
    const candidates = (Array.isArray(input?.candidates) ? input.candidates : [])
      .slice(0, 200)
      .map(c => ({ ...c, supersedes: null }));
    return consolidateMemoriesFree(this._memoryWriteHost(), {
      agentId: this.name,
      mode: "write",
      model: null,
      sourceChunks: 0,
      parseStatus: `migration:${String(input?.from_agent_id ?? "unknown")}`,
      candidates,
    });
  }

  @callable()
  async consolidateMemories(input?: {
    maxChunks?: number; threshold?: number; sinceTurnCount?: number;
    // 群体记忆. `parentTaskId` set (this agent is a subagent) → PUSH
    // its promoted insights up to the registry keyed by parentTaskId. `taskId`
    // (this finalizing task) → INGEST subagent insights keyed by it (parent role).
    parentTaskId?: string | null;
    taskId?: string | null;
  }): Promise<ConsolidationLedgerEntry & { rawPreview?: string; llmExtracted?: number; droppedSemantic?: number }> {
    const DIALOG_CHAR_CAP = 12_000;
    let dialog = "";
    // Track M (2026-06-25) — the PRIMARY source is the agent's LIVE conversation
    // (`getDialogTurns`), not just `conversation_archive`. Archival only fires on
    // context reset/newContext, which normally-dispatched user agents never do, so
    // their archive is empty while the live log holds the real dialog (probed: user
    // agents have 20–48 live turns, 0 archive chunks). `getDialogTurns` excludes
    // tool parts (an earlier revision/c privacy contract), so no tool payload leaks in.
    let liveTurns = 0;
    try {
      // Track M-b — when the end-of-turn trigger passes `sinceTurnCount`, extract only
      // turns after the watermark (new content), so re-runs don't re-promote. Manual /
      // endpoint calls omit it → extract the recent window. Clamp a stale watermark
      // (e.g. after a context reset cleared the log) back to 0.
      const allTurns = this.getDialogTurns(200);
      const since = input?.sinceTurnCount;
      const effSince = (typeof since === "number" && since >= 0 && since <= allTurns.length) ? since : 0;
      for (const t of allTurns.slice(effSince)) {
        const u = (t.userText ?? "").trim();
        const a = (t.assistantText ?? "").trim();
        const block = u.length > 0 ? (a.length > 0 ? `用户: ${u}\n助手: ${a}` : `用户: ${u}`) : a;
        if (block.trim().length === 0) continue;
        if (dialog.length + block.length > DIALOG_CHAR_CAP) break;
        dialog += `${block}\n---\n`;
        liveTurns++;
      }
    } catch { /* fail-soft to archive-only below */ }
    // Supplement with archive chunks (old/reset contexts; the operator/registry DO
    // accumulates these). Semantic dedup downstream prevents double-promotion when
    // live and archived content overlap.
    const maxChunks = Math.min(Math.max(5, Math.floor(input?.maxChunks ?? 40)), 80);
    let chunks: Array<{ text: string }> = [];
    try {
      chunks = this.sql<{ text: string }>`SELECT text FROM conversation_archive ORDER BY created_at DESC LIMIT ${maxChunks}`;
    } catch { chunks = []; }
    for (const c of chunks) {
      const t = String(c.text ?? "").trim();
      if (t.length === 0) continue;
      if (dialog.length + t.length > DIALOG_CHAR_CAP) break;
      dialog += `${t}\n---\n`;
    }
    const sourceCount = liveTurns + chunks.length;
    // carry ids in a stable order so a candidate's `supersedes`
    // index resolves to a real row id in consolidateMemoriesFree.
    const existingRefs = this.sql<{ id: number; content: string }>`SELECT id, content FROM agent_memories WHERE active = 1 ORDER BY id`;
    const existing = existingRefs.map(r => r.content);
    // Scoped real-write opened 2026-06-25 (the operator). Promote for every owner, not
    // just operator agents — extraction stays within THIS agent's own live log +
    // archive, so a user can only ever populate their own agent's memory.
    const mode: "write" | "dry_run" = "write";
    // 群体记忆 INGEST (parent role): pull subagent insights pushed
    // under THIS finalizing task, OWNER-check fail-closed (same owner only,
    // never cross-tenant), and admit them as extraction candidates tagged
    // `source="subagent:<id>"`. They flow through the SAME semantic-dedup +
    // an earlier revision confidence/supersede promote path as LLM candidates.
    let insightCandidates: ExtractedMemory[] = [];
    if (typeof input?.taskId === "string" && input.taskId.length > 0) {
      try {
        const registry = await getRegistryStub(this.env);
        const rawInsights = await registry.readSubagentInsights(input.taskId);
        // an earlier revision (agentX review, High) — the INGEST owner check is a READ boundary,
        // so use the fail-CLOSED identity resolver (null on resolution failure), NOT
        // the write-stamp `_resolveOwnArchiveOwnerId` which fail-OPENS to the admin
        // sentinel and would let a scoped parent wrongly ingest admin insights on a
        // resolution glitch. Null → leave insightCandidates empty (drop all).
        const parentIdentity = await this._resolveOwnArchiveOwnerIdentity();
        if (parentIdentity !== null) {
          insightCandidates = insightsToCandidates(filterInsightsByOwner(rawInsights, ownerUserIdFor(parentIdentity)));
        }
      } catch (e) {
        this.logEvent("memory.consolidation.insight_ingest_error", { error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    if (dialog.trim().length === 0 && insightCandidates.length === 0) {
      return consolidateMemoriesFree(this._memoryWriteHost(), {
        agentId: this.name, mode, model: null, sourceChunks: sourceCount, parseStatus: "empty", candidates: [],
      });
    }
    // Extraction is a system meta-task, decoupled from the agent's persona model.
    // Use the raw Workers AI binding (the reliable path `toMarkdown` uses) — the
    // workers-ai-provider SDK wrapper returns empty text via streamText/
    // generateText for the Kimi family (project_kimi_model flush bug). And use a
    // strong NON-reasoning instruct model: Kimi-k2.6 is a reasoning model that
    // burns the whole token budget on `reasoning_content` and leaves the final
    // `content` empty (finish_reason=length) — wrong tool for terse JSON output.
    const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    let raw = "";
    let parseStatus = insightCandidates.length > 0 ? "insight_only" : "empty";
    let candidates: ExtractedMemory[] = [];
    // Only run LLM extraction when there is dialog; a parent with no new dialog
    // but with ingested subagent insights still consolidates those .
    if (dialog.trim().length > 0) {
      const prompt = buildMemoryExtractionPrompt(dialog, existing, new Date().toISOString().slice(0, 10));
      try {
        const ai = this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> };
        const aiResp = await ai.run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 2000, temperature: 0.1 });
        if (typeof aiResp === "string") {
          raw = aiResp;
        } else {
          const o = aiResp as Record<string, unknown>;
          const choices = o.choices as Array<{ message?: { content?: string; reasoning_content?: string } }> | undefined;
          raw = String(
            choices?.[0]?.message?.content
            || (o.response as string | undefined)
            || (o.text as string | undefined)
            || choices?.[0]?.message?.reasoning_content
            || "",
          );
        }
        const parsed = parseMemoryExtraction(raw);
        parseStatus = parsed.parseStatus;
        candidates = parsed.candidates;
      } catch (e) {
        this.logEvent("memory.consolidation.extract_error", { error: e instanceof Error ? e.message.slice(0, 150) : String(e) });
        // extraction failed, but ingested subagent insights should
        // still promote; fall through with empty LLM candidates.
        parseStatus = insightCandidates.length > 0 ? "insight_only" : "parse_failed";
      }
    }
    // merge ingested subagent insight candidates with LLM candidates.
    // (agentX review, High) Subagent candidates go FIRST so that on a same-fact
    // intra-run duplicate the subagent-PROVENANCE row survives (both semantic and
    // lexical dedup keep the earlier candidate) — preventing the "subagent
    // provenance silently overwritten by an llm-extracted copy" decay.
    const mergedCandidates: ExtractedMemory[] = [...insightCandidates, ...candidates];
    // Semantic dedup (idempotency): embed candidates + existing memories and drop
    // any candidate cosine-close to an existing one — lexical dedup misses LLM
    // re-phrasings, so re-runs kept promoting near-duplicates. Fail-soft: an
    // embedding hiccup leaves the lexical dedup in consolidateMemoriesFree.
    let dedupedCandidates: ExtractedMemory[] = mergedCandidates;
    let droppedSemantic = 0;
    if (mergedCandidates.length > 0 && existing.length > 0) {
      try {
        const ai = this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> };
        const texts = [...mergedCandidates.map(c => c.content), ...existing];
        const emb = await ai.run("@cf/baai/bge-m3", { text: texts });
        const vecs = parseEmbeddings(emb);
        if (vecs.length === texts.length) {
          const candVecs = vecs.slice(0, mergedCandidates.length);
          const existingVecs = vecs.slice(mergedCandidates.length);
          const filtered = semanticDedupFilter(mergedCandidates, candVecs, existingVecs);
          // never let semantic dedup drop a candidate the LLM flagged
          // as superseding an existing memory; a contradiction is cosine-close to
          // what it replaces by nature. Re-admit any flagged candidate it dropped.
          const survivorSet = new Set(filtered.survivors);
          const reAdmitted = mergedCandidates.filter(c => typeof c.supersedes === "number" && c.supersedes !== null && !survivorSet.has(c));
          dedupedCandidates = [...filtered.survivors, ...reAdmitted];
          droppedSemantic = filtered.droppedSemantic - reAdmitted.length;
        }
      } catch (e) {
        this.logEvent("memory.consolidation.embed_error", { error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    const ledger = consolidateMemoriesFree(this._memoryWriteHost(), {
      agentId: this.name, mode, model, sourceChunks: sourceCount, parseStatus, candidates: dedupedCandidates,
      existingRefs,
      ...(typeof input?.threshold === "number" ? { threshold: input.threshold } : {}),
    });
    // 群体记忆 PUSH (subagent role): if THIS agent is a subagent
    // (parent_task_id present) and it just promoted its OWN insights, push them
    // up to the registry keyed by parent_task_id so the dispatching parent
    // ingests them at its own consolidation. Only its OWN insights (source not
    // already `subagent:*`) — never re-push ingested ones (no cascade dupes).
    // Owner-stamped from THIS agent's own owner; the parent-side read
    // fail-closes on owner mismatch. Fail-soft (never breaks consolidation).
    if (typeof input?.parentTaskId === "string" && input.parentTaskId.length > 0
      && ledger.promoted > 0 && ledger.promoted_memory_ids.length > 0) {
      try {
        const promotedSet = new Set(ledger.promoted_memory_ids);
        const rows = this.sql<{ id: number; type: string; content: string; confidence: number | null; source: string }>`
          SELECT id, type, content, confidence, source FROM agent_memories WHERE active = 1`;
        const insights = rows
          .filter(r => promotedSet.has(r.id) && !String(r.source ?? "").startsWith("subagent:"))
          .map(r => ({ type: r.type, content: r.content, confidence: r.confidence ?? 0 }));
        if (insights.length > 0) {
          const ownerUserId = await this._resolveOwnArchiveOwnerId();
          const payload = buildSubagentInsightPayload({
            parent_task_id: input.parentTaskId,
            source_agent_id: this.name,
            owner_user_id: ownerUserId,
            insights,
            completed_at: new Date().toISOString(),
          });
          const registry = await getRegistryStub(this.env);
          await registry.pushSubagentInsight(input.parentTaskId, payload);
          this.logEvent("memory.subagent_insight.pushed", { parent_task_id: input.parentTaskId, count: insights.length });
        }
      } catch (e) {
        this.logEvent("memory.subagent_insight.push_error", { error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    // Operator-only endpoint — rawPreview + the LLM's true extraction count and
    // semantic-dedup drops help diagnose a low promoted count.
    return { ...ledger, llmExtracted: candidates.length, droppedSemantic, rawPreview: raw.slice(0, 500) };
  }

  @callable()
  clearStaleBlockingState(): { ok: boolean; cleared: string[] } {
    const cleared: string[] = [];
    const patch: Partial<AgentThursdayState> = {};
    if (this.agentthursdayState.waitingForHuman) { patch.waitingForHuman = false; cleared.push("waitingForHuman"); }
    if (this.agentthursdayState.pendingHelpRequest !== null) { patch.pendingHelpRequest = null; cleared.push("pendingHelpRequest"); }
    if (this.agentthursdayState.currentObstacle !== null) { patch.currentObstacle = null; cleared.push("currentObstacle"); }
    if (cleared.length > 0) {
      this.setAgentThursdayState({ ...this.agentthursdayState, ...patch, updatedAt: Date.now() });
      this.logEvent("state.stale_cleared", { cleared });
    }
    return { ok: true, cleared };
  }

  // recovery/readiness/review projection helpers live in
  // `./agent/recoveryViews`. Host is built once per call.
  private _recoveryViewsHost(): RecoveryViewsHost {
    return {
      sql: this.sql.bind(this) as RecoveryViewsHost["sql"],
      getSafeState: () => this.getSafeState(),
    };
  }

  @callable()
  getRecentReviewNotes(): { content: string; source: string; created_at: number }[] {
    return getRecentReviewNotesView(this._recoveryViewsHost());
  }

  /**
   * explicit channel-ingress readiness predicate.
   *
   * Replaces ChannelHub's previous heuristic `currentTask !== null` (which
   * misfired when `currentTask` was a stale string but the actual loop was
   * idle — the operator hit this in dogfood: agentD showed busy forever).
   *
   * `canAccept` is the authority on whether ChannelHub may submit a new
   * channel-driven task on top of current state. The reason string is
   * carried into busy-skip decisions so operators can see the concrete
   * predicate (`waitingForHuman`, `blocked: …`, `active task lifecycle=active`,
   * `prior task completed`, etc.) instead of generic "active task".
   */
  @callable()
  getChannelIngressReadiness(): { canAccept: boolean; reason: string; currentTaskId: string | null; currentTaskLifecycle: string | null } {
    return getChannelIngressReadinessView(this.getSafeState());
  }

  @callable()
  getRecentCheckpoints(): { key: string; content: string; source: string; created_at: number }[] {
    return getRecentCheckpointsView(this._recoveryViewsHost());
  }

  @callable()
  getRecentKanbanMutations(): { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; status: string; applied_at: number | null; evidence: string | null; created_at: number }[] {
    return getRecentKanbanMutationsView(this._recoveryViewsHost());
  }

  @callable()
  getPendingKanbanMutations(): { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; created_at: number }[] {
    return getPendingKanbanMutationsView(this._recoveryViewsHost());
  }

  @callable()
  confirmKanbanMutation(id: number, status: string, evidence: string): void {
    const allowed = ["applied", "failed", "rejected"];
    const safeStatus = allowed.includes(status) ? status : "rejected";
    this.sql`UPDATE kanban_mutations SET status = ${safeStatus}, applied_at = ${Date.now()}, evidence = ${evidence} WHERE id = ${id}`;
    this.logEvent("action.kanban.mutation.confirmed", { id, status: safeStatus, evidenceSnippet: evidence.slice(0, 120) });
  }

  @callable()
  getOutcomeVerification(): OutcomeVerification {
    return getOutcomeVerificationView(this._recoveryViewsHost());
  }

  @callable()
  getMutationReview(): MutationReview {
    return getMutationReviewView(this._recoveryViewsHost());
  }

  @callable()
  getRecoveryTimeline(): RecoveryTimelineItem[] {
    return getRecoveryTimelineView(this._recoveryViewsHost());
  }

  @callable()
  getRecoveryReview(): RecoveryReview {
    return getRecoveryReviewView(this.getSafeState());
  }

  @callable()
  setModelProfile(provider: string, model: string): void {
    const prevSignal = getIntelligenceSignal(this.agentthursdayState.modelProfile);
    const newProfile = { provider, model };
    const newSignal = getIntelligenceSignal(newProfile);
    const awareness = getProfileAwareness(newProfile);
    this.logEvent("model.changed", { from: this.agentthursdayState.modelProfile, to: newProfile, awareness });
    if (prevSignal.tier !== newSignal.tier || prevSignal.mode !== newSignal.mode) {
      this.logEvent("intelligence.changed", { from: prevSignal, to: newSignal });
    }
    // Human responded to escalation by switching model → enter recovered mode
    const prevMode = this.agentthursdayState.runtimeMode;
    const runtimeMode: RuntimeMode = prevMode.mode === "assisted"
      ? { mode: "recovered", reason: `model switched to ${provider}/${model} after escalation` }
      : prevMode;
    if (runtimeMode.mode !== prevMode.mode) {
      this.logEvent("mode.changed", { from: prevMode.mode, to: runtimeMode.mode, reason: runtimeMode.reason });
    }
    this.setAgentThursdayState({ ...this.agentthursdayState, modelProfile: newProfile, runtimeMode, updatedAt: Date.now() });
  }

  @callable()
  acknowledgeHumanResponse(fromHuman: string, content: string): void {
    const traceId = `ack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const humanResponse: HumanResponse = { fromHuman, content, acknowledged: true, usedInResume: false };
    this.logEvent("response.received", { fromHuman, contentSnippet: content.slice(0, 100) }, traceId);
    // Human acknowledged → if in assisted mode, enter recovered
    const prevMode = this.agentthursdayState.runtimeMode;
    const runtimeMode: RuntimeMode = prevMode.mode === "assisted"
      ? { mode: "recovered", reason: `human response received from ${fromHuman}` }
      : prevMode;
    if (runtimeMode.mode !== prevMode.mode) {
      this.logEvent("mode.changed", { from: prevMode.mode, to: runtimeMode.mode, reason: runtimeMode.reason }, traceId);
    }
    this.logEvent("response.acknowledged", { fromHuman, acknowledged: true }, traceId);
    const resumeTrigger = `human-response:${fromHuman}`;
    this.logEvent("resume.triggered", { trigger: resumeTrigger, fromHuman }, traceId);
    const prevPolicy = this.agentthursdayState.recoveryPolicy;
    const recoveryPolicy: RecoveryPolicy = { policyMode: "safe-resume", reason: `human response received — entering safe-resume before full recovery` };
    if (recoveryPolicy.policyMode !== prevPolicy.policyMode) {
      this.logEvent("recovery.policy.changed", { from: prevPolicy.policyMode, to: recoveryPolicy.policyMode, reason: recoveryPolicy.reason }, traceId);
    }
    const resumedTaskObject = this.agentthursdayState.currentTaskObject?.status === "waiting"
      ? { ...this.agentthursdayState.currentTaskObject, status: "active" as const, updatedAt: Date.now() }
      : this.agentthursdayState.currentTaskObject;
    this.setAgentThursdayState({ ...this.agentthursdayState, lastHumanResponse: humanResponse, currentTaskObject: resumedTaskObject, waitingForHuman: false, resumeTrigger, recoveryPolicy, runtimeMode, updatedAt: Date.now() });
  }
}

// `/api/diag/dispatch` route + 3 diag helpers extracted to
// `src/routes/diagRoutes.ts`. See that file for the an earlier revision A.2 bodies.


// auto-route helper. After a successful inbound INSERT, the
// ingest endpoint calls this so addressed/trusted messages flow into the
// AgentThursdayAgent loop without requiring a manual /api/channel/route-pending POST.
// - bounded limit (5) keeps latency tight
// - duplicate ingest skips this entirely (caller passes inserted=false)
// - errors are swallowed; the ingest response still succeeds
// - busy-skipped rows stay `received` (an earlier revision invariant: do not consume the
//   user's message just because the agent is busy)
export type AutoRouteSummary = {
  scanned: number;
  busySkipped: number;
  processed: number;
  deferred: number;
  ignored: number;
  failed: number;
};
// Structural shape — getAgentByName returns DurableObjectStub<ChannelHubAgent>,
// not the class itself. Only `routePending` is consumed here.
type ChannelHubRouteCallable = {
  routePending(limit?: number): Promise<{
    ok: boolean;
    scanned: number;
    busySkipped: number;
    decisions: Array<{ finalStatus: string }>;
  }>;
};

async function autoRouteAfterIngest(
  stub: ChannelHubRouteCallable,
  inserted: boolean,
): Promise<AutoRouteSummary | null> {
  if (!inserted) return null;
  try {
    const r = await stub.routePending(5);
    let processed = 0, deferred = 0, ignored = 0, failed = 0;
    for (const d of r.decisions) {
      if (d.finalStatus === "handled") processed++;
      else if (d.finalStatus === "deferred") deferred++;
      else if (d.finalStatus === "ignored") ignored++;
      else if (d.finalStatus === "failed") failed++;
    }
    return { scanned: r.scanned, busySkipped: r.busySkipped, processed, deferred, ignored, failed };
  } catch (e) {
    console.warn("[autoRoute] failed:", String(e instanceof Error ? e.message : e).slice(0, 200));
    return null;
  }
}

// `browserError` moved to `./routes/browserRoutes.ts` along
// with the only route that consumed it (`POST /api/browser/run`).

// `workspaceFileError` moved to `./routes/workspaceRoutes.ts`
// (private helper, only consumed by the two workspace file routes that
// also moved there).

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // M7.1 an earlier revision: CORS preflight is exempt from auth (no header on OPTIONS).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // /health is intentionally exempt so Cloudflare health probes and uptime
    // monitors can keep working without the secret. Keep its response shape minimal.
    // body lives in `./routes/healthRoutes`.
    if (url.pathname === "/health") {
      return handleHealth();
    }

    // M7.1 an earlier revision + 78: auth only gates the data surface. The SPA shell
    // (HTML/JS/CSS bundle served by ASSETS) must load without a secret so
    // SecretGate can prompt the user. SecretGate then probes /api/workspace
    // — a 401 means "wrong secret", a 503 means "worker misconfigured".
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/cli/") ||
      url.pathname.startsWith("/demo/") ||
      // the agents-SDK RPC routes (/agents/<class>/<instance>)
      // reach a per-agent DO directly; gate them behind the secret too so the
      // public console exposes no unauthenticated per-agent-DO access path.
      isAgentsSdkPath(url.pathname)
    ) {
      const authResp = requireSecret(request, env);
      if (authResp) return authResp;
    }

    // resolve the tenant identity AFTER the secret check. The
    // `X-AgentThursday-User-Id` header is only trusted once `requireSecret` has
    // passed (the secret is held only by the gateway/admin, so the public
    // internet cannot forge an identity). No header ⇒ admin (the current
    // operator), so all existing console/system traffic is unchanged.
    const identity: RequestIdentity = resolveRequestIdentity(
      request.headers.get(USER_ID_HEADER),
    );

    // the operator/debug surface is ADMIN-ONLY. These per-agent
    // routes resolve a Durable Object from the caller-supplied
    // `X-AgentThursday-Context-Id` (any agent_id), so a scoped tenant must never reach
    // them — they would expose another tenant's workspace / inspect / artifacts
    // / dev-shell. The user product uses its own tenant-scoped routes (P3); the
    // operator console sends no `X-AgentThursday-User-Id` and is unaffected. This single
    // chokepoint closes the whole X-AgentThursday-Context-Id bypass surface.
    if (identity.kind === "user" && isOperatorOnlyPath(url.pathname)) {
      return new Response(
        JSON.stringify({ code: "forbidden", message: "operator-only surface" }),
        { status: 403, headers: { "content-type": "application/json", ...CORS_HEADERS } },
      );
    }

    // defense-in-depth: a scoped (gateway-on-behalf-of-user) request
    // must use `/api/*`, never the raw agents-SDK DO RPC path
    // (`/agents/<class>/<instance>/<method>`). Over that path the owner-scoped
    // @callables' optional `identity` cannot be carried (→ admin branch). The
    // path is already secret-gated (426g) and unreachable by a no-secret user;
    // this makes that invariant local + regression-proof for 426b/c/d/e at once.
    // Admin/system (no `X-AgentThursday-User-Id` → admin) and the console SPA's own SDK
    // connections are unaffected.
    if (isScopedSdkRpcForbidden(identity.kind === "user", url.pathname)) {
      return new Response(
        JSON.stringify({ code: "forbidden", message: "scoped users must use /api/*, not the agents-SDK RPC path" }),
        { status: 403, headers: { "content-type": "application/json", ...CORS_HEADERS } },
      );
    }

    // an earlier revision + `/demo/*` bodies and dispatch live in
    // `./routes/demoRoutes`. Auth ordering stays in this composition
    // root (the `/demo/*` umbrella gate above); the facade returns
    // `null` for non-matching paths or method-mismatches so we fall
    // through to the next route family, preserving the original
    // inline `pathname === X && method === Y` semantics exactly.
    if (url.pathname.startsWith("/demo/")) {
      const resp = await handleDemoRoutes(request, url, env);
      if (resp !== null) return resp;
    }

    if (url.pathname === "/api/workspace" && request.method === "GET") {
      // handler body lives in `./routes/workspaceRoutes.ts`.
      // Composition root resolves both the canonical-active stub and
      // the registry stub (looked up via `DEMO_INSTANCE`, kept in
      // `./demoConstants` per an earlier revision v2), then delegates. The
      // route-module body preserves the exact 14-call `Promise.all`,
      // `buildWorkspaceSnapshot` invocation, and
      // `WorkspaceSnapshotSchema.parse` boundary validation.
      const stub = await getCanonicalActiveAgentThursdayAgentStub(env, request);
      const registry = await getRegistryStub(env);
      return handleApiWorkspace(stub, registry);
    }

    // `/api/discord-gateway/*` HTTP route handling extracted
    // to `./routes/discordGatewayRoutes.ts`. Single delegation; module
    // returns null when no branch matches so execution falls through.
    // Auth-gated by the `/api/`/`/cli/`/`/demo/` umbrella above.
    if (url.pathname.startsWith("/api/discord-gateway/")) {
      const resp = await handleDiscordGateway(request, url, {
        getGatewayStub: () => getAgentByName<Env, DiscordGatewayAgent>(
          env.DiscordGatewayAgent as unknown as AgentNamespace<DiscordGatewayAgent>,
          DISCORD_GATEWAY_INSTANCE,
        ),
      });
      if (resp !== null) return resp;
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      // small public-config endpoint so the SPA can read
      // the debug surface mode at runtime. Auth-gated like every
      // other /api/* route; flipping `AGENT_THURSDAY_DEBUG_SURFACE_MODE` in
      // wrangler.toml is a `wrangler deploy` away with no web
      // rebuild. The shape stays narrow (no env / no secrets) so
      // callers can't probe it for anything else.
      // body lives in `./routes/configRoutes`.
      return handleConfig(env);
    }

    // read-only model profile catalog for the Models page.
    if (url.pathname === "/api/models" && request.method === "GET") {
      return handleModels();
    }

    // BYO-key provider credential store (registry DO). Auth
    // is the `/api/*` umbrella above. The raw key is write-only: POST
    // accepts it, GET returns only key_hint, and it never round-trips.
    {
      // M1 — /api/models/credentials {GET,POST} + /:provider DELETE extracted to
      // `./routes/credentialRoutes`. Same auth (the `/api/*` umbrella above).
      const resp = await handleCredentialRoutes(request, url, {
        identity,
        getRegistryStub: () => getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    // BYO Discord bot config. POST validates the token
    // against Discord (/users/@me) server-side and derives bot_id +
    // username; the token is write-only from then on. One channel
    // belongs to exactly one bot (env channels included).
    {
      // M1 — Discord BYO bot config routes (GET/POST /api/channel/discord/bots +
      // /:id DELETE) extracted to `./routes/discordBotRoutes`. Same auth umbrella.
      const resp = await handleDiscordBotRoutes(request, url, {
        env,
        identity,
        getRegistryStub: () => getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    {
      // M1 — model-provider discover (GET /api/models/providers/:p/models) +
      // enable (POST …/enabled) extracted to `./routes/modelProviderRoutes`.
      const resp = await handleModelProviderRoutes(request, url, {
        identity,
        getRegistryStub: () => getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    // `POST /api/sandbox/exec` admin-smoke route extracted
    // to `./routes/sandboxExecRoutes.ts` (was an earlier revision inline body).
    // Auth umbrella `requireSecret(...)` above stays in this
    // composition root; the facade returns `null` for path/method
    // mismatch so we fall through to the next route family. The
    // original inline gate was `pathname === X && method === Y`, so
    // fall-through (not 405) is the preserved semantic.
    {
      const resp = await handleSandboxExecRoutes(request, url, env);
      if (resp !== null) return resp;
    }

    // `/api/inspect/*` GET routes extracted to
    // `./routes/inspectRoutes.ts`. Delegation dispatches all read-only
    // inspect GETs; POST inspect routes (approvals/request, decide,
    // replay-consume, patch-artifacts/propose, patch-artifacts/apply-dry-run)
    // intentionally stay below in this file. When the route module
    // returns null (no inspect-GET branch matched), execution falls
    // through to the inline POST handlers and subsequent dispatch.
    if (
      (url.pathname === "/api/inspect" || url.pathname.startsWith("/api/inspect/")) &&
      (request.method === "GET" ||
        // the executor trigger is the one POST handled by the
        // inspect module (the handler runs before its GET-only guard).
        (request.method === "POST" && url.pathname === "/api/inspect/workflow-runs/execute") ||
        // the memory-consolidation trigger is also a POST.
        (request.method === "POST" && url.pathname === "/api/inspect/memory/consolidate") ||
        // 2026-06-27 — the memory-prune lever (forget one / all) is also a POST.
        (request.method === "POST" && url.pathname === "/api/inspect/memory/forget") ||
        // 2026-06-30 — the tool-result truncation trigger is also a POST.
        (request.method === "POST" && url.pathname === "/api/inspect/compact-messages") ||
        // operator archive + memory migration drivers.
        (request.method === "POST" && url.pathname === "/api/inspect/operator-archive-migrate") ||
        (request.method === "POST" && url.pathname === "/api/inspect/operator-memory-migrate") ||
        // operator routing cutover / rollback.
        (request.method === "POST" && url.pathname === "/api/inspect/operator-route-cutover") ||
        // one-time lineage backfill (admin maintenance).
        (request.method === "POST" && url.pathname === "/api/inspect/agent-lineage-backfill") ||
        // spawned-agent lifecycle sweep (admin maintenance).
        (request.method === "POST" && url.pathname === "/api/inspect/agent-lifecycle-sweep") ||
        // FTS backfill driver (admin maintenance).
        (request.method === "POST" && url.pathname === "/api/inspect/fts-backfill"))
    ) {
      const resp = await handleApiInspect(request, url, {
        env,
        getAgentThursdayStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
        // same resolution as getAgentThursdayStub, name form.
        getCanonicalContextName: () => getCanonicalActiveContextDoName(env, request),
        // the operator's own DO (A1 Phase 2 migration target).
        getOperatorStub: () => getAgentThursdayStubByName(env, OPERATOR_INSTANCE),
        getChannelHubStub: () =>
          getAgentByName<Env, ChannelHubAgent>(
            env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
            CHANNEL_HUB_INSTANCE,
          ),
        getContentHubStub: () =>
          getAgentByName<Env, ContentHubAgent>(
            env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          ),
        // registry DO stub for `/api/inspect/agents`.
        // Same DO that `handleAgentProfileRoutes` reads from.
        getRegistryStub: () =>
          getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    // skillset runtime HTTP route family extracted to
    // `./routes/skillsetRuntimeRoutes.ts`. Composition root injects
    // the canonical-active AgentThursdayAgent stub resolver and env. The
    // route module covers `/api/skillset/runtime`, `/reload`,
    // `/disable`, `/enable` and returns `null` for fall-through
    // (including method mismatch) so execution falls through to
    // subsequent `/api/*` handlers below. Status mapping
    // (400/404/409 for disable; 400/404 for enable) preserved
    // verbatim inside the route module.
    if (url.pathname.startsWith("/api/skillset/")) {
      const resp = await handleSkillsetRuntimeRoutes(request, url, {
        getActiveStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
        env,
      });
      if (resp !== null) return resp;
    }

    // workspace artifact share API v1. Auth-gated via the
    // global `/api/*` requireSecret (above). Producer/read share the
    // same secret in v1; auth split is a follow-up (see card body
    // `Scope constraints`). Routes go through the canonical-active
    // AgentThursdayAgent stub so all validation, secret scan, size caps,
    // sha256 computation, and audit events live in one place.
    //
    //   POST /api/artifact/<card_id>/<filename>
    //     body: JSON { type, source_agent, mime?, notes?,
    //                  producer_user_id?, content }
    //     → 200 envelope (with server-computed sha256 + size_bytes)
    //     → 400 invalid_*  (card_id, filename, type, source_agent,
    //                       content_required)
    //     → 413 oversize   (size exceeds 245c §9.2 cap for type)
    //     → 422 secret_pattern (245c §9.3 hit)
    //     → 403 denied_path (denylisted segment / prefix)
    //   GET  /api/artifact/<card_id>/<filename>
    //     → 200 { envelope, content }
    //     → 404 not_found
    //   GET  /api/artifact/<card_id>
    //     → 200 { card_id, envelopes: [...] } (empty list if no writes yet)
    //
    // No response field echoes any server-side secret value; only
    // user-provided fields and server-computed digests are returned
    // (245c §9.3 / 245b parity).
    if (url.pathname.startsWith("/api/artifact/")) {
      // handler body lives in `./routes/artifactRoutes.ts`.
      // Stub resolution stays here (composition root) so the route
      // module never imports `getCanonicalActiveAgentThursdayAgentStub` or
      // `DEMO_INSTANCE`. Path parsing, method routing, and error
      // code → HTTP status mapping preserved verbatim in the route.
      const stub = await getCanonicalActiveAgentThursdayAgentStub(env, request);
      return handleApiArtifact(stub, request, url);
    }

    // M9.0 manager skillset dispatch. Resolves
    // `manager.*` adapters from the registry; status mapping is
    // richer than fyimd because manager tools use `{ok, error}` and
    // `{status, reason}` envelopes (see `dispatchManagerRoutes`).
    if (url.pathname.startsWith("/api/dispatch/manager/")) {
      const resp = await handleDispatchManagerRoutes(request, url, { env });
      if (resp !== null) return resp;
    }

    // dispatch route delegated to skillsetRuntimeRoutes
    // module. Behavior preserved: POST only, missing handler → 500,
    // success returns adapter evidence with HTTP 200.
    if (url.pathname === "/api/dispatch/skillset/runtime_summary") {
      const resp = await handleSkillsetRuntimeRoutes(request, url, {
        getActiveStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
        env,
      });
      if (resp !== null) return resp;
    }

    // `/api/dev-shell/*` HTTP route handling extracted to
    // `./routes/devShellRoutes.ts`. Single delegation; module returns
    // null when no `/api/dev-shell/*` branch matches so execution falls
    // through to the remaining `/api/*` handlers below.
    if (url.pathname.startsWith("/api/dev-shell/")) {
      const resp = await handleDevShell(request, url, {
        getActiveStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
      });
      if (resp !== null) return resp;
    }
    // R4 inspect mutation POSTs (approvals/request/decide/
    // replay-consume, patch-artifacts/propose/apply-dry-run) extracted
    // to `routes/inspectMutationRoutes.ts`. Composition root injects
    // the ChannelHubAgent stub resolver; the route module returns
    // `null` for fall-through to R5 codemode-probe below.
    {
      const resp = await handleInspectMutations(request, url, {
        getChannelHubStub: () =>
          getAgentByName<Env, ChannelHubAgent>(
            env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
            CHANNEL_HUB_INSTANCE,
          ),
      });
      if (resp !== null) return resp;
    }
    // `POST /api/admin/codemode-probe` handler body lives in
    // `./routes/adminRoutes.ts`. Composition root resolves the registry
    // stub via `getAgentByName(env.AgentThursdayAgent, DEMO_INSTANCE)` inside
    // the module; module returns null on path/method mismatch so we
    // fall through to the next handler. Auth still gated by the
    // composition-root `/api/*` umbrella above.
    {
      const resp = await handleAdminRoutes(request, url, env);
      if (resp !== null) return resp;
    }

    // handler body lives in `./routes/diagRoutes.ts`. Auth gating
    // is preserved by the composition root above (this branch sits inside
    // the existing `/api/*` auth umbrella).
    if (url.pathname === "/api/diag/dispatch" && request.method === "POST") {
      return handleDiagDispatch(request, env);
    }

    // workspace file manager (read-only).
    // handler bodies live in `./routes/workspaceRoutes.ts`.
    // Composition root resolves the canonical-active stub; route
    // module preserves error mapping (`workspaceFileError`) and
    // `WorkspaceFileListSchema` / `WorkspaceFileContentSchema`
    // boundary validation.
    if (url.pathname === "/api/workspace/files" && request.method === "GET") {
      const stub = await getCanonicalActiveAgentThursdayAgentStub(env, request);
      return handleApiWorkspaceFiles(stub, url.searchParams);
    }

    if (url.pathname === "/api/workspace/file" && request.method === "GET") {
      const stub = await getCanonicalActiveAgentThursdayAgentStub(env, request);
      return handleApiWorkspaceFile(stub, url.searchParams);
    }

    // `/api/channel/*` + PUBLIC `/discord/interactions` HTTP
    // route handling extracted to `./routes/channelRoutes.ts`. Single
    // delegation block covers all 12 channel + the public Discord HTTP
    // Interactions endpoint. Module returns null when no branch matches
    // so execution falls through to remaining handlers (incl. the
    // `/test/discord-mock/*` block immediately below — kept inline per
    // 242z3 spec). `/discord/interactions` is PUBLIC: the `/api/`/
    // `/cli/`/`/demo/` umbrella above does NOT fire on `/discord/`, and
    // the route module verifies Discord's Ed25519 signature itself.
    if (
      url.pathname.startsWith("/api/channel/") ||
      url.pathname === "/discord/interactions"
    ) {
      const resp = await handleChannel(request, url, {
        env,
        // M9.2 — resolved tenant identity for conversation-binding owner-scoping
        // (absent header ⇒ admin/operator console, unrestricted; proxied user ⇒ scoped).
        identity,
        getChannelStub: () => getAgentByName<Env, ChannelHubAgent>(
          env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
          CHANNEL_HUB_INSTANCE,
        ),
        autoRouteAfterIngest,
        // stored-bot channel allowlist merge on direct ingest.
        getRegistryStub: () => getRegistryStub(env),
        // an earlier revision v2 — let the discord-direct handler defer the
        // first-chunk routePending via Worker ctx.waitUntil so
        // multipart continuations have time to merge into the anchor.
        ctx,
      });
      if (resp !== null) return resp;
    }

    // Discord REST mock for smoke testing. When operators
    // point DISCORD_API_BASE_URL at this prefix, sendDiscordMessage hits this
    // endpoint instead of discord.com. Returns a Discord-shaped {id} so the
    // sender can record providerMessageId. NOT auth-gated (the worker's own
    // sender doesn't carry X-AgentThursday-Secret to "Discord"); harmless if hit
    // unsolicited (no state change).
    if (url.pathname.startsWith("/test/discord-mock/") && request.method === "POST") {
      const mockId = `mock-${crypto.randomUUID()}`;
      return new Response(JSON.stringify({ id: mockId }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // `GET /api/memory` handler body lives in
    // `./routes/memoryRoutes.ts`. an earlier revision Agent Memory v1 snapshot;
    // an earlier revision routes through canonical active context so the Memory
    // tab reflects the active session's `agent_memories` /
    // `memory_knowledge`, not DEMO_INSTANCE's (mirrors `/api/inspect`
    // and `/api/workspace`). Module returns null on path/method
    // mismatch so we fall through to the next handler. Auth still
    // gated by the composition-root `/api/*` umbrella above.
    {
      const resp = await handleMemoryRoutes(request, url, {
        getActiveStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
      });
      if (resp !== null) return resp;
    }

    // M9.0 AgentProfile create/list/read API. Routes go
    // through the DEMO_INSTANCE registry DO so AgentProfile rows are
    // global config (visible across contexts), not scoped to a single
    // context DO. Auth gated by the umbrella `/api/*` requireSecret
    // above; module returns `null` for fall-through.
    {
      const resp = await handleAgentProfileRoutes(request, url, {
        identity,
        getRegistryStub: () =>
          getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    // P1 end-user accounts (admin-gated). Resolve at gateway
    // login; list/approve from the console. Auth via the umbrella gate above.
    {
      const resp = await handleUserRoutes(request, url, {
        identity,
        getRegistryStub: () =>
          getRegistryStub(env),
      });
      if (resp !== null) return resp;
    }

    // 2026-06-23 — user document upload (/api/manager/documents). Must run BEFORE
    // the general /api/manager/* handler. Owner-scoped via the session identity;
    // env.AI.toMarkdown extracts text (raw files are never stored).
    {
      const resp = await handleDocumentRoutes(request, url, {
        identity,
        getRegistryStub: () =>
          getRegistryStub(env),
        convertEnv: {
          AI: env.AI as unknown as ConverterEnv["AI"],
          FYIMD_API_KEY: (env as { FYIMD_API_KEY?: string }).FYIMD_API_KEY,
          FYIMD_API_BASE: (env as { FYIMD_API_BASE?: string }).FYIMD_API_BASE,
          FYIMD_POLL_MS: (env as { FYIMD_POLL_MS?: string }).FYIMD_POLL_MS,
          DOC_CONVERT_TIMEOUT_MS: (env as { DOC_CONVERT_TIMEOUT_MS?: string }).DOC_CONVERT_TIMEOUT_MS,
        },
      });
      if (resp !== null) return resp;
    }

    // M9.0 manager skillset HTTP surface (/api/manager/*).
    // Shares validation + persistence with the dispatch adapters via
    // `src/agent/managerOps.ts`. Auth gated by the umbrella
    // `/api/*` requireSecret above; module returns `null` for
    // path / method mismatch so we fall through.
    {
      const resp = await handleManagerRoutes(request, url, {
        env: { AgentThursdayAgent: env.AgentThursdayAgent },
        // async-default manager message path uses
        // ctx.waitUntil to park the dispatch so the HTTP envelope
        // returns quickly while the manager loop runs in background.
        ctx: { waitUntil: (p) => ctx.waitUntil(p) },
        // tenant identity for owner-scoped manager ops + dispatch.
        identity,
      });
      if (resp !== null) return resp;
    }

    // M9.0 `POST /api/agent-runs` skeleton.
    // adds durable `agent_run` row on the registry DO,
    // real `AgentThursdayAgent` invocation inside `AgentRunWorkflow.step.do`,
    // and `GET /api/agent-runs/:id`. Routes call the registry stub
    // for row reads; the ops layer calls it for row inserts.
    // Auth gated by the umbrella `/api/*` requireSecret above; module
    // returns `null` for path / method mismatch so we fall through.
    {
      const getRegistryStub = () =>
        getAgentThursdayStubByName(env, DEMO_INSTANCE);
      const resp = await handleAgentRunRoutes(request, url, {
        host: {
          workflow: env.AGENT_RUN_WORKFLOW,
          getRegistryStub,
        },
        workflowInstance: (id: string) => env.AGENT_RUN_WORKFLOW.get(id),
        // scope the activities surface to the gateway-verified tenant.
        identity,
      });
      if (resp !== null) return resp;
    }

    // `/api/content/*` extracted to `routes/contentHubRoutes.ts`.
    // Composition root injects the ContentHubAgent stub resolver; the route
    // module returns `null` for fall-through to `/api/browser/run` below.
    {
      const resp = await handleApiContent(request, url, {
        getContentHubStub: () =>
          getAgentByName<Env, ContentHubAgent>(
            env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          ),
        // Registry DO for the BYO-key store (Unit 3 registration stores the
        // github PAT under the owner's encrypted user_provider_credential).
        getRegistryStub: () =>
          getRegistryStub(env),
        // BYO GitHub — the server-resolved identity (from the gateway-verified
        // X-AgentThursday-User-Id at line ~7795, NEVER the body). Reads owner-scope to it
        // (admin → operator; scoped user → own sources); registration stamps the
        // owner from it. Single source of truth for who the caller is.
        identity,
      });
      if (resp !== null) return resp;
    }

    // `POST /api/browser/run` (was an earlier revision inline body)
    // extracted to `./routes/browserRoutes.ts`. Auth umbrella above
    // still gates `/api/*`; module returns `null` for path/method
    // mismatch so we fall through to the next route family. SSRF
    // guard still lives inside `runBrowser`.
    {
      const resp = await handleBrowserRoutes(request, url, env);
      if (resp !== null) return resp;
    }

    // `/cli/*` HTTP route handling extracted to
    // `./routes/cliRoutes.ts`. Single delegation; module returns null
    // when no `/cli/*` branch matches so execution falls through to
    // `routeAgentRequest` then `env.ASSETS.fetch` below.
    if (url.pathname.startsWith("/cli/")) {
      const resp = await handleCli(request, url, {
        env,
        getActiveStub: () => getCanonicalActiveAgentThursdayAgentStub(env, request),
        resolveActiveRoute: () => resolveCanonicalActiveContextRoute(env, request),
        buildDashboardSection: (core) =>
          buildDashboardSectionFree(
            {
              getChannelHubStub: () =>
                getAgentByName<Env, ChannelHubAgent>(
                  env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
                  CHANNEL_HUB_INSTANCE,
                ),
              readWorkerVersionMetadata: () => readWorkerVersionMetadata(env),
            } satisfies DashboardSectionDeps,
            core,
          ),
      });
      if (resp !== null) return resp;
    }

    // M7.1 an earlier revision: anything not handled above falls through to:
    //   1. agents library router (Durable Object websockets etc.)
    //   2. static SPA assets from web/dist (binding ASSETS in wrangler.toml)
    const agentResp = await routeAgentRequest(request, env);
    if (agentResp) return agentResp;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
