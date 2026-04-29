import type { ModelProfile, IntelligenceSignal, TaskProgress, NextAction, ObstacleState } from "./types";

export type MemoryLayers = {
  soul: string;
  workingMemory: string;
  knowledge: string; // summary line from knowledge rows
};

export type GenerateRequest = {
  task: string;
  context: {
    project: string;
    lastCheckpoint: string | null;
    stepNumber: number;
    humanResponse: string | null;
  };
  modelProfile: ModelProfile;
  intelligenceSignal: IntelligenceSignal;
  memoryLayers: MemoryLayers;
};

export type GenerateResult = {
  text: string;
  usedProfile: ModelProfile;
  progress: TaskProgress;
  nextAction: NextAction;
  obstacle: ObstacleState;
};

export interface ModelAdapter {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

const SAFER_MODE_MARKER = "[safer-mode: low-tier model — 建议仅推进最优先下一步，避免并行多目标]";

// stub-concise: terse single-line suggestion. Default adapter.
class ConciseAdapter implements ModelAdapter {
  async generate({ task, context, modelProfile, intelligenceSignal, memoryLayers }: GenerateRequest): Promise<GenerateResult> {
    const { project, lastCheckpoint, stepNumber, humanResponse } = context;
    const preamble = lastCheckpoint
      ? `[${project}] 从 checkpoint 恢复: ${lastCheckpoint}`
      : `[${project}] 首次执行。`;

    let text: string;
    if (task.includes("如何使用新构建的 agent 开发当前项目")) {
      text = `${preamble} 基于 ${memoryLayers.knowledge}，建议下一步: 推进全流程 event trace 可回放 (DoD-6)。`;
    } else {
      text = `${preamble} 已处理: "${task}"。建议继续推进 AgentThursday M0 剩余 DoD 条目。`;
    }

    if (humanResponse) {
      text = `[收到人类响应: ${humanResponse}]\n${text}`;
    }

    if (intelligenceSignal.mode === "safer") {
      text = `${SAFER_MODE_MARKER}\n${text}`;
    }

    // Phase: understanding → proposing (if resumed on step 1) → converging (step 3+)
    let phase: TaskProgress["phase"];
    if (stepNumber === 1 && lastCheckpoint === null) phase = "understanding";
    else if (stepNumber <= 2) phase = "proposing";
    else phase = "converging";

    const progress: TaskProgress = { phase, completion: false, reason: "stub-concise: continuing; no completion signal" };

    const actionsByPhase: Record<TaskProgress["phase"], NextAction> = {
      understanding: { title: "明确任务范围与当前项目状态", reason: "首次执行，需先建立对当前状态的基本理解", committed: true },
      proposing:     { title: "选定单一最优先推进方向", reason: "已有基础上下文，需明确本轮最该做哪一步", committed: true },
      converging:    { title: "收敛到可交付 checkpoint", reason: "多步推进中，聚焦完成条件避免发散", committed: true },
      completed:     { title: "确认交付并关闭当前任务", reason: "已到达完成状态，需正式结束", committed: true },
    };
    const nextAction = actionsByPhase[phase];

    // safer-mode stub hits capacity boundary at step 3+
    const obstacle: ObstacleState = stepNumber >= 3
      ? { blocked: true, reason: "safer-mode adapter 在第 3 步触达容量边界，无法继续推进复杂多步任务", suggestedUnblockAction: "切换到 stub-verbose 或 workers-ai adapter 以突破 safer-mode 容量边界" }
      : { blocked: false, reason: "", suggestedUnblockAction: "" };

    return { text, usedProfile: modelProfile, progress, nextAction, obstacle };
  }
}

// stub-verbose: structured multi-point suggestion. Shows adapter switching is real.
class VerboseAdapter implements ModelAdapter {
  async generate({ task, context, modelProfile, intelligenceSignal, memoryLayers }: GenerateRequest): Promise<GenerateResult> {
    const { project, lastCheckpoint, humanResponse } = context;
    const resumeNote = lastCheckpoint
      ? `\n  上次 checkpoint: ${lastCheckpoint}`
      : "\n  首次执行，无上次 checkpoint。";
    const humanResponseNote = humanResponse ? `\n  收到人类响应: ${humanResponse}` : "";

    let text: string;
    if (task.includes("如何使用新构建的 agent 开发当前项目")) {
      text = [
        `[${project}] 项目状态分析 (verbose) — intelligence tier: ${intelligenceSignal.tier}`,
        resumeNote,
        humanResponseNote,
        "",
        `身份: ${memoryLayers.soul.split("\n")[0]}`,
        `知识: ${memoryLayers.knowledge}`,
        memoryLayers.workingMemory ? `工作记忆: ${memoryLayers.workingMemory.split("\n").slice(-1)[0]}` : "",
        "",
        "当前已完成的 M0 DoD 条目:",
        "  ✓ DoD-1: 稳定 agent identity — AgentThursdayAgent Durable Object，稳定 instance name。",
        "  ✓ DoD-2: session 恢复 — lastCheckpoint 持久化，resumed: true 可验证。",
        "  ✓ DoD-3: model adapter 层 — modelProfile 驱动 adapter 选择，state 不丢。",
        "  ✓ DoD-5: intelligence awareness 信号 — tier/mode/reason 可观察，degrade policy 激活。",
        "  ✓ DoD-x: memory layering v1 — soul/working memory/knowledge 三层进入 runtime。",
        "",
        "待完成的 M0 DoD 条目:",
        "  ○ DoD-4: 当前 model profile 元数据可感知 (provider/model/tier)。",
        "  ○ DoD-6: 全流程 event trace 可回放。",
        "",
        "建议下一步开卡: 全流程 event trace 可回放 (DoD-6)。",
      ].filter(Boolean).join("\n");
    } else {
      text = [
        `[${project}] 任务处理报告 (verbose) — intelligence tier: ${intelligenceSignal.tier}`,
        resumeNote,
        `任务: "${task}"`,
        "状态: 已处理，建议继续推进 AgentThursday M0 剩余 DoD 条目。",
      ].join("\n");
    }

    const { stepNumber } = context;
    const completion = stepNumber >= 2;
    const phase: TaskProgress["phase"] = completion ? "completed" : "proposing";
    const progress: TaskProgress = {
      phase,
      completion,
      reason: completion ? "stub-verbose: structured analysis complete at step 2" : "stub-verbose: initial proposal phase",
    };
    const nextAction: NextAction = completion
      ? { title: "提交当前成果进入 code review", reason: "structured analysis complete，进入 review 阶段", committed: true }
      : { title: "开具下一张 kanban 卡，定义可交付条目", reason: "已完成状态分析，需进入实现规划", committed: true };
    const obstacle: ObstacleState = { blocked: false, reason: "", suggestedUnblockAction: "" };
    return { text, usedProfile: modelProfile, progress, nextAction, obstacle };
  }
}

// workers-ai: real Cloudflare cloud inference. Requires AI binding.
class WorkersAIAdapter implements ModelAdapter {
  // Default model — known to @cloudflare/workers-types, serves text generation via messages API.
  private static readonly MODEL = "@cf/meta/llama-3-8b-instruct" as const;

  constructor(private ai: Ai) {}

  async generate({ task, context, modelProfile, intelligenceSignal, memoryLayers }: GenerateRequest): Promise<GenerateResult> {
    const { project, lastCheckpoint, humanResponse } = context;
    const systemContent = [
      memoryLayers.soul,
      `项目: ${project}`,
      `知识: ${memoryLayers.knowledge}`,
      memoryLayers.workingMemory
        ? `工作记忆最新: ${memoryLayers.workingMemory.split("\n").slice(-1)[0]}`
        : "",
      lastCheckpoint ? `上次 checkpoint: ${lastCheckpoint}` : "首次执行。",
      humanResponse ? `当前为恢复执行。人类响应: ${humanResponse}` : "",
      `当前 intelligence tier: ${intelligenceSignal.tier} / mode: ${intelligenceSignal.mode}`,
      "请用中文简明回答，聚焦 AgentThursday 项目当前推进建议，不超过 200 字。",
      "如果你认为当前任务分析已经充分完整，在回答末尾加上 [DONE]。",
      "在回答末尾用 [ACTION: <一句话>] 格式给出当前最优先 next action。",
      "如果遇到无法继续推进的阻塞（如信息缺失、能力边界、依赖未满足），在回答末尾加上 [BLOCKED: <原因>]。",
    ].filter(Boolean).join("\n");

    const result = await this.ai.run(WorkersAIAdapter.MODEL, {
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: task },
      ],
      max_tokens: 300,
    });

    const raw = result.response?.trim() || "[Workers AI: empty response]";
    const completion = raw.includes("[DONE]");
    const actionMatch = raw.match(/\[ACTION:\s*(.+?)\]/);
    const blockedMatch = raw.match(/\[BLOCKED:\s*(.+?)\]/);
    const text = raw.replace(/\[DONE\]/g, "").replace(/\[ACTION:[^\]]*\]/g, "").replace(/\[BLOCKED:[^\]]*\]/g, "").trim();
    const progress: TaskProgress = {
      phase: completion ? "completed" : "converging",
      completion,
      reason: completion ? "workers-ai: model signaled [DONE]" : "workers-ai: no completion signal, continuing",
    };
    const nextAction: NextAction = actionMatch
      ? { title: actionMatch[1].trim(), reason: "workers-ai: model selected action", committed: true }
      : { title: "继续推进当前任务", reason: "workers-ai: no explicit action signal", committed: true };
    const obstacle: ObstacleState = blockedMatch
      ? { blocked: true, reason: blockedMatch[1].trim(), suggestedUnblockAction: "提供缺失信息或切换到更高 tier 模型后重试" }
      : { blocked: false, reason: "", suggestedUnblockAction: "" };
    return { text, usedProfile: modelProfile, progress, nextAction, obstacle };
  }
}

export function createAdapter(profile: ModelProfile, ai?: Ai): ModelAdapter {
  if (profile.provider === "workers-ai") {
    if (!ai) throw new Error("Workers AI adapter requires an AI binding");
    return new WorkersAIAdapter(ai);
  }
  if (profile.model === "stub-verbose") {
    return new VerboseAdapter();
  }
  return new ConciseAdapter();
}
