/**
 * M9.4 / 2026-06-25 — document converter.
 *
 * the operator 2026-06-25: don't maintain two copies of the parsing waterfall. Call the
 * fyimd service (https://fyi.md, the operator's own Worker) over its public API instead of
 * the ported LlamaParse tier — fyimd already runs the full waterfall
 * (LlamaParse / LLM-vision / Firecrawl / CF) behind one endpoint, so AgentThursday gets
 * higher-fidelity PDF/office parsing without porting + maintaining it here.
 *
 * Async upload (the operator: "改异步吧 没转换好之前给用户转圈"): hard PDFs route to
 * fyimd's queue and take minutes — too long for a synchronous upload request. So
 * PDF/office uploads `fyimdSubmit` (a fast POST that returns a poll URL), the doc
 * is recorded `processing`, and a later list/read `fyimdPollOnce`s that URL and
 * fills the markdown when fyimd finishes. `convertBinaryDocument` stays as the
 * always-available CF `toMarkdown` baseline — used for non-PDF binaries (images)
 * and as the synchronous fallback when fyimd is unconfigured or errors.
 *
 * The raw file never lands in AgentThursday storage — it is streamed to the configured
 * parser (fyimd / CF) for that one call only. NOTE: fyimd stores the *converted
 * markdown* at an unguessable `fyi.md/<id>` URL with a plan-based TTL (raw input
 * is not stored). Acceptable per the operator's "用公开api" call; revisit if private-doc
 * exposure matters.
 */

export interface ConverterEnv {
  AI: { toMarkdown: (docs: Array<{ name: string; blob: Blob }>) => Promise<Array<{ data?: string } | { markdown?: string }>> };
  FYIMD_API_KEY?: string;
  FYIMD_API_BASE?: string;
  FYIMD_POLL_MS?: string;
  DOC_CONVERT_TIMEOUT_MS?: string;
}

export interface ConvertResult {
  markdown: string;
  provider: string;
  trace: string[];
}

const DEFAULT_FYIMD_BASE = "https://fyi.md";

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

function fyimdBase(env: ConverterEnv): string {
  return (env.FYIMD_API_BASE || DEFAULT_FYIMD_BASE).replace(/\/$/, "");
}

/**
 * Which provider produced the markdown — for `document.resolved` provenance, so a
 * premium-provider result (LlamaParse / LLM-vision) is distinguishable from the CF
 * baseline. fyimd has no top-level `provider`; it records the waterfall in
 * `metadata.trace` (e.g. `["cloudflare-ai-markdown: success"]`). Take the name
 * before the successful entry's colon.
 */
function fyimdProvider(provider: string | undefined, trace: string[] | undefined): string | undefined {
  if (provider) return provider;
  if (Array.isArray(trace) && trace.length > 0) {
    const ok = trace.find((t) => /:\s*success/i.test(t)) ?? trace[trace.length - 1];
    if (ok) return String(ok).split(":")[0].trim();
  }
  return undefined;
}

/**
 * Hand a document to fyimd. POSTs the base64 payload to `/api/convert`; small/fast
 * inputs come back `done` with inline markdown, larger ones route to fyimd's queue
 * and return a `jsonUrl` to poll later. Throws (`unconfigured`) when no key is set,
 * so the caller can fall back to the CF baseline. Bounded so the upload request
 * never hangs on the POST itself.
 */
export async function fyimdSubmit(
  env: ConverterEnv,
  bytes: ArrayBuffer,
  mime: string,
): Promise<{ done: string } | { jsonUrl: string }> {
  const apiKey = env.FYIMD_API_KEY;
  if (!apiKey) throw new Error("unconfigured");
  const base = fyimdBase(env);
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
  if (!res.ok) throw new Error(`fyimd convert ${res.status}`);
  const data = (await res.json()) as { status?: string; markdown?: string; jsonUrl?: string };
  if (data.status === "done" && typeof data.markdown === "string" && data.markdown.trim().length > 0) {
    return { done: data.markdown.trim() };
  }
  if (data.jsonUrl) return { jsonUrl: data.jsonUrl };
  throw new Error("fyimd: no jsonUrl in response");
}

/**
 * Poll a fyimd job once. Returns the conversion state — `done` carries the markdown
 * (+ which provider produced it, for provenance), `processing` means keep waiting,
 * `failed` is terminal. A transient/throwing fetch surfaces as `processing` so the
 * job isn't wrongly marked failed (the next poll retries).
 */
export async function fyimdPollOnce(
  env: ConverterEnv,
  jsonUrl: string,
): Promise<{ status: "done"; markdown: string; provider?: string } | { status: "processing" } | { status: "failed" }> {
  const apiKey = env.FYIMD_API_KEY;
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
      return md ? { status: "done", markdown: md, provider: fyimdProvider(doc.provider, doc.metadata?.trace) } : { status: "failed" };
    }
    return { status: "processing" };
  } catch {
    return { status: "processing" };
  }
}

/**
 * CF `toMarkdown` baseline for a binary document — used for non-PDF binaries and
 * as the synchronous fallback when fyimd is unavailable. Throws if extraction
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
