/**
 * LocalDoc — external markdown-publishing callable tool adapter.
 *
 * Provider-specific code lives ONLY in this module and the
 * `/api/dispatch/localdoc/convert_text` route that calls it. The
 * skillset loader, contract registry, and inspect surface remain
 * provider-neutral; they see the localdoc skill only through the
 * generic `SkillDescriptor` extension fields declared in the
 * `external-publishing` manifest.
 *
 * Endpoint is configurable: the default below is a placeholder. Point
 * `LOCALDOC_DEFAULT_ENDPOINT` (or the per-call `options.endpoint`) at
 * your own markdown-publishing service before enabling this skill.
 *
 * Secret policy:
 *   - secret is read from `env.LOCALDOC_API_KEY` (binding name exported
 *     as `LOCALDOC_SECRET_BINDING_NAME` so the contract registry / inspect
 *     downgrade can reference the same string).
 *   - never logged, never echoed in evidence, never put on the wire
 *     except as the `Authorization: Bearer <key>` header to the endpoint.
 *   - missing/empty → dispatch returns a structured failure
 *     `{ status: "blocked", reason: "missing_secret" }` without
 *     touching the network.
 */

export const LOCALDOC_TOOL_ID = "localdoc.convert_text";
export const LOCALDOC_SKILL_ID = "localdoc.publish.convert_text";
export const LOCALDOC_SECRET_BINDING_NAME = "LOCALDOC_API_KEY";
export const LOCALDOC_DEFAULT_ENDPOINT = "https://localdoc.example.com/api/convert";
export const LOCALDOC_DEFAULT_TIMEOUT_MS = 15000;

export interface LocalDocConvertTextInput {
  content: string;
  title?: string;
}

export interface LocalDocSuccessEvidence {
  status: "ok";
  id: string;
  url: string;
  markdownUrl: string;
  http_status: number;
}

export interface LocalDocBlockedEvidence {
  status: "blocked";
  reason: "missing_secret";
}

export type LocalDocFailureReason =
  | "invalid_input"
  | "http_error"
  | "timeout"
  | "malformed_response"
  | "network_error";

export interface LocalDocFailureEvidence {
  status: "failed";
  reason: LocalDocFailureReason;
  http_status?: number;
  error_message?: string;
}

export type LocalDocEvidence =
  | LocalDocSuccessEvidence
  | LocalDocBlockedEvidence
  | LocalDocFailureEvidence;

export interface LocalDocEnvLike {
  LOCALDOC_API_KEY?: string;
}

export interface LocalDocDispatchOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function isLocalDocReady(env: LocalDocEnvLike): boolean {
  const key = env.LOCALDOC_API_KEY;
  return typeof key === "string" && key.length > 0;
}

/**
 * Truncate provider-side error message so we never accidentally
 * leak a token-shaped substring back to evidence consumers, and so
 * the dashboard does not have to deal with arbitrarily long bodies.
 */
function safeErrorMessage(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 200)}…`;
}

export async function dispatchLocalDocConvertText(
  input: LocalDocConvertTextInput,
  env: LocalDocEnvLike,
  options: LocalDocDispatchOptions = {},
): Promise<LocalDocEvidence> {
  if (typeof input.content !== "string" || input.content.length === 0) {
    return {
      status: "failed",
      reason: "invalid_input",
      error_message: "content must be a non-empty string",
    };
  }

  const secret = env.LOCALDOC_API_KEY;
  if (typeof secret !== "string" || secret.length === 0) {
    return { status: "blocked", reason: "missing_secret" };
  }

  const endpoint = options.endpoint ?? LOCALDOC_DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? LOCALDOC_DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // The publishing endpoint expects the markdown payload under `text`.
  // The public dispatch route + adapter input field stays `content` for
  // provider-neutral naming; only the wire body field is renamed.
  const wireBody: { title?: string; text: string } = { text: input.content };
  if (input.title !== undefined) wireBody.title = input.title;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
      },
      body: JSON.stringify(wireBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      return { status: "failed", reason: "timeout" };
    }
    return {
      status: "failed",
      reason: "network_error",
      error_message: safeErrorMessage(err instanceof Error ? err.message : String(err)),
    };
  }
  clearTimeout(timer);

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    return {
      status: "failed",
      reason: "malformed_response",
      http_status: response.status,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      status: "failed",
      reason: "http_error",
      http_status: response.status,
      error_message: safeErrorMessage(bodyText),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: "failed",
      reason: "malformed_response",
      http_status: response.status,
    };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { url?: unknown }).url !== "string" ||
    typeof (parsed as { markdownUrl?: unknown }).markdownUrl !== "string"
  ) {
    return {
      status: "failed",
      reason: "malformed_response",
      http_status: response.status,
    };
  }

  const p = parsed as { id: string; url: string; markdownUrl: string };
  return {
    status: "ok",
    id: p.id,
    url: p.url,
    markdownUrl: p.markdownUrl,
    http_status: response.status,
  };
}
