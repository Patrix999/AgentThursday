/**
 * shared safe text preview / secret redaction helpers.
 *
 * Used at two boundaries:
 *  - Emission (`src/skillset/agentDynamicTools.ts`): cap + redact
 *    user-supplied content (e.g. `manager.agent_message` `text` and
 *    `reply`) before writing to event_log, so even raw inspect trace
 *    does not leak unbounded prompts or recognizable secret shapes.
 *  - Action UI intent mapping (`src/actionUiIntents.ts`): defensive
 *    pass when constructing intent props from already-bounded
 *    emission fields, and to redact summary text composed at the
 *    mapper layer.
 *
 * Patterns covered: GitHub PAT (`ghp_…`, `github_pat_…`), Bearer
 * tokens, OpenAI-style `sk-…` keys, generic approval-token shapes.
 * Not a full secret scanner — defends against the high-signal shapes
 * surfaced by an earlier revision spec; deeper redaction lives at provider
 * adapters and CI secret-scanning.
 */

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /approval[_-]?token[\s:=]+\S+/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export const SAFE_PREVIEW_DEFAULT_CAP = 160;

export function previewText(
  input: string,
  cap: number = SAFE_PREVIEW_DEFAULT_CAP,
): { text: string; truncated: boolean } {
  const redacted = redactSecrets(input);
  if (redacted.length <= cap) return { text: redacted, truncated: false };
  return { text: redacted.slice(0, cap), truncated: true };
}
