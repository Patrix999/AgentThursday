//  —  AgentProfile model runtime routing.
//
// `MODEL_CONTEXT_REGISTRY` (src/contextWindowRegistry.ts) is
// context-window metadata only. The presence of a key there does NOT
// imply that the corresponding provider adapter is wired or that the
// secret binding exists — see  §Scope §4.
//
// This module is the SEPARATE runtime-routing registry: it lists which
// AgentProfile.model ids can actually be dispatched to inference, and
// names the executable target each one resolves to. Pure functions, no
// I/O, no environment reads.
//
// `runtimeStatus`:
//   - `"available"`     — runtime target + provider adapter both wired
//                         in this card. Allowed in `/agents/new` and
//                         accepted by `POST /api/agent-profiles`.
//   - `"not_configured"` — known model id (context metadata exists),
//                         but no adapter + secret binding yet. UI may
//                         show it disabled; POST rejects with 400
//                         `unsupported_model`.
//
// Adding a new runnable model in a future card:
//   1. Confirm the provider adapter (workers-ai-provider /
//      anthropic-sdk / openai-sdk / google-genai) is imported by the
//      relevant getModel() factory site, and that any secret binding
//      it needs is declared in wrangler.toml / env types.
//   2. Add an entry here with `runtimeStatus: "available"` + a
//      `target` string.
//   3. Update `AgentThursdayAgent.getModel()` if the provider differs from
//      workers-ai (the v1 path only knows workers-ai).
//   4. Confirm `MODEL_CONTEXT_REGISTRY` has a matching key.

import { MODEL_CONTEXT_REGISTRY } from "../contextWindowRegistry";

export type AgentRuntimeProvider =
  | "workers-ai"
  | "anthropic"
  | "deepseek"
  | "openai"
  | "google";

/**
 *  — external providers whose runnability is gated by a stored
 * credential (registry DO `provider_credential`) rather than a static
 * `available` status. workers-ai needs no credential.
 */
export const CREDENTIAL_GATED_PROVIDERS: ReadonlySet<AgentRuntimeProvider> =
  new Set(["anthropic", "deepseek"]);

export type AgentRuntimeStatus = "available" | "not_configured";

export interface AgentRuntimeModelEntry {
  /** Stable id used in AgentProfile.model and `/agents/new`. */
  id: string;
  /** Human-readable label for UI. */
  label: string;
  /** Logical provider family. Determines which adapter `getModel()` uses. */
  provider: AgentRuntimeProvider;
  /** Whether this model can actually be dispatched right now. */
  runtimeStatus: AgentRuntimeStatus;
  /**
   * Executable target string, or null when not configured.
   * For workers-ai this is the `@cf/...` model name passed to
   * `createWorkersAI({ binding })(target)`. Server-side only — not
   * exposed in the `/options` response.
   */
  target: string | null;
}

/**
 * Public-facing option shape returned by `/api/agent-profiles/options`.
 * Excludes the executable `target` so we never leak it through the
 * public API surface. The UI only needs `id`, `label`, `provider`,
 * `runtimeStatus`.
 */
export interface AgentRuntimeModelOption {
  id: string;
  label: string;
  provider: AgentRuntimeProvider;
  runtimeStatus: AgentRuntimeStatus;
}

const ENTRIES: readonly AgentRuntimeModelEntry[] = [
  // Workers AI — the only runnable provider in  v1.
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6 (Workers AI)",
    provider: "workers-ai",
    runtimeStatus: "available",
    target: "@cf/moonshotai/kimi-k2.6",
  },
  //  — second runnable Workers AI choice. GLM-4.7-Flash is
  // documented by Cloudflare as multi-turn tool-calling optimized
  // (131,072 context). Dispatch path is identical to Kimi —
  // workers-ai-provider createWorkersAI({ binding })(target).
  {
    id: "glm-4.7-flash",
    label: "GLM-4.7-Flash (Workers AI)",
    provider: "workers-ai",
    runtimeStatus: "available",
    target: "@cf/zai-org/glm-4.7-flash",
  },

  //  — Anthropic Claude, wired for REAL dispatch via
  // `@ai-sdk/anthropic`. `target` is the bare Claude model id; these
  // become runnable only when `ANTHROPIC_API_KEY` is configured
  // (key-gated — see `isRunnableAgentRuntimeModel(modelId, opts)` and
  // `effectiveRuntimeStatus`). The static `runtimeStatus` here is the
  // no-key default; the env-aware resolvers upgrade it when the key is
  // present.
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8 (Anthropic)",
    provider: "anthropic",
    runtimeStatus: "not_configured",
    target: "claude-opus-4-8",
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5 (Anthropic)",
    provider: "anthropic",
    runtimeStatus: "not_configured",
    target: "claude-fable-5",
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7 (Anthropic)",
    provider: "anthropic",
    runtimeStatus: "not_configured",
    target: "claude-opus-4-7",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (Anthropic)",
    provider: "anthropic",
    runtimeStatus: "not_configured",
    target: "claude-sonnet-4-6",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5 (Anthropic)",
    provider: "anthropic",
    runtimeStatus: "not_configured",
    target: "claude-haiku-4-5",
  },
  //  — DeepSeek (wallet-friendly), via @ai-sdk/deepseek.
  {
    id: "deepseek-chat",
    label: "DeepSeek V3 (deepseek-chat)",
    provider: "deepseek",
    runtimeStatus: "not_configured",
    target: "deepseek-chat",
  },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek R1 (deepseek-reasoner)",
    provider: "deepseek",
    runtimeStatus: "not_configured",
    target: "deepseek-reasoner",
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1 (OpenAI)",
    provider: "openai",
    runtimeStatus: "not_configured",
    target: null,
  },
  {
    id: "gpt-4o",
    label: "GPT-4o (OpenAI)",
    provider: "openai",
    runtimeStatus: "not_configured",
    target: null,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro (Google)",
    provider: "google",
    runtimeStatus: "not_configured",
    target: null,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash (Google)",
    provider: "google",
    runtimeStatus: "not_configured",
    target: null,
  },
];

const ENTRY_BY_ID: ReadonlyMap<string, AgentRuntimeModelEntry> = new Map(
  ENTRIES.map(e => [e.id, e]),
);

// Load-time sanity check: every entry id must exist in
// MODEL_CONTEXT_REGISTRY. Otherwise downstream context-window helpers
// fall through to DEFAULT_CONTEXT_PROFILE (128K) silently when this
// model is selected, which the  lastObservedModel path is
// supposed to prevent. Throwing here makes the mismatch fail-fast at
// module-import time rather than at first inference.
{
  const missing: string[] = [];
  for (const entry of ENTRIES) {
    if (!Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_REGISTRY, entry.id)) {
      missing.push(entry.id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `agentModelRuntime: entries missing from MODEL_CONTEXT_REGISTRY: ${missing.join(", ")}`,
    );
  }
}

/** Returns the full closed registry, including not_configured entries. */
export function listAgentRuntimeModelEntries(): readonly AgentRuntimeModelEntry[] {
  return ENTRIES;
}

/** Returns the public option list. Excludes the executable `target`. */
export function listAgentRuntimeModelOptions(): AgentRuntimeModelOption[] {
  return ENTRIES.map(e => ({
    id: e.id,
    label: e.label,
    provider: e.provider,
    runtimeStatus: e.runtimeStatus,
  }));
}

/**
 *  — merge live-discovered provider models into the options
 * list so the agent-create dropdown isn't a hardcoded set.
 *
 * Rules:
 * 1. A static credential-gated entry (anthropic/deepseek) flips to
 *    `available` when its provider has a stored credential.
 * 2. A discovered model id not already in the static list is appended
 *    as an `available` option (its provider is configured by
 *    construction — discovery requires the credential).
 * 3. Static external entries for unconfigured providers stay
 *    `not_configured` (rendered disabled).
 *
 * Keeps options consistent with what create actually accepts
 * (configuredProviders gate + resolveProviderForModel cache).
 */
export function mergeRuntimeModelOptions(
  staticOptions: AgentRuntimeModelOption[],
  configuredProviders: string[],
  discovered: Array<{ provider: string; models: string[] }>,
): AgentRuntimeModelOption[] {
  const configured = new Set(configuredProviders);
  const out: AgentRuntimeModelOption[] = staticOptions.map((o) =>
    CREDENTIAL_GATED_PROVIDERS.has(o.provider) && configured.has(o.provider)
      ? { ...o, runtimeStatus: "available" }
      : o,
  );
  const seen = new Set(out.map((o) => o.id));
  for (const d of discovered) {
    if (!configured.has(d.provider)) continue;
    for (const id of d.models) {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: `${id} (${d.provider})`,
        provider: d.provider as AgentRuntimeProvider,
        runtimeStatus: "available",
      });
    }
  }
  return out;
}

/**
 * Resolve a model id to an entry, or null if not in the runtime
 * registry. The caller decides whether to fail-soft to the default or
 * surface an error.
 */
export function resolveAgentRuntimeModel(
  modelId: string | null | undefined,
): AgentRuntimeModelEntry | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  return ENTRY_BY_ID.get(modelId) ?? null;
}

/**
 * Safe default for getModel() when no profile-driven target is set
 * (e.g. registry DO `DEMO_INSTANCE`, or a per-profile DO that hasn't
 * loaded its profile yet). Always returns an `available` entry.
 */
export function defaultAgentRuntimeModel(): AgentRuntimeModelEntry {
  const def = ENTRY_BY_ID.get("kimi-k2.6");
  if (!def || def.runtimeStatus !== "available" || def.target === null) {
    throw new Error("agentModelRuntime: default entry kimi-k2.6 must be available");
  }
  return def;
}

/**
 * /412 — runnability gate for external providers. A provider is
 * "configured" when a credential exists for it (registry DO
 * `provider_credential`, or — back-compat — an env key). Only the SET
 * of configured providers matters here; key values never reach this
 * boundary.
 */
export interface RuntimeModelEnv {
  /**  — provider ids that have a usable credential. */
  configuredProviders?: ReadonlySet<AgentRuntimeProvider> | AgentRuntimeProvider[];
  /**  — deprecated alias; treated as anthropic configured. */
  anthropicKeyPresent?: boolean;
}

function providerConfigured(
  provider: AgentRuntimeProvider,
  env?: RuntimeModelEnv,
): boolean {
  if (env?.anthropicKeyPresent === true && provider === "anthropic") return true;
  const set = env?.configuredProviders;
  if (!set) return false;
  return Array.isArray(set) ? set.includes(provider) : set.has(provider);
}

/**
 * Effective runnability for an entry given the environment.
 * - workers-ai: runnable when statically `available` + has a target.
 * - credential-gated provider (anthropic/deepseek): runnable when it
 *   has a target AND that provider is configured.
 */
export function isEntryRunnable(
  entry: AgentRuntimeModelEntry,
  env?: RuntimeModelEnv,
): boolean {
  if (entry.target === null) return false;
  if (CREDENTIAL_GATED_PROVIDERS.has(entry.provider)) {
    return providerConfigured(entry.provider, env);
  }
  return entry.runtimeStatus === "available";
}

/** Convenience predicate: "would `POST /api/agent-profiles` accept this?" */
export function isRunnableAgentRuntimeModel(
  modelId: string,
  env?: RuntimeModelEnv,
): boolean {
  const entry = resolveAgentRuntimeModel(modelId);
  return entry !== null && isEntryRunnable(entry, env);
}
