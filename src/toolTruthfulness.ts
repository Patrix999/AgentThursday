/**
 * Tool-Truthfulness Gate.
 *
 * Pure helpers to detect tool-call claims in assistant text and check them
 * against the authoritative `tool.*` event_log entries actually emitted
 * during a submitTask round. When the agent says "I called X" but no
 * `tool.X` event was logged, that's a fabrication — surface it.
 *
 * No SQL, no DO access here — caller passes in the assistant text + the set
 * of tool names that were ACTUALLY dispatched (read by caller from
 * event_log). Keeps this layer testable and side-effect free.
 */

export type ToolClaim = {
  /** The tool name as the agent named it (matched against the known list). */
  tool: string;
  /** Verb category — "called" / "tried" / "claimed-failed". For diagnostics only. */
  verb: "called" | "tried" | "claimed-failed";
  /** Character index in the source text where the claim was found. */
  idx: number;
  /** A short snippet around the claim for the violation log payload. */
  snippet: string;
};

export type TruthfulnessResult = {
  claims: ToolClaim[];
  /** Tool names mentioned in claims but with no matching `tool.<name>` event. */
  fabricated: string[];
  /** Tool names with both a claim and a real event — consistent. */
  consistent: string[];
};

const SNIPPET_HALF = 40;

/**
 * Detect tool-call claims in `text` for any of `knownTools`. Conservative:
 * prefer false-negatives over false-positives. Sentences that explicitly
 * negate the call ("没调", "没有真调用", "did not call", "didn't call") are
 * NOT counted as claims — those are honest self-corrections.
 */
export function findToolClaims(text: string, knownTools: readonly string[]): ToolClaim[] {
  if (!text || knownTools.length === 0) return [];
  const claims: ToolClaim[] = [];
  // Sort by length desc so longer names match first (e.g. `list_memories`
  // before `list`), avoiding partial-name false matches.
  const sortedTools = [...knownTools].sort((a, b) => b.length - a.length);

  for (const tool of sortedTools) {
    // Word-boundary-ish match. Tool names are JS identifiers; allow them to
    // appear with backticks, quotes, or as bare tokens. Avoid matching when
    // the name is part of a longer identifier.
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      // Look at the surrounding sentence for claim/negation cues.
      const winStart = Math.max(0, idx - 120);
      const winEnd = Math.min(text.length, idx + tool.length + 120);
      const window = text.slice(winStart, winEnd);
      if ((isClaim(window) || isTaglineClaim(window)) && !isNegation(window)) {
        claims.push({
          tool,
          verb: classifyVerb(window),
          idx,
          snippet: text.slice(Math.max(0, idx - SNIPPET_HALF), Math.min(text.length, idx + tool.length + SNIPPET_HALF)),
        });
      }
    }
  }
  return claims;
}

/**
 *  Track B — tagline-style claim detection.
 *
 * Some models reply in a "report card" style instead of an explicit verb form,
 * e.g.  `✅ Probe 2 — recall ✅` followed by a `实际返回值：\n```json {...}` block.
 * The verb-keyed `isClaim` heuristic misses these and the gate stays silent
 * even on entirely fabricated returns. This sibling matches the bot's tagline
 * markers when they appear near a known tool name. Still gated by `isNegation`.
 */
function isTaglineClaim(window: string): boolean {
  return /(?:实际返回值|返回如下|raw\s+JSON|tool\s+(?:result|returned)|工具(?:实际)?返回|Probe[^。\n]{0,40}✅|✅[^。\n]{0,40}(?:returned|returns|result))/i.test(window)
    || /```json\b/i.test(window);
}

function isClaim(window: string): boolean {
  // CN: 调(用)了|刚才(真)?调(用)?|尝试调用|试图调用|调用了|...调用失败
  // EN: I called|tried|attempted|invoked|... call failed|tool call failed
  return /(?:刚才[^。\n]{0,8}(?:真)?调(?:用)?了?|调(?:用)?了|尝试调(?:用)?|试图调(?:用)?|调用失败|工具调用失败|调用)/i.test(window)
    || /\b(I\s+(?:called|tried|attempted|invoked|ran|used)|tool\s+call\s+failed|invocation\s+failed)\b/i.test(window);
}

function isNegation(window: string): boolean {
  // CN existing: 没调|没真调|没有调|未调|没有真调用|不会调|没有调用|没真正调用
  // CN self-correction existing: 心算了|错误声称|实际上没调|并未真调|没真正发起|fabricate/编造
  // EN existing: did not call|didn't call|did not invoke|didn't try|claimed but didn't|falsely claimed
  // ──  (2026-04-29) — refusal/meta-claim patterns missed by the
  // existing regex when models say "I won't claim ..." / "在没有 X 的情况
  // 下声称调用了 Y" instead of the simple "我没调用" form. Real saga
  // example ( case 4-bis): SOUL refusal text
  //   "在没有真实 dispatch 的情况下声称调用了 review_project_status"
  // The negation marker "没有" is too far from "调用" for the simple
  // adjacency regex to fire, so the existing path miscategorizes the
  // refusal as a fabricated claim.
  return /(?:没(?:有)?(?:真)?(?:正)?调(?:用)?|未(?:真)?调(?:用)?|没真调|不会调用|没尝试|没真正|心算了|错误声称|并未(?:真)?调|实际上(?:并)?没调|fabricate|编造)/i.test(window)
    // explicit refusal-to-claim verbs ("不能/不会/不要/不可" + "声称/假装/假称/宣称/说我调/说自己调"):
    //   "不能声称我调用了" / "不会假装调用" / "不要声称我执行" / "不可宣称"
    || /不(?:能|会|要|可)\s*(?:声称|假装|假称|宣称|说\s*(?:我|自己)?\s*调)/i.test(window)
    // "并未/没/未 + 执行/运行/发起/做/跑" — covers tool verbs
    // that aren't "调":  "并未执行 X" / "没有运行任何工具" / "未发起 X".
    || /(?:并未|没(?:有)?|未)\s*(?:执行|运行|发起|做|跑)/i.test(window)
    // "声称/假装 + (我/自己?)? + 调" — meta-claim language is
    // almost always refusal/discussion-of-claims, not actual claim. A real
    // fabrication says "我刚才调用了", not "我声称我调用了 X".
    || /(?:声称|假装|假称|宣称)\s*(?:我|自己)?\s*调(?:用)?(?:了|过|过的)?/i.test(window)
    // explicit prohibition leading the sentence:
    //   "禁止...调用" / "拒绝声称调用" / "不允许假装调用".
    || /(?:禁止|拒绝|不允许)[^。\n]{0,60}(?:调|声称|假装)/i.test(window)
    // "在没有/缺乏 (真实)? ... dispatch" English+CN mixed
    // pattern, matches  case 4-bis verbatim shape.
    || /(?:在\s*没有|缺乏|没\s*有)\s*(?:真实|实际|真正)?[^。\n]{0,30}\s*dispatch/i.test(window)
    || /\b(?:did\s*n['o]?t|didn['o]?t|never)\s+(?:call|invoke|run|try|use)\b/i.test(window)
    // EN refusal-to-claim: cannot/won't/will not + claim/say/pretend/assert.
    || /\b(?:cannot|can\s*not|won['o]?t|will\s+not|shall\s+not|must\s+not)\s+(?:claim|say|pretend|assert|state)\b/i.test(window)
    || /\bnot\s+claim\s+(?:that\s+I\s+(?:did|called|ran|invoked)|to\s+have)/i.test(window)
    // EN explicit dispatch denial: "no tool was dispatched" /
    // "no tool dispatched" / "without dispatching".
    || /\bno\s+tool\s+(?:was\s+)?dispatched\b/i.test(window)
    || /\bwithout\s+dispatching\b/i.test(window)
    || /\b(?:falsely|incorrectly|mistakenly)\s+claimed?\b/i.test(window);
}

function classifyVerb(window: string): ToolClaim["verb"] {
  if (/(?:调用失败|失败|错误|error|fail)/i.test(window)) return "claimed-failed";
  if (/(?:尝试|试图|tried|attempted)/i.test(window)) return "tried";
  return "called";
}

/**
 * Compare claims against the set of tools that actually dispatched. A claim
 * with no matching event → fabrication. Returns aggregate verdict.
 */
export function checkTruthfulness(claims: ToolClaim[], actualToolNames: ReadonlySet<string>): TruthfulnessResult {
  const fabricated: string[] = [];
  const consistent: string[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    if (seen.has(c.tool)) continue;
    seen.add(c.tool);
    if (actualToolNames.has(c.tool)) consistent.push(c.tool);
    else fabricated.push(c.tool);
  }
  return { claims, fabricated, consistent };
}

/**
 * Render the user-visible warning line prepended to the reply when fabrication
 * is detected. Short, uniform, easy for reviewers to grep on.
 */
export function renderTruthfulnessWarning(fabricated: string[]): string {
  if (fabricated.length === 0) return "";
  const list = fabricated.map(t => `\`${t}\``).join(", ");
  return `⚠️ Truthfulness gate: this reply claims tool call(s) ${list} were made, but the trace shows no such dispatch. Treat the reported result as unverified.`;
}
