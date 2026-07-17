// Model context window registry + ratio thresholds.
//
// Replaces the previous hardcoded `pickModelMaxTokens()` mapper +
// absolute `CONTEXT_BUDGET_THRESHOLDS` (8K / 24K) with a typed,
// auditable registry. The 8K/24K constants don't make sense against
// 256K/1M windows; ratios scale across model sizes consistently.
//
// Source-of-truth contract: every entry carries `source` and
// `lastChecked` so future readers know whether a number came from
// vendor docs (and when), provider runtime introspection, manual
// override, or a conservative fallback.

export type ModelContextProfileSource =
  | "vendor-docs"
  | "provider-runtime"
  | "fallback"
  | "manual";

export interface ModelContextThresholds {
  /** UI hint only — "可以开始整理" prompt. Hygiene does NOT force compact at this point. */
  softCompactRatio: number;
  /** Hygiene loop's main auto-compact trigger. Maps to `contextBudget.autoCompactAt` for backward compat. */
  hardCompactRatio: number;
  /** Red line / strong warning. Maps to `contextBudget.dangerAt`. Buffer above this for tool traces / output / framework overhead. */
  dangerRatio: number;
}

export interface ModelContextProfile {
  modelMaxTokens: number;
  thresholds: ModelContextThresholds;
  source: ModelContextProfileSource;
  /** ISO date YYYY-MM-DD when this entry was last verified against vendor docs / runtime. */
  lastChecked: string;
  notes?: string;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ModelContextThresholds = {
  softCompactRatio: 0.5,
  hardCompactRatio: 0.7,
  dangerRatio: 0.85,
};

export const DEFAULT_CONTEXT_PROFILE: ModelContextProfile = {
  modelMaxTokens: 128_000,
  thresholds: DEFAULT_CONTEXT_THRESHOLDS,
  source: "fallback",
  lastChecked: "2026-05-04",
  notes: "Conservative fallback for unknown / unmapped models.",
};

// Exact-id entries take precedence; alias / prefix matching applies
// when no exact match (see `pickModelContextProfile`). All ratio
// triplets default to 0.5/0.7/0.85 unless a specific model has reason
// to differ (none v1).
export const MODEL_CONTEXT_REGISTRY: Record<string, ModelContextProfile> = {
  // ── Kimi / Moonshot ───────────────────────────────────────────────
  // Kimi K2 modern family: 256K. Older 0711 preview shipped with 128K
  // before K2 was generalized; keep its key explicit so the alias
  // matcher below doesn't lump it in with modern K2.
  "kimi-k2.6": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Moonshot Kimi K2.6 — 256K context (re-verified platform.kimi.com).",
  },
  "kimi-k2.5": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Moonshot Kimi K2.5 — 256K context.",
  },
  "kimi-k2-0905-preview": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "kimi-k2-turbo-preview": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "kimi-k2-thinking": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "kimi-k2-thinking-preview": {
    modelMaxTokens: 256_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "kimi-k2-0711-preview": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Earlier K2 preview — 128K, not 256K.",
  },
  "moonshot-v1-8k": {
    modelMaxTokens: 8_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "moonshot-v1-32k": {
    modelMaxTokens: 32_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "moonshot-v1-128k": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },

  // ── Zhipu GLM (Workers AI) ────────────────────────────────────────
  "glm-4.7-flash": {
    modelMaxTokens: 131_072,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-23",
    notes: "GLM-4.7-Flash via Workers AI @cf/zai-org/glm-4.7-flash — 131,072 context window, multi-turn tool-calling optimized.",
  },
  // GLM-5 (Zhipu BYO-key): model overview lists 200K context.
  "glm-5": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Zhipu GLM-5 — 200K context (docs.bigmodel.cn model overview).",
  },

  // ── Anthropic Claude 5 / 4.x / 3.x ────────────────────────────────
  // (2026-07-17 pricing-auditor sweep, task-ce1dbbb0): Fable 5,
  // Opus 4.8 and Sonnet 5 ship 1M stable default per current vendor docs
  // (no beta header). Older 4.x/3.x stay 200K; Sonnet 4's 1M tier is
  // still behind the `context-1m-2025-08-07` beta header.
  "claude-opus-4-7": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Anthropic Claude Opus 4.7 — 200K stable default.",
  },
  // current Anthropic models wired for real dispatch.
  "claude-opus-4-8": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Anthropic Claude Opus 4.8 — 1M stable default (models overview, 2026-07-17).",
  },
  "claude-fable-5": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Anthropic Claude Fable 5 — 1M stable default (models overview, 2026-07-17).",
  },
  "claude-sonnet-5": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Anthropic Claude Sonnet 5 — 1M stable default (models overview, 2026-07-17).",
  },
  // DeepSeek (64K context, vendor docs).
  "deepseek-chat": {
    modelMaxTokens: 64_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-06-11",
    notes: "DeepSeek V3 — 64K context.",
  },
  "deepseek-reasoner": {
    modelMaxTokens: 64_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-06-11",
    notes: "DeepSeek R1 (reasoning) — 64K context.",
  },
  // DeepSeek V4 family: vendor pricing page lists CONTEXT LENGTH 1M.
  "deepseek-v4-pro": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "DeepSeek V4 Pro — 1M context (api-docs pricing, 2026-07-17).",
  },
  "deepseek-v4-flash": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "DeepSeek V4 Flash — 1M context (api-docs pricing, 2026-07-17).",
  },

  // ── xAI Grok (previously unmapped, fell to 128K fallback) ──
  "grok-4.5": {
    modelMaxTokens: 500_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "xAI Grok 4.5 — 500k (docs.x.ai pricing; beyond 500k bills at the long-context rate).",
  },
  "grok-4.3": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "xAI Grok 4.3 — 1M (docs.x.ai pricing).",
  },
  "grok-4.20": {
    modelMaxTokens: 1_000_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "xAI Grok 4.20 — 1M (docs.x.ai pricing).",
  },
  "claude-sonnet-4-6": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Anthropic Claude Sonnet 4.6 — 200K stable. 1M tier requires beta header.",
  },
  "claude-haiku-4-5": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-07-17",
    notes: "Haiku 4.5 stays 200K — the only current non-1M Claude (2026-07-17 sweep).",
  },
  "claude-3-7-sonnet": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "claude-3-5-sonnet": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "claude-3-5-haiku": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  "gpt-4.1": {
    modelMaxTokens: 1_047_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "GPT-4.1 — 1,047,576 token context.",
  },
  "gpt-4.1-mini": {
    modelMaxTokens: 1_047_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "gpt-4.1-nano": {
    modelMaxTokens: 1_047_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "gpt-4o": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "gpt-4o-mini": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },

  // ── Google Gemini ─────────────────────────────────────────────────
  "gemini-2.5-pro": {
    modelMaxTokens: 1_048_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Gemini 2.5 Pro — 1,048,576 token context (Google docs).",
  },
  "gemini-2.5-flash": {
    modelMaxTokens: 1_048_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "gemini-1.5-pro": {
    modelMaxTokens: 1_048_576,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },

  // ── Meta Llama ────────────────────────────────────────────────────
  "llama-3.3-70b": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "llama-3.1-70b": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
  "llama-3.1-8b": {
    modelMaxTokens: 128_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
  },
};

/**
 * Resolve a model id to its profile.
 *
 * Match order:
 *   1. Exact key match against `MODEL_CONTEXT_REGISTRY`.
 *   2. Lowercase normalized exact match.
 *   3. Pattern / prefix heuristics for common families that may carry
 *      vendor-specific suffixes (e.g. `kimi-k2.6-1m-context`,
 *      `claude-sonnet-4-6@20260201`). Patterns are deterministic and
 *      prefer the most-specific match.
 *   4. Fallback to `DEFAULT_CONTEXT_PROFILE`.
 *
 * Pure function — safe to call from anywhere; no I/O.
 */
export function pickModelContextProfile(modelId: string | null | undefined): ModelContextProfile {
  if (!modelId) return DEFAULT_CONTEXT_PROFILE;
  const id = modelId.trim();
  if (id.length === 0) return DEFAULT_CONTEXT_PROFILE;

  // 1. Exact match
  const direct = MODEL_CONTEXT_REGISTRY[id];
  if (direct) return direct;

  // 2. Lowercase normalized
  const lower = id.toLowerCase();
  const lowerDirect = MODEL_CONTEXT_REGISTRY[lower];
  if (lowerDirect) return lowerDirect;

  // 3. Family / prefix patterns. Order matters: specific → general.
  // Kimi family
  if (lower.includes("kimi-k2-0711")) return MODEL_CONTEXT_REGISTRY["kimi-k2-0711-preview"];
  if (lower.includes("kimi-k2-turbo")) return MODEL_CONTEXT_REGISTRY["kimi-k2-turbo-preview"];
  if (lower.includes("kimi-k2-thinking")) return MODEL_CONTEXT_REGISTRY["kimi-k2-thinking"];
  if (lower.includes("kimi-k2.6")) return MODEL_CONTEXT_REGISTRY["kimi-k2.6"];
  if (lower.includes("kimi-k2.5")) return MODEL_CONTEXT_REGISTRY["kimi-k2.5"];
  if (lower.includes("kimi-k2")) return MODEL_CONTEXT_REGISTRY["kimi-k2.6"]; // modern default
  if (lower.includes("moonshot-v1-128k")) return MODEL_CONTEXT_REGISTRY["moonshot-v1-128k"];
  if (lower.includes("moonshot-v1-32k")) return MODEL_CONTEXT_REGISTRY["moonshot-v1-32k"];
  if (lower.includes("moonshot-v1-8k")) return MODEL_CONTEXT_REGISTRY["moonshot-v1-8k"];
  if (lower.includes("kimi") || lower.includes("moonshot")) return MODEL_CONTEXT_REGISTRY["kimi-k2.6"];

  // Anthropic Claude (5-gen / Opus 4.8 are 1M; match before the
  // 4.x family defaults so they don't collapse to 200K).
  if (lower.includes("claude-fable")) return MODEL_CONTEXT_REGISTRY["claude-fable-5"];
  if (lower.includes("claude-opus-4-8") || lower.includes("claude-opus-4.8")) return MODEL_CONTEXT_REGISTRY["claude-opus-4-8"];
  if (lower.includes("claude-sonnet-5")) return MODEL_CONTEXT_REGISTRY["claude-sonnet-5"];
  if (lower.includes("claude-opus-4")) return MODEL_CONTEXT_REGISTRY["claude-opus-4-7"];
  if (lower.includes("claude-sonnet-4")) return MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"];
  if (lower.includes("claude-haiku-4")) return MODEL_CONTEXT_REGISTRY["claude-haiku-4-5"];
  if (lower.includes("claude-3-7-sonnet") || lower.includes("3-7-sonnet")) return MODEL_CONTEXT_REGISTRY["claude-3-7-sonnet"];
  if (lower.includes("claude-3-5-sonnet") || lower.includes("3-5-sonnet")) return MODEL_CONTEXT_REGISTRY["claude-3-5-sonnet"];
  if (lower.includes("claude-3-5-haiku") || lower.includes("3-5-haiku")) return MODEL_CONTEXT_REGISTRY["claude-3-5-haiku"];
  if (lower.includes("claude")) return MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"]; // sane default

  // xAI Grok () — only the audited 4.x line; unknown/older grok ids
  // stay on the conservative DEFAULT rather than over-committing to 1M.
  if (lower.includes("grok-4.20")) return MODEL_CONTEXT_REGISTRY["grok-4.20"];
  if (lower.includes("grok-4.5")) return MODEL_CONTEXT_REGISTRY["grok-4.5"];
  if (lower.includes("grok-4.3")) return MODEL_CONTEXT_REGISTRY["grok-4.3"];

  // DeepSeek V4 () — both variants 1M; -chat/-reasoner (V3/R1) stay 64K above.
  if (lower.includes("deepseek-v4-pro")) return MODEL_CONTEXT_REGISTRY["deepseek-v4-pro"];
  if (lower.includes("deepseek-v4")) return MODEL_CONTEXT_REGISTRY["deepseek-v4-flash"];

  // Zhipu GLM-5 (); glm-4.7-flash keeps its exact key above.
  if (lower.includes("glm-5")) return MODEL_CONTEXT_REGISTRY["glm-5"];

  // OpenAI
  if (lower.includes("gpt-4.1-mini")) return MODEL_CONTEXT_REGISTRY["gpt-4.1-mini"];
  if (lower.includes("gpt-4.1-nano")) return MODEL_CONTEXT_REGISTRY["gpt-4.1-nano"];
  if (lower.includes("gpt-4.1")) return MODEL_CONTEXT_REGISTRY["gpt-4.1"];
  if (lower.includes("gpt-4o-mini")) return MODEL_CONTEXT_REGISTRY["gpt-4o-mini"];
  if (lower.includes("gpt-4o")) return MODEL_CONTEXT_REGISTRY["gpt-4o"];

  // Gemini
  if (lower.includes("gemini-2.5-pro")) return MODEL_CONTEXT_REGISTRY["gemini-2.5-pro"];
  if (lower.includes("gemini-2.5-flash")) return MODEL_CONTEXT_REGISTRY["gemini-2.5-flash"];
  if (lower.includes("gemini-1.5")) return MODEL_CONTEXT_REGISTRY["gemini-1.5-pro"];

  // Llama
  if (lower.includes("llama-3.3")) return MODEL_CONTEXT_REGISTRY["llama-3.3-70b"];
  if (lower.includes("llama-3.1-70b")) return MODEL_CONTEXT_REGISTRY["llama-3.1-70b"];
  if (lower.includes("llama-3.1-8b")) return MODEL_CONTEXT_REGISTRY["llama-3.1-8b"];
  if (lower.includes("llama-3.1") || lower.includes("llama-3.3")) return MODEL_CONTEXT_REGISTRY["llama-3.3-70b"];
  // Older / unknown llama: keep conservative DEFAULT (128K), not 8K, since
  // 8K is a dangerous over-commit if the model is actually 128K-capable.
  // Operators wanting a tighter ceiling can add an explicit registry key.

  // 4. Fallback
  return DEFAULT_CONTEXT_PROFILE;
}
