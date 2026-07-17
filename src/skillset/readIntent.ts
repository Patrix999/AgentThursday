/**
 * read-side intent detector.
 *
 * Mirrors the shape of `src/skillset/gateIntent.ts` but for repo-file
 * inspection prompts. The existing `readOnlySafe` classifier in
 * `src/server.ts:_finalizeTaskTurn` caller (and seal-time eligibility
 * check in `evidenceEnvelope.ts`) is gate-intent-only: a prompt like
 * "看一下 docs/X.md 前 5 项" reaches seal with `execution_len=0` and
 * receives `verdict_reason="read_only_no_action_required"` because no
 * gate keywords appeared and no tools were dispatched. That hides
 * file-inspection requests that should have triggered `repo_read` /
 * `repo_grep`.
 *
 * This module is pure (no SDK / SQL / DO state) so it is trivially
 * testable. The cross-check against actually-dispatched tool ids is
 * not done here — `detectReadIntent` only inspects the prompt text.
 * The seal contract uses the conjunction
 * `promptReadIntent && wrappedDispatchCount === 0` to decide whether
 * to flip `readOnlySafe` false and emit the degraded verdict reason
 * `read_intent_no_execution`.
 *
 * Over-firing is acceptable: read-intent detection only matters when
 * zero tools were dispatched. If the agent did dispatch `repo_read`,
 * the envelope is already evidenced and the strict-ring path runs.
 */

export interface ReadIntent {
  detected: boolean;
  /** Lowercased pattern keys that fired, for inspect / debug. */
  matchedPatterns: string[];
}

/**
 * File-path-like token. Conservative: must include a path separator
 * or a known repo-source extension, and must not start with a URL
 * scheme. Lets us anchor read-verb detection on something that looks
 * like an actual repo file rather than firing on every Chinese verb.
 *
 * Examples that match:
 *   docs/skillsets/software-dev.0.1.0.yaml
 *   src/server.ts
 *   ./README.md
 *
 * Examples that do NOT match:
 *   https://example.com/path
 *   example.com
 *   plain English text without slashes
 */
const REPO_PATH_RE = /(?<![A-Za-z0-9])(?:\.{0,2}\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html)\b/;

const PATH_ONLY_RE = /(?<![A-Za-z0-9/])[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs)\b/;

const READ_VERB_PATTERNS: Array<{ key: string; re: RegExp }> = [
  // Chinese — "看 / 读 / 查看 / 看一下 / 读一下 / 打开 / 翻一翻"
  { key: "kan_path", re: /(?:看一下|看看|查看|看|读一下|读读|读|打开|翻一翻|翻一下)[\s\S]{0,12}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // English — "read / show me / look at / open / cat / view"
  { key: "read_path_en", re: /\b(?:read|show\s+me|look\s+at|open|cat|view|inspect)\s+[\s\S]{0,16}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // "前 N 项 / first N items / list the X in Y" — requires a path elsewhere in prompt
  { key: "list_n_items_zh", re: /(?:前\s*\d+\s*[项条个]|前\s*几\s*[项条个]|列出|列一下)/i },
  { key: "list_n_items_en", re: /\b(?:first|top)\s+\d+\s+(?:items?|entries|lines?|rows?)\b|\blist\s+(?:the\s+)?(?:contents?|entries|items?|fields?)\b/i },
];

/**
 * Detect read-side intent in a prompt.
 *
 * Conservative dual-anchor design: a pattern fires either when
 * (a) a read verb co-occurs with a repo-shaped path within a short
 * window, OR (b) a bare repo-shaped path appears AND a "list /
 * 前 N 项" pattern appears anywhere in the prompt (apparent file
 * subject + enumeration ask).
 */
export function detectReadIntent(text: string): ReadIntent {
  if (!text || text.length === 0) {
    return { detected: false, matchedPatterns: [] };
  }
  const matched: string[] = [];
  for (const { key, re } of READ_VERB_PATTERNS) {
    if (re.test(text)) matched.push(key);
  }
  const hasPath = REPO_PATH_RE.test(text) || PATH_ONLY_RE.test(text);
  // (a) explicit read-verb + path collocation (kan_path / read_path_en).
  const verbWithPath = matched.includes("kan_path") || matched.includes("read_path_en");
  // (b) enumeration ask + a path anywhere in prompt.
  const enumerationAsk = matched.includes("list_n_items_zh") || matched.includes("list_n_items_en");
  const enumerationWithPath = enumerationAsk && hasPath;
  const detected = verbWithPath || enumerationWithPath;
  if (detected && hasPath && !matched.includes("repo_path_present")) {
    matched.push("repo_path_present");
  }
  return { detected, matchedPatterns: matched };
}
