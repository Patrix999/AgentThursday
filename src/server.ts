import { routeAgentRequest, getAgentByName, unstable_callable as callable } from "agents";
import { AgentSearchProvider, type SessionMessage } from "agents/experimental/memory/session";
import { Think, Session, type StepContext, type StreamableResult } from "@cloudflare/think";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createWorker } from "@cloudflare/worker-bundler";
import { getSandbox } from "@cloudflare/sandbox";
import { createWorkersAI } from "workers-ai-provider";
import { tool } from "ai";
import { toolApprovalUpdate, applyToolUpdate } from "agents/chat";
import { z } from "zod";
import type { AgentNamespace } from "agents";
import type { AgentThursdayState, HumanResponse, RuntimeMode, RecoveryPolicy, RecoveryReview, RecoveryTimelineItem, ActionResult, OutcomeVerification, MutationReview, TaskObject, TaskLifecycle, LoopContract, DeliverableConvergence, ApprovalPolicy, DeveloperLoopReview, CliSession, CliResultView, M3CliLoopStep, M3CliLoopDemo, M4TuiWorkflowStep, M4TuiWorkflowDemo } from "./types";
import { getIntelligenceSignal, getProfileAwareness } from "./intelligence";
import {
  WorkspaceSnapshotSchema,
  InspectSnapshotSchema,
  type WorkspaceSnapshot,
  type SessionView,
  type TaskView,
  type MessageView,
  type ApprovalView,
  type ArtifactView,
  type InspectEntry,
  type InspectSnapshot,
  type ContentAuditSummary,
  type LadderTierEntry,
  type TraceEvent,
  type ToolEvent,
  type DegradationDiagnostics,
  type TaskDegradationSummaryView,
  type SupplierSignalSummaryView,
  type TruthfulnessViolationView,
  type ActionUiIntent,
  WorkspaceFileListSchema,
  WorkspaceFileContentSchema,
  type WorkspaceFileList,
  type WorkspaceFileContent,
  BrowserRunRequestSchema,
  BrowserRunResultSchema,
  type BrowserRunResult,
  MemorySnapshotSchema,
  type MemoryEntry,
  type MemoryRecallMatch,
  type MemorySnapshot,
  type MemoryType,
} from "./schema";
import { requireSecret, CORS_HEADERS } from "./auth";
import { listWorkspaceDir, readWorkspaceFile } from "./workspaceFiles";
import { runBrowser, BrowserError } from "./browser";
import { findToolClaims, checkTruthfulness, renderTruthfulnessWarning } from "./toolTruthfulness";
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
  isResumeIntent,
  renderAwaitingResumeMessage,
  renderPauseMessage,
  shouldPauseForNeedsHuman,
} from "./pauseDecision";
import { buildActionUiIntents, type ActionUiIntentSourceRow } from "./actionUiIntents";
import {
  ChannelMessageEnvelopeSchema,
  ChannelInboundResultSchema,
  ChannelSnapshotSchema,
  ChannelRoutePendingResultSchema,
  EnqueueOutboundTextRequestSchema,
  EnqueueOutboundApprovalRequestSchema,
  EnqueueOutboundResultSchema,
  DeliverPendingResultSchema,
  ApprovalResolveRequestSchema,
  ApprovalResolveResultSchema,
  ChannelCompactSummarySchema,
  ContentSourcesResponseSchema,
  ContentReadResponseSchema,
  ContentListResponseSchema,
  ContentReadRequestSchema,
  ContentListRequestSchema,
  ContentSearchRequestSchema,
  ContentSearchResponseSchema,
} from "./schema";
import { CHANNEL_HUB_INSTANCE } from "./channel";
import { ChannelHubAgent } from "./channelHub";
import { ContentHubAgent, CONTENT_HUB_INSTANCE } from "./contentHub";
import { DiscordGatewayAgent, DISCORD_GATEWAY_INSTANCE } from "./discordGatewayAgent";
import { OpenClawDiscordInboundSchema, normalizeOpenClawPayload } from "./discordBridge";
import {
  verifyDiscordSignature,
  loadDirectDiscordConfig,
  applyDirectFilters,
  DiscordInteractionSchema,
  extractSlashPrompt,
  normalizeSlashInteraction,
  decodeApprovalCustomId,
} from "./discordDirect";

export type { AgentThursdayState };
export { Sandbox } from "@cloudflare/sandbox";
export { ChannelHubAgent };
export { ContentHubAgent };
export { DiscordGatewayAgent };

const SOUL = `你是 AgentThursday Agent —— 一个云原生工作 agent。
你运行在 Cloudflare Durable Objects 上，具备跨 hibernate 的持久 identity 与 session 连续性。
你的首要目标是协助操作员推进 AgentThursday 项目，保持工作的连续性与可回放性。
在模型水平较低时（safer mode），你只推进最优先的单一下一步，不承诺超出当前能力的目标。

## 工具调用规则（强制）
你拥有工具可以调用。遇到可执行动作时，你必须优先调用对应工具，不得仅用文字声称"已完成"。
- 推进 kanban 卡状态 → 必须调用 advance_kanban_card 工具
- 写入进度 checkpoint → 必须调用 write_checkpoint 工具
- 查看项目状态 → 必须调用 review_project_status 工具
- 读写 workspace 文件 → 必须调用 read / write / edit 工具
不调用工具而只用文字汇报"已执行"是错误行为。

**两条更严格的子规则**（真实性）：
- 任何 tool call 之后，**必须再产一段 assistant 文本**综合 tool 的结果（哪怕一句话），然后才能结束本轮。结束时 last assistant message 不能是"正在调用 X..."这种 progress 文本——那会让 channel 层把过期 progress 当成最终回复发出去。如果 tool 失败、无结果可综合，也要明确说明失败 + 你的下一步打算。
- 你**不得**伪造 tool 调用：不得在没真发起 tool dispatch 的情况下用 *"我刚才调用了 X..."* / *"调用 X 失败"* 这种声明。如果你打算调，就真调；如果你没调，就别说。系统在 channel 层有 truthfulness gate 会自动 cross-validate（），fabrication 会被 ⚠️ 标出来。

## 长期记忆规则（Agent Memory v1）
你有四个 memory 工具：remember / recall / list_memories / forget。
- 学到稳定项目事实或操作规约 → remember({type:"fact"|"instruction", key, content})；同 key 自动 supersede 旧版
- 关键事件（部署 / 决策 / 失败）→ remember({type:"event", content})（无 key）
- 当前 active 任务上下文 → remember({type:"task", content})（短寿命）
- 回答任何依赖历史项目知识的问题前 → 先 recall({query})
- 错的 / 已过时的 memory → forget({id, reason})（软删除，不物理 delete）
- **不要** 把 secret / 临时 noise / 大段 raw log 写进 memory
- checkpoint 与 review_note 是任务进度日志，与 memory 不同：memory 是可检索的命题；checkpoint/note 是过程记录。

## Content Sources vs Workspace（affordance）

Tier 0 workspace 是**你自己的**活跃工作区——scratch、drafts、任务输出、你显式创建的 artifacts。它**不会**自动同步 AgentThursday 源码、GitHub repos、OneDrive/Dropbox 文件夹、协作文档、邮件附件或网页内容。

外部项目代码与人类协作资料统称 **Content Sources**。**当前部署中 ContentHub 工具（\`content_sources\` / \`content_list\` / \`content_read\` / \`content_search\`）已生产可用**，必须通过它们访问外部内容，并在推理与回答中保留 provenance（\`sourceId\` / \`pathOrId\` / \`revision\`）。

### HARD INVARIANTS（不得违反）
- **不得**声称读取过任何外部项目文件、repo 源码、网盘文档、协作文档、邮件附件或网页内容，除非该读取**真实**来自带 provenance 的 content/source 工具调用结果。
- **不得**把 Tier 0 workspace 当作 AgentThursday repo 或任何外部 source 的镜像。Workspace 不会自动同步任何外部资料。
- **不得**在 source 不可用时静默回退到记忆、猜测或陈旧上下文——必须如实说"该 source 不可用"。
- 外部内容**不会**自动进入 Agent Memory；只有显式 \`remember\` 且通过 no-secret/noise 规则的稳定事实才允许写入。

### GUIDELINES（用判断）
- 当出现一个不熟悉的外部 source（你未在本 session 调用过）→ 先 \`content_sources({ includeHealth: true })\` 确认它存在且可用。
- 当 session 已绑定一个 active sourceId（你已成功调用过）→ 可以直接 \`content_read\` / \`content_list\` / \`content_search\`，不必每次重新探活；回答中保留 \`sourceId / pathOrId / revision\` 作为引用证据。
- 当 \`content_read\` 返回 \`truncated: true\` → 说明你看到的是前缀，应缩小 \`path\` 范围或调大 \`maxBytes\` 重试，**不**得当成完整文件处理。
- 当 \`content_search\` 返回 \`searchMode: "degraded-grep"\` 或 \`searchCoverage: "partial"\` → 必须在回答中明说"这是部分覆盖，不是权威结果"。

## Execution Ladder 路由规则（强制）
选择执行层时，遵循**最低有效 tier 原则**——能在低层完成的任务不得升到高层：

- **Tier 0 — workspace 工具**（read / write / list / edit）：你**自己的**活跃工作区文件读写、目录遍历——scratch / drafts / 任务输出 / 你显式创建的 artifacts。**不是** AgentThursday repo 或外部 source 的镜像（外部资料走 Content Sources，见上节）。首选用于自己产出物，开销最低。
- **Tier 1 — execute 工具**（codemode）：需要运行 JS/TS 逻辑时使用，无 npm 依赖时选此层。
- **Tier 2 — execute 工具**（codemode + npm deps）：同 Tier 1，已内置 zod 等依赖，自动生效，无需额外选择。
- **Tier 3 — browse 工具**（headless browser）：网页访问 / Web UI smoke / DOM 文本/链接抓取 / 截图证据。
  专门用于 *任意 URL* 的页面级任务：检查页面是否能打开、抓取标题/正文/链接、截图。
  不要用 Tier 4 sandbox 跑 curl/wget 来代替；那是错误的层级。
  也不要用 Tier 3 跑 repo build / mutation / 任意 shell（那是 Tier 4）。
- **Tier 4 — sandbox_exec 工具**（container）：仅在需要完整 OS 环境时才使用：Python/Go/Rust toolchain、apt/pip install、repo 级 build / clone / mutation、长进程。Tier 4 启动开销最高。

按层级选择小结：
- 自己工作区文件读写（scratch / drafts / outputs）→ Tier 0
- 外部项目源码 / 文档 / 协作资料 → Content Sources（\`content_*\` 工具，见上节），不是 Tier 0
- 纯 JS/TS 计算 → Tier 1/2
- 网页/UI/DOM/screenshot → Tier 3
- repo / build / shell → Tier 4

旧本地 bridge（exec-node）已废弃，禁止通过任何路径调用。`;

const DEMO_INSTANCE = "agent-thursday-dev";

// tool names the truthfulness gate watches for in assistant
// text. Must stay aligned with `getTools()` registration; if a new tool is
// added, add its name here so claims about it are validated. Workspace tools
// (read/write/list/edit) come from `createWorkspaceTools` and are addressed
// by their bare names below.
const KNOWN_TOOL_NAMES: readonly string[] = [
  "review_project_status",
  "write_checkpoint",
  "review_note",
  "advance_kanban_card",
  "execute",
  "sandbox_exec",
  "remember",
  "recall",
  "list_memories",
  "forget",
  "browse",
  "read",
  "write",
  "list",
  "edit",
  // ContentHub external source tools.
  "content_sources",
  "content_list",
  "content_read",
  // ContentHub literal search.
  "content_search",
];
const DOGFOOD_TASK = "如何使用新构建的 agent 开发当前项目？";

type EventLogRow = { event_type: string; payload: string; created_at: number; trace_id: string | null };


const CLI_COMMANDS: CliSession["availableCommands"] = [
  { name: "submit",   kind: "loop-advance", description: "提交新任务，启动 developer loop",                endpoint: "/cli/submit",   method: "POST" },
  { name: "status",   kind: "read",         description: "查看当前 CLI session / loop 状态",              endpoint: "/cli/status",   method: "GET"  },
  { name: "continue", kind: "loop-advance", description: "执行当前 committedAction，推进 loop",           endpoint: "/cli/continue", method: "POST" },
  { name: "approve",  kind: "write",        description: "处理人类确认：响应 escalation 或 confirm mutation", endpoint: "/cli/approve",  method: "POST" },
  { name: "result",   kind: "read",         description: "查看当前 deliverable 与 reviewer 结论",         endpoint: "/cli/result",   method: "GET"  },
];

type DebugTraceShape = {
  lastAssistantSummary: string;
  recentToolEvents: { type: string; summary: string; at: number }[];
  pendingApprovalReason: string | null;
  lastActionResult: { actionType: string; outcome: string; summary: string } | null;
  lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null;
};

type PendingMutationRow = { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; created_at: number };

function buildWorkspaceSnapshot(input: {
  agentThursdayState: AgentThursdayState;
  cliSession: CliSession;
  loopReview: DeveloperLoopReview;
  approvalPolicy: ApprovalPolicy;
  pendingToolApproval: { toolCallId: string; toolName: string } | null;
  debugTrace: DebugTraceShape;
  deliverableGate: DeliverableConvergence;
  pendingMutations: PendingMutationRow[];
  eventLogCount: number;
}): WorkspaceSnapshot {
  const { agentThursdayState, cliSession, loopReview, approvalPolicy, pendingToolApproval, debugTrace, deliverableGate, pendingMutations, eventLogCount } = input;
  const now = Date.now();

  const session: SessionView = {
    sessionId: cliSession.sessionId,
    instanceName: cliSession.instanceName,
    agentState: agentThursdayState.status,
    loopStage: cliSession.loopStage,
    autoContinue: cliSession.autoContinue,
  };

  const currentTask: TaskView | null =
    cliSession.taskId && cliSession.taskTitle && cliSession.taskLifecycle
      ? {
          taskId: cliSession.taskId,
          title: cliSession.taskTitle,
          lifecycle: cliSession.taskLifecycle,
          loopStage: cliSession.loopStage,
          readyForNextRound: cliSession.readyForNextRound,
          ladderTier: debugTrace.lastLadderTier?.tier ?? null,
          ladderReason: debugTrace.lastLadderTier?.reason ?? null,
        }
      : null;

  // summaryStream: only human-readable text. Never include raw event_payload
  // or tool call JSON — those are inspect-layer responsibilities ().
  const summaryStream: MessageView[] = [];
  if (debugTrace.lastAssistantSummary) {
    summaryStream.push({
      id: `assistant-${debugTrace.lastLadderTier?.at ?? now}`,
      kind: "assistant",
      text: debugTrace.lastAssistantSummary,
      at: debugTrace.lastLadderTier?.at ?? now,
    });
  }
  if (loopReview.summary) {
    summaryStream.push({
      id: `summary-${now}`,
      kind: "summary",
      text: loopReview.summary,
      at: now,
    });
  }
  for (const intervention of approvalPolicy.interventions) {
    if (intervention.active) {
      summaryStream.push({
        id: `system-${intervention.kind}`,
        kind: "system",
        text: `[${intervention.kind}] ${intervention.reason}`,
        at: now,
      });
    }
  }

  let pendingApproval: ApprovalView | null = null;
  if (pendingToolApproval) {
    pendingApproval = {
      id: `tool-${pendingToolApproval.toolCallId}`,
      kind: "tool",
      reason: debugTrace.pendingApprovalReason ?? "Tool call requires human approval",
      toolName: pendingToolApproval.toolName,
      toolCallId: pendingToolApproval.toolCallId,
      createdAt: now,
    };
  } else if (pendingMutations.length > 0) {
    const m = pendingMutations[0];
    pendingApproval = {
      id: `mutation-${m.id}`,
      kind: "mutation",
      reason: `Kanban mutation requires confirmation: ${m.mutation_type}`,
      diffSnippet: `${m.description}\n${m.diff_hint}`.slice(0, 600),
      cardRef: m.card_ref || null,
      mutationId: m.id,
      createdAt: m.created_at,
    };
  }

  let replyNeed: WorkspaceSnapshot["replyNeed"] = null;
  if (agentThursdayState.waitingForHuman && agentThursdayState.pendingHelpRequest) {
    const hr = agentThursdayState.pendingHelpRequest;
    replyNeed = {
      question: `${hr.whyBlocked}\n\nNeeded: ${hr.neededFromHuman}`,
      sinceAt: agentThursdayState.updatedAt,
    };
  }

  let latestResult: ArtifactView | null = null;
  if (deliverableGate.deliverable.readyForReview && deliverableGate.deliverable.resultSummary) {
    latestResult = {
      id: `deliverable-${deliverableGate.deliverable.taskId ?? "current"}`,
      kind: "deliverable",
      title: deliverableGate.deliverable.taskTitle ?? "Deliverable",
      textSummary: deliverableGate.deliverable.resultSummary,
      createdAt: deliverableGate.deliverable.producedAt ?? now,
    };
  } else if (agentThursdayState.lastActionResult) {
    const ar = agentThursdayState.lastActionResult;
    latestResult = {
      id: `actionResult-${ar.recordedAt}`,
      kind: "actionResult",
      title: `${ar.actionType} → ${ar.outcome}`,
      textSummary: ar.summary,
      createdAt: ar.recordedAt,
    };
  }

  const inspectEntry: InspectEntry = {
    hasLadder: !!debugTrace.lastLadderTier,
    hasTrace: eventLogCount > 0,
    hasToolEvents: debugTrace.recentToolEvents.length > 0,
  };

  return { session, currentTask, summaryStream, pendingApproval, replyNeed, latestResult, inspectEntry };
}

function buildCliResultView(session: CliSession, loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): CliResultView {
  const activeInterventions = approvalPolicy.interventions.filter(i => i.active).map(i => `[${i.kind}] ${i.reason}`);
  return {
    taskId: session.taskId,
    taskTitle: session.taskTitle,
    taskLifecycle: session.taskLifecycle,
    loopStage: session.loopStage,
    deliverableFormed: deliverableGate.deliverable.readyForReview,
    deliverableSummary: deliverableGate.deliverable.resultSummary,
    gatePassed: deliverableGate.reviewGate.gate === "open",
    gateReason: deliverableGate.reviewGate.reason,
    readyForNextRound: session.readyForNextRound,
    activeInterventions,
    suggestedNextCommand: session.suggestedNextCommand,
    loopSummary: loopReview.summary,
  };
}

function buildM3CliLoopDemo(session: CliSession, loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): M3CliLoopDemo {
  const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
  const steps: M3CliLoopStep[] = session.availableCommands.map(cmd => {
    let statusNote: string;
    if (cmd.name === "submit") {
      statusNote = session.taskId
        ? `✓ task: ${session.taskTitle ?? "—"}  lifecycle: ${session.taskLifecycle}`
        : "→ 发送 POST /cli/submit { task } 启动 loop";
    } else if (cmd.name === "status") {
      statusNote = `✓ loopStage: ${session.loopStage}  readyForNextRound: ${session.readyForNextRound}`;
    } else if (cmd.name === "continue") {
      statusNote = session.readyForNextRound
        ? "✓ loop ready — 可执行 continue 推进下一轮"
        : "→ 等待 loop 条件满足后推进";
    } else if (cmd.name === "approve") {
      statusNote = activeInterventionCount > 0
        ? `⚠ ${activeInterventionCount} 个干预点待处理`
        : "✓ 无活跃干预点";
    } else if (cmd.name === "result") {
      statusNote = deliverableGate.deliverable.readyForReview
        ? `✓ deliverable 已形成  gate: ${deliverableGate.reviewGate.gate}`
        : "→ 等待 deliverable 形成后查看";
    } else {
      statusNote = "—";
    }
    return { name: cmd.name, endpoint: cmd.endpoint, method: cmd.method, description: cmd.description, statusNote };
  });
  return {
    loopReady: session.readyForNextRound && activeInterventionCount === 0,
    steps,
    currentLoopStage: session.loopStage,
    readyForNextRound: session.readyForNextRound,
    activeInterventionCount,
    summary: loopReview.summary,
  };
}

function buildM4TuiWorkflowDemo(session: CliSession, loopReview: DeveloperLoopReview, approvalPolicy: ApprovalPolicy, deliverableGate: DeliverableConvergence): M4TuiWorkflowDemo {
  const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
  const interventionClear = activeInterventionCount === 0;

  const TUI_WORKFLOW: Array<{ name: string; endpoint: string; method: "GET" | "POST"; description: string }> = [
    { name: "submit",   endpoint: "/cli/submit",   method: "POST", description: "提交任务，启动 developer loop" },
    { name: "status",   endpoint: "/cli/status",   method: "GET",  description: "观察 loop stage / interventions / readiness" },
    { name: "continue", endpoint: "/cli/continue", method: "POST", description: "执行当前 committedAction，推进 loop" },
    { name: "approve",  endpoint: "/cli/approve",  method: "POST", description: "处理卡点：人类响应或 confirm mutation" },
    { name: "result",   endpoint: "/cli/result",   method: "GET",  description: "查看 deliverable / gate / readiness" },
  ];

  const steps: M4TuiWorkflowStep[] = TUI_WORKFLOW.map(s => {
    let statusNote: string;
    if (s.name === "submit") {
      statusNote = session.taskId
        ? `✓ task active: ${session.taskTitle ?? "—"}  [${session.taskLifecycle}]`
        : "→ 在 INPUT 区按 S 提交任务";
    } else if (s.name === "status") {
      statusNote = `✓ loopStage: ${session.loopStage}  interventions: ${activeInterventionCount}  ready: ${session.readyForNextRound}`;
    } else if (s.name === "continue") {
      statusNote = session.readyForNextRound
        ? "✓ loop ready — 按 C 推进"
        : "→ 等待 loop 条件满足后继续";
    } else if (s.name === "approve") {
      statusNote = activeInterventionCount > 0
        ? `⚠ ${activeInterventionCount} 个卡点待处理 — 按 A 响应`
        : "✓ 无活跃卡点";
    } else {
      statusNote = deliverableGate.deliverable.readyForReview
        ? `✓ deliverable 已形成  gate: ${deliverableGate.reviewGate.gate}`
        : "→ 等待 deliverable 形成";
    }
    return { ...s, statusNote };
  });

  const cloudStateReady = !!session.taskId;
  const workflowReady = cloudStateReady && interventionClear && session.readyForNextRound;

  let summary: string;
  if (!cloudStateReady) {
    summary = "TUI 已就绪，等待提交第一个 task 启动 loop。使用 npm run tui 启动终端界面。";
  } else if (activeInterventionCount > 0) {
    summary = `Loop 推进中，有 ${activeInterventionCount} 个卡点待处理。在 TUI 中按 A 响应。`;
  } else if (session.readyForNextRound) {
    summary = `完整 developer loop 已就绪：task → loop → deliverable → gate open。TUI 端到端链路成立。`;
  } else {
    summary = `Loop 推进中（stage: ${session.loopStage}）。在 TUI 中按 C 继续推进。`;
  }

  return { workflowReady, steps, cloudStateReady, interventionClear, readyForNextMilestone: workflowReady, summary };
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
    updatedAt: Date.now(),
  };

  chatRecovery = true;

  // In-memory token accumulators — reset on DO wake; task-scoped resets when task changes.
  private _sessionTok = { in: 0, out: 0, total: 0, hasData: false };
  private _taskTok = { taskId: null as string | null, in: 0, out: 0, total: 0 };
  private _lastStepModel: { provider: string; modelId: string } | null = null;
  private _lastStepIn: number | null = null;
  // supplier-side degradation signal collector for the
  // current submitTask round. Reset at the top of submitTask, populated by
  // onStepFinish + onError, read at reply finalization.
  private _currentTaskSupplierSignals: SupplierTaskSignals = emptySupplierTaskSignals();
  //  truthfulness verdict for the same round, so
  // the `supplier.signal.summary` event_log row can include
  // `truthfulnessViolationSeen` + `truthfulnessCategory` without changing
  // applyTruthfulnessGate's user-visible behavior. Reset at submitTask top.
  private _currentTaskTruthfulnessVerdict: { violationSeen: boolean; category: string | null } = {
    violationSeen: false, category: null,
  };
  // Tier 2: pre-bundled npm modules for the codemode sandbox. null = not yet initialized.
  // Each value uses the explicit-type Module shape `{ js: source }` so the
  // Workers Loader accepts bare specifier keys like `"zod"` ().
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

  override onStepFinish(ctx: StepContext): void {
    const u = ctx.usage;
    const inp = u?.inputTokens ?? 0;
    const out = u?.outputTokens ?? 0;
    const tot = u?.totalTokens ?? (inp + out);
    if (inp > 0 || out > 0) {
      this._sessionTok = { in: this._sessionTok.in + inp, out: this._sessionTok.out + out, total: this._sessionTok.total + tot, hasData: true };
      this._lastStepIn = inp;
    }
    const currentTaskId = this.agentThursdayState.currentTaskObject?.id ?? null;
    if (this._taskTok.taskId !== currentTaskId) {
      this._taskTok = { taskId: currentTaskId, in: 0, out: 0, total: 0 };
    }
    if (inp > 0 || out > 0) {
      this._taskTok = { ...this._taskTok, in: this._taskTok.in + inp, out: this._taskTok.out + out, total: this._taskTok.total + tot };
    }
    if (ctx.model) this._lastStepModel = { provider: ctx.model.provider, modelId: ctx.model.modelId };

    // capture supplier-side step signal for the current
    // submitTask round. Wrapped in try/catch so a malformed StepContext
    // shape never breaks the main step loop (kanban: fail-soft).
    //  extends this with optional tool-call / tool-result names so
    // the persisted summary event has grep-friendly identifiers, not just
    // counts. Names are capped at the call site to keep payload bounded.
    try {
      const c = ctx as unknown as {
        finishReason?: string;
        toolCalls?: ReadonlyArray<{ toolName?: unknown }>;
        toolResults?: ReadonlyArray<{ toolName?: unknown }>;
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
      this._currentTaskSupplierSignals.steps.push({
        finishReason: c.finishReason,
        toolCallCount: Array.isArray(c.toolCalls) ? c.toolCalls.length : 0,
        toolResultCount: Array.isArray(c.toolResults) ? c.toolResults.length : 0,
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

    // Preserve Agent/Think default error semantics.  detection must
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
        return (async function* () {
          try {
            yield* stream;
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

  private get agentThursdayState(): AgentThursdayState { return this.getConfig() ?? this.defaultAgentThursdayState; }
  private setAgentThursdayState(s: AgentThursdayState): void { this.configure(s); }
  // model dispatch discriminator.
  // Findings so far:
  // - gpt-oss 120b/20b, GLM, Kimi, and Llama Scout can emit raw/inline function JSON.
  // - Fresh DO with Llama Scout still fabricated inline execute JSON instead of framework tool_call.
  // - Test Llama 3.3 70B fast to separate model-specific emission from Workers AI adapter issues.
  // Keep mitigation 1 in place for now while validating dispatch.
  getModel() { return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6"); }
  configureSession(session: Session): Session {
    return session
      .withContext("soul", { provider: { get: async () => `${SOUL}\n\n${this.readKnowledge()}` } })
      .withContext("memory", { description: "工作记忆：当前任务进度、临时笔记、下一步计划", maxTokens: 2000 })
      .withContext("history", { provider: new AgentSearchProvider(this) });
  }

  beforeTurn() {
    return { toolChoice: "auto" as const };
  }

  getTools() {
    return {
      review_project_status: tool({
        description: "读取并汇总当前项目与 agent 状态",
        inputSchema: z.object({}),
        execute: async () => {
          const s = this.getSafeState();
          const knowledge = this.readKnowledge();
          const ar: ActionResult = { actionType: "review-project-status", outcome: "success", summary: `task: ${(s.currentTask ?? "none").slice(0, 80)}`, recordedAt: Date.now() };
          this.setAgentThursdayState({ ...this.agentThursdayState, lastActionResult: ar, updatedAt: Date.now() });
          this.logEvent("tool.review_project_status", { task: s.currentTask });
          return { status: s.status, currentTask: s.currentTask, lastCheckpoint: s.lastCheckpoint, knowledge };
        },
      }),
      write_checkpoint: tool({
        description: "写入当前工作 checkpoint，持久化进度",
        inputSchema: z.object({ content: z.string().describe("checkpoint 内容"), key: z.string().optional().describe("可选 key") }),
        execute: async (input) => {
          const k = input.key ?? `checkpoint-${Date.now().toString(36)}`;
          this.sql`INSERT INTO checkpoints (key, content, source, created_at) VALUES (${k}, ${input.content}, 'tool', ${Date.now()})`;
          const checkpoint = `step:${Date.now()}:${(this.agentThursdayState.currentTask ?? "task").slice(0, 30).replace(/\s+/g, "-")}`;
          const ar: ActionResult = { actionType: "write-checkpoint", outcome: "success", summary: input.content.slice(0, 120), recordedAt: Date.now() };
          this.setAgentThursdayState({ ...this.agentThursdayState, lastCheckpoint: checkpoint, lastActionResult: ar, status: "idle", updatedAt: Date.now() });
          this.logEvent("tool.write_checkpoint", { key: k, checkpoint });
          return { ok: true, key: k, checkpoint };
        },
      }),
      review_note: tool({
        description: "生成当前推进状态 review note，汇总任务进度与建议",
        inputSchema: z.object({ content: z.string().describe("review note 内容") }),
        execute: async (input) => {
          this.sql`INSERT INTO review_notes (content, source, created_at) VALUES (${input.content}, 'tool', ${Date.now()})`;
          const ar: ActionResult = { actionType: "review-note", outcome: "success", summary: input.content.slice(0, 120), recordedAt: Date.now() };
          this.setAgentThursdayState({ ...this.agentThursdayState, lastActionResult: ar, updatedAt: Date.now() });
          this.logEvent("tool.review_note", { contentSnippet: input.content.slice(0, 100) });
          return { ok: true };
        },
      }),
      advance_kanban_card: tool({
        description: "推进当前 kanban 卡，记录推进结果（需要人类确认）",
        inputSchema: z.object({
          card_ref: z.string().describe("卡片引用，如 card-55"),
          description: z.string().describe("推进描述"),
          diff_hint: z.string().describe("预期修改提示"),
        }),
        needsApproval: true,
        execute: async (input) => {
          this.sql`INSERT INTO kanban_mutations (card_ref, mutation_type, description, diff_hint, created_at) VALUES (${input.card_ref}, ${"status-advance"}, ${input.description}, ${input.diff_hint}, ${Date.now()})`;
          const ar: ActionResult = { actionType: "advance-kanban-card", outcome: "success", summary: `kanban mutation recorded — ${input.card_ref}: ${input.description.slice(0, 80)}`, recordedAt: Date.now() };
          this.setAgentThursdayState({ ...this.agentThursdayState, lastActionResult: ar, updatedAt: Date.now() });
          this.logEvent("tool.advance_kanban_card", { cardRef: input.card_ref, descriptionSnippet: input.description.slice(0, 80) });
          return { ok: true, card_ref: input.card_ref };
        },
      }),
      execute: (() => {
        const base = createExecuteTool({
          tools: createWorkspaceTools(this.workspace),
          executor: new DynamicWorkerExecutor({
            loader: this.env.LOADER,
            // : bundledModules uses Module-object form `{ js: ... }`
            // (the explicit-type form Workers Loader requires for keys without
            // `.js`/`.py` extension). DynamicWorkerExecutor's TS signature is
            // narrowed to `Record<string,string>`, but at runtime it forwards
            // the map straight to `loader.get(...).modules`, which accepts the
            // wider Module shape. Cast through unknown to bridge the gap.
            modules: (this._bundledModules ?? undefined) as unknown as Record<string, string> | undefined,
          }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { ...base, execute: async (input: any, opts: any) => {
          const tier = (this._bundledModules && Object.keys(this._bundledModules).length > 0) ? 2 : 1;
          //  Track B-3 — capped code preview for trace analysis.
          // CodeInput shape is `{ code: string }` per `@cloudflare/codemode/shared`.
          const codePreview = typeof input?.code === "string" ? (input.code as string).slice(0, 200) : null;
          this.logEvent("tool.execute", {
            tier,
            reason: tier === 2 ? "codemode + bundled npm deps" : "codemode JS/TS",
            codePreview,
          });
          return base.execute!(input, opts);
        } };
      })(),
      sandbox_exec: tool({
        description: "Tier 4 — container sandbox: execute a shell command in a full OS environment. Use ONLY for tasks that require toolchains (Python, Go, Rust), package managers (apt, pip, npm install), repo-level builds, or long-running processes. Do NOT use for JS/TS logic or file I/O (use execute or workspace tools instead).",
        inputSchema: z.object({
          command: z.string().describe("Shell command to execute"),
          sandbox_id: z.string().optional().describe("Sandbox instance ID (default: 'agent-thursday')"),
        }),
        execute: async (input) => {
          this.logEvent("tool.sandbox_exec", { tier: 4, command_preview: input.command.slice(0, 80), reason: "container OS execution", sandbox_id: input.sandbox_id ?? "agent-thursday" });
          const sandbox = getSandbox(this.env.Sandbox, input.sandbox_id ?? "agent-thursday");
          const result = await sandbox.exec(input.command);
          return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, success: result.success };
        },
      }),
      // ── Agent Memory v1 (model-facing) ─────────────────────
      remember: tool({
        description: "Store a durable memory (fact / instruction / event / task). Use for stable knowledge worth recalling later (e.g. 'project uses GraphQL', 'when X, do Y'). Provide `key` for facts/instructions to enable supersession on update. DO NOT store secrets or transient noise. See docs/design/agent-memory-v1.md.",
        inputSchema: z.object({
          type: z.enum(["fact", "instruction", "event", "task"]),
          content: z.string().min(1).max(4000),
          key: z.string().min(1).max(200).optional(),
          confidence: z.number().min(0).max(1).optional(),
          supersedesId: z.number().int().optional(),
        }),
        execute: async (input) => {
          return this.rememberMemory(input);
        },
      }),
      recall: tool({
        description: "Retrieve durable memories matching a query. Call BEFORE answering questions that depend on prior project context. Returns ranked matches by exact-key > keyword > recency.",
        inputSchema: z.object({
          query: z.string().min(1).max(500),
          types: z.array(z.enum(["fact", "instruction", "event", "task"])).max(4).optional(),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        execute: async (input) => {
          return this.recallMemory(input);
        },
      }),
      //  mitigation 1: temporarily hide low-priority
      // memory management tools from the LLM tool spec to test the Kimi
      // tool-count/description-size threshold hypothesis. DO callables
      // remain available for API/inspect paths; only model-facing tools
      // `list_memories` and `forget` are removed here. Keep `recall`.
      browse: tool({
        description: "Tier 3 — headless browser: open an http(s) URL via Cloudflare Browser Rendering and extract title / visible text / links / screenshot. Use for web/UI smoke tests, page reachability checks, DOM text extraction, and screenshot evidence. Do NOT use to fetch JSON APIs (use execute), to clone repos or run shell (use sandbox_exec), or to read local workspace files (use read). SSRF protected: only http(s); rejects localhost/private/metadata IPs.",
        inputSchema: z.object({
          url: z.string().url().max(2048).describe("Absolute http(s) URL to open"),
          extract: z.array(z.enum(["summary", "text", "links", "screenshot"])).max(4).optional()
            .describe("Which artifacts to capture; defaults to ['summary'] (title+text+links)"),
          waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
          timeoutMs: z.number().int().min(1000).max(30_000).optional(),
        }),
        execute: async (input) => {
          this.logEvent("tool.browse", { tier: 3, url: input.url.slice(0, 200), extract: input.extract ?? ["summary"] });
          try {
            const result = await runBrowser(this.env.BROWSER, input);
            this.logEvent("tool.browse.ok", { tier: 3, finalUrl: result.finalUrl, durationMs: result.durationMs, gotTitle: !!result.title, gotText: !!result.text, linkCount: result.links?.length ?? 0, gotScreenshot: !!result.screenshotBase64 });
            return result;
          } catch (e) {
            const code = e instanceof BrowserError ? e.code : "internal";
            this.logEvent("tool.browse.error", { tier: 3, code, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
            throw e;
          }
        },
      }),
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
          this.logEvent("tool.content_sources", { includeHealth: input.includeHealth ?? true });
          const stub = await getAgentByName<Env, ContentHubAgent>(
            this.env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          );
          // propagate the current task id as audit trace id so
          // ContentHubAgent.audit_log rows can be correlated with the
          // AgentThursdayAgent event_log task.submitted entry that triggered them.
          const traceId = this.agentThursdayState.currentTaskObject?.id ?? null;
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
          this.logEvent("tool.content_list", { sourceId: input.sourceId, pathPreview: input.path.slice(0, 80) });
          const stub = await getAgentByName<Env, ContentHubAgent>(
            this.env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          );
          const traceId = this.agentThursdayState.currentTaskObject?.id ?? null;
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
          this.logEvent("tool.content_read", { sourceId: input.sourceId, pathPreview: input.path.slice(0, 80), maxBytes: input.maxBytes ?? null });
          const stub = await getAgentByName<Env, ContentHubAgent>(
            this.env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          );
          const traceId = this.agentThursdayState.currentTaskObject?.id ?? null;
          return await stub.read({ sourceId: input.sourceId, path: input.path, ref: input.ref, maxBytes: input.maxBytes }, traceId);
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
          this.logEvent("tool.content_search", {
            mode: input.sourceId !== undefined ? "single" : "multi",
            sourceId: input.sourceId ?? null,
            sourceIdsCount: input.sourceIds?.length ?? null,
            queryPreview: input.query.slice(0, 80),
            pathPreview: input.path?.slice(0, 80) ?? null,
            strategy: input.strategy ?? "api-search",
            maxResults: input.maxResults ?? null,
          });
          const stub = await getAgentByName<Env, ContentHubAgent>(
            this.env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
            CONTENT_HUB_INSTANCE,
          );
          const traceId = this.agentThursdayState.currentTaskObject?.id ?? null;
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

  private getSafeState(): AgentThursdayState {
    return {
      ...this.defaultAgentThursdayState,
      ...this.agentThursdayState,
      currentTask: this.agentThursdayState.currentTask ?? null,
      currentTaskObject: this.agentThursdayState.currentTaskObject ?? null,
      lastCheckpoint: this.agentThursdayState.lastCheckpoint ?? null,
      committedAction: this.agentThursdayState.committedAction ?? null,
      currentObstacle: this.agentThursdayState.currentObstacle ?? null,
      pendingHelpRequest: this.agentThursdayState.pendingHelpRequest ?? null,
      lastHumanResponse: this.agentThursdayState.lastHumanResponse ?? null,
      waitingForHuman: this.agentThursdayState.waitingForHuman ?? false,
      resumeTrigger: this.agentThursdayState.resumeTrigger ?? null,
      recoveryPolicy: this.agentThursdayState.recoveryPolicy ?? this.defaultAgentThursdayState.recoveryPolicy,
      lastActionResult: this.agentThursdayState.lastActionResult ?? null,
      runtimeMode: this.agentThursdayState.runtimeMode ?? this.defaultAgentThursdayState.runtimeMode,
      updatedAt: this.agentThursdayState.updatedAt ?? Date.now(),
    };
  }

  async onStart(props?: unknown): Promise<void> {
    await super.onStart(props as Record<string, unknown> | undefined);
    this.sql`
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    // Migrate: add trace_id column if not present
    const cols = this.sql<{ name: string }>`PRAGMA table_info(event_log)`;
    if (!cols.some(c => c.name === "trace_id")) {
      this.sql`ALTER TABLE event_log ADD COLUMN trace_id TEXT`;
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS memory_knowledge (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS review_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS kanban_mutations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_ref TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        description TEXT NOT NULL,
        diff_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        applied_at INTEGER,
        evidence TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    // Agent Memory v1. Additive, idempotent. See
    // docs/design/agent-memory-v1.md. Profile boundary = this DO.
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        key TEXT,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL,
        active INTEGER NOT NULL DEFAULT 1,
        supersedes_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_memories_type_active ON agent_memories(type, active)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_memories_key ON agent_memories(key)`;
    // Migrate: add status/applied_at/evidence columns to kanban_mutations if not present
    const kmCols = this.sql<{ name: string }>`PRAGMA table_info(kanban_mutations)`;
    if (!kmCols.some(c => c.name === "status")) {
      this.sql`ALTER TABLE kanban_mutations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`;
    }
    if (!kmCols.some(c => c.name === "applied_at")) {
      this.sql`ALTER TABLE kanban_mutations ADD COLUMN applied_at INTEGER`;
    }
    if (!kmCols.some(c => c.name === "evidence")) {
      this.sql`ALTER TABLE kanban_mutations ADD COLUMN evidence TEXT`;
    }
    const existing = this.sql<{ key: string }>`SELECT key FROM memory_knowledge LIMIT 1`;
    if (existing.length === 0) {
      for (const [key, content] of [
        ["project", "AgentThursday — 云原生 durable agent OS，运行在 Cloudflare Durable Objects + Agents SDK 上。"],
        ["m0-dod", "M0 DoD: DoD-1 稳定身份, DoD-2 session 恢复, DoD-3 model adapter, DoD-4 profile 可感知, DoD-5 intelligence awareness, DoD-6 event trace 可回放。"],
        ["stack", "技术栈: Cloudflare Workers + Durable Objects + Agents SDK v0.0.95 + TypeScript。"],
        ["dogfood", "固定 dogfood 问题: 如何使用新构建的 agent 开发当前项目？"],
      ] as [string, string][]) {
        this.sql`INSERT INTO memory_knowledge (key, content) VALUES (${key}, ${content})`;
      }
    }
    const safeState = this.getSafeState();
    if (
      safeState.recoveryPolicy !== this.agentThursdayState.recoveryPolicy ||
      safeState.runtimeMode !== this.agentThursdayState.runtimeMode ||
      safeState.waitingForHuman !== this.agentThursdayState.waitingForHuman ||
      safeState.updatedAt !== this.agentThursdayState.updatedAt
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

  // full last-assistant text for outbound delivery. No truncation
  // suffix (would corrupt user-visible Discord reply); 's
  // splitForDiscord2000 handles the 2000-char chunk limit downstream.
  private getLastAssistantTextFull(): string {
    const msgs = this.getMessages();
    const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return "";
    const textPart = lastAssistant.parts.find((p): p is { type: "text"; text: string } => p.type === "text");
    return textPart?.text ?? "";
  }

  // aggregate ALL new assistant texts produced during this
  // submitTask round, in order. Replaces 's "last assistant text"
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

  // truthfulness gate. Looks at the assistant text, finds
  // tool-call claims, and cross-validates against `tool.*` events emitted
  // during this submitTask round. Returns the (possibly annotated)
  // user-visible reply.
  private applyTruthfulnessGate(text: string, startTs: number, taskId: string): string {
    const mode = (this.env as { AGENT_THURSDAY_TRUTHFULNESS_GATE?: string }).AGENT_THURSDAY_TRUTHFULNESS_GATE;
    const effectiveMode: "warn" | "log-only" | "off" =
      mode === "off" ? "off" : mode === "log-only" ? "log-only" : "warn";
    if (effectiveMode === "off" || !text || text.trim().length === 0) return text;

    const claims = findToolClaims(text, KNOWN_TOOL_NAMES);

    // Read the tool.* events emitted during this round (created_at >= start).
    // logEvent uses Date.now() for created_at, so >= startTs is the right scope.
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
      //  Track B-1 — `tool.memory.<verb>` events use the "memory"
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

    //  Track B-4 — inline-JSON detection. A model that emits
    // ```json blocks in plain text but never dispatches a tool is producing
    // a fabricated tool result outside the tool-call frame. Count fenced
    // JSON blocks so /api/inspect can classify the round even when the
    // bot's reply has no detectable claim.
    const inlineJsonCount = (text.match(/```json\b/gi) ?? []).length;

    const verdict = checkTruthfulness(claims, actualToolNames);
    const dispatchedToolNames = [...actualToolNames].sort();
    const inlineJsonWithoutDispatch =
      inlineJsonCount > 0 && actualToolNames.size === 0 && claims.length === 0;

    if (verdict.fabricated.length === 0 && !inlineJsonWithoutDispatch) return text;

    const category: string = verdict.fabricated.length > 0 ? "fabricated-claim" : "inline-json-without-dispatch";
    this.logEvent("tool.truthfulness.violation", {
      taskId,
      //  Track B-4 — `category` lets reviewers split fabricated
      // tool-call claims (the original  case) from inline-JSON
      // fabrications that slip past claim detection entirely.
      category,
      claimedTools: verdict.claims.map(c => c.tool),
      fabricatedTools: verdict.fabricated,
      consistentTools: verdict.consistent,
      dispatchedToolNames,
      inlineJsonCount,
      claimsCount: verdict.claims.length,
      replyTextLen: text.length,
      mode: effectiveMode,
    });

    // share verdict with the per-turn supplier summary
    // event without changing user-visible behavior. Set BEFORE the early
    // returns below so log-only mode also persists the cross-link in
    // supplier.signal.summary.
    this._currentTaskTruthfulnessVerdict = { violationSeen: true, category };

    if (verdict.fabricated.length === 0) return text;
    if (effectiveMode === "log-only") return text;
    // warn mode → prepend a single warning line.
    const warning = renderTruthfulnessWarning(verdict.fabricated);
    return `${warning}\n\n${text}`;
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
        toolCallNames: s.toolCallNames,
        toolResultNames: s.toolResultNames,
      }));
      this.logEvent("supplier.signal.summary", {
        taskId,
        //  convention — current task id doubles as cross-DO
        // trace id elsewhere; keep null until a separate carrier exists.
        traceId: null,
        model: this._lastStepModel?.modelId ?? null,
        provider: this._lastStepModel?.provider ?? null,
        // Hardcoded for v1: getModel() wraps workers-ai-provider. If a
        // future card pluggable-adapters this, derive from registry instead.
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
    const rows = this.sql<{ key: string; content: string }>`SELECT key, content FROM memory_knowledge ORDER BY key`;
    return rows.map(r => `[${r.key}] ${r.content}`).join(" | ");
  }

  private makeTaskObject(task: string, source: TaskObject["source"]): TaskObject {
    return { id: `task-${Date.now().toString(36)}`, title: task.slice(0, 120), status: "active", source, createdAt: Date.now(), updatedAt: Date.now() };
  }

  @callable()
  async submitTask(task: string): Promise<{ ok: boolean; taskId: string; loopTriggered: boolean; replyText: string }> {
    // conversational resume from a prior `needs_human`
    // pause. While paused, only explicit resume intents ("继续" /
    // "proceed" / "resume" / ...) may advance the current loop. Other
    // text receives a reminder and does NOT create a new task or call the
    // model, preserving the operator's "resume via conversation" requirement.
    const wasWaitingForHuman = !!this.agentThursdayState.waitingForHuman;
    const isExplicitResume = wasWaitingForHuman && isResumeIntent(task);
    const prevTaskObj = this.agentThursdayState.currentTaskObject;
    if (wasWaitingForHuman && !isExplicitResume) {
      this.logEvent("loop.pause.awaiting_resume", {
        taskId: prevTaskObj?.id ?? null,
        userTextPreview: task.slice(0, 80),
      });
      return {
        ok: true,
        taskId: prevTaskObj?.id ?? "paused",
        loopTriggered: false,
        replyText: renderAwaitingResumeMessage(prevTaskObj?.id ?? null),
      };
    }

    const source: TaskObject["source"] = task === DOGFOOD_TASK ? "dogfood" : "human";
    const isResubmit = !!(prevTaskObj && prevTaskObj.title === task.slice(0, 120));
    const taskObject: TaskObject = isExplicitResume && prevTaskObj
      ? { ...prevTaskObj, status: "active", updatedAt: Date.now() }
      : isResubmit
        ? { ...prevTaskObj, status: "active", updatedAt: Date.now() }
        : this.makeTaskObject(task, source);
    const nextTaskTitle = isExplicitResume && prevTaskObj ? prevTaskObj.title : task;
    // New task: reset lastActionResult so old round's completion state doesn't bleed in.
    // Explicit resume keeps the current paused task identity and does not
    // manufacture a new task titled "继续".
    const nextState = isExplicitResume || isResubmit
      ? { ...this.agentThursdayState, currentTask: nextTaskTitle, currentTaskObject: taskObject, status: "running" as const, waitingForHuman: false, updatedAt: Date.now() }
      : { ...this.agentThursdayState, currentTask: task, currentTaskObject: taskObject, status: "running" as const, waitingForHuman: false, lastActionResult: null, updatedAt: Date.now() };
    this.setAgentThursdayState(nextState);
    if (isExplicitResume) {
      this.logEvent("loop.resume.needs_human", {
        taskId: taskObject.id,
        prevTaskId: prevTaskObj?.id ?? null,
        userTextPreview: task.slice(0, 80),
      });
    }
    this.logEvent("task.submitted", { task, taskId: taskObject.id, isResubmit });
    // snapshot message-log length BEFORE saveMessages so we
    // can collect ALL new assistant texts produced during this round, not
    // just the "last assistant message" ('s strategy lost results
    // when the model produced progress + tool call but no synthesis turn).
    const prevMsgLen = this.getMessages().length;
    // truthfulness gate prep: snapshot timestamp BEFORE
    // saveMessages so we can scope the "what tools actually dispatched in
    // THIS round" query to events emitted during the loop.
    const truthfulnessStartTs = Date.now();
    // reset supplier-side signal collector for this round.
    // Populated by onStepFinish + onError during saveMessages.
    this._currentTaskSupplierSignals = emptySupplierTaskSignals();
    // reset truthfulness verdict for this round so a stale
    // value from a previous turn never leaks into the supplier summary.
    this._currentTaskTruthfulnessVerdict = { violationSeen: false, category: null };
    const result = await this.saveMessages([{
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: task }],
    }]);
    // aggregate all assistant texts produced during this
    // submitTask round (replaces 's `getLastAssistantTextFull()`).
    //  still in code as a fallback for inspect surfaces.
    const rawReplyText = this.getNewAssistantTextsSince(prevMsgLen);
    // tool-truthfulness gate. Detect tool-call claims in the
    // assistant text and cross-validate against `tool.*` events actually
    // logged during this round. Fabricated claims (claim without event) get
    // a warning line prepended to the user-visible reply + a structured
    // `tool.truthfulness.violation` event for inspect. Mode controlled by
    // env.AGENT_THURSDAY_TRUTHFULNESS_GATE: "warn" (default) | "log-only" | "off".
    const gatedReplyText = this.applyTruthfulnessGate(rawReplyText, truthfulnessStartTs, taskObject.id);
    // supplier-side degradation marker. Coexists with Card
    // 102 (catches a different layer of failure: model/adapter signals
    // rather than user-facing claims). When both fire, the supplier marker
    // sits ABOVE the truthfulness marker so reviewers see the broader
    // "this round's pipeline was sketchy" context first, then the specific
    // "this claim looks fabricated" line. Detection is fail-soft: any
    // throw inside detection/render returns the gated text unchanged.
    let replyText = this.applySupplierDegradationMarker(gatedReplyText);
    // persist per-turn supplier signal summary into
    // event_log so reviewers can grep / inspect tool-decision path
    // signals later without re-deploying diag endpoints. Fail-soft: the
    // helper swallows any throw so a logging glitch can't break the turn.
    this.logSupplierSignalSummary(taskObject.id);
    // finalize currentTaskObject.status. Without this the
    // object stays "active" forever,  readiness reports
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
    const latest = this.agentThursdayState;
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
        // `!s.waitingForHuman`), and  banner all reflect pause
        // coherently. Override the just-finalized lifecycle.
        const stateNow = this.agentThursdayState;
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
    return { ok: true, taskId: taskObject.id, loopTriggered: result.status === "completed", replyText };
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
  async codemodeProbe(): Promise<{
    ok: boolean;
    toolsRegistered: string[];
    executeRegistered: boolean;
    executeProbeResult?: { result: unknown; error?: string; logs?: string[] };
    timestamp: number;
    durationMs: number;
  }> {
    const start = Date.now();
    const tools = this.getTools();
    const toolsRegistered = Object.keys(tools);
    const executeRegistered = "execute" in tools;
    let probeResult: { result: unknown; error?: string; logs?: string[] } | undefined;
    if (executeRegistered) {
      try {
        const executor = new DynamicWorkerExecutor({
          loader: this.env.LOADER,
          modules: (this._bundledModules ?? undefined) as unknown as Record<string, string> | undefined,
        });
        const r = await executor.execute("return 1 + 1", []);
        probeResult = { result: r.result, error: r.error, logs: r.logs };
      } catch (e) {
        const err = e instanceof Error
          ? `${e.name}: ${e.message}\n${(e.stack ?? "").slice(0, 800)}`
          : String(e).slice(0, 800);
        probeResult = { result: undefined, error: err };
      }
    }
    const durationMs = Date.now() - start;
    const ok = executeRegistered && !!probeResult && !probeResult.error && probeResult.result === 2;
    this.logEvent("tool.health.probe", {
      tool: "execute",
      ok,
      executeRegistered,
      errorPreview: probeResult?.error?.slice(0, 200) ?? null,
      durationMs,
    });
    return {
      ok,
      toolsRegistered,
      executeRegistered,
      executeProbeResult: probeResult,
      timestamp: start,
      durationMs,
    };
  }

  @callable()
  getStatus(): AgentThursdayState {
    return this.getSafeState();
  }

  @callable()
  getCurrentTaskObject(): TaskObject | null {
    return this.getSafeState().currentTaskObject;
  }

  @callable()
  getLoopContract(): LoopContract {
    const s = this.getSafeState();
    const lar = s.lastActionResult;

    const planner = {
      taskId: s.currentTaskObject?.id ?? null,
      taskTitle: s.currentTaskObject?.title ?? s.currentTask,
      nextStep: s.committedAction?.title ?? null,
      rationale: s.committedAction?.reason ?? null,
      readyForExecutor: s.committedAction !== null,
    };

    const executor = {
      actionType: lar?.actionType ?? null,
      outcome: lar?.outcome ?? null,
      artifactSummary: lar ? `${lar.actionType} → ${lar.outcome}: ${lar.summary.slice(0, 100)}` : null,
      executedAt: lar?.recordedAt ?? null,
    };

    const canContinue = !s.waitingForHuman && !(s.currentObstacle?.blocked);
    const accepted = lar?.outcome === "success" && canContinue;
    let reason: string;
    if (!lar) {
      reason = "尚未执行任何 action，等待 executor 完成第一次执行。";
    } else if (lar.outcome === "blocked") {
      reason = `执行失败: ${lar.summary}`;
    } else if (s.waitingForHuman) {
      reason = "Agent 等待人类响应，无法继续。";
    } else if (s.currentObstacle?.blocked) {
      reason = `存在未解除阻塞: ${s.currentObstacle.reason}`;
    } else {
      reason = `${lar.actionType} 执行成功，可以继续。`;
    }
    const reviewer = { accepted, canContinue, reason };

    return {
      roundId: s.currentTaskObject?.id ?? `round-${Date.now().toString(36)}`,
      planner,
      executor,
      reviewer,
      updatedAt: Date.now(),
    };
  }

  @callable()
  getEventLog(): EventLogRow[] {
    return this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log ORDER BY created_at DESC LIMIT 20
    `;
  }

  @callable()
  getLastTrace(): { traceId: string; events: EventLogRow[] } | null {
    const rows = this.sql<{ trace_id: string }>`
      SELECT DISTINCT trace_id FROM event_log
      WHERE trace_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    const traceId = rows[0].trace_id;
    const events = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE trace_id = ${traceId}
      ORDER BY created_at ASC
    `;
    return { traceId, events };
  }

  @callable()
  getDebugTrace(): { lastAssistantSummary: string; recentToolEvents: { type: string; summary: string; at: number }[]; pendingApprovalReason: string | null; lastActionResult: { actionType: string; outcome: string; summary: string } | null; lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null } {
    const s = this.getSafeState();
    const lar = s.lastActionResult;

    const rawEvents = this.sql<{ event_type: string; payload: string; created_at: number }>`
      SELECT event_type, payload, created_at FROM event_log
      WHERE event_type LIKE 'tool.%'
      ORDER BY created_at DESC LIMIT 20
    `;
    const recentToolEvents = rawEvents.map(e => {
      let summary = e.event_type;
      try {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        const snippets = Object.entries(p).map(([k, v]) => {
          const raw = String(v);
          const cap = 500;
          const val = raw.length > cap ? `${raw.slice(0, cap)}…(+${raw.length - cap})` : raw;
          return `${k}:${val}`;
        }).join(" ");
        if (snippets) summary = `${e.event_type} — ${snippets}`;
      } catch { /* ignore */ }
      return { type: e.event_type, summary, at: e.created_at };
    });

    const pta = this.getPendingToolApproval();
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;
    const pendingMutCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'pending' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const pendingApprovalReason = pta
      ? `tool-approval: ${pta.toolName}`
      : s.waitingForHuman
      ? "waiting-for-human"
      : pendingMutCount > 0
      ? `${pendingMutCount} mutation(s) pending confirm`
      : null;

    const ladderRows = this.sql<{ event_type: string; payload: string; created_at: number }>`
      SELECT event_type, payload, created_at FROM event_log
      WHERE event_type IN ('tool.execute', 'tool.sandbox_exec')
      ORDER BY created_at DESC LIMIT 1
    `;
    let lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null = null;
    if (ladderRows.length > 0) {
      const ev = ladderRows[0];
      try {
        const p = JSON.parse(ev.payload) as { tier?: number; reason?: string };
        lastLadderTier = { tier: p.tier ?? 1, toolName: ev.event_type.replace("tool.", ""), reason: p.reason ?? "", at: ev.created_at };
      } catch { /* ignore */ }
    }

    return {
      lastAssistantSummary: this.getLastAssistantText(10000),
      recentToolEvents,
      pendingApprovalReason,
      lastActionResult: lar ? { actionType: lar.actionType, outcome: lar.outcome, summary: lar.summary } : null,
      lastLadderTier,
    };
  }

  @callable()
  // index recent degradation events into a compact view
  // for the inspect panel. Read-only: queries existing event_log rows
  // emitted by Cards 117 / 119 / 102, parses payload as JSON, and tolerates
  // shape drift via fail-soft per-row try/catch. Cap recentSummaries to
  // keep the inspect response payload bounded.
  private getDegradationDiagnostics(): DegradationDiagnostics {
    const SUMMARY_CAP = 10;

    const summaryRows = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'degradation.summary'
      ORDER BY created_at DESC LIMIT ${SUMMARY_CAP}
    `;
    const recentSummaries: TaskDegradationSummaryView[] = [];
    for (const r of summaryRows) {
      try {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        if (typeof p?.taskId !== "string") continue;
        if (typeof p?.state !== "string") continue;
        recentSummaries.push({ ...(p as unknown as TaskDegradationSummaryView), eventAt: r.created_at });
      } catch { /* skip malformed row */ }
    }
    const latestSummary: TaskDegradationSummaryView | null = recentSummaries[0] ?? null;

    const latestTaskId = latestSummary?.taskId ?? null;

    const supplierRows = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'supplier.signal.summary'
      ORDER BY created_at DESC LIMIT 50
    `;
    let latestSupplierSignal: SupplierSignalSummaryView | null = null;
    if (latestTaskId) {
      for (const r of supplierRows) {
        try {
          const p = JSON.parse(r.payload) as Record<string, unknown>;
          if (p?.taskId !== latestTaskId) continue;
          latestSupplierSignal = { ...(p as unknown as SupplierSignalSummaryView), eventAt: r.created_at };
          break;
        } catch { /* skip */ }
      }
    }

    const truthfulnessRows = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type = 'tool.truthfulness.violation'
      ORDER BY created_at DESC LIMIT 50
    `;
    let latestTruthfulnessViolation: TruthfulnessViolationView | null = null;
    if (latestTaskId) {
      for (const r of truthfulnessRows) {
        try {
          const p = JSON.parse(r.payload) as Record<string, unknown>;
          if (p?.taskId !== latestTaskId) continue;
          latestTruthfulnessViolation = { ...(p as unknown as TruthfulnessViolationView), eventAt: r.created_at };
          break;
        } catch { /* skip */ }
      }
    }

    return { latestSummary, latestSupplierSignal, latestTruthfulnessViolation, recentSummaries };
  }

  getInspectSnapshot(): InspectSnapshot {
    // real producer for /api/inspect.
    // No new storage; pulls from event_log + DO state.  schema is canonical.

    // ladder: history of tier-bearing tool events, newest first
    const ladderRows = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      WHERE event_type IN ('tool.execute', 'tool.sandbox_exec')
      ORDER BY created_at DESC LIMIT 50
    `;
    const ladder: LadderTierEntry[] = ladderRows.map(r => {
      let tier = 1;
      let reason = "";
      try {
        const p = JSON.parse(r.payload) as { tier?: number; reason?: string };
        tier = p.tier ?? 1;
        reason = p.reason ?? "";
      } catch { /* ignore parse failures */ }
      return {
        tier,
        toolName: r.event_type.replace(/^tool\./, ""),
        reason,
        at: r.created_at,
      };
    });

    // trace: full event log (capped) newest-first; payloads parsed when valid JSON
    const traceRows = this.sql<EventLogRow>`
      SELECT event_type, payload, created_at, trace_id FROM event_log
      ORDER BY created_at DESC LIMIT 200
    `;
    const trace: TraceEvent[] = traceRows.map(r => {
      let payload: unknown = r.payload;
      try { payload = JSON.parse(r.payload); } catch { /* keep raw string */ }
      return {
        id: `${r.event_type}-${r.created_at}`,
        type: r.event_type,
        payload,
        at: r.created_at,
        traceId: r.trace_id,
      };
    });

    // toolEvents: filter to tool.* — kind="call" because the worker only logs tool entries today;
    // "result" rows would need a separate logEvent path (out of scope for this card).
    const toolEvents: ToolEvent[] = traceRows
      .filter(r => r.event_type.startsWith("tool."))
      .map(r => {
        let payload: unknown = r.payload;
        try { payload = JSON.parse(r.payload); } catch { /* keep raw */ }
        return {
          id: `${r.event_type}-${r.created_at}`,
          kind: "call" as const,
          toolName: r.event_type.replace(/^tool\./, ""),
          payload,
          at: r.created_at,
        };
      });

    // debugRaw: the existing debugTrace dump preserved for deep-dive debugging
    const debugRaw = this.getDebugTrace();

    // index latest degradation events into a compact view
    // for the inspect panel. Read-only over existing event_log; null fields
    // when no degradation events have been logged yet.
    const degradationDiagnostics = this.getDegradationDiagnostics();

    // derive Action UI Intents from the same traceRows
    // (newest-first event_log slice) the trace[] / toolEvents views are
    // already built from. Pure builder, capped at 30 newest intents.
    // Wrapped in try/catch so a malformed row never breaks /api/inspect.
    let actionUiIntents: ActionUiIntent[] | undefined;
    try {
      const sourceRows: ActionUiIntentSourceRow[] = traceRows.map(r => ({
        event_type: r.event_type,
        payload: r.payload,
        created_at: r.created_at,
        trace_id: r.trace_id,
      }));
      actionUiIntents = buildActionUiIntents(sourceRows);
    } catch { /* fail-soft: omit field rather than break inspect */ }

    return { ladder, trace, toolEvents, debugRaw, degradationDiagnostics, actionUiIntents };
  }

  @callable()
  getUsageStats(): {
    checkpoints: number; notes: number; appliedMutations: number; eventCount: number;
    taskCheckpoints: number; taskNotes: number; taskAppliedMutations: number;
    tokenSession: { in: number; out: number; total: number } | null;
    tokenTask: { in: number; out: number; total: number } | null;
    lastStepInputTokens: number | null;
    msgCount: number;
    modelInfo: { provider: string; modelId: string } | null;
    modelProfile: { provider: string; model: string };
  } {
    const checkpoints = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints`)[0]?.n ?? 0);
    const notes = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes`)[0]?.n ?? 0);
    const appliedMutations = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied'`)[0]?.n ?? 0);
    const eventCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM event_log`)[0]?.n ?? 0);
    const taskStartedAt = this.agentThursdayState.currentTaskObject?.createdAt ?? 0;
    const taskCheckpoints = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const taskNotes = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const taskAppliedMutations = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const msgCount = this.getMessages().length;
    const mp = this.agentThursdayState.modelProfile;
    return {
      checkpoints, notes, appliedMutations, eventCount,
      taskCheckpoints, taskNotes, taskAppliedMutations,
      tokenSession: this._sessionTok.hasData ? { in: this._sessionTok.in, out: this._sessionTok.out, total: this._sessionTok.total } : null,
      tokenTask: (this._taskTok.taskId !== null && (this._taskTok.in > 0 || this._taskTok.out > 0)) ? { in: this._taskTok.in, out: this._taskTok.out, total: this._taskTok.total } : null,
      lastStepInputTokens: this._lastStepIn,
      msgCount,
      modelInfo: this._lastStepModel,
      modelProfile: { provider: mp.provider, model: mp.model },
    };
  }

  @callable()
  getMemoryLayers(): { soul: string; knowledge: { key: string; content: string }[]; lastMessage: string } {
    const knowledge = this.sql<{ key: string; content: string }>`SELECT key, content FROM memory_knowledge ORDER BY key`;
    return { soul: SOUL, knowledge, lastMessage: this.getLastAssistantText() };
  }

  @callable()
  getProfileAwareness() {
    return getProfileAwareness(this.agentThursdayState.modelProfile);
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
    const hasArtifact = ckptCount > 0 || noteCount > 0 || appliedMut > 0;

    const reviewerAccepted = lar?.outcome === "success";
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
    } else if (!lar) {
      stage = "task-active";
      summary = `task [${taskLifecycle}] 已建立，等待 executor 完成第一次执行。`;
    } else if (!gateOpen) {
      stage = "awaiting-deliverable";
      summary = `task [${taskLifecycle}] 执行中，deliverable 未满足（${!hasArtifact ? "无 artifact" : lar.outcome !== "success" ? `outcome: ${lar.outcome}` : "有阻塞"}）。`;
    } else if (activeInterventionCount > 0) {
      stage = "gate-open";
      summary = `gate 已开放，但存在 ${activeInterventionCount} 个干预点（pending mutations 等），需先 confirm 再进入下一轮。`;
    } else {
      stage = "loop-ready";
      summary = `developer loop 就绪：task [${taskLifecycle}]，deliverable confirmed，gate open，无干预点，可进入下一轮。`;
    }

    const lastMsg = this.getLastAssistantText(200);
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
    const hasArtifact = ckptCount > 0 || noteCount > 0 || appliedMut > 0;
    const noBlockers = !s.waitingForHuman && !(s.currentObstacle?.blocked);
    const gateOpen = (lar?.outcome === "success") && hasArtifact && noBlockers;
    const activeInterventionCount = [s.waitingForHuman, !!(s.currentObstacle?.blocked), pendingMut > 0, !gateOpen].filter(Boolean).length;
    const readyForNextRound = gateOpen && activeInterventionCount === 0;
    const autoContinue = readyForNextRound;

    let loopStage: string;
    if (!s.currentTaskObject) loopStage = "no-task";
    else if (!lar) loopStage = "task-active";
    else if (!gateOpen) loopStage = "awaiting-deliverable";
    else if (activeInterventionCount > 0) loopStage = "gate-open";
    else loopStage = "loop-ready";

    let suggestedNextCommand: string | null;
    if (loopStage === "no-task") suggestedNextCommand = "submit";
    else if (s.waitingForHuman || pendingMut > 0) suggestedNextCommand = "approve";
    else if (loopStage === "awaiting-deliverable" || loopStage === "task-active") suggestedNextCommand = "continue";
    else if (loopStage === "gate-open") suggestedNextCommand = "approve";
    else suggestedNextCommand = "continue";

    return {
      sessionId: s.currentTaskObject?.id ?? DEMO_INSTANCE,
      instanceName: DEMO_INSTANCE,
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

  @callable()
  getDeliverableGate(): DeliverableConvergence {
    const s = this.getSafeState();
    const lar = s.lastActionResult;
    const taskStartedAt = s.currentTaskObject?.createdAt ?? 0;

    const ckptCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const noteCount = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes WHERE created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const mutCount  = Number((this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations WHERE status = 'applied' AND created_at >= ${taskStartedAt}`)[0]?.n ?? 0);
    const hasArtifact = ckptCount > 0 || noteCount > 0 || mutCount > 0;

    const readyForReview = (lar?.outcome === "success") && hasArtifact;
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
    if (!lar) {
      reason = "尚未产出任何执行结果，gate 等待第一次执行。";
    } else if (s.waitingForHuman) {
      reason = "Agent 等待人类响应，gate 关闭。";
    } else if (s.currentObstacle?.blocked) {
      reason = `阻塞未解除: ${s.currentObstacle.reason}`;
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
    const hasArtifact = ckptCount > 0 || noteCount > 0 || appliedMut > 0;
    const gateBlocked = !lar || lar.outcome !== "success" || !hasArtifact || s.waitingForHuman || !!(s.currentObstacle?.blocked);

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
          ? (!lar ? "尚未执行 action" : !hasArtifact ? "无真实 artifact" : `最近 action outcome: ${lar.outcome}`)
          : "review gate 已开放",
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
    const now = Date.now();
    const source = input.source ?? "agent";
    const key = input.key && input.key.length > 0 ? input.key : null;
    const confidence = typeof input.confidence === "number" ? input.confidence : null;

    let supersededId: number | null = null;
    if (typeof input.supersedesId === "number") {
      // Explicit supersede: deactivate the named row (if present + active).
      const target = this.sql<{ id: number }>`SELECT id FROM agent_memories WHERE id = ${input.supersedesId} AND active = 1`;
      if (target.length > 0) {
        this.sql`UPDATE agent_memories SET active = 0, updated_at = ${now} WHERE id = ${input.supersedesId}`;
        supersededId = input.supersedesId;
      }
    } else if (key !== null) {
      // Implicit auto-supersede on (type, key) collision among active rows.
      const prior = this.sql<{ id: number }>`
        SELECT id FROM agent_memories
        WHERE type = ${input.type} AND active = 1 AND key IS NOT NULL AND lower(key) = lower(${key})
        ORDER BY created_at DESC LIMIT 1
      `;
      if (prior.length > 0) {
        supersededId = prior[0].id;
        this.sql`UPDATE agent_memories SET active = 0, updated_at = ${now} WHERE id = ${supersededId}`;
      }
    }

    const inserted = this.sql<{ id: number }>`
      INSERT INTO agent_memories (type, key, content, source, confidence, active, supersedes_id, created_at, updated_at)
      VALUES (${input.type}, ${key}, ${input.content}, ${source}, ${confidence}, 1, ${supersededId}, ${now}, ${now})
      RETURNING id
    `;
    const id = inserted[0]?.id ?? 0;
    this.logEvent("tool.memory.remember", { id, type: input.type, key, supersededId, source });
    return { id, type: input.type, supersededId };
  }

  @callable()
  recallMemory(input: { query: string; types?: MemoryType[]; limit?: number }): { matches: MemoryRecallMatch[] } {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 5)), 20);
    const types = input.types && input.types.length > 0 ? input.types : (["fact", "instruction", "event", "task"] as MemoryType[]);
    const queryRaw = (input.query ?? "").trim();

    type Row = { id: number; type: string; key: string | null; content: string; created_at: number };
    const seen = new Map<number, { row: Row; score: number }>();

    const accept = (row: Row, score: number) => {
      const prev = seen.get(row.id);
      if (!prev || prev.score < score) seen.set(row.id, { row, score });
    };

    // Channel 1: exact key match (highest weight)
    if (queryRaw.length > 0) {
      const placeholders = types.map((_t, i) => `?${i + 1}`).join(",");
      // SQLite tagged template doesn't take arrays; spell out type list as alternation.
      for (const t of types) {
        const rows = this.sql<Row>`
          SELECT id, type, key, content, created_at FROM agent_memories
          WHERE active = 1 AND type = ${t} AND key IS NOT NULL AND lower(key) = lower(${queryRaw})
          ORDER BY created_at DESC LIMIT ${limit}
        `;
        for (const r of rows) accept(r, 1.0);
      }
      void placeholders; // silence unused
    }

    // Channel 2: keyword LIKE on content (per token, max 5 tokens)
    const tokens = queryRaw.split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
    if (tokens.length > 0) {
      for (const t of types) {
        for (const tok of tokens) {
          const pat = `%${tok.replace(/[%_\\]/g, m => `\\${m}`)}%`;
          const rows = this.sql<Row>`
            SELECT id, type, key, content, created_at FROM agent_memories
            WHERE active = 1 AND type = ${t} AND content LIKE ${pat} ESCAPE '\\'
            ORDER BY created_at DESC LIMIT ${limit}
          `;
          for (const r of rows) {
            const recencyBoost = Math.max(0, 0.1 - (Date.now() - r.created_at) / (1000 * 60 * 60 * 24 * 365)); // small
            accept(r, 0.4 + recencyBoost);
          }
        }
      }
    }

    // Channel 3: recency fallback if nothing matched
    if (seen.size === 0) {
      for (const t of types) {
        const rows = this.sql<Row>`
          SELECT id, type, key, content, created_at FROM agent_memories
          WHERE active = 1 AND type = ${t}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
        for (const r of rows) accept(r, 0.2);
      }
    }

    const matches: MemoryRecallMatch[] = [...seen.values()]
      .sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: row.id,
        type: row.type as MemoryType,
        key: row.key,
        content: row.content,
        score: Math.round(score * 1000) / 1000,
        createdAt: row.created_at,
      }));

    this.logEvent("tool.memory.recall", { query: queryRaw.slice(0, 200), matches: matches.length });
    return { matches };
  }

  @callable()
  listMemoriesEntries(input: { type?: MemoryType; activeOnly?: boolean; limit?: number }): { items: MemoryEntry[] } {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 100);
    const activeOnly = input.activeOnly !== false; // default true
    type Row = { id: number; type: string; key: string | null; content: string; source: string; confidence: number | null; active: number; supersedes_id: number | null; created_at: number; updated_at: number };
    let rows: Row[];
    if (input.type && activeOnly) {
      rows = this.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE type = ${input.type} AND active = 1 ORDER BY created_at DESC LIMIT ${limit}`;
    } else if (input.type && !activeOnly) {
      rows = this.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE type = ${input.type} ORDER BY created_at DESC LIMIT ${limit}`;
    } else if (!input.type && activeOnly) {
      rows = this.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE active = 1 ORDER BY created_at DESC LIMIT ${limit}`;
    } else {
      rows = this.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories ORDER BY created_at DESC LIMIT ${limit}`;
    }
    const items: MemoryEntry[] = rows.map(r => ({
      id: r.id,
      type: r.type as MemoryType,
      key: r.key,
      content: r.content,
      source: r.source,
      confidence: r.confidence,
      active: r.active === 1,
      supersedesId: r.supersedes_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    this.logEvent("tool.memory.list", { type: input.type ?? "all", activeOnly, returned: items.length });
    return { items };
  }

  @callable()
  forgetMemory(input: { id: number; reason?: string }): { ok: boolean; id: number } {
    const target = this.sql<{ id: number; active: number }>`SELECT id, active FROM agent_memories WHERE id = ${input.id}`;
    if (target.length === 0) {
      this.logEvent("tool.memory.forget", { id: input.id, ok: false, reason: "not-found" });
      return { ok: false, id: input.id };
    }
    if (target[0].active === 0) {
      this.logEvent("tool.memory.forget", { id: input.id, ok: true, reason: "already-inactive" });
      return { ok: true, id: input.id };
    }
    this.sql`UPDATE agent_memories SET active = 0, updated_at = ${Date.now()} WHERE id = ${input.id}`;
    this.logEvent("tool.memory.forget", { id: input.id, ok: true, reason: (input.reason ?? "").slice(0, 200) });
    return { ok: true, id: input.id };
  }

  @callable()
  getMemorySnapshot(): MemorySnapshot {
    type CountRow = { type: string; n: number };
    const counts = this.sql<CountRow>`SELECT type, COUNT(*) as n FROM agent_memories WHERE active = 1 GROUP BY type`;
    const inactive = Number((this.sql<{ n: number }>`SELECT COUNT(*) as n FROM agent_memories WHERE active = 0`)[0]?.n ?? 0);
    const byType: Record<MemoryType, number> = { fact: 0, instruction: 0, event: 0, task: 0 };
    for (const c of counts) {
      if (c.type === "fact" || c.type === "instruction" || c.type === "event" || c.type === "task") {
        byType[c.type] = Number(c.n);
      }
    }
    const recent = (t: MemoryType, limit: number): MemoryEntry[] => {
      type Row = { id: number; type: string; key: string | null; content: string; source: string; confidence: number | null; active: number; supersedes_id: number | null; created_at: number; updated_at: number };
      const rows = this.sql<Row>`SELECT id, type, key, content, source, confidence, active, supersedes_id, created_at, updated_at FROM agent_memories WHERE active = 1 AND type = ${t} ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(r => ({
        id: r.id, type: r.type as MemoryType, key: r.key, content: r.content,
        source: r.source, confidence: r.confidence, active: r.active === 1,
        supersedesId: r.supersedes_id, createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    };
    return {
      counts: { ...byType, inactive },
      recentFacts: recent("fact", 3),
      recentInstructions: recent("instruction", 3),
      recentEvents: recent("event", 5),
      recentTasks: recent("task", 5),
    };
  }

  @callable()
  clearStaleBlockingState(): { ok: boolean; cleared: string[] } {
    const cleared: string[] = [];
    const patch: Partial<AgentThursdayState> = {};
    if (this.agentThursdayState.waitingForHuman) { patch.waitingForHuman = false; cleared.push("waitingForHuman"); }
    if (this.agentThursdayState.pendingHelpRequest !== null) { patch.pendingHelpRequest = null; cleared.push("pendingHelpRequest"); }
    if (this.agentThursdayState.currentObstacle !== null) { patch.currentObstacle = null; cleared.push("currentObstacle"); }
    if (cleared.length > 0) {
      this.setAgentThursdayState({ ...this.agentThursdayState, ...patch, updatedAt: Date.now() });
      this.logEvent("state.stale_cleared", { cleared });
    }
    return { ok: true, cleared };
  }

  @callable()
  getRecentReviewNotes(): { content: string; source: string; created_at: number }[] {
    return this.sql<{ content: string; source: string; created_at: number }>`
      SELECT content, source, created_at FROM review_notes ORDER BY created_at DESC LIMIT 3
    `;
  }

  /**
   * explicit channel-ingress readiness predicate.
   *
   * Replaces ChannelHub's previous heuristic `currentTask !== null` (which
   * misfired when `currentTask` was a stale string but the actual loop was
   * idle — observed in dogfood: the bot showed busy forever).
   *
   * `canAccept` is the authority on whether ChannelHub may submit a new
   * channel-driven task on top of current state. The reason string is
   * carried into busy-skip decisions so operators can see the concrete
   * predicate (`waitingForHuman`, `blocked: …`, `active task lifecycle=active`,
   * `prior task completed`, etc.) instead of generic "active task".
   */
  @callable()
  getChannelIngressReadiness(): { canAccept: boolean; reason: string; currentTaskId: string | null; currentTaskLifecycle: string | null } {
    const s = this.getSafeState();
    const taskId = s.currentTaskObject?.id ?? null;
    const lifecycle = s.currentTaskObject?.status ?? null;
    if (s.waitingForHuman) {
      return { canAccept: false, reason: "waitingForHuman", currentTaskId: taskId, currentTaskLifecycle: lifecycle };
    }
    if (s.currentObstacle?.blocked) {
      const why = (s.currentObstacle.reason ?? "").slice(0, 120);
      return { canAccept: false, reason: `blocked: ${why}`, currentTaskId: taskId, currentTaskLifecycle: lifecycle };
    }
    // No structured task at all → free. (This is the production-bug fix:
    // stale `currentTask` STRING with NULL `currentTaskObject` is no longer
    // treated as busy. The string is a leftover from an earlier checkpoint;
    // the loop has nothing in flight.)
    if (s.currentTaskObject === null) {
      return { canAccept: true, reason: "no active task object", currentTaskId: null, currentTaskLifecycle: null };
    }
    if (lifecycle === "completed" || lifecycle === "failed") {
      return { canAccept: true, reason: `prior task ${lifecycle}`, currentTaskId: taskId, currentTaskLifecycle: lifecycle };
    }
    // Active / draft / waiting / review lifecycle — submitting a new task
    // here would overwrite in-flight work. Keep busy.
    return {
      canAccept: false,
      reason: `active task lifecycle=${lifecycle}`,
      currentTaskId: taskId,
      currentTaskLifecycle: lifecycle,
    };
  }

  @callable()
  getRecentCheckpoints(): { key: string; content: string; source: string; created_at: number }[] {
    return this.sql<{ key: string; content: string; source: string; created_at: number }>`
      SELECT key, content, source, created_at FROM checkpoints ORDER BY created_at DESC LIMIT 5
    `;
  }

  @callable()
  getRecentKanbanMutations(): { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; status: string; applied_at: number | null; evidence: string | null; created_at: number }[] {
    return this.sql<{ id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; status: string; applied_at: number | null; evidence: string | null; created_at: number }>`
      SELECT id, card_ref, mutation_type, description, diff_hint, status, applied_at, evidence, created_at FROM kanban_mutations ORDER BY created_at DESC LIMIT 5
    `;
  }

  @callable()
  getPendingKanbanMutations(): { id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; created_at: number }[] {
    return this.sql<{ id: number; card_ref: string; mutation_type: string; description: string; diff_hint: string; created_at: number }>`
      SELECT id, card_ref, mutation_type, description, diff_hint, created_at FROM kanban_mutations WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10
    `;
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
    const lar = this.agentThursdayState.lastActionResult;
    const ckptRows = this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM checkpoints`;
    const noteRows = this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM review_notes`;
    const mutRows = this.sql<{ n: number | bigint }>`SELECT COUNT(*) as n FROM kanban_mutations`;
    const ckptCount = Number(ckptRows[0]?.n ?? 0);
    const noteCount = Number(noteRows[0]?.n ?? 0);
    const mutCount = Number(mutRows[0]?.n ?? 0);

    const items: OutcomeVerification["items"] = [
      {
        actionType: "write-checkpoint",
        verified: ckptCount > 0,
        evidence: ckptCount > 0 ? `${ckptCount} checkpoint(s) in DB` : "checkpoints 表为空",
      },
      {
        actionType: "review-note",
        verified: noteCount > 0,
        evidence: noteCount > 0 ? `${noteCount} review note(s) in DB` : "review_notes 表为空",
      },
      {
        actionType: "advance-kanban-card",
        verified: mutCount > 0,
        evidence: mutCount > 0 ? `${mutCount} kanban mutation(s) in DB` : "kanban_mutations 表为空",
      },
      {
        actionType: "last-action",
        verified: lar?.outcome === "success",
        evidence: lar ? `lastActionResult: ${lar.actionType} → ${lar.outcome}` : "尚未执行任何 action",
      },
    ];

    const verified = items.every(i => i.verified);
    const effectiveProgress = (lar?.outcome === "success") && (ckptCount > 0 || noteCount > 0);
    let summary: string;
    if (!lar) {
      summary = "尚未执行 real action，请先运行 doWork 再执行 action。";
    } else if (effectiveProgress) {
      summary = `有效推进已确认：${lar.actionType} 执行成功，已有可审计 artifact。`;
    } else if (lar.outcome === "success") {
      summary = `${lar.actionType} 执行成功，但暂无持久化 artifact（可能为 stub）。`;
    } else {
      summary = `最近 action 未产出有效推进（outcome: ${lar.outcome}）。`;
    }

    return { lastActionType: lar?.actionType ?? null, lastOutcome: lar?.outcome ?? null, verified, items, effectiveProgress, summary };
  }

  @callable()
  getMutationReview(): MutationReview {
    const rows = this.sql<{ status: string; evidence: string | null }>`
      SELECT status, evidence FROM kanban_mutations
    `;
    const pendingCount  = rows.filter(r => r.status === "pending").length;
    const appliedCount  = rows.filter(r => r.status === "applied").length;
    const failedCount   = rows.filter(r => r.status === "failed").length;
    const rejectedCount = rows.filter(r => r.status === "rejected").length;
    const hasEvidence   = rows.some(r => r.status === "applied" && r.evidence !== null && r.evidence !== "");
    const effectiveProgress = appliedCount > 0 && hasEvidence;
    const readyForNextMilestone = effectiveProgress;

    let stage: MutationReview["stage"];
    let summary: string;
    if (rows.length === 0) {
      stage = "no-mutation";
      summary = "尚未产生任何 kanban mutation。先运行 doWork（stub-verbose）再执行 advance-kanban-card。";
    } else if (appliedCount === 0) {
      stage = "pending-only";
      summary = `${pendingCount} 条 pending mutation，尚未 apply。local executor 尚未确认任何修改。`;
    } else if (!effectiveProgress) {
      stage = "partial-applied";
      summary = `${appliedCount} 条已 apply，但无有效 evidence。confirm 时请提供 evidence。`;
    } else {
      stage = "mutation-verified";
      summary = `planner/executor 闭环成立：${appliedCount} applied（有 evidence），${failedCount} failed，${rejectedCount} rejected。mutation 已确认推动项目对象。`;
    }

    return { stage, pendingCount, appliedCount, failedCount, rejectedCount, hasEvidence, effectiveProgress, readyForNextMilestone, summary };
  }

  @callable()
  getRecoveryTimeline(): RecoveryTimelineItem[] {
    const RECOVERY_EVENTS = new Set([
      "obstacle.detected", "escalation.requested", "waiting.entered",
      "response.received", "response.acknowledged", "resume.triggered",
      "mode.changed", "response.used_in_resume", "action.failure.bridged",
    ]);

    const rows = this.sql<{ event_type: string; payload: string; created_at: number }>`
      SELECT event_type, payload, created_at FROM event_log
      ORDER BY created_at DESC LIMIT 100
    `;

    // Filter to recovery events and restore ASC order
    const recovery = rows.filter(r => RECOVERY_EVENTS.has(r.event_type)).reverse();

    // Scope to most recent recovery chain (from last obstacle.detected onward)
    const lastBlockIdx = recovery.map(r => r.event_type).lastIndexOf("obstacle.detected");
    const chain = lastBlockIdx >= 0 ? recovery.slice(lastBlockIdx) : recovery;

    return chain.map(row => {
      const p = JSON.parse(row.payload) as Record<string, string>;
      let summary: string;
      switch (row.event_type) {
        case "obstacle.detected":      summary = `阻塞: ${p.reason ?? ""}`; break;
        case "escalation.requested":   summary = `求助: ${p.whyBlocked ?? ""}`; break;
        case "waiting.entered":        summary = `进入等待: ${p.reason ?? ""}`; break;
        case "response.received":      summary = `收到响应 (${p.fromHuman}): ${p.contentSnippet ?? ""}`; break;
        case "response.acknowledged":  summary = `响应已确认: ${p.fromHuman}`; break;
        case "resume.triggered":       summary = `恢复触发: ${p.trigger ?? ""}`; break;
        case "mode.changed":           summary = `模式切换: ${p.from} → ${p.to}`; break;
        case "response.used_in_resume":  summary = `响应已用于恢复 (${p.fromHuman})`; break;
        case "action.failure.bridged":   summary = `执行失败已桥接回恢复链: ${p.actionType} — ${p.reason ?? ""}`; break;
        default:                       summary = row.event_type;
      }
      return { at: row.created_at, event: row.event_type, summary };
    });
  }

  @callable()
  getRecoveryReview(): RecoveryReview {
    const { waitingForHuman, currentObstacle, runtimeMode, recoveryPolicy, resumeTrigger } = this.getSafeState();
    let stage: RecoveryReview["stage"];
    let summary: string;
    if (waitingForHuman) {
      stage = "waiting";
      summary = "Agent 正在等待人类响应，请通过 Send Human Response 提供输入后继续。";
    } else if (currentObstacle?.blocked) {
      stage = "blocked";
      summary = `Agent 遇到阻塞: ${currentObstacle.reason}`;
    } else if (recoveryPolicy.policyMode === "safe-resume") {
      stage = "safe-resume";
      summary = `Agent 处于安全恢复模式，将单步谨慎推进。恢复触发: ${resumeTrigger ?? "—"}`;
    } else if (runtimeMode.mode === "recovered") {
      stage = "recovering";
      summary = "Agent 已收到人类响应，正在恢复执行。";
    } else {
      stage = "normal";
      summary = "Agent 运行正常，无恢复链路激活。";
    }
    const readyToContinue = !waitingForHuman && !(currentObstacle?.blocked);
    return { stage, readyToContinue, summary };
  }

  @callable()
  setModelProfile(provider: string, model: string): void {
    const prevSignal = getIntelligenceSignal(this.agentThursdayState.modelProfile);
    const newProfile = { provider, model };
    const newSignal = getIntelligenceSignal(newProfile);
    const awareness = getProfileAwareness(newProfile);
    this.logEvent("model.changed", { from: this.agentThursdayState.modelProfile, to: newProfile, awareness });
    if (prevSignal.tier !== newSignal.tier || prevSignal.mode !== newSignal.mode) {
      this.logEvent("intelligence.changed", { from: prevSignal, to: newSignal });
    }
    // Human responded to escalation by switching model → enter recovered mode
    const prevMode = this.agentThursdayState.runtimeMode;
    const runtimeMode: RuntimeMode = prevMode.mode === "assisted"
      ? { mode: "recovered", reason: `model switched to ${provider}/${model} after escalation` }
      : prevMode;
    if (runtimeMode.mode !== prevMode.mode) {
      this.logEvent("mode.changed", { from: prevMode.mode, to: runtimeMode.mode, reason: runtimeMode.reason });
    }
    this.setAgentThursdayState({ ...this.agentThursdayState, modelProfile: newProfile, runtimeMode, updatedAt: Date.now() });
  }

  @callable()
  acknowledgeHumanResponse(fromHuman: string, content: string): void {
    const traceId = `ack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const humanResponse: HumanResponse = { fromHuman, content, acknowledged: true, usedInResume: false };
    this.logEvent("response.received", { fromHuman, contentSnippet: content.slice(0, 100) }, traceId);
    // Human acknowledged → if in assisted mode, enter recovered
    const prevMode = this.agentThursdayState.runtimeMode;
    const runtimeMode: RuntimeMode = prevMode.mode === "assisted"
      ? { mode: "recovered", reason: `human response received from ${fromHuman}` }
      : prevMode;
    if (runtimeMode.mode !== prevMode.mode) {
      this.logEvent("mode.changed", { from: prevMode.mode, to: runtimeMode.mode, reason: runtimeMode.reason }, traceId);
    }
    this.logEvent("response.acknowledged", { fromHuman, acknowledged: true }, traceId);
    const resumeTrigger = `human-response:${fromHuman}`;
    this.logEvent("resume.triggered", { trigger: resumeTrigger, fromHuman }, traceId);
    const prevPolicy = this.agentThursdayState.recoveryPolicy;
    const recoveryPolicy: RecoveryPolicy = { policyMode: "safe-resume", reason: `human response received — entering safe-resume before full recovery` };
    if (recoveryPolicy.policyMode !== prevPolicy.policyMode) {
      this.logEvent("recovery.policy.changed", { from: prevPolicy.policyMode, to: recoveryPolicy.policyMode, reason: recoveryPolicy.reason }, traceId);
    }
    const resumedTaskObject = this.agentThursdayState.currentTaskObject?.status === "waiting"
      ? { ...this.agentThursdayState.currentTaskObject, status: "active" as const, updatedAt: Date.now() }
      : this.agentThursdayState.currentTaskObject;
    this.setAgentThursdayState({ ...this.agentThursdayState, lastHumanResponse: humanResponse, currentTaskObject: resumedTaskObject, waitingForHuman: false, resumeTrigger, recoveryPolicy, runtimeMode, updatedAt: Date.now() });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

//  A.2 — diagnostic endpoint helpers. Lets reviewers capture the
// raw `env.AI.run()` output for the four models in the dispatch saga, so we
// can tell whether tool_calls land where workers-ai-provider expects them.
const DIAG_MODEL_ALLOWLIST = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwq-32b",
  "@cf/moonshotai/kimi-k2.6",
] as const;

const DiagDispatchRequestSchema = z.object({
  model: z.enum(DIAG_MODEL_ALLOWLIST),
  prompt: z.string().min(1).max(2000),
  //  A.2-stream — opt into streaming mode. When set, the endpoint
  // calls env.AI.run(..., {stream: true}) and returns an SSE-chunk summary.
  stream: z.boolean().optional(),
});

type ToolCallsLocation = "top-level" | "choices.message" | "choices.delta" | "none";
type ResponseShape = "openai-style" | "native" | "unknown";

function summarizeDiagOutput(output: unknown): {
  rawKeys: string[];
  choiceMessageKeys: string[];
  responseShape: ResponseShape;
  toolCallsLocation: ToolCallsLocation;
  finishReason: string | null;
  hasReasoningContent: boolean;
  usage: unknown;
  rawOutputCapped: string;
} {
  const out = (output ?? {}) as Record<string, unknown>;
  const rawKeys = Object.keys(out);
  const choices = (Array.isArray(out.choices) ? out.choices : []) as Record<string, unknown>[];
  const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (firstChoice.message ?? {}) as Record<string, unknown>;
  const delta = (firstChoice.delta ?? {}) as Record<string, unknown>;
  const choiceMessageKeys = Object.keys(message);

  let toolCallsLocation: ToolCallsLocation;
  if (Array.isArray(out.tool_calls)) toolCallsLocation = "top-level";
  else if (Array.isArray(message.tool_calls)) toolCallsLocation = "choices.message";
  else if (Array.isArray(delta.tool_calls)) toolCallsLocation = "choices.delta";
  else toolCallsLocation = "none";

  let responseShape: ResponseShape;
  if (choices.length > 0) responseShape = "openai-style";
  else if ("response" in out) responseShape = "native";
  else responseShape = "unknown";

  const finishReason = typeof out.finish_reason === "string"
    ? (out.finish_reason as string)
    : (typeof firstChoice.finish_reason === "string" ? (firstChoice.finish_reason as string) : null);

  const hasReasoningContent =
    !!(message.reasoning_content || message.reasoning || delta.reasoning_content || delta.reasoning);

  const usage = out.usage ?? null;

  // Cap rawOutput at 4KB. Structural fields above are the primary signal;
  // the dump is for unexpected shapes the structural classifiers miss.
  let stringified: string;
  try { stringified = JSON.stringify(output) ?? "null"; }
  catch { stringified = "[unstringifiable output]"; }
  const rawOutputCapped = stringified.length > 4096
    ? stringified.slice(0, 4096) + "...[truncated]"
    : stringified;

  return {
    rawKeys,
    choiceMessageKeys,
    responseShape,
    toolCallsLocation,
    finishReason,
    hasReasoningContent,
    usage,
    rawOutputCapped,
  };
}

//  A.2-stream — read SSE chunks from a Workers AI streaming response,
// parse line-buffered `data: {...}` events, and return a summary of where
// tool_calls (and content) appear across chunks. Bypasses workers-ai-provider's
// own parser so we can tell whether tool_calls are dropped at the network
// layer (Workers AI doesn't emit them in chunks) or at the parser layer
// (provider drops them after Workers AI emits them).
async function readSSEChunks(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Hard caps so a runaway stream cannot exhaust memory.
  const MAX_CHUNKS = 200;
  const MAX_BYTES = 256 * 1024;
  let bytesRead = 0;
  try {
    while (chunks.length < MAX_CHUNKS && bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let data: string;
        if (trimmed.startsWith("data: ")) data = trimmed.slice(6);
        else if (trimmed.startsWith("data:")) data = trimmed.slice(5);
        else continue;
        if (data === "[DONE]") continue;
        try { chunks.push(JSON.parse(data)); }
        catch { /* skip un-parsable chunks; they're rare and not informative */ }
      }
    }
    // Drain a final flush of any remaining buffered partial line.
    const finalTrimmed = buffer.trim();
    if (finalTrimmed) {
      let data: string | null = null;
      if (finalTrimmed.startsWith("data: ")) data = finalTrimmed.slice(6);
      else if (finalTrimmed.startsWith("data:")) data = finalTrimmed.slice(5);
      if (data && data !== "[DONE]") {
        try { chunks.push(JSON.parse(data)); } catch { /* ignore */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return chunks;
}

function summarizeDiagStreamChunks(chunks: unknown[]): {
  totalChunks: number;
  chunksWithTopLevelToolCalls: number;
  chunksWithChoicesDeltaToolCalls: number;
  chunksWithChoicesMessageToolCalls: number;
  chunksWithNativeResponse: number;
  chunksWithChoicesDeltaContent: number;
  chunksWithFinishReason: number;
  finishReasons: string[];
  firstChunkKeys: string[];
  lastChunkKeys: string[];
  accumulatedContentLen: number;
  accumulatedToolCallsCount: number;
  rawChunksCapped: string;
} {
  let chunksWithTopLevelToolCalls = 0;
  let chunksWithChoicesDeltaToolCalls = 0;
  let chunksWithChoicesMessageToolCalls = 0;
  let chunksWithNativeResponse = 0;
  let chunksWithChoicesDeltaContent = 0;
  let chunksWithFinishReason = 0;
  const finishReasons: string[] = [];
  let accumulatedContent = "";
  const toolCalls: unknown[] = [];

  for (const c of chunks) {
    const ch = (c ?? {}) as Record<string, unknown>;
    const choices = (Array.isArray(ch.choices) ? ch.choices : []) as Record<string, unknown>[];
    const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (firstChoice.delta ?? {}) as Record<string, unknown>;
    const message = (firstChoice.message ?? {}) as Record<string, unknown>;

    if (Array.isArray(ch.tool_calls)) {
      chunksWithTopLevelToolCalls++;
      for (const tc of ch.tool_calls) toolCalls.push(tc);
    }
    if (Array.isArray(delta.tool_calls)) {
      chunksWithChoicesDeltaToolCalls++;
      for (const tc of delta.tool_calls) toolCalls.push(tc);
    }
    if (Array.isArray(message.tool_calls)) {
      chunksWithChoicesMessageToolCalls++;
      for (const tc of message.tool_calls) toolCalls.push(tc);
    }
    if (typeof ch.response === "string" && ch.response.length > 0) {
      chunksWithNativeResponse++;
      accumulatedContent += ch.response;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      chunksWithChoicesDeltaContent++;
      accumulatedContent += delta.content;
    }
    const fr = ch.finish_reason ?? firstChoice.finish_reason;
    if (typeof fr === "string") {
      chunksWithFinishReason++;
      if (!finishReasons.includes(fr)) finishReasons.push(fr);
    }
  }

  const firstChunk = (chunks[0] ?? {}) as Record<string, unknown>;
  const lastChunk = (chunks[chunks.length - 1] ?? {}) as Record<string, unknown>;

  // Cap raw chunks dump at 4KB across the first N chunks for inspectability.
  let rawChunksCapped = "";
  for (const c of chunks) {
    let s: string;
    try { s = JSON.stringify(c) ?? "null"; } catch { s = "[unstringifiable]"; }
    if (rawChunksCapped.length + s.length + 1 > 4096) break;
    rawChunksCapped += (rawChunksCapped ? "\n" : "") + s;
  }
  if (chunks.length > 0 && rawChunksCapped.length === 0) rawChunksCapped = "[chunks too large to fit cap]";

  return {
    totalChunks: chunks.length,
    chunksWithTopLevelToolCalls,
    chunksWithChoicesDeltaToolCalls,
    chunksWithChoicesMessageToolCalls,
    chunksWithNativeResponse,
    chunksWithChoicesDeltaContent,
    chunksWithFinishReason,
    finishReasons,
    firstChunkKeys: Object.keys(firstChunk),
    lastChunkKeys: Object.keys(lastChunk),
    accumulatedContentLen: accumulatedContent.length,
    accumulatedToolCallsCount: toolCalls.length,
    rawChunksCapped,
  };
}

// auto-route helper. After a successful inbound INSERT, the
// ingest endpoint calls this so addressed/trusted messages flow into the
// AgentThursdayAgent loop without requiring a manual /api/channel/route-pending POST.
// - bounded limit (5) keeps latency tight
// - duplicate ingest skips this entirely (caller passes inserted=false)
// - errors are swallowed; the ingest response still succeeds
// - busy-skipped rows stay `received` ( invariant: do not consume the
//   user's message just because the agent is busy)
type AutoRouteSummary = {
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

// map BrowserError to stable HTTP shapes; same message-prefix
// reasoning as workspaceFileError (DO RPC erases JS class identity).
function browserError(e: unknown): Response {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("browser:url-invalid"))     return json({ code: "browser.url-invalid" }, 400);
  if (msg.includes("browser:url-scheme"))      return json({ code: "browser.url-scheme" }, 400);
  if (msg.includes("browser:url-localhost"))   return json({ code: "browser.url-localhost" }, 400);
  if (msg.includes("browser:url-private"))     return json({ code: "browser.url-private" }, 400);
  if (msg.includes("browser:url-metadata"))    return json({ code: "browser.url-metadata" }, 400);
  if (msg.includes("browser:binding-missing")) return json({ code: "browser.binding-missing", message: msg }, 503);
  if (msg.includes("browser:navigate-failed"))  return json({ code: "browser.navigate-failed", message: msg }, 502);
  if (msg.includes("browser:evaluate-failed"))  return json({ code: "browser.evaluate-failed", message: msg }, 502);
  if (msg.includes("browser:timeout"))         return json({ code: "browser.timeout" }, 504);
  return json({ code: "internal", message: msg }, 500);
}

// map workspace file errors to HTTP shapes the web client knows.
// Pattern-match by message because errors thrown inside @callable() DO methods
// lose their JS class identity when serialized across the RPC boundary; the
// stable contract is the `path:*` / `file:*` message prefixes set in
// src/workspaceFiles.ts.
function workspaceFileError(e: unknown): Response {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("path:null-byte"))   return json({ code: "path.null-byte" }, 400);
  if (msg.includes("path:backslash"))   return json({ code: "path.backslash" }, 400);
  if (msg.includes("path:absolute"))    return json({ code: "path.absolute" }, 400);
  if (msg.includes("path:traversal"))   return json({ code: "path.traversal" }, 400);
  if (msg.includes("path:hidden"))      return json({ code: "path.hidden" }, 403);
  if (msg.includes("file:not-found"))   return json({ code: "file.not-found" }, 404);
  if (msg.includes("file:is-dir"))      return json({ code: "file.is-dir" }, 400);
  if (msg.includes("file:binary"))      return json({ code: "file.binary" }, 415);
  return json({ code: "internal", message: msg }, 500);
}

function homePage(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentThursday Agent Demo</title>
<style>
  body { font-family: monospace; max-width: 800px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: .5rem; }
  h2 { color: #8b949e; font-size: 1rem; margin-top: 2rem; }
  button { background: #238636; color: #fff; border: none; padding: .5rem 1.2rem; cursor: pointer; font-family: monospace; border-radius: 4px; }
  button:hover { background: #2ea043; }
  pre { background: #161b22; border: 1px solid #30363d; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border-radius: 4px; min-height: 3rem; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .8rem; }
  .idle { background: #1f6feb22; color: #58a6ff; }
  .running { background: #d29922; color: #fff; }
  a { color: #58a6ff; }
  .links { margin: 1rem 0; }
  .links a { margin-right: 1rem; }
  .profile-btn { background: #1f3a5f; margin-right: .5rem; }
  .profile-btn:hover { background: #2a5080; }
  .review-box { border: 1px solid #30363d; border-radius: 6px; padding: 1rem; margin: 1rem 0; }
  .stage-normal { border-color: #1f6feb; background: #0d1f3c; }
  .stage-waiting { border-color: #d29922; background: #2a1f00; }
  .stage-blocked { border-color: #da3633; background: #3d0c0c; }
  .stage-safe-resume { border-color: #8957e5; background: #1b1040; }
  .stage-recovering { border-color: #2ea043; background: #0d2a14; }
  .exec-no-action { border-color: #484f58; background: #161b22; }
  .exec-gate-blocked { border-color: #da3633; background: #3d0c0c; }
  .exec-gate-open { border-color: #1f6feb; background: #0d1f3c; }
  .exec-executed-success { border-color: #2ea043; background: #0d2a14; }
  .exec-bridged-to-recovery { border-color: #d29922; background: #2a1f00; }
  .real-no-execution { border-color: #484f58; background: #161b22; }
  .real-stub-only { border-color: #1f6feb; background: #0d1f3c; }
  .real-real-partial { border-color: #d29922; background: #2a1f00; }
  .real-real-verified { border-color: #2ea043; background: #0d2a14; }
  .mut-no-mutation { border-color: #484f58; background: #161b22; }
  .mut-pending-only { border-color: #1f6feb; background: #0d1f3c; }
  .mut-partial-applied { border-color: #d29922; background: #2a1f00; }
  .mut-mutation-verified { border-color: #2ea043; background: #0d2a14; }
  .gate-open { border-color: #2ea043; background: #0d2a14; }
  .gate-blocked { border-color: #da3633; background: #3d0c0c; }
  .approval-clear { border-color: #2ea043; background: #0d2a14; }
  .approval-blocked { border-color: #da3633; background: #3d0c0c; }
  .loop-no-task { border-color: #484f58; background: #161b22; }
  .loop-task-active { border-color: #1f6feb; background: #0d1f3c; }
  .loop-awaiting-deliverable { border-color: #d29922; background: #2a1f00; }
  .loop-gate-open { border-color: #8957e5; background: #1b1040; }
  .loop-loop-ready { border-color: #2ea043; background: #0d2a14; }
  .stage-label { font-size: 1.1rem; font-weight: bold; margin-bottom: .5rem; }
  .ready-yes { color: #2ea043; } .ready-no { color: #da3633; }
</style>
</head>
<body>
<h1>AgentThursday — Durable Agent Skeleton</h1>
<p>Cloud-native serverless agent built on Cloudflare Durable Objects. <span id="badge" class="badge idle">loading...</span></p>
<div class="links">
  <a href="/health">/health</a>
  <a href="/demo/status">/demo/status</a>
</div>

<h2>M4 TUI WORKFLOW DEMO ()</h2>
<div id="m4-tui-demo-box" class="review-box loop-no-task">
  <div class="stage-label" id="m4-demo-ready">loading...</div>
  <div id="m4-demo-stage">—</div>
  <pre id="m4-demo-steps" style="margin-top:.5rem;font-size:.85rem;">—</pre>
</div>

<h2>M3 CLI SESSION (M3)</h2>
<pre id="cli-session">(no session yet)</pre>

<h2>M3 CLI RESULT VIEW ()</h2>
<pre id="cli-result-view">(submit a task and run doWork to see result view)</pre>

<h2>M3 END-TO-END LOOP DEMO ()</h2>
<div id="m3-loop-demo-box" class="review-box loop-no-task">
  <div class="stage-label" id="m3-demo-ready">loading...</div>
  <div id="m3-demo-stage">—</div>
  <pre id="m3-demo-steps" style="margin-top:.5rem;font-size:.85rem;">—</pre>
</div>

<h2>M2 DEVELOPER LOOP REVIEW</h2>
<div id="dev-loop-review-box" class="review-box loop-no-task">
  <div class="stage-label" id="dev-loop-stage">loading...</div>
  <div id="dev-loop-ready">—</div>
  <div id="dev-loop-detail" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="dev-loop-summary" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>M2 HUMAN INTERVENTION &amp; APPROVAL POLICY</h2>
<div id="approval-policy-box" class="review-box approval-blocked">
  <div class="stage-label" id="approval-stage">loading...</div>
  <div id="approval-ready">—</div>
  <div id="approval-interventions" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="approval-block-reason" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>M2 DELIVERABLE CONVERGENCE &amp; REVIEW GATE</h2>
<div id="deliverable-gate-box" class="review-box gate-blocked">
  <div class="stage-label" id="gate-stage">loading...</div>
  <div id="gate-ready">—</div>
  <div id="gate-deliverable" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="gate-reason" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>MUTATION REVIEW</h2>
<div id="mutation-review-box" class="review-box mut-no-mutation">
  <div class="stage-label" id="mut-review-stage">loading...</div>
  <div id="mut-review-ready">—</div>
  <div id="mut-review-detail" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="mut-review-summary" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>RECOVERY REVIEW</h2>
<div id="recovery-review-box" class="review-box stage-normal">
  <div class="stage-label" id="review-stage">loading...</div>
  <div id="review-ready">—</div>
  <div id="review-summary" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>REAL ACTION REVIEW</h2>
<div id="real-action-review-box" class="review-box real-no-execution">
  <div class="stage-label" id="real-review-stage">loading...</div>
  <div id="real-review-ready">—</div>
  <div id="real-review-detail" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="real-review-summary" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>EXECUTION REVIEW</h2>
<div id="execution-review-box" class="review-box exec-no-action">
  <div class="stage-label" id="exec-review-stage">loading...</div>
  <div id="exec-review-ready">—</div>
  <div id="exec-review-detail" style="margin-top:.5rem;color:#8b949e;font-size:.9rem;">—</div>
  <div id="exec-review-summary" style="margin-top:.5rem;color:#8b949e;">—</div>
</div>

<h2>AGENT STATUS</h2>
<pre id="status">Loading...</pre>

<h2>MODEL PROFILE &amp; INTELLIGENCE</h2>
<pre id="profile">Loading...</pre>
<button class="profile-btn" onclick="switchProfile('deterministic','stub-concise')">stub-concise (low / safer)</button>
<button class="profile-btn" onclick="switchProfile('deterministic','stub-verbose')">stub-verbose (medium / normal)</button>
<button class="profile-btn" onclick="switchProfile('workers-ai','@cf/meta/llama-3-8b-instruct')">workers-ai / llama-3-8b (real model)</button>

<h2>CURRENT TASK OBJECT (M2)</h2>
<pre id="task-object">(no task yet — run doWork first)</pre>

<h2>PLANNER / EXECUTOR / REVIEWER CONTRACT (M2)</h2>
<pre id="loop-contract">(no contract yet — run doWork then executeAction)</pre>

<h2>COMMITTED NEXT ACTION</h2>
<pre id="committed-action">Loading...</pre>

<h2>REAL ACTION POLICY ()</h2>
<pre id="real-action-policy">Loading...</pre>

<h2>ACTION EXECUTION CONTRACT</h2>
<pre id="action-contract">Loading...</pre>

<h2>PREFLIGHT / EXECUTION GATE</h2>
<pre id="preflight">Loading...</pre>

<h2>REAL ACTION OUTCOME VERIFICATION</h2>
<pre id="outcome-verification">(no actions executed yet)</pre>

<h2>RECENT REVIEW NOTES (real write)</h2>
<pre id="recent-review-notes">(no review notes written yet)</pre>

<h2>RECENT CHECKPOINTS (real write)</h2>
<pre id="recent-checkpoints">(no checkpoints written yet)</pre>

<h2>RECENT KANBAN MUTATIONS (real bounded)</h2>
<pre id="recent-kanban-mutations">(no kanban mutations recorded yet)</pre>

<h2>ACTION RESULT</h2>
<pre id="action-result">(no action executed yet)</pre>

<h2>RUNTIME MODE</h2>
<pre id="runtime-mode">Loading...</pre>

<h2>RECOVERY POLICY</h2>
<pre id="recovery-policy">Loading...</pre>

<h2>OBSTACLE STATE</h2>
<pre id="obstacle">Loading...</pre>

<h2>HELP REQUEST / ESCALATION</h2>
<pre id="help-request">Loading...</pre>

<h2>WAITING / RESUME STATE</h2>
<pre id="waiting-state">Loading...</pre>

<h2>HUMAN RESPONSE / RESUME BRIDGE</h2>
<pre id="human-response">Loading...</pre>
<textarea id="respond-content" rows="2" style="width:100%;font-family:monospace;background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:.5rem;box-sizing:border-box;border-radius:4px;" placeholder="输入人类响应内容..."></textarea>
<button onclick="sendHumanResponse()" style="margin-top:.5rem;background:#6e40c9;">Send Human Response</button>
<pre id="respond-result" style="margin-top:.5rem;">—</pre>

<h2>MEMORY LAYERS</h2>
<pre id="memory">Loading...</pre>

<h2>RUN DOGFOOD DEMO</h2>
<p>Fixed task: <em>${DOGFOOD_TASK}</em></p>
<button onclick="runDemo()">Run doWork() (single step)</button>
<button onclick="runLoop()" style="margin-left:.5rem;background:#5a2d8c;">Run runLoop() (3 steps)</button>
<pre id="result">—</pre>

<h2>LAST TRACE REPLAY</h2>
<pre id="trace">—</pre>

<h2>RECOVERY TIMELINE</h2>
<pre id="recovery-timeline">(no recovery chain yet — run doWork until blocked, then respond)</pre>

<h2>RECENT EVENTS</h2>
<pre id="events">Loading...</pre>

<script>
async function load() {
  try {
    const r = await fetch('/demo/status');
    const d = await r.json();
    if (d.cliSession) {
      const cs = d.cliSession;
      const dlr = d.developerLoopReview;
      const ap = d.approvalPolicy;
      const activeIv = ap ? ap.interventions.filter(i => i.active).map(i => \`  ⚠ [\${i.kind}] \${i.reason}\`).join('\\n') : '';
      const cmdLines = cs.availableCommands.map(c =>
        \`  [\${c.kind.padEnd(12)}] \${c.method.padEnd(4)} \${c.endpoint.padEnd(16)} — \${c.description}\`
      ).join('\\n');
      document.getElementById('cli-session').textContent =
        \`sessionId:  \${cs.sessionId}\\ninstance:   \${cs.instanceName}\\ntask:       \${cs.taskTitle ?? '(none)'}\\nlifecycle:  \${cs.taskLifecycle ?? '—'}\\nloopStage:  \${cs.loopStage}\\nautoContinue: \${cs.autoContinue}\\nsuggested:  \${cs.suggestedNextCommand ?? '—'}\\n\` +
        (dlr ? \`loopSummary: \${dlr.summary}\\n\` : '') +
        (activeIv ? \`\\nactive interventions:\\n\${activeIv}\\n\` : '') +
        \`\\ncommands:\\n\${cmdLines}\`;
    }
    if (d.cliResultView) {
      const rv = d.cliResultView;
      document.getElementById('cli-result-view').textContent =
        \`task:              \${rv.taskTitle ?? '(none)'}  [\${rv.taskLifecycle ?? '—'}]\\n\` +
        \`loopStage:         \${rv.loopStage}\\n\` +
        \`deliverableFormed: \${rv.deliverableFormed ? '✓ yes' : '✗ no'}  — \${rv.deliverableSummary ?? '—'}\\n\` +
        \`gatePassed:        \${rv.gatePassed ? '✓ yes' : '✗ no'}  — \${rv.gateReason}\\n\` +
        \`readyForNextRound: \${rv.readyForNextRound ? '✓ yes' : '✗ no'}\\n\` +
        \`suggested:         \${rv.suggestedNextCommand ?? '—'}\\n\` +
        \`loopSummary:       \${rv.loopSummary}\\n\` +
        (rv.activeInterventions.length > 0
          ? \`\\nactive interventions:\\n\${rv.activeInterventions.map(i => '  ⚠ ' + i).join('\\n')}\`
          : '\\n(no active interventions)');
    }
    if (d.m4TuiWorkflowDemo) {
      const dm = d.m4TuiWorkflowDemo;
      const box = document.getElementById('m4-tui-demo-box');
      box.className = 'review-box ' + (dm.workflowReady ? 'loop-loop-ready' : 'loop-task-active');
      const readyEl = document.getElementById('m4-demo-ready');
      readyEl.textContent = dm.workflowReady ? '✓ TUI WORKFLOW READY — end-to-end chain clear' : '○ TUI READY — waiting for task or intervention resolution';
      readyEl.className = dm.workflowReady ? 'ready-yes' : 'ready-no';
      document.getElementById('m4-demo-stage').textContent =
        \`cloudState: \${dm.cloudStateReady}  |  interventionClear: \${dm.interventionClear}  |  readyForNextMilestone: \${dm.readyForNextMilestone}\`;
      document.getElementById('m4-demo-steps').textContent = dm.steps.map(s =>
        \`[\${s.method.padEnd(4)}] \${s.endpoint.padEnd(16)}  \${s.name.padEnd(8)} — \${s.statusNote}\`
      ).join('\\n') + '\\n\\n' + dm.summary;
    }
    if (d.m3CliLoopDemo) {
      const dm = d.m3CliLoopDemo;
      const box = document.getElementById('m3-loop-demo-box');
      box.className = 'review-box ' + (dm.loopReady ? 'loop-loop-ready' : 'loop-task-active');
      const readyEl = document.getElementById('m3-demo-ready');
      readyEl.textContent = dm.loopReady ? '✓ LOOP READY — end-to-end chain clear' : '○ LOOP IN PROGRESS';
      readyEl.className = dm.loopReady ? 'ready-yes' : 'ready-no';
      document.getElementById('m3-demo-stage').textContent =
        \`loopStage: \${dm.currentLoopStage}  |  readyForNextRound: \${dm.readyForNextRound}  |  activeInterventions: \${dm.activeInterventionCount}\`;
      document.getElementById('m3-demo-steps').textContent = dm.steps.map(s =>
        \`[\${s.method.padEnd(4)}] \${s.endpoint.padEnd(16)}  \${s.name.padEnd(8)} — \${s.statusNote}\`
      ).join('\\n');
    }
    if (d.developerLoopReview) {
      const dlr = d.developerLoopReview;
      const box = document.getElementById('dev-loop-review-box');
      box.className = 'review-box loop-' + dlr.stage;
      document.getElementById('dev-loop-stage').textContent = 'STAGE: ' + dlr.stage.toUpperCase().replace(/-/g, ' ');
      const readyEl = document.getElementById('dev-loop-ready');
      readyEl.textContent = dlr.readyForNextRound ? '✓ ready for next round' : '✗ not ready for next round';
      readyEl.className = dlr.readyForNextRound ? 'ready-yes' : 'ready-no';
      document.getElementById('dev-loop-detail').textContent =
        \`task: \${dlr.taskLifecycle ?? '—'}  |  reviewer: \${dlr.reviewerAccepted}  |  gate: \${dlr.gateOpen ? 'open' : 'blocked'}  |  interventions: \${dlr.activeInterventionCount}\`;
      document.getElementById('dev-loop-summary').textContent = dlr.summary;
    }
    if (d.approvalPolicy) {
      const ap = d.approvalPolicy;
      const box = document.getElementById('approval-policy-box');
      box.className = 'review-box approval-' + (ap.autoContinue ? 'clear' : 'blocked');
      document.getElementById('approval-stage').textContent = ap.autoContinue ? 'AUTO-CONTINUE: YES' : 'REQUIRES HUMAN CONFIRM';
      const readyEl = document.getElementById('approval-ready');
      readyEl.textContent = ap.autoContinue ? '✓ auto-continue allowed' : '✗ human intervention required';
      readyEl.className = ap.autoContinue ? 'ready-yes' : 'ready-no';
      const ivLines = ap.interventions.map(i =>
        \`  \${i.active ? '⚠' : '✓'} [\${i.kind}] \${i.reason}\`
      ).join('\\n');
      document.getElementById('approval-interventions').textContent = ivLines;
      document.getElementById('approval-block-reason').textContent = ap.blockReason ?? '—';
    }
    if (d.deliverableGate) {
      const dg = d.deliverableGate;
      const box = document.getElementById('deliverable-gate-box');
      box.className = 'review-box gate-' + dg.reviewGate.gate;
      document.getElementById('gate-stage').textContent = 'GATE: ' + dg.reviewGate.gate.toUpperCase();
      const readyEl = document.getElementById('gate-ready');
      readyEl.textContent = dg.reviewGate.allowNextRound ? '✓ allow next round' : '✗ cannot continue yet';
      readyEl.className = dg.reviewGate.allowNextRound ? 'ready-yes' : 'ready-no';
      const del = dg.deliverable;
      document.getElementById('gate-deliverable').textContent =
        \`task: \${del.taskTitle ?? '—'}  |  readyForReview: \${del.readyForReview}  |  artifact: \${del.resultSummary ?? '—'}\`;
      document.getElementById('gate-reason').textContent = dg.reviewGate.reason;
    }
    if (d.mutationReview) {
      const mr = d.mutationReview;
      const box = document.getElementById('mutation-review-box');
      box.className = 'review-box mut-' + mr.stage;
      document.getElementById('mut-review-stage').textContent = 'STAGE: ' + mr.stage.toUpperCase().replace(/-/g, ' ');
      const readyEl = document.getElementById('mut-review-ready');
      readyEl.textContent = mr.readyForNextMilestone ? '✓ ready for next milestone' : '✗ not ready for next milestone';
      readyEl.className = mr.readyForNextMilestone ? 'ready-yes' : 'ready-no';
      document.getElementById('mut-review-detail').textContent =
        \`pending: \${mr.pendingCount}  |  applied: \${mr.appliedCount}  |  failed: \${mr.failedCount}  |  rejected: \${mr.rejectedCount}  |  hasEvidence: \${mr.hasEvidence}  |  effectiveProgress: \${mr.effectiveProgress}\`;
      document.getElementById('mut-review-summary').textContent = mr.summary;
    }
    if (d.realActionReview) {
      const rar = d.realActionReview;
      const box = document.getElementById('real-action-review-box');
      box.className = 'review-box real-' + rar.stage;
      document.getElementById('real-review-stage').textContent = 'STAGE: ' + rar.stage.toUpperCase().replace(/-/g, ' ');
      const readyEl = document.getElementById('real-review-ready');
      readyEl.textContent = rar.readyForNextMilestone ? '✓ ready for next milestone' : '✗ not ready for next milestone';
      readyEl.className = rar.readyForNextMilestone ? 'ready-yes' : 'ready-no';
      document.getElementById('real-review-detail').textContent =
        \`real actions: \${rar.realActionCount}  |  artifacts: \${rar.artifactCount}  |  effectiveProgress: \${rar.effectiveProgress}  |  recoveryReady: \${rar.recoveryReady}\`;
      document.getElementById('real-review-summary').textContent = rar.summary;
    }
    if (d.executionReview) {
      const er = d.executionReview;
      const box = document.getElementById('execution-review-box');
      box.className = 'review-box exec-' + er.stage;
      document.getElementById('exec-review-stage').textContent = 'STAGE: ' + er.stage.toUpperCase().replace(/-/g, ' ');
      const readyEl = document.getElementById('exec-review-ready');
      readyEl.textContent = er.readyToContinue ? '✓ ready to continue' : '✗ not ready to continue';
      readyEl.className = er.readyToContinue ? 'ready-yes' : 'ready-no';
      document.getElementById('exec-review-detail').textContent =
        \`allowlisted: \${er.allowlisted}  |  gate: \${er.gateOpen ? 'open' : 'blocked'}  |  lastOutcome: \${er.lastOutcome ?? '—'}  |  failureBridged: \${er.failureBridged}\`;
      document.getElementById('exec-review-summary').textContent = er.summary;
    }
    if (d.recoveryReview) {
      const rv = d.recoveryReview;
      const box = document.getElementById('recovery-review-box');
      box.className = 'review-box stage-' + rv.stage;
      document.getElementById('review-stage').textContent = 'STAGE: ' + rv.stage.toUpperCase();
      const readyEl = document.getElementById('review-ready');
      readyEl.textContent = rv.readyToContinue ? '✓ ready to continue' : '✗ not ready to continue';
      readyEl.className = rv.readyToContinue ? 'ready-yes' : 'ready-no';
      document.getElementById('review-summary').textContent = rv.summary;
    }
    document.getElementById('status').textContent = JSON.stringify(d.status, null, 2);
    if (d.currentTaskObject) {
      const to = d.currentTaskObject;
      document.getElementById('task-object').textContent =
        \`id:        \${to.id}\\ntitle:     \${to.title}\\nstatus:    \${to.status}\\nsource:    \${to.source}\\ncreatedAt: \${new Date(to.createdAt).toISOString()}\\nupdatedAt: \${new Date(to.updatedAt).toISOString()}\`;
    } else {
      document.getElementById('task-object').textContent = '(no task yet — run doWork first)';
    }
    if (d.loopContract) {
      const lc = d.loopContract;
      const p = lc.planner; const e = lc.executor; const r = lc.reviewer;
      document.getElementById('loop-contract').textContent =
        \`round: \${lc.roundId}\\n\\n\` +
        \`[PLANNER]\\n  task:      \${p.taskTitle ?? '—'}\\n  nextStep:  \${p.nextStep ?? '—'}\\n  rationale: \${p.rationale ?? '—'}\\n  readyForExecutor: \${p.readyForExecutor}\\n\\n\` +
        \`[EXECUTOR]\\n  action:   \${e.actionType ?? '—'}\\n  outcome:  \${e.outcome ?? '—'}\\n  artifact: \${e.artifactSummary ?? '—'}\\n  executedAt: \${e.executedAt ? new Date(e.executedAt).toISOString() : '—'}\\n\\n\` +
        \`[REVIEWER]\\n  accepted:    \${r.accepted}\\n  canContinue: \${r.canContinue}\\n  reason:      \${r.reason}\`;
    }
    document.getElementById('profile').textContent =
      JSON.stringify(d.profileAwareness, null, 2);
    document.getElementById('memory').textContent =
      JSON.stringify(d.memoryLayers, null, 2);
    if (d.outcomeVerification) {
      const ov = d.outcomeVerification;
      const itemLines = ov.items.map(i => \`  \${i.verified ? '✓' : '✗'} [\${i.actionType}] \${i.evidence}\`).join('\\n');
      document.getElementById('outcome-verification').textContent =
        \`effectiveProgress: \${ov.effectiveProgress ? '✓ yes' : '✗ no'}\\n\` +
        \`lastAction:        \${ov.lastActionType ?? '—'} → \${ov.lastOutcome ?? '—'}\\n\\n\` +
        \`verification items:\\n\${itemLines}\\n\\n\` +
        \`summary: \${ov.summary}\`;
    }
    if (d.recentReviewNotes) {
      document.getElementById('recent-review-notes').textContent = d.recentReviewNotes.length > 0
        ? d.recentReviewNotes.map(n =>
            \`[\${new Date(n.created_at).toISOString()}] [\${n.source}]\\n\${n.content}\`
          ).join('\\n─────────────────────────────────────────────\\n')
        : '(no review notes written yet)';
    }
    if (d.recentCheckpoints) {
      document.getElementById('recent-checkpoints').textContent = d.recentCheckpoints.length > 0
        ? d.recentCheckpoints.map(c =>
            \`[\${new Date(c.created_at).toISOString()}] [\${c.source}] \${c.key}\\n  \${c.content}\`
          ).join('\\n')
        : '(no checkpoints written yet)';
    }
    if (d.recentKanbanMutations) {
      document.getElementById('recent-kanban-mutations').textContent = d.recentKanbanMutations.length > 0
        ? d.recentKanbanMutations.map(m =>
            \`[\${new Date(m.created_at).toISOString()}] [id:\${m.id}] [\${m.mutation_type}] \${m.card_ref}  status: \${m.status}\` +
            (m.applied_at ? \` applied: \${new Date(m.applied_at).toISOString()}\` : '') +
            \`\\n  \${m.description}\\n  hint: \${m.diff_hint}\` +
            (m.evidence ? \`\\n  evidence: \${m.evidence}\` : '')
          ).join('\\n─────────────────────────────────────────────\\n')
        : '(no kanban mutations recorded yet)';
    }
    const lar = d.status.lastActionResult;
    document.getElementById('action-result').textContent = lar
      ? \`actionType: \${lar.actionType}\\noutcome:    \${lar.outcome}\\nsummary:    \${lar.summary}\\nrecordedAt: \${new Date(lar.recordedAt).toISOString()}\`
      : '(no action executed yet)';
    if (d.preflight) {
      const pf = d.preflight;
      const gateStr = pf.gate === 'open' ? '✓ GATE: OPEN' : '✗ GATE: BLOCKED';
      const checksStr = pf.checks.map(c => \`  \${c.passed ? '✓' : '✗'} [\${c.name}] \${c.reason}\`).join('\\n');
      document.getElementById('preflight').textContent = \`\${gateStr}\\nreason: \${pf.reason}\\n\\nchecks:\\n\${checksStr}\`;
    }
    if (d.realActionPolicy) {
      const rap = d.realActionPolicy;
      const lines = rap.entries.map(e =>
        \`  [\${e.executionMode === 'real' ? '✓ real' : '○ stub'}] \${e.actionType} — \${e.rationale}\`
      ).join('\\n');
      document.getElementById('real-action-policy').textContent = \`policy v\${rap.version}:\\n\${lines}\`;
    }
    if (d.actionContract) {
      const ac = d.actionContract;
      const cea = ac.currentExecutableAction;
      const allowlistLines = ac.allowlist.entries.map(e => \`  [\${e.actionType}] \${e.description}\`).join('\\n');
      const ceaLine = cea
        ? \`currentExecutableAction:\\n  type:        \${cea.actionType}\\n  allowlisted: \${cea.allowlisted}\\n  title:       \${cea.title}\`
        : 'currentExecutableAction: (none yet — run doWork first)';
      document.getElementById('action-contract').textContent =
        \`allowlist (v\${ac.allowlist.version}):\\n\${allowlistLines}\\n\\n\${ceaLine}\`;
    }
    const ca = d.status.committedAction;
    document.getElementById('committed-action').textContent = ca
      ? \`title:     \${ca.title}\nreason:    \${ca.reason}\ncommitted: \${ca.committed}\`
      : '(none yet — run doWork first)';
    const rm = d.status.runtimeMode;
    document.getElementById('runtime-mode').textContent = rm
      ? \`mode:   \${rm.mode}\nreason: \${rm.reason}\`
      : 'loading...';
    const rp = d.status.recoveryPolicy;
    document.getElementById('recovery-policy').textContent = rp
      ? \`policyMode: \${rp.policyMode}\nreason:     \${rp.reason}\`
      : 'loading...';
    const ob = d.status.currentObstacle;
    document.getElementById('obstacle').textContent = ob
      ? \`blocked:               \${ob.blocked}\nreason:                \${ob.reason}\nsuggestedUnblockAction: \${ob.suggestedUnblockAction}\`
      : '(no obstacle detected)';
    const hr = d.status.pendingHelpRequest;
    document.getElementById('help-request').textContent = hr
      ? \`whyBlocked:         \${hr.whyBlocked}\nneededFromHuman:    \${hr.neededFromHuman}\nsuggestedResolution: \${hr.suggestedResolution}\`
      : '(no pending help request)';
    document.getElementById('waiting-state').textContent =
      \`waitingForHuman: \${d.status.waitingForHuman}\nresumeTrigger:   \${d.status.resumeTrigger ?? '(none)'}\`;
    const lhr = d.status.lastHumanResponse;
    document.getElementById('human-response').textContent = lhr
      ? \`fromHuman:    \${lhr.fromHuman}\ncontent:      \${lhr.content}\nacknowledged: \${lhr.acknowledged}\nusedInResume: \${lhr.usedInResume}\`
      : '(no human response yet)';
    if (d.lastTrace) {
      const lines = [\`trace: \${d.lastTrace.traceId}\`];
      d.lastTrace.events.forEach(e => {
        lines.push(\`  \${new Date(e.created_at).toISOString()}  \${e.event_type}\`);
      });
      document.getElementById('trace').textContent = lines.join('\\n');
    } else {
      document.getElementById('trace').textContent = '(no trace yet — run doWork first)';
    }
    if (d.recoveryTimeline && d.recoveryTimeline.length > 0) {
      document.getElementById('recovery-timeline').textContent =
        d.recoveryTimeline.map(item =>
          \`\${new Date(item.at).toISOString()}  [\${item.event}]  \${item.summary}\`
        ).join('\\n');
    } else {
      document.getElementById('recovery-timeline').textContent = '(no recovery chain yet — run doWork until blocked, then respond)';
    }
    document.getElementById('events').textContent =
      d.recentEvents.map(e => \`\${new Date(e.created_at).toISOString()}  \${e.event_type}  \${e.payload}\`).join('\\n') || '(no events yet)';
    const badge = document.getElementById('badge');
    badge.textContent = d.status.status;
    badge.className = 'badge ' + d.status.status;
  } catch(e) { document.getElementById('status').textContent = 'Error: ' + e.message; }
}

async function runDemo() {
  document.getElementById('result').textContent = 'Running...';
  try {
    const r = await fetch('/demo/run', { method: 'POST' });
    const d = await r.json();
    document.getElementById('result').textContent = JSON.stringify(d, null, 2);
    await load();
  } catch(e) { document.getElementById('result').textContent = 'Error: ' + e.message; }
}

async function runLoop() {
  document.getElementById('result').textContent = 'Running loop (3 steps)...';
  try {
    const r = await fetch('/demo/loop', { method: 'POST' });
    const d = await r.json();
    document.getElementById('result').textContent = JSON.stringify(d, null, 2);
    await load();
  } catch(e) { document.getElementById('result').textContent = 'Error: ' + e.message; }
}

async function switchProfile(provider, model) {
  await fetch('/demo/profile', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ provider, model }) });
  await load();
}

async function sendHumanResponse() {
  const content = document.getElementById('respond-content').value.trim();
  if (!content) return;
  document.getElementById('respond-result').textContent = 'Sending...';
  try {
    const r = await fetch('/demo/respond', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fromHuman: 'human', content }) });
    const d = await r.json();
    document.getElementById('respond-result').textContent = JSON.stringify(d, null, 2);
    await load();
  } catch(e) { document.getElementById('respond-result').textContent = 'Error: ' + e.message; }
}

load();
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // : CORS preflight is exempt from auth (no header on OPTIONS).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // /health is intentionally exempt so Cloudflare health probes and uptime
    // monitors can keep working without the secret. Keep its response shape minimal.
    if (url.pathname === "/health") {
      return json({ ok: true, service: "agent-thursday", version: "0.1.0", agent: "AgentThursdayAgent", instance: DEMO_INSTANCE, timestamp: Date.now() });
    }

    //  + 78: auth only gates the data surface. The SPA shell
    // (HTML/JS/CSS bundle served by ASSETS) must load without a secret so
    // SecretGate can prompt the user. SecretGate then probes /api/workspace
    // — a 401 means "wrong secret", a 503 means "worker misconfigured".
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/cli/") ||
      url.pathname.startsWith("/demo/")
    ) {
      const authResp = requireSecret(request, env);
      if (authResp) return authResp;
    }

    if (url.pathname === "/demo/status" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const [status, recentEvents, memoryLayers, lastTrace, profileAwareness, recoveryTimeline, recoveryReview, recentCheckpoints, recentReviewNotes, outcomeVerification, recentKanbanMutations, mutationReview, currentTaskObject, loopContract, deliverableGate, approvalPolicy, developerLoopReview, cliSession, workspaceInfo] = await Promise.all([
        stub.getStatus(), stub.getEventLog(), stub.getMemoryLayers(), stub.getLastTrace(), stub.getProfileAwareness(), stub.getRecoveryTimeline(), stub.getRecoveryReview(), stub.getRecentCheckpoints(), stub.getRecentReviewNotes(), stub.getOutcomeVerification(), stub.getRecentKanbanMutations(), stub.getMutationReview(), stub.getCurrentTaskObject(), stub.getLoopContract(), stub.getDeliverableGate(), stub.getApprovalPolicy(), stub.getDeveloperLoopReview(), stub.getCliSession(), stub.getWorkspaceInfo(),
      ]);
      const intelligenceSignal = getIntelligenceSignal(status.modelProfile);
      const cliResultView = buildCliResultView(cliSession, developerLoopReview, approvalPolicy, deliverableGate);
      const m3CliLoopDemo = buildM3CliLoopDemo(cliSession, developerLoopReview, approvalPolicy, deliverableGate);
      const m4TuiWorkflowDemo = buildM4TuiWorkflowDemo(cliSession, developerLoopReview, approvalPolicy, deliverableGate);
      return json({ status, profileAwareness, intelligenceSignal, memoryLayers, lastTrace, recentEvents, recoveryTimeline, recoveryReview, recentCheckpoints, recentReviewNotes, outcomeVerification, recentKanbanMutations, mutationReview, currentTaskObject, loopContract, deliverableGate, approvalPolicy, developerLoopReview, cliSession, cliResultView, m3CliLoopDemo, m4TuiWorkflowDemo, workspaceInfo });
    }

    if (url.pathname === "/demo/run" && request.method === "POST") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const result = await stub.submitTask(DOGFOOD_TASK);
      return json(result);
    }

    if (url.pathname === "/demo/loop" && request.method === "POST") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const result = await stub.continueTask();
      return json(result);
    }

    if (url.pathname === "/demo/profile" && request.method === "POST") {
      const { provider, model } = await request.json<{ provider: string; model: string }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      await stub.setModelProfile(provider, model);
      return json({ ok: true, modelProfile: { provider, model } });
    }

    if (url.pathname === "/demo/respond" && request.method === "POST") {
      const { fromHuman, content } = await request.json<{ fromHuman: string; content: string }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      await stub.acknowledgeHumanResponse(fromHuman, content);
      return json({ ok: true, fromHuman, content });
    }

    if (url.pathname === "/demo/pending-mutations" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const pending = await stub.getPendingKanbanMutations();
      return json({ pending });
    }

    if (url.pathname === "/demo/confirm-mutation" && request.method === "POST") {
      const { id, status, evidence } = await request.json<{ id: number; status: string; evidence: string }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      await stub.confirmKanbanMutation(id, status, evidence);
      return json({ ok: true, id, status, evidence });
    }

    if (url.pathname === "/api/workspace" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const [agentThursdayState, cliSession, loopReview, approvalPolicy, pendingToolApproval, debugTrace, deliverableGate, pendingMutations, eventLog] = await Promise.all([
        stub.getStatus(),
        stub.getCliSession(),
        stub.getDeveloperLoopReview(),
        stub.getApprovalPolicy(),
        stub.getPendingToolApproval(),
        stub.getDebugTrace(),
        stub.getDeliverableGate(),
        stub.getPendingKanbanMutations(),
        stub.getEventLog(),
      ]);
      const snapshot = buildWorkspaceSnapshot({
        agentThursdayState,
        cliSession,
        loopReview,
        approvalPolicy,
        pendingToolApproval,
        debugTrace,
        deliverableGate,
        pendingMutations,
        eventLogCount: eventLog.length,
      });
      // Validate at the boundary so legacy field drift is caught early.
      return json(WorkspaceSnapshotSchema.parse(snapshot));
    }

    // Discord Gateway DO control surface. Auth-gated by
    // the global `requireSecret` check above. POST /start and /stop are
    // idempotent; GET /status is safe to poll. Status fields never include
    // tokens / shared secret / raw gateway frames.
    if (url.pathname === "/api/discord-gateway/start" && request.method === "POST") {
      const stub = await getAgentByName<Env, DiscordGatewayAgent>(
        env.DiscordGatewayAgent as unknown as AgentNamespace<DiscordGatewayAgent>,
        DISCORD_GATEWAY_INSTANCE,
      );
      const workerOrigin = `${url.protocol}//${url.host}`;
      try {
        const status = await stub.start({ workerOrigin });
        return json(status);
      } catch (e) {
        return json({ error: "start_failed", message: String(e instanceof Error ? e.message : e).slice(0, 300) }, 500);
      }
    }
    if (url.pathname === "/api/discord-gateway/stop" && request.method === "POST") {
      const stub = await getAgentByName<Env, DiscordGatewayAgent>(
        env.DiscordGatewayAgent as unknown as AgentNamespace<DiscordGatewayAgent>,
        DISCORD_GATEWAY_INSTANCE,
      );
      const status = await stub.stop();
      return json(status);
    }
    if (url.pathname === "/api/discord-gateway/status" && request.method === "GET") {
      const stub = await getAgentByName<Env, DiscordGatewayAgent>(
        env.DiscordGatewayAgent as unknown as AgentNamespace<DiscordGatewayAgent>,
        DISCORD_GATEWAY_INSTANCE,
      );
      const status = await stub.getStatus();
      return json(status);
    }

    if (url.pathname === "/api/inspect" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const snapshot: InspectSnapshot = await stub.getInspectSnapshot();
      //  / 114 — best-effort cross-DO fetches against ContentHubAgent.
      // Both `contentAudit` (raw rows) and `contentEvidence` (
      // aggregated summary) are observability layers; failure must not
      // break the AgentThursdayAgent snapshot or each other.
      let contentAudit: Array<{ type: string; at: number; payload: unknown; traceId: string | null }> = [];
      let contentEvidence: ContentAuditSummary | undefined;
      try {
        const hub = await getAgentByName<Env, ContentHubAgent>(
          env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
          CONTENT_HUB_INSTANCE,
        );
        try { contentAudit = await hub.getRecentAuditEvents({ limit: 100 }); }
        catch { /* ignore — return snapshot without contentAudit */ }
        try { contentEvidence = await hub.getContentEvidence(); }
        catch { /* ignore — return snapshot without contentEvidence */ }
      } catch { /* ignore — DO unreachable */ }
      const merged: InspectSnapshot = { ...snapshot, contentAudit, ...(contentEvidence ? { contentEvidence } : {}) };
      return json(InspectSnapshotSchema.parse(merged));
    }

    // codemode self-probe. Bypasses the model loop; calls
    // executor.execute("return 1+1", []) directly so reviewers get ground
    // truth about whether `execute` is registered + functional. Auth-gated
    // (already covered by the global secret check above).
    if (url.pathname === "/api/admin/codemode-probe" && request.method === "POST") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const probe = await stub.codemodeProbe();
      return json(probe);
    }

    //  A.2 — diagnostic endpoint for direct env.AI.run() capture.
    // Bypasses the workers-ai-provider adapter so we can see the raw shape
    // Workers AI returns for an allowlisted model + minimal tool schema.
    // Used to determine whether tool_calls land in the structural fields
    // the adapter reads from, vs in plain-text content. Auth-gated.
    if (url.pathname === "/api/diag/dispatch" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const parsed = DiagDispatchRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, 400);
      const { model, prompt, stream } = parsed.data;
      const tools = [{
        type: "function",
        function: {
          name: "echo_test",
          description: "Echo back input. Used only to test tool-call dispatch shape.",
          parameters: {
            type: "object",
            properties: { x: { type: "string", description: "Any string." } },
            required: ["x"],
          },
        },
      }];
      const inputs = {
        messages: [{ role: "user", content: prompt }],
        tools,
        tool_choice: "required",
        ...(stream === true ? { stream: true } : {}),
      };
      let output: unknown;
      try {
        output = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, inputs);
      } catch (e) {
        return json({
          error: "ai_run_failed",
          message: String(e instanceof Error ? e.message : e).slice(0, 500),
        }, 502);
      }
      if (stream === true) {
        if (!(output instanceof ReadableStream)) {
          return json({
            error: "expected_stream",
            actualType: typeof output,
            note: "binding returned a non-stream value despite stream:true",
          }, 502);
        }
        const chunks = await readSSEChunks(output as ReadableStream<Uint8Array>);
        return json({ mode: "stream", ...summarizeDiagStreamChunks(chunks) });
      }
      return json({ mode: "non-stream", ...summarizeDiagOutput(output) });
    }

    // workspace file manager (read-only).
    if (url.pathname === "/api/workspace/files" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      try {
        const list = await stub.listWorkspaceFiles(url.searchParams.get("path"));
        return json(WorkspaceFileListSchema.parse(list));
      } catch (e) {
        return workspaceFileError(e);
      }
    }

    if (url.pathname === "/api/workspace/file" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      try {
        const content = await stub.readWorkspaceFileText(url.searchParams.get("path"));
        return json(WorkspaceFileContentSchema.parse(content));
      } catch (e) {
        return workspaceFileError(e);
      }
    }

    // ChannelHub auth-gated stub endpoints.
    if (url.pathname === "/api/channel/inbound" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ code: "request.invalid-json" }, 400);
      }
      const parsed = ChannelMessageEnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      }
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.ingestInbound(parsed.data);
      const routeSummary = await autoRouteAfterIngest(stub, result.inserted);
      return json({ ...ChannelInboundResultSchema.parse(result), routeSummary });
    }

    if (url.pathname === "/api/channel/snapshot" && request.method === "GET") {
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const snapshot = await stub.getSnapshot();
      return json(ChannelSnapshotSchema.parse(snapshot));
    }

    // compact channel summary for default user-layer panel.
    if (url.pathname === "/api/channel/summary" && request.method === "GET") {
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const summary = await stub.getCompactSummary();
      return json(ChannelCompactSummarySchema.parse(summary));
    }

    // outbound text enqueue.
    if (url.pathname === "/api/channel/outbound/text" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = EnqueueOutboundTextRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      try {
        const result = await stub.enqueueOutboundText(parsed.data);
        return json(EnqueueOutboundResultSchema.parse(result));
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes("outbound:proactive-not-allowed")) {
          return json({ code: "outbound.proactive-not-allowed" }, 403);
        }
        return json({ code: "internal", message: msg }, 500);
      }
    }

    // approval card enqueue.
    if (url.pathname === "/api/channel/outbound/approval" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = EnqueueOutboundApprovalRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.enqueueOutboundApproval(parsed.data);
      return json(EnqueueOutboundResultSchema.parse(result));
    }

    // deliver pending outbound (bridge or dry-run).
    if (url.pathname === "/api/channel/outbound/deliver-pending" && request.method === "POST") {
      let body: unknown = {};
      try { body = await request.json(); } catch { body = {}; }
      const limit = typeof (body as { limit?: number }).limit === "number" ? (body as { limit?: number }).limit : 10;
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.deliverPendingOutbound(limit);
      return json(DeliverPendingResultSchema.parse(result));
    }

    // approval resolve callback (bridge → AgentThursday button click).
    if (url.pathname === "/api/channel/approval/resolve" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = ApprovalResolveRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.resolveApproval(parsed.data);
      return json(ApprovalResolveResultSchema.parse(result));
    }

    // direct Discord adapter: HTTP Interactions endpoint.
    // PUBLIC (no X-AgentThursday-Secret); authenticity comes from Discord's Ed25519
    // signature. CF Worker can't run the Gateway WebSocket, so normal
    // MESSAGE_CREATE arrives via the auth-gated /api/channel/discord/direct
    // path (below) — typically populated by a sidecar gateway runner OR by
    // smoke tests using the  OpenClaw payload shape.
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const sig = request.headers.get("X-Signature-Ed25519");
      const ts = request.headers.get("X-Signature-Timestamp");
      const pubKey = env.DISCORD_PUBLIC_KEY;
      const rawBody = await request.text();
      if (!sig || !ts || !pubKey) {
        return json({ code: "discord.signature-misconfigured" }, 401);
      }
      const ok = await verifyDiscordSignature({
        rawBody, signatureHex: sig, timestamp: ts, publicKeyHex: pubKey,
      });
      if (!ok) {
        return json({ code: "discord.signature-invalid" }, 401);
      }
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = DiscordInteractionSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const interaction = parsed.data;

      // Type 1 = PING handshake
      if (interaction.type === 1) {
        return json({ type: 1 });
      }

      // Type 2 = APPLICATION_COMMAND (slash)
      if (interaction.type === 2) {
        const cfg = loadDirectDiscordConfig(env);
        const author = interaction.member?.user ?? interaction.user;
        if (!author) return json({ type: 4, data: { content: "missing user", flags: 64 } });
        // Apply filter pipeline against slash sender
        const isDm = !interaction.guild_id;
        const filterRes = applyDirectFilters({
          authorId: author.id,
          authorIsBot: author.bot ?? false,
          isDm,
          channelId: interaction.channel_id ?? interaction.channel?.id ?? "",
          mentionsBot: true, // slash command implies addressed
          mentionedUserIds: cfg.botUserId ? [cfg.botUserId] : [],
        }, cfg);
        if (!filterRes.accept) {
          return json({ type: 4, data: { content: `ignored: ${filterRes.reason}`, flags: 64 } });
        }
        const slash = extractSlashPrompt(interaction);
        if (!slash) {
          return json({ type: 4, data: { content: "unsupported command (try /ask <prompt>)", flags: 64 } });
        }
        const envelope = await normalizeSlashInteraction(interaction, slash.prompt, cfg);
        const stub = await getAgentByName<Env, ChannelHubAgent>(
          env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
          CHANNEL_HUB_INSTANCE,
        );
        const result = await stub.ingestInbound(envelope);
        const routeSummary = await autoRouteAfterIngest(stub, result.inserted);
        const routeNote = routeSummary && routeSummary.processed > 0
          ? " · routed to agent"
          : routeSummary && routeSummary.busySkipped > 0
          ? " · agent busy, will route when free"
          : "";
        // Ephemeral response so other channel members don't see the receipt
        return json({
          type: 4,
          data: {
            content: result.inserted
              ? `received (id ${result.id.slice(0, 8)})${routeNote}`
              : `already received (id ${result.id.slice(0, 8)})`,
            flags: 64,
          },
        });
      }

      // Type 3 = MESSAGE_COMPONENT (button click)
      if (interaction.type === 3) {
        const data = interaction.data as { custom_id?: string } | undefined;
        const customId = typeof data?.custom_id === "string" ? data.custom_id : "";
        const decoded = decodeApprovalCustomId(customId);
        if (!decoded) {
          return json({ type: 4, data: { content: "unrecognized button", flags: 64 } });
        }
        const author = interaction.member?.user ?? interaction.user;
        if (!author) return json({ type: 4, data: { content: "missing user", flags: 64 } });
        const stub = await getAgentByName<Env, ChannelHubAgent>(
          env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
          CHANNEL_HUB_INSTANCE,
        );
        // Look up the full payload hash from the approval row, then resolve.
        // We sent the button with a 12-char prefix; the resolve API needs the
        // full hash in `payloadHashEcho`. Pull from snapshot-style fetch.
        // Simpler: pass the prefix as the echo and have resolveApproval
        // accept a prefix match — but that weakens the invalidation guarantee.
        // Cleanest: read the row directly via a new minimal callable.
        // For v1: use `lookupApprovalHash(approvalId)` then echo full hash.
        const fullHash = await stub.lookupApprovalHash(decoded.approvalId);
        if (!fullHash) {
          return json({ type: 4, data: { content: `approval ${decoded.approvalId.slice(0, 8)} not found`, flags: 64 } });
        }
        // Sanity: button's hash prefix must agree with row's full hash. If
        // someone hand-crafts a custom_id, the prefix mismatch would surface here.
        if (!fullHash.startsWith(decoded.payloadHashPrefix)) {
          return json({ type: 4, data: { content: "button hash mismatch (payload changed?)", flags: 64 } });
        }
        const resolveResult = await stub.resolveApproval({
          approvalId: decoded.approvalId,
          scope: decoded.scope,
          actorProvider: "discord",
          actorProviderUserId: author.id,
          payloadHashEcho: fullHash,
        });
        // Ephemeral feedback so only the clicker sees it (Card §D-7 — ideal
        // would be to UPDATE the original message disabling buttons; that's
        // an edit via REST and recorded as a TODO below).
        return json({
          type: 4,
          data: {
            content: `${resolveResult.audit}${resolveResult.alreadyResolved ? " (already resolved)" : ""}`,
            flags: 64,
          },
        });
      }

      // Other interaction types not yet handled.
      return json({ type: 4, data: { content: "interaction type not supported", flags: 64 } });
    }

    // auth-gated direct ingest path. Same OpenClaw payload shape
    // () so a sidecar gateway runner can post message-create-shaped events
    // here without renaming the contract. Bridge endpoint /api/channel/discord/openclaw
    // is preserved as a compatibility alias.
    if (url.pathname === "/api/channel/discord/direct" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = OpenClawDiscordInboundSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      // Apply  Hermes-inspired filters BEFORE normalization so we don't
      // persist messages we'd just ignore. Bridge path (openclaw) keeps the
      // old behavior — operators can ingest unfiltered there.
      const cfg = loadDirectDiscordConfig(env);
      const isDm = parsed.data.isDm === true || parsed.data.guildId == null;
      const filterRes = applyDirectFilters({
        authorId: parsed.data.authorId,
        authorIsBot: parsed.data.authorIsBot ?? false,
        isDm,
        channelId: parsed.data.channelId,
        mentionsBot: parsed.data.mentionsBot ?? false,
        mentionedUserIds: [],
      }, cfg);
      if (!filterRes.accept) {
        return json({ ok: false, ignored: true, reason: filterRes.reason }, 200);
      }
      const envelope = await normalizeOpenClawPayload(parsed.data, env);
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.ingestInbound(envelope);
      const routeSummary = await autoRouteAfterIngest(stub, result.inserted);
      return json({
        ok: result.ok,
        inserted: result.inserted,
        id: result.id,
        status: result.status,
        conversationId: envelope.conversationId,
        addressedToAgent: envelope.addressedToAgent,
        addressedSignals: envelope.addressedSignals,
        routeSummary,
      });
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

    //  helper — set channel identity role (trusted/unknown).
    if (url.pathname === "/api/channel/identity/role" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const b = body as { provider?: string; providerUserId?: string; role?: string };
      if (
        typeof b.provider !== "string" ||
        typeof b.providerUserId !== "string" ||
        (b.role !== "trusted" && b.role !== "unknown")
      ) {
        return json({ code: "request.invalid-shape" }, 400);
      }
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.setIdentityRole({
        provider: b.provider as Parameters<ChannelHubAgent["setIdentityRole"]>[0]["provider"],
        providerUserId: b.providerUserId,
        role: b.role,
      });
      return json(result);
    }

    // route pending inbox rows. Idempotent: only `received`
    // status rows are picked up, others are skipped.
    if (url.pathname === "/api/channel/route-pending" && request.method === "POST") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const limit = typeof (body as { limit?: number }).limit === "number"
        ? (body as { limit?: number }).limit
        : 10;
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.routePending(limit);
      return json(ChannelRoutePendingResultSchema.parse(result));
    }

    // OpenClaw Discord bridge inbound. Translates the narrow
    // OpenClaw payload into ChannelMessageEnvelope and persists via 
    // ingestInbound. Same /api/* auth gate; raw Discord JSON is NOT accepted.
    if (url.pathname === "/api/channel/discord/openclaw" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ code: "request.invalid-json" }, 400);
      }
      const parsed = OpenClawDiscordInboundSchema.safeParse(body);
      if (!parsed.success) {
        return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      }
      const envelope = await normalizeOpenClawPayload(parsed.data, env);
      const stub = await getAgentByName<Env, ChannelHubAgent>(
        env.ChannelHubAgent as unknown as AgentNamespace<ChannelHubAgent>,
        CHANNEL_HUB_INSTANCE,
      );
      const result = await stub.ingestInbound(envelope);
      const routeSummary = await autoRouteAfterIngest(stub, result.inserted);
      // Compact normalization metadata so the bridge can surface decisions
      // without re-parsing the snapshot. No raw Discord JSON in response.
      return json({
        ok: result.ok,
        inserted: result.inserted,
        id: result.id,
        status: result.status,
        conversationId: envelope.conversationId,
        addressedToAgent: envelope.addressedToAgent,
        addressedSignals: envelope.addressedSignals,
        routeSummary,
      });
    }

    // Agent Memory v1 read-only snapshot.
    if (url.pathname === "/api/memory" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const snapshot = await stub.getMemorySnapshot();
      return json(MemorySnapshotSchema.parse(snapshot));
    }

    // ContentHub registry listing.  returns the
    // hardcoded `agentthursday-github` source with static `registry-only` health.
    //  swaps the health probe for a real GitHub fetch and 
    // adds inspect-layer events. Query params:
    //   ?includeHealth=false  → cheap listing without health field
    //   ?sourceId=<id>        → filter to a single source (404-shaped: empty array)
    if (url.pathname === "/api/content/sources" && request.method === "GET") {
      const includeHealth = url.searchParams.get("includeHealth") !== "false";
      const sourceIdParam = url.searchParams.get("sourceId");
      const stub = await getAgentByName<Env, ContentHubAgent>(
        env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
        CONTENT_HUB_INSTANCE,
      );
      const result = await stub.getSources({
        includeHealth,
        ...(sourceIdParam ? { sourceId: sourceIdParam } : {}),
      });
      return json(ContentSourcesResponseSchema.parse(result));
    }

    // ContentHub list endpoint. Body shape:
    //   { sourceId, path, ref? } → ContentListResponse (`{ ok, result|error }`)
    if (url.pathname === "/api/content/list" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = ContentListRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ContentHubAgent>(
        env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
        CONTENT_HUB_INSTANCE,
      );
      const result = await stub.list(parsed.data);
      return json(ContentListResponseSchema.parse(result));
    }

    // ContentHub read endpoint. Body shape:
    //   { sourceId, path, ref?, maxBytes? } → ContentReadResponse
    if (url.pathname === "/api/content/read" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = ContentReadRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ContentHubAgent>(
        env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
        CONTENT_HUB_INSTANCE,
      );
      const result = await stub.read(parsed.data);
      return json(ContentReadResponseSchema.parse(result));
    }

    // ContentHub literal-search endpoint. Body shape:
    //   { sourceId, query, path?, ref?, strategy?, maxResults? } → ContentSearchResponse
    // `strategy:"api-search"` (default) is fail-loud on quota; explicit
    // `strategy:"bounded-local"` returns degraded grep with searchedPaths +
    // omittedReason populated.
    if (url.pathname === "/api/content/search" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
      const parsed = ContentSearchRequestSchema.safeParse(body);
      if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      const stub = await getAgentByName<Env, ContentHubAgent>(
        env.ContentHubAgent as unknown as AgentNamespace<ContentHubAgent>,
        CONTENT_HUB_INSTANCE,
      );
      const result = await stub.search(parsed.data);
      return json(ContentSearchResponseSchema.parse(result));
    }

    // Tier 3 headless browser smoke endpoint. Same auth/CORS
    // posture as the rest of /api/*. SSRF guard runs inside runBrowser.
    if (url.pathname === "/api/browser/run" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ code: "request.invalid-json" }, 400);
      }
      const parsed = BrowserRunRequestSchema.safeParse(body);
      if (!parsed.success) {
        return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
      }
      try {
        const result: BrowserRunResult = await runBrowser(env.BROWSER, parsed.data);
        return json(BrowserRunResultSchema.parse(result));
      } catch (e) {
        return browserError(e);
      }
    }

    if (url.pathname === "/cli/status" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const [session, loopReview, approvalPolicy, pendingToolApproval, debugTrace, usageStats] = await Promise.all([
        stub.getCliSession(), stub.getDeveloperLoopReview(), stub.getApprovalPolicy(), stub.getPendingToolApproval(), stub.getDebugTrace(), stub.getUsageStats(),
      ]);
      const activeInterventions = approvalPolicy.interventions
        .filter(i => i.active)
        .map(i => `[${i.kind}] ${i.reason}`);
      return json({ session, loopSummary: loopReview.summary, activeInterventions, pendingToolApproval, debugTrace, usageStats });
    }

    if (url.pathname === "/cli/submit" && request.method === "POST") {
      const { task } = await request.json<{ task: string }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      await stub.submitTask(task);
      const [session, loopReview] = await Promise.all([stub.getCliSession(), stub.getDeveloperLoopReview()]);
      return json({
        ok: true,
        taskId: session.taskId ?? DEMO_INSTANCE,
        submittedTask: task.slice(0, 120),
        loopStageAfter: session.loopStage,
        suggestedNextCommand: session.suggestedNextCommand,
        loopSummary: loopReview.summary,
      });
    }

    if (url.pathname === "/cli/continue" && request.method === "POST") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      await stub.continueTask();
      const session = await stub.getCliSession();
      return json({ ok: true, session });
    }

    if (url.pathname === "/cli/approve" && request.method === "POST") {
      const body = await request.json<{ kind: "human-response" | "mutation-confirm"; fromHuman?: string; content?: string; mutationId?: number; mutationStatus?: string; evidence?: string }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      let description: string;
      if (body.kind === "mutation-confirm" && body.mutationId !== undefined) {
        await stub.confirmKanbanMutation(body.mutationId, body.mutationStatus ?? "applied", body.evidence ?? "");
        description = `mutation #${body.mutationId} 已 ${body.mutationStatus ?? "applied"}`;
      } else {
        await stub.acknowledgeHumanResponse(body.fromHuman ?? "human", body.content ?? "");
        description = `human-response 已接收：${(body.content ?? "").slice(0, 80)}`;
      }
      const [session, loopReview, approvalPolicy] = await Promise.all([
        stub.getCliSession(),
        stub.getDeveloperLoopReview(),
        stub.getApprovalPolicy(),
      ]);
      const activeInterventionCount = approvalPolicy.interventions.filter(i => i.active).length;
      return json({
        ok: true,
        kind: body.kind,
        description,
        loopStageAfter: session.loopStage,
        suggestedNextCommand: session.suggestedNextCommand,
        loopSummary: loopReview.summary,
        activeInterventionCount,
      });
    }

    if (url.pathname === "/cli/result" && request.method === "GET") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const [deliverableGate, loopReview, approvalPolicy, session] = await Promise.all([
        stub.getDeliverableGate(), stub.getDeveloperLoopReview(), stub.getApprovalPolicy(), stub.getCliSession(),
      ]);
      return json(buildCliResultView(session, loopReview, approvalPolicy, deliverableGate));
    }

    if (url.pathname === "/cli/tool-approval" && request.method === "POST") {
      const { toolCallId, approved } = await request.json<{ toolCallId: string; approved: boolean }>();
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const result = await stub.approvePendingTool(toolCallId, approved);
      return json({ ok: result.ok, toolCallId, approved });
    }

    if (url.pathname === "/cli/clear-stale-state" && request.method === "POST") {
      const stub = await getAgentByName<Env, AgentThursdayAgent>(env.AgentThursdayAgent as unknown as AgentNamespace<AgentThursdayAgent>, DEMO_INSTANCE);
      const result = await stub.clearStaleBlockingState();
      return json(result);
    }

    // : anything not handled above falls through to:
    //   1. agents library router (Durable Object websockets etc.)
    //   2. static SPA assets from web/dist (binding ASSETS in wrangler.toml)
    // The legacy `homePage()` HTML is no longer wired; left in source for now
    // and removed by a follow-up cleanup card.
    const agentResp = await routeAgentRequest(request, env);
    if (agentResp) return agentResp;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
