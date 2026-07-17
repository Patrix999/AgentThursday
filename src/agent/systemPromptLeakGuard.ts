/**
 * System-prompt leak guard — output-side backstop that blocks a user-visible
 * reply which dumps the agent's system prompt (the SOUL) near-verbatim.
 *
 * This is the NARROW half of a two-layer defense:
 *   - The SOUL's "系统提示保密规则" instruction is the BROAD defense — it makes
 *     the model decline to reveal / paraphrase / translate / summarize its
 *     instructions across the common attack shapes.
 *   - This detector catches exactly ONE residual: a near-verbatim dump
 *     ("repeat everything above"). It does NOT catch translation, base64 /
 *     spacing encodings, summarization, or sub-`minRun` fragments — that's the
 *     instruction's job. Treat the pair as defense-in-depth, not a complete seal.
 *
 * Pure / node-importable (no `cloudflare:workers`) so it is unit-testable —
 * `server.ts` imports it; the established repo split for testable logic.
 */

export type PromptLeakGuardMode = "off" | "log-only" | "block";

/** Mirror of `AGENT_THURSDAY_TRUTHFULNESS_GATE` resolution. Default (unset) → block. */
export function resolvePromptLeakGuardMode(raw: string | undefined): PromptLeakGuardMode {
  return raw === "off" ? "off" : raw === "log-only" ? "log-only" : "block";
}

/**
 * Collapse all whitespace and lowercase so reformatting / re-spacing / case
 * changes don't let a verbatim dump evade the scan. (Does not defeat real
 * encodings — those are the instruction's job, per the file header.)
 */
export function normalizeForLeakScan(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

export interface LeakScanResult {
  leaked: boolean;
  matchedRunLen: number;
}

/**
 * True iff `reply` contains a contiguous run of >= `minRun` normalized chars
 * that also appears in any of `secrets`. `minRun = 28` ≈ a full clause; a
 * coincidental 28-char verbatim overlap with the SOUL by a normal reply is
 * implausible, so false positives are very low. Builds the secret n-gram set
 * each call — trivial at SOUL size (a few KB); deliberately NO cached instance
 * state (avoids the DO-field-stomp footgun).
 */
export function detectSystemPromptLeak(
  reply: string,
  secrets: string[],
  minRun = 28,
): LeakScanResult {
  const nr = normalizeForLeakScan(reply);
  if (nr.length < minRun) return { leaked: false, matchedRunLen: 0 };
  const grams = new Set<string>();
  for (const secret of secrets) {
    const ns = normalizeForLeakScan(secret);
    for (let i = 0; i + minRun <= ns.length; i++) grams.add(ns.slice(i, i + minRun));
  }
  if (grams.size === 0) return { leaked: false, matchedRunLen: 0 };
  for (let i = 0; i + minRun <= nr.length; i++) {
    if (grams.has(nr.slice(i, i + minRun))) return { leaked: true, matchedRunLen: minRun };
  }
  return { leaked: false, matchedRunLen: 0 };
}

/**
 * User-facing refusal that REPLACES a leaking reply wholesale (the reply was
 * dumping the prompt — safer to refuse than to partially redact and risk
 * leaving fragments). Product language is English (Agent Thursday).
 */
export function renderSystemPromptRefusal(): string {
  return "I can't share my system prompt or internal instructions. I'm happy to help with whatever you're working on, though — what would you like to do?";
}
