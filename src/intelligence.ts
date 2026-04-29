import type { ModelProfile, IntelligenceSignal, ModelProfileAwareness } from "./types";

export function getIntelligenceSignal(profile: ModelProfile): IntelligenceSignal {
  if (profile.provider === "workers-ai") {
    return {
      tier: "medium",
      mode: "normal",
      reason: `Workers AI real model (${profile.model}): cloud inference active`,
    };
  }
  if (profile.model === "stub-verbose") {
    return {
      tier: "medium",
      mode: "normal",
      reason: "stub-verbose profile (v1 placeholder): structured planning enabled",
    };
  }
  return {
    tier: "low",
    mode: "safer",
    reason: "stub-concise profile (v1 placeholder): conservative mode active",
  };
}

export function getProfileAwareness(profile: ModelProfile): ModelProfileAwareness {
  if (profile.provider === "workers-ai") {
    return {
      provider: profile.provider,
      model: profile.model,
      adapterType: "real-model",
      tier: "medium",
      mode: "normal",
      capabilitySummary: `Cloudflare Workers AI 云端推理 (${profile.model})，支持自然语言理解与生成`,
      boundaryNote: "v1 单步 agent；复杂多轮推理仍有限；依赖 Cloudflare 账号与 AI binding",
    };
  }
  if (profile.model === "stub-verbose") {
    return {
      provider: profile.provider,
      model: profile.model,
      adapterType: "stub",
      tier: "medium",
      mode: "normal",
      capabilitySummary: "确定性结构化 DoD 状态报告生成器，无真实推理",
      boundaryNote: "适合结构化状态输出与离线测试；无真实智能；stub only",
    };
  }
  return {
    provider: profile.provider,
    model: profile.model,
    adapterType: "stub",
    tier: "low",
    mode: "safer",
    capabilitySummary: "确定性单行建议生成器，无真实推理",
    boundaryNote: "仅适合单步最保守建议；safer mode 激活；不承诺复杂目标",
  };
}
