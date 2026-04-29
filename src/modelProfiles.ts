/**
 * M7.5 Card 118 — ModelProfile static registry.
 *
 * Typed source of truth for known Workers AI model capability/risk facts.
 * Card 116 (supplier marker), Card 117 (`supplier.signal.summary` events),
 * and future Card 119 (`recommendedAction` derivation) read these profiles
 * to interpret runtime signals against an explicit baseline.
 *
 * v1 invariants (per kanban + M7.5 milestone red lines):
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
 *   - dynamic profile updates from canary data (deferred to Card 122+)
 *   - per-task 4-state degradation summary (Card 119)
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
      "Profile reflects Card 117 verifier baseline on 2026-04-29 production tasks; not an exhaustive guarantee.",
    ],
    recommendedUse: [
      "Default production model for tool-dispatch tasks.",
      "Reference baseline for Card 116/117/118 supplier-signal interpretation.",
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
      "Streaming finish_reason may be absent at end of stream; workers-ai-provider flush() can reject the round as `stream-truncated` (M7.4 saga 2026-04-28; nine hypotheses to localize).",
      "Tool calls may be emitted as inline JSON inside assistant text rather than the structured toolCalls field, bypassing dispatch entirely (Card 116 e2e 2026-04-29).",
      "When the inline-JSON pattern occurs, Card 102 logs `tool.truthfulness.violation` with `category=fabricated-claim` but no structured tool dispatch happens, so Card 116's structural reasons (`tool_calls_present_but_not_dispatched`, `finish_reason_missing`) do not always fire on this exact path.",
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
      "Llama family streaming finish_reason regression (M7.4 saga 2026-04-28) may apply; treat with the same conservatism as Llama Scout until validated against Card 117 supplier.signal.summary baseline.",
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
      "Was probed during the 2026-04-28 saga discriminator round but no Card 117-equivalent summary was captured then; needs a fresh smoke under current Card 117 instrumentation.",
    ],
    recommendedUse: [
      "Treat capability as unknown until evidence collected.",
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
