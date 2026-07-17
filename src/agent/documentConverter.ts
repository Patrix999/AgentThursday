/**
 * / 2026-06-25 — document converter.
 *
 * the operator 2026-06-25: don't maintain two copies of the parsing waterfall. Call the
 * localdoc service (https://fyi.md, the operator's own Worker) over its public API instead of
 * the ported LlamaParse tier — localdoc already runs the full waterfall
 * (LlamaParse / LLM-vision / Firecrawl / CF) behind one endpoint, so AgentThursday gets
 * higher-fidelity PDF/office parsing without porting + maintaining it here.
 *
 * Async upload (the operator: "改异步吧 没转换好之前给用户转圈"): hard PDFs route to
 * localdoc's queue and take minutes — too long for a synchronous upload request. So
 * PDF/office uploads `localdocSubmit` (a fast POST that returns a poll URL), the doc
 * is recorded `processing`, and a later list/read `localdocPollOnce`s that URL and
 * fills the markdown when localdoc finishes. `convertBinaryDocument` stays as the
 * always-available CF `toMarkdown` baseline — used for non-PDF binaries (images)
 * and as the synchronous fallback when localdoc is unconfigured or errors.
 *
 * The raw file never lands in AgentThursday storage — it is streamed to the configured
 * parser (localdoc / CF) for that one call only. NOTE: localdoc stores the *converted
 * markdown* at an unguessable `fyi.md/<id>` URL with a plan-based TTL (raw input
 * is not stored). Acceptable per the operator's "用公开api" call; revisit if private-doc
 * exposure matters.
 */

export interface ConverterEnv {
  AI: { toMarkdown: (docs: Array<{ name: string; blob: Blob }>) => Promise<Array<{ data?: string } | { markdown?: string }>> };
  LOCALDOC_API_KEY?: string;
  LOCALDOC_API_BASE?: string;
  LOCALDOC_POLL_MS?: string;
  DOC_CONVERT_TIMEOUT_MS?: string;
}

export interface ConvertResult {
  markdown: string;
  provider: string;
  trace: string[];
}

const DEFAULT_LOCALDOC_BASE = "https://fyi.md";

export function isPdfOrOffice(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime === "application/msword"
  );
}

/** Base64-encode an ArrayBuffer in chunks (avoids stack overflow on large files). */
function bytesToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** CF Workers AI `toMarkdown` — the always-available baseline. */
async function cfToMarkdown(env: ConverterEnv, bytes: ArrayBuffer, filename: string, mime: string): Promise<string> {
  const blob = new Blob([bytes], { type: mime });
  const res = await env.AI.toMarkdown([{ name: filename, blob }]);
  const first = res?.[0] as { data?: string; markdown?: string } | undefined;
  return String(first?.data ?? first?.markdown ?? "").trim();
}

function localdocBase(env: ConverterEnv): string {
  return (env.LOCALDOC_API_BASE || DEFAULT_LOCALDOC_BASE).replace(/\/$/, "");
}

/**
 * Which provider produced the markdown — for `document.resolved` provenance, so a
 * premium-provider result (LlamaParse / LLM-vision) is distinguishable from the CF
 * baseline. localdoc has no top-level `provider`; it records the waterfall in
 * `metadata.trace` (e.g. `["cloudflare-ai-markdown: success"]`). Take the name
 * before the successful entry's colon.
 */
function localdocProvider(provider: string | undefined, trace: string[] | undefined): string | undefined {
  if (provider) return provider;
  if (Array.isArray(trace) && trace.length > 0) {
    const ok = trace.find((t) => /:\s*success/i.test(t)) ?? trace[trace.length - 1];
    if (ok) return String(ok).split(":")[0].trim();
  }
  return undefined;
}

/**
 * Hand a document to localdoc. POSTs the base64 payload to `/api/convert`; small/fast
 * inputs come back `done` with inline markdown, larger ones route to localdoc's queue
 * and return a `jsonUrl` to poll later. Throws (`unconfigured`) when no key is set,
 * so the caller can fall back to the CF baseline. Bounded so the upload request
 * never hangs on the POST itself.
 */
export async function localdocSubmit(
  env: ConverterEnv,
  bytes: ArrayBuffer,
  mime: string,
): Promise<{ done: string } | { jsonUrl: string }> {
  const apiKey = env.LOCALDOC_API_KEY;
  if (!apiKey) throw new Error("unconfigured");
  const base = localdocBase(env);
  const base64 = bytesToBase64(bytes);
  const payload = mime.startsWith("image/")
    ? { imageBase64: base64, imageMimeType: mime }
    : { documentBase64: base64, documentMimeType: mime };

  const res = await fetch(`${base}/api/convert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`localdoc convert ${res.status}`);
  const data = (await res.json()) as { status?: string; markdown?: string; jsonUrl?: string };
  if (data.status === "done" && typeof data.markdown === "string" && data.markdown.trim().length > 0) {
    return { done: data.markdown.trim() };
  }
  if (data.jsonUrl) return { jsonUrl: data.jsonUrl };
  throw new Error("localdoc: no jsonUrl in response");
}

/**
 * Poll a localdoc job once. Returns the conversion state — `done` carries the markdown
 * (+ which provider produced it, for provenance), `processing` means keep waiting,
 * `failed` is terminal. A transient/throwing fetch surfaces as `processing` so the
 * job isn't wrongly marked failed (the next poll retries).
 */
export async function localdocPollOnce(
  env: ConverterEnv,
  jsonUrl: string,
): Promise<{ status: "done"; markdown: string; provider?: string } | { status: "processing" } | { status: "failed" }> {
  const apiKey = env.LOCALDOC_API_KEY;
  if (!apiKey) return { status: "failed" };
  try {
    const pr = await fetch(jsonUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!pr.ok) return { status: "processing" };
    const doc = (await pr.json()) as {
      status?: string;
      markdown?: string;
      error?: string;
      provider?: string;
      metadata?: { trace?: string[] };
    };
    if (doc.error) return { status: "failed" };
    if (doc.status === "done") {
      const md = String(doc.markdown ?? "").trim();
      return md ? { status: "done", markdown: md, provider: localdocProvider(doc.provider, doc.metadata?.trace) } : { status: "failed" };
    }
    return { status: "processing" };
  } catch {
    return { status: "processing" };
  }
}

/**
 * CF `toMarkdown` baseline for a binary document — used for non-PDF binaries and
 * as the synchronous fallback when localdoc is unavailable. Throws if extraction
 * yields nothing so the caller can return a clear "unsupported" error.
 */
export async function convertBinaryDocument(opts: {
  env: ConverterEnv;
  bytes: ArrayBuffer;
  filename: string;
  mime: string;
}): Promise<ConvertResult> {
  const { env, bytes, filename, mime } = opts;
  const md = await cfToMarkdown(env, bytes, filename, mime);
  if (!md || md.trim().length === 0) throw new Error("cloudflare-ai-markdown: empty");
  return { markdown: md, provider: "cloudflare-ai-markdown", trace: ["cloudflare-ai-markdown: ok"] };
}
