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
    lastChecked: "2026-05-04",
    notes: "Moonshot Kimi K2.6 — 256K context.",
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

  // ── Anthropic Claude 4.x / 3.x ────────────────────────────────────
  // Claude Sonnet 4 has a 1M long-context tier behind the
  // `context-1m-2025-08-07` beta header; do NOT default to 1M. Stable
  // default is 200K across Opus/Sonnet/Haiku 4 and 3.x families.
  "claude-opus-4-7": {
    modelMaxTokens: 200_000,
    thresholds: DEFAULT_CONTEXT_THRESHOLDS,
    source: "vendor-docs",
    lastChecked: "2026-05-04",
    notes: "Anthropic Claude Opus 4.7 — 200K stable default.",
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
    lastChecked: "2026-05-04",
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

  // Anthropic Claude
  if (lower.includes("claude-opus-4")) return MODEL_CONTEXT_REGISTRY["claude-opus-4-7"];
  if (lower.includes("claude-sonnet-4")) return MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"];
  if (lower.includes("claude-haiku-4")) return MODEL_CONTEXT_REGISTRY["claude-haiku-4-5"];
  if (lower.includes("claude-3-7-sonnet") || lower.includes("3-7-sonnet")) return MODEL_CONTEXT_REGISTRY["claude-3-7-sonnet"];
  if (lower.includes("claude-3-5-sonnet") || lower.includes("3-5-sonnet")) return MODEL_CONTEXT_REGISTRY["claude-3-5-sonnet"];
  if (lower.includes("claude-3-5-haiku") || lower.includes("3-5-haiku")) return MODEL_CONTEXT_REGISTRY["claude-3-5-haiku"];
  if (lower.includes("claude")) return MODEL_CONTEXT_REGISTRY["claude-sonnet-4-6"]; // sane default

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
