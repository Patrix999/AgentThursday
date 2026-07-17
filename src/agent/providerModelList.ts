/**
 * provider list-models discovery. Server-side fetch of a
 * provider's available models using a stored credential. The API key
 * stays in the worker (passed in, never returned). Fail-soft: network
 * / auth errors return a structured `{ok:false}` rather than throwing.
 */

export interface DiscoveredModel {
  id: string;
  label?: string;
}

export type ProviderModelsResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; error: string };

interface ProviderListSpec {
  url: (baseUrl: string | null, apiKey: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  /** Custom parser for non-OpenAI-shaped responses (defaults to parseModelsResponse). */
  parse?: (body: unknown) => DiscoveredModel[];
}

const SPECS: Record<string, ProviderListSpec> = {
  anthropic: {
    url: (b) => `${(b ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/models`,
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  deepseek: {
    // OpenAI-compatible models endpoint.
    url: (b) => `${(b ?? "https://api.deepseek.com").replace(/\/$/, "")}/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  openai: {
    // OpenAI-compatible `{data:[{id}]}`.
    url: (b) => `${(b ?? "https://api.openai.com").replace(/\/$/, "")}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  google: {
    // Gemini Generative Language API: key in query, `{models:[{name}]}` shape.
    url: (b, k) => `${(b ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "")}/v1beta/models?key=${encodeURIComponent(k)}&pageSize=200`,
    headers: () => ({}),
    parse: parseGoogleModels,
  },
  zhipu: {
    // 2026-06-29 — 智谱 (Zhipu / BigModel). OpenAI-compatible `{data:[{id}]}`.
    url: (b) => `${(b ?? "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "")}/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  grok: {
    // 2026-07-09 — xAI Grok. OpenAI-compatible `{data:[{id}]}`.
    url: (b) => `${(b ?? "https://api.x.ai/v1").replace(/\/$/, "")}/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
};

/**
 * Parse the Gemini `{models:[{name:"models/<id>", displayName?, supportedGenerationMethods?}]}`
 * shape. Strips the `models/` prefix to the bare id `@ai-sdk/google` expects, and
 * keeps only generateContent-capable models (drops embeddings/aqa/etc.).
 */
// Bound the discovered list so a pathological response can't blow up the UI,
// but high enough for real catalogs (OpenAI's /v1/models exceeds 100 with
// fine-tunes + embeddings/tts/whisper/etc.). an earlier revision.
const MAX_DISCOVERED_MODELS = 500;

export function parseGoogleModels(body: unknown): DiscoveredModel[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: DiscoveredModel[] = [];
  for (const m of models) {
    const mm = m as Record<string, unknown>;
    const name = typeof mm.name === "string" ? mm.name : null;
    if (name === null) continue;
    const methods = mm.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
    const id = name.startsWith("models/") ? name.slice("models/".length) : name;
    const label = typeof mm.displayName === "string" ? mm.displayName : undefined;
    out.push(label !== undefined ? { id, label } : { id });
    if (out.length >= MAX_DISCOVERED_MODELS) break;
  }
  return out;
}

/**
 * Parse the OpenAI/Anthropic-compatible `{data: [{id, display_name?}]}`
 * list shape into bounded `{id, label}` entries.
 */
export function parseModelsResponse(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const m of data) {
    const mm = m as Record<string, unknown>;
    const id = typeof mm.id === "string" ? mm.id : null;
    if (id === null) continue;
    const label = typeof mm.display_name === "string" ? mm.display_name : undefined;
    out.push(label !== undefined ? { id, label } : { id });
    if (out.length >= MAX_DISCOVERED_MODELS) break;
  }
  return out;
}

export async function fetchProviderModels(
  provider: string,
  apiKey: string,
  baseUrl: string | null,
): Promise<ProviderModelsResult> {
  const spec = SPECS[provider];
  if (!spec) return { ok: false, error: `list-models not supported for provider: ${provider}` };
  try {
    const res = await fetch(spec.url(baseUrl, apiKey), { headers: spec.headers(apiKey) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `provider returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    const body = await res.json();
    return { ok: true, models: (spec.parse ?? parseModelsResponse)(body) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  }
}
