/**
 * ModelProfile static registry.
 *
 * Typed source of truth for known Workers AI model capability/risk facts.
 *  (supplier marker),  (`supplier.signal.summary` events),
 * and future  (`recommendedAction` derivation) read these profiles
 * to interpret runtime signals against an explicit baseline.
 *
 * v1 invariants (per kanban +  milestone red lines):
 *   - This module does NOT route, retry, switch, pause, or score models.
 *   - Profiles are engineering facts and observed risks, not global
 *     intelligence rankings.
 *   - `recommendedUse` reflects current operational policy, not user advice.
 *   - `knownRisks` should not claim absence of risk globally — phrase
 *     reliable-models entries as "current observed baseline" so future
 *     evidence can update without making the prior wording obsolete.
 *   - `getModel()` in `src/server.ts` continues to hardcode Kimi; Manager
 *     prompts MAY read these profiles but v1 dispatch is unchanged.
 *
 * Out of scope (per kanban):
 *   - dynamic profile updates from canary data (deferred to +)
 *   - per-task 4-state degradation summary ()
 *   - any change to `supplier.signal.summary` event shape
 */

export type ToolCallsCapability = "reliable" | "partial" | "unsupported" | "unknown";
export type StreamingToolCallsCapability = "reliable" | "risky" | "unsupported" | "unknown";

export type ModelProfile = {
  modelId: string;
  provider: string;
  adapter: string;
  capabilities: {
    toolCalls: ToolCallsCapability;
    streamingToolCalls: StreamingToolCallsCapability;
  };
  knownRisks: string[];
  recommendedUse: string[];
  notes?: string;
};

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    modelId: "@cf/moonshotai/kimi-k2.6",
    provider: "workersai.chat",
    adapter: "workers-ai-provider",
    capabilities: {
      toolCalls: "reliable",
      streamingToolCalls: "reliable",
    },
    knownRisks: [
      "Profile reflects  verifier baseline on 2026-04-29 production tasks; not an exhaustive guarantee.",
    ],
    recommendedUse: [
      "Default production model for tool-dispatch tasks.",
      "Reference baseline for /117/118 supplier-signal interpretation.",
    ],
    notes: "Saved getModel() target after the 2026-04-28 Llama saga — only model in the discriminator probe with proper streaming finish_reason emission.",
  },
  {
    modelId: "@cf/meta/llama-4-scout-17b-16e-instruct",
    provider: "workersai.chat",
    adapter: "workers-ai-provider",
    capabilities: {
      toolCalls: "partial",
      streamingToolCalls: "risky",
    },
    knownRisks: [
      "Streaming finish_reason may be absent at end of stream; workers-ai-provider flush() can reject the round as `stream-truncated` ( saga 2026-04-28; nine hypotheses to localize).",
      "Tool calls may be emitted as inline JSON inside assistant text rather than the structured toolCalls field, bypassing dispatch entirely ( e2e 2026-04-29).",
      "When the inline-JSON pattern occurs,  logs `tool.truthfulness.violation` with `category=fabricated-claim` but no structured tool dispatch happens, so 's structural reasons (`tool_calls_present_but_not_dispatched`, `finish_reason_missing`) do not always fire on this exact path.",
    ],
    recommendedUse: [
      "Diagnostic / canary probing of supplier-side regression patterns.",
      "Not recommended as default tool-dispatch model.",
    ],
  },
  {
    modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    provider: "workersai.chat",
    adapter: "workers-ai-provider",
    capabilities: {
      toolCalls: "unknown",
      streamingToolCalls: "unknown",
    },
    knownRisks: [
      "No production-grade ModelProfile-shaped evidence collected as of 2026-04-29.",
      "Llama family streaming finish_reason regression ( saga 2026-04-28) may apply; treat with the same conservatism as Llama Scout until validated against  supplier.signal.summary baseline.",
    ],
    recommendedUse: [
      "Treat capability as unknown until evidence collected.",
    ],
  },
  {
    modelId: "@cf/qwen/qwq-32b",
    provider: "workersai.chat",
    adapter: "workers-ai-provider",
    capabilities: {
      toolCalls: "unknown",
      streamingToolCalls: "unknown",
    },
    knownRisks: [
      "No production-grade ModelProfile-shaped evidence collected as of 2026-04-29.",
      "Was probed during the 2026-04-28 saga discriminator round but no -equivalent summary was captured then; needs a fresh smoke under current  instrumentation.",
    ],
    recommendedUse: [
      "Treat capability as unknown until evidence collected.",
    ],
  },
  //  — Anthropic Claude, dispatched via @ai-sdk/anthropic.
  // Runnable only when ANTHROPIC_API_KEY is configured.
  {
    modelId: "claude-opus-4-8",
    provider: "anthropic",
    adapter: "@ai-sdk/anthropic",
    capabilities: {
      toolCalls: "reliable",
      streamingToolCalls: "reliable",
    },
    knownRisks: [
      "Requires ANTHROPIC_API_KEY (wrangler secret) — falls back to the workers-ai default when unconfigured.",
      "External API: usage is billed per Anthropic pricing; subject to Anthropic rate limits.",
    ],
    recommendedUse: [
      "Highest-capability option for hard reasoning / long-horizon agentic work.",
    ],
    notes: "Adaptive thinking only (no temperature/budget_tokens); the agentthursday loop passes neither, so the constraint is satisfied automatically.",
  },
  {
    modelId: "claude-sonnet-4-6",
    provider: "anthropic",
    adapter: "@ai-sdk/anthropic",
    capabilities: {
      toolCalls: "reliable",
      streamingToolCalls: "reliable",
    },
    knownRisks: [
      "Requires ANTHROPIC_API_KEY (wrangler secret).",
      "External API billing + rate limits.",
    ],
    recommendedUse: [
      "Balanced speed/intelligence Anthropic option.",
    ],
  },
  {
    modelId: "claude-haiku-4-5",
    provider: "anthropic",
    adapter: "@ai-sdk/anthropic",
    capabilities: {
      toolCalls: "reliable",
      streamingToolCalls: "reliable",
    },
    knownRisks: [
      "Requires an Anthropic credential (Models page → Add provider key).",
      "External API billing + rate limits.",
    ],
    recommendedUse: [
      "Fast, cost-effective Anthropic option for simpler tasks.",
    ],
  },
  //  — DeepSeek, dispatched via @ai-sdk/deepseek. Runnable when
  // a deepseek credential is stored (Models page → Add provider key).
  {
    modelId: "deepseek-chat",
    provider: "deepseek",
    adapter: "@ai-sdk/deepseek",
    capabilities: {
      toolCalls: "reliable",
      streamingToolCalls: "unknown",
    },
    knownRisks: [
      "Requires a DeepSeek credential (Models page → Add provider key).",
      "Streaming tool-call reliability not yet validated against the  supplier-signal baseline.",
    ],
    recommendedUse: [
      "Wallet-friendly external option for general tool-dispatch tasks.",
    ],
    notes: "DeepSeek V3 via OpenAI-compatible API (api.deepseek.com).",
  },
  {
    modelId: "deepseek-reasoner",
    provider: "deepseek",
    adapter: "@ai-sdk/deepseek",
    capabilities: {
      toolCalls: "unknown",
      streamingToolCalls: "unknown",
    },
    knownRisks: [
      "Requires a DeepSeek credential.",
      "Reasoning model — may not emit structured tool calls the same way; validate before tool-heavy use.",
    ],
    recommendedUse: [
      "Reasoning-heavy tasks where chain-of-thought matters more than tool dispatch.",
    ],
  },
];

/**
 * Look up a profile by exact `modelId` match (e.g.
 * `"@cf/moonshotai/kimi-k2.6"`). Returns `null` for unknown models so
 * callers can fall back to a conservative default rather than throwing.
 */
export function getModelProfile(modelId: string | null | undefined): ModelProfile | null {
  if (!modelId) return null;
  for (const p of MODEL_PROFILES) {
    if (p.modelId === modelId) return p;
  }
  return null;
}

/**
 * Returns a shallow-copied array of all known profiles. Callers may
 * iterate / sort but not mutate the global registry.
 */
export function listModelProfiles(): ModelProfile[] {
  return MODEL_PROFILES.slice();
}
