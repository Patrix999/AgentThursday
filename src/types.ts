export type ModelProfile = {
  provider: string;
  model: string;
};

export type IntelligenceSignal = {
  tier: "low" | "medium" | "high";
  mode: "normal" | "safer";
  reason: string;
};

export type ModelProfileAwareness = {
  provider: string;
  model: string;
  adapterType: "stub" | "real-model";
  tier: "low" | "medium" | "high";
  mode: "normal" | "safer";
  capabilitySummary: string;
  boundaryNote: string;
};

export type AgentStatus = "idle" | "running" | "waiting" | "completed";

export type RuntimeMode = {
  mode: "normal" | "assisted" | "recovered";
  reason: string;
};

export type NextAction = {
  title: string;
  reason: string;
  committed: boolean;
};

export type ObstacleState = {
  blocked: boolean;
  reason: string;
  suggestedUnblockAction: string;
};

export type HelpRequest = {
  whyBlocked: string;
  neededFromHuman: string;
  suggestedResolution: string;
};

export type HumanResponse = {
  fromHuman: string;
  content: string;
  acknowledged: boolean;
  usedInResume: boolean;
};

export type TaskLifecycle = "draft" | "active" | "waiting" | "review" | "completed" | "failed";

export type TaskObject = {
  id: string;
  title: string;
  status: TaskLifecycle;
  source: "dogfood" | "human" | "agent";
  createdAt: number;
  updatedAt: number;
};

export type AgentThursdayState = {
  agentId: string;
  project: string;
  status: AgentStatus;
  currentTask: string | null;
  currentTaskObject: TaskObject | null;
  lastCheckpoint: string | null;
  modelProfile: ModelProfile;
  committedAction: NextAction | null;
  currentObstacle: ObstacleState | null;
  pendingHelpRequest: HelpRequest | null;
  lastHumanResponse: HumanResponse | null;
  waitingForHuman: boolean;
  resumeTrigger: string | null;
  recoveryPolicy: RecoveryPolicy;
  lastActionResult: ActionResult | null;
  runtimeMode: RuntimeMode;
  updatedAt: number;
};

export type TaskProgress = {
  phase: "understanding" | "proposing" | "converging" | "completed";
  completion: boolean;
  reason: string;
};


export type ExecutableAction = {
  actionType: string;
  title: string;
  reason: string;
  allowlisted: boolean;
  source: "committed-action" | "manual";
};

export type ActionAllowlistEntry = {
  actionType: string;
  description: string;
};

export type ActionAllowlist = {
  version: string;
  entries: ActionAllowlistEntry[];
};

export type ActionResult = {
  actionType: string;
  outcome: "success" | "blocked" | "noop";
  summary: string;
  recordedAt: number;
};

export type PreflightCheck = {
  name: string;
  passed: boolean;
  reason: string;
};

export type PreflightCheckResult = {
  gate: "open" | "blocked";
  allowlisted: boolean;
  checks: PreflightCheck[];
  reason: string;
};

export type RealActionEntry = {
  actionType: string;
  executionMode: "real" | "stub";
  rationale: string;
};

export type RealActionPolicy = {
  version: string;
  entries: RealActionEntry[];
};

export type RealActionReview = {
  stage: "no-execution" | "stub-only" | "real-partial" | "real-verified";
  realActionCount: number;
  artifactCount: number;
  effectiveProgress: boolean;
  recoveryReady: boolean;
  readyForNextMilestone: boolean;
  summary: string;
};

export type CliApproveResponse = {
  ok: boolean;
  kind: "human-response" | "mutation-confirm";
  description: string;
  loopStageAfter: string;
  suggestedNextCommand: string | null;
  loopSummary: string;
  activeInterventionCount: number;
};

export type CliStatusView = {
  session: CliSession;
  loopSummary: string;
  activeInterventions: string[];
  pendingToolApproval: { toolCallId: string; toolName: string } | null;
};

export type CliSubmitResponse = {
  ok: boolean;
  taskId: string;
  submittedTask: string;
  loopStageAfter: string;
  suggestedNextCommand: string | null;
  loopSummary: string;
};

export type CliCommand = {
  name: string;
  kind: "read" | "write" | "loop-advance";
  description: string;
  endpoint: string;
  method: "GET" | "POST";
};

export type CliSession = {
  sessionId: string;
  instanceName: string;
  taskId: string | null;
  taskTitle: string | null;
  taskLifecycle: TaskLifecycle | null;
  loopStage: string;
  readyForNextRound: boolean;
  autoContinue: boolean;
  suggestedNextCommand: string | null;
  availableCommands: CliCommand[];
};

export type DeveloperLoopReview = {
  stage: "no-task" | "task-active" | "awaiting-deliverable" | "gate-open" | "loop-ready";
  taskLifecycle: TaskLifecycle | null;
  reviewerAccepted: boolean;
  gateOpen: boolean;
  activeInterventionCount: number;
  readyForNextRound: boolean;
  summary: string;
};

export type InterventionKind = "tool-approval-required" | "waiting-for-human" | "blocked-obstacle" | "mutation-confirm-required" | "review-gate-blocked";

export type InterventionPoint = {
  kind: InterventionKind;
  active: boolean;
  reason: string;
};

export type ApprovalPolicy = {
  requiresHumanConfirm: boolean;
  autoContinue: boolean;
  blockReason: string | null;
  interventions: InterventionPoint[];
};

export type DeliverableObject = {
  taskId: string | null;
  taskTitle: string | null;
  resultSummary: string | null;
  readyForReview: boolean;
  producedAt: number | null;
};

export type ReviewGate = {
  gate: "open" | "blocked";
  reason: string;
  allowNextRound: boolean;
};

export type DeliverableConvergence = {
  deliverable: DeliverableObject;
  reviewGate: ReviewGate;
};

export type PlannerOutput = {
  taskId: string | null;
  taskTitle: string | null;
  nextStep: string | null;
  rationale: string | null;
  readyForExecutor: boolean;
};

export type ExecutorOutput = {
  actionType: string | null;
  outcome: "success" | "blocked" | "noop" | null;
  artifactSummary: string | null;
  executedAt: number | null;
};

export type ReviewerOutput = {
  accepted: boolean;
  canContinue: boolean;
  reason: string;
};

export type LoopContract = {
  roundId: string;
  planner: PlannerOutput;
  executor: ExecutorOutput;
  reviewer: ReviewerOutput;
  updatedAt: number;
};

export type MutationReview = {
  stage: "no-mutation" | "pending-only" | "partial-applied" | "mutation-verified";
  pendingCount: number;
  appliedCount: number;
  failedCount: number;
  rejectedCount: number;
  hasEvidence: boolean;
  effectiveProgress: boolean;
  readyForNextMilestone: boolean;
  summary: string;
};

export type OutcomeVerificationItem = {
  actionType: string;
  verified: boolean;
  evidence: string;
};

export type OutcomeVerification = {
  lastActionType: string | null;
  lastOutcome: "success" | "blocked" | "noop" | null;
  verified: boolean;
  items: OutcomeVerificationItem[];
  effectiveProgress: boolean;
  summary: string;
};

export type ExecutionReview = {
  stage: "no-action" | "gate-blocked" | "gate-open" | "executed-success" | "bridged-to-recovery";
  allowlisted: boolean;
  gateOpen: boolean;
  lastOutcome: "success" | "blocked" | "noop" | null;
  failureBridged: boolean;
  readyToContinue: boolean;
  summary: string;
};

export type RecoveryReview = {
  stage: "normal" | "blocked" | "waiting" | "safe-resume" | "recovering";
  readyToContinue: boolean;
  summary: string;
};

export type RecoveryPolicy = {
  policyMode: "normal" | "safe-resume";
  reason: string;
};

export type RecoveryTimelineItem = {
  at: number;
  event: string;
  summary: string;
};


export type CliResultView = {
  taskId: string | null;
  taskTitle: string | null;
  taskLifecycle: TaskLifecycle | null;
  loopStage: string;
  deliverableFormed: boolean;
  deliverableSummary: string | null;
  gatePassed: boolean;
  gateReason: string;
  readyForNextRound: boolean;
  activeInterventions: string[];
  suggestedNextCommand: string | null;
  loopSummary: string;
};

export type M4TuiWorkflowStep = {
  name: string;
  endpoint: string;
  method: "GET" | "POST";
  description: string;
  statusNote: string;
};

export type M4TuiWorkflowDemo = {
  workflowReady: boolean;
  steps: M4TuiWorkflowStep[];
  cloudStateReady: boolean;
  interventionClear: boolean;
  readyForNextMilestone: boolean;
  summary: string;
};

export type M3CliLoopStep = {
  name: string;
  endpoint: string;
  method: "GET" | "POST";
  description: string;
  statusNote: string;
};

export type M3CliLoopDemo = {
  loopReady: boolean;
  steps: M3CliLoopStep[];
  currentLoopStage: string;
  readyForNextRound: boolean;
  activeInterventionCount: number;
  summary: string;
};
