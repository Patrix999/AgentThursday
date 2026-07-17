/**
 * prompt-level mutation-intent detector.
 *
 * Companion to `src/skillset/readIntent.ts`  but for the
 * write / delete / edit / patch surface. The motivating failure mode
 * is the an earlier revision retest #1 shape: a prompt like "在 `docs/qa/` 下
 * 创建一个临时文件 `X.md` 然后删掉它" reaches `submitTask.finally`
 * with `totalToolCalls === 0` (model finished with `assistant.parts =
 * [step-start, reasoning, text]` only), yet the visible reply claims
 * the mutation succeeded. The an earlier revision unwrapped-mutation detector
 * doesn't fire because nothing was dispatched at the supplier surface
 * either; the seal collapses to `read_only_no_action_required` and the
 * hallucinated narrative reaches the user with no audit evidence.
 *
 * This module is pure (no SDK / SQL / DO state). The seal contract
 * uses the conjunction `promptMutationIntent && totalToolCalls === 0`
 * to disqualify the read-only-safe short-circuit and emit the
 * dedicated verdict reason `mutation_intent_no_execution`. Precedence
 * in `EvidenceEnvelope.seal`: `mutation_intent_unwrapped_execution`
 * (an earlier revision, stronger — supplier actually dispatched something) >
 * `mutation_intent_no_execution` (this card — zero dispatch) >
 * `read_intent_no_execution`  > generic missing-rings.
 *
 * Design — conservative dual-anchor, same shape as `detectReadIntent`:
 * a pattern fires when a mutation verb co-occurs with a repo-shaped
 * path within a short window. Bare verbs without a path never fire
 * (so casual mentions like "I'd write a doc about this" or
 * "what does delete do?" don't override the reply). False-positive
 * rate is the blocking concern — over-firing breaks normal Q&A.
 */

export interface MutationIntent {
  detected: boolean;
  /** Lowercased pattern keys that fired, for inspect / debug. */
  matchedPatterns: string[];
}

/**
 * Review / verdict framing. When a prompt is a code-REVIEW task, its text is
 * FULL of mutation verbs + paths — because it describes the diff under review
 * ("写 drain-to-self `contextOps.ts`", "删了死 `archiveChunksRemote`") — yet the
 * reviewer correctly calls NO mutating tool. That tripped
 * `mutation_intent_no_execution` on every agentD review reply (2026-07-01, Card
 * 449) and even truncated the output. A review is definitionally read-only; if
 * it also writes (e.g. a report) it dispatches a tool, so `totalToolCalls > 0`
 * and the gate is moot. So: when strong review framing is present, suppress the
 * mutation-intent signal. Markers are intentionally NARROW (review-specific
 * verdict language, not a bare "review") so a real mutation request like
 * "在 `docs/` 创建 `X.md` 然后删掉" — an earlier revision's motivating case — is NOT
 * suppressed and still fires.
 */
const REVIEW_FRAMING_PATTERNS: RegExp[] = [
  /code[\s-]?review/i,
  // CJK has no \w word boundaries, so `\b` around Chinese never anchors — match bare.
  /复核/,
  /评审/,
  /审查代码|代码审查|检视/,
  /\bverdict\b/i,
  /给出?\s*(?:PASS|FAIL)\b/i,
  /判\s*(?:定\s*)?(?:PASS|FAIL)\b/i,
  /\bPASS\s*\/\s*FAIL\b/i,
  /review\s+(?:the\s+)?(?:diff|branch|changes?|pull\s*request|pr|code)\b/i,
];

/** True iff the text carries strong code-review / verdict framing. */
export function hasReviewFraming(text: string): boolean {
  if (!text) return false;
  return REVIEW_FRAMING_PATTERNS.some(re => re.test(text));
}

/**
 * File-path-like token (identical to readIntent.ts). Conservative:
 * must include a path separator or a known repo-source extension,
 * and must not start with a URL scheme.
 */
const REPO_PATH_RE = /(?<![A-Za-z0-9])(?:\.{0,2}\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html)\b/;
const PATH_ONLY_RE = /(?<![A-Za-z0-9/])[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs)\b/;

/**
 * Mutation verb + path collocation patterns. Window is 30 chars so a
 * phrase like "创建一个临时文件 `X.md`" (verb→noun-phrase→backtick→path,
 * ~8 chars between verb and path) still anchors, but a paragraph-long
 * gap between a verb and a path mention does not. Backticks are
 * skipped by the path regex (`[A-Za-z0-9_.-]` excludes `` ` ``).
 *
 * Chinese verb set is intentionally narrow: canonical CJK mutation
 * forms (创建/新建/删除/修改/编辑/写入) plus a few common variants
 * (删掉/改一下/写一行). Single-char `改` is NOT included because it
 * collides with conversational use (e.g. "改进", "改名"); use `修改`
 * or `改一下` instead.
 */
const MUTATION_VERB_PATTERNS: Array<{ key: string; re: RegExp }> = [
  // Chinese — create / write
  { key: "write_path_zh", re: /(?:写入|写一行|写一个|创建|新建|建立|添加|加上|写一份|写)[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // Chinese — delete / remove
  { key: "delete_path_zh", re: /(?:删除|删掉|移除|清除)[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // Chinese — edit / modify / patch
  { key: "edit_path_zh", re: /(?:修改|编辑|改一下|改写|更新|补丁|打补丁)[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // English — create / write
  { key: "write_path_en", re: /\b(?:write|create|add|append)\s+[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // English — delete / remove
  { key: "delete_path_en", re: /\b(?:delete|remove|rm)\s+[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
  // English — edit / modify / patch
  { key: "edit_path_en", re: /\b(?:edit|modify|update|patch)\s+[\s\S]{0,30}(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|sql|sh|py|go|rs|css|html))/i },
];

/**
 * Detect mutation-side intent in a prompt.
 *
 * Anchor: a mutation verb (write/create/delete/edit/patch family)
 * MUST co-occur with a repo-shaped path within a 30-char window.
 * Bare verbs without a path never fire — Q&A about mutation topics
 * stays clean.
 */
export function detectMutationIntent(text: string): MutationIntent {
  if (!text || text.length === 0) {
    return { detected: false, matchedPatterns: [] };
  }
  const matched: string[] = [];
  for (const { key, re } of MUTATION_VERB_PATTERNS) {
    if (re.test(text)) matched.push(key);
  }
  if (matched.length > 0 && (REPO_PATH_RE.test(text) || PATH_ONLY_RE.test(text)) && !matched.includes("repo_path_present")) {
    matched.push("repo_path_present");
  }
  // Review-framing suppression: a code-review prompt is packed with mutation
  // verb+path phrases (describing the diff), but the reviewer calls no mutating
  // tool. Keep the fired verb keys for observability but report NOT detected so
  // `mutation_intent_no_execution` never fires on a review. A real mutation
  // request (no review framing) is unaffected.
  if (matched.length > 0 && hasReviewFraming(text)) {
    return { detected: false, matchedPatterns: [...matched, "suppressed_review_framing"] };
  }
  return { detected: matched.length > 0, matchedPatterns: matched };
}
