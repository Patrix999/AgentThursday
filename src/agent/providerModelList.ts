/**
 *  — provider list-models discovery. Server-side fetch of a
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
  url: (baseUrl: string | null) => string;
  headers: (apiKey: string) => Record<string, string>;
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
};

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
    if (out.length >= 100) break;
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
    const res = await fetch(spec.url(baseUrl), { headers: spec.headers(apiKey) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `provider returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    const body = await res.json();
    return { ok: true, models: parseModelsResponse(body) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  }
}
