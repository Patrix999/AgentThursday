/**
 *  / 202a — strip leaked thinking-family tag residue from
 * user-visible reply.
 *
 * Some model paths emit `<think>...</think>` (or its `<thinking>`
 * sibling) reasoning fragments into the assistant text channel.
 *  verifier saw `直接跑 gate：</think>直接跑 gate：`. Card
 * 202 verifier saw `前缀</thinking>后缀`. Both are reasoning syntax;
 * users should not see either.
 *
 * Scope (intentionally narrow):
 *   - Strip paired `<think>...</think>` and `<thinking>...</thinking>`
 *     blocks (content + tags). Mixed pairs (`<think>...</thinking>`
 *     or vice versa) are also stripped — the reasoning content
 *     INSIDE such a block is by definition reasoning; removing it
 *     is the safer default.
 *   - Strip orphan `<think>` / `</think>` / `<thinking>` /
 *     `</thinking>` tokens that survive pairing (residue from a
 *     partially-streamed block, or from the model echoing a tag-
 *     like literal verbatim per a forced prompt).
 *   - Do NOT match unrelated `<think-...>`-prefixed names such as
 *     `<think-block>` or `<think-element>`, nor unrelated tags
 *     like `<thoughtful>` or `<section>`. This is not a general
 *     HTML sanitizer and must not delete unrelated content.
 *
 * Boundary: the regex requires the character immediately after
 * `<think>` / `<thinking>` (i.e. after the optional `ing` suffix
 * inside the tag-name) to be one of `[\s>/]`. That keeps:
 *   - `<think>`        → match  (next char `>`)
 *   - `<thinking>`     → match  (next char `>`)
 *   - `<think foo="x">` → match  (next char ` `)
 *   - `<think/>`       → match  (next char `/`)
 *   - `<think-block>`  → NO match (next char `-`)
 *   - `<thoughtful>`   → NO match (does not start with `<think`)
 *
 * Pure function. No SDK / SQL / DO state. Trivially testable.
 */

const PAIRED_THINK_BLOCK = /<think(?:ing)?(?=[\s>/])[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi;
const ORPHAN_THINK_TAG = /<\/?think(?:ing)?(?=[\s>/])[^>]*>/gi;

export function stripThinkingTagsFromReply(text: string): string {
  if (!text) return text;
  let out = text.replace(PAIRED_THINK_BLOCK, "");
  out = out.replace(ORPHAN_THINK_TAG, "");
  return out;
}
