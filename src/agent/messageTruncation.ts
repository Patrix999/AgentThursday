/**
 * 2026-06-30 — truncate-on-persist for large file-read tool results (DO-OOM fix).
 *
 * A persisted assistant message's `content` is JSON with a `parts` array; a
 * file-read tool call is a `tool-<name>` part carrying the full result in
 * `output` (e.g. a 465KB content_read of a source file). Loading many such rows
 * on DO wake materialises MB-scale strings into the 128MB isolate heap → reset.
 *
 * This pure transform shrinks any oversized tool-result `output` to a tiny
 * re-read marker. CRITICAL: it preserves `type` / `toolCallId` / `toolName` /
 * `state` / `input` and only swaps `output`, so the tool_use↔tool_result pairing
 * the provider validates on replay stays intact. Idempotent (skips parts already
 * carrying `truncated: true`).
 */

export function defaultReReadHint(toolName: string, input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const key =
    (typeof o.path === "string" && o.path) ||
    (typeof o.url === "string" && o.url) ||
    (typeof o.doc_id === "string" && o.doc_id) ||
    (typeof o.docId === "string" && o.docId) ||
    null;
  return key ? `${toolName} ${key}` : toolName;
}

export function truncateLargeToolResultParts(
  content: string,
  opts: { partLimitBytes: number; reReadHint?: (toolName: string, input: unknown) => string },
): { content: string; changed: boolean; truncatedParts: number } {
  const hintFn = opts.reReadHint ?? defaultReReadHint;
  let parsed: { parts?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(content) as { parts?: Array<Record<string, unknown>> };
  } catch {
    return { content, changed: false, truncatedParts: 0 };
  }
  const parts = Array.isArray(parsed.parts) ? parsed.parts : null;
  if (parts === null) return { content, changed: false, truncatedParts: 0 };
  let changed = false;
  let truncatedParts = 0;
  for (const p of parts) {
    const type = typeof p.type === "string" ? p.type : "";
    if (!type.startsWith("tool-")) continue; // only tool-result parts
    const output = p.output;
    if (output === undefined || output === null) continue;
    if (typeof output === "object" && (output as Record<string, unknown>).truncated === true) continue; // already done
    const originalBytes = JSON.stringify(output).length;
    if (originalBytes <= opts.partLimitBytes) continue;
    const toolName = typeof p.toolName === "string" ? p.toolName : type.slice(5);
    p.output = {
      ok: true,
      truncated: true,
      originalBytes,
      hint: `Result truncated from conversation history to save memory. If you need this content, re-read it: ${hintFn(toolName, p.input)}.`,
    };
    changed = true;
    truncatedParts++;
  }
  return changed
    ? { content: JSON.stringify(parsed), changed: true, truncatedParts }
    : { content, changed: false, truncatedParts: 0 };
}
