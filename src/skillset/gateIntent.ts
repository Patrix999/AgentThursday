/**
 *  — gate-intent detector and reply finalization guard.
 *
 * When a user prompt clearly requests build/typecheck gate verification,
 * the agent turn must produce corresponding `gate.*` execution evidence,
 * or the final reply must not claim that the gate was run / passed.
 *
 * This module is pure (no SDK / SQL / DO state) so it is trivially
 * testable. The cross-check against actually-dispatched tool ids is
 * done in server.ts using `_currentTaskWrappedToolIds` (the same array
 * used by the rest of the truthfulness path).
 *
 * Only `gate.build` and `gate.typecheck` are recognized — the agent
 * tool surface only exposes these two fixed gate tools (see
 * src/skillset/agentToolBinding.ts), so any other "gate" claim is
 * inherently unsupported regardless of intent.
 */

export interface GateIntent {
  detected: boolean;
  /**
   * Sorted list drawn from `["gate.build", "gate.typecheck"]`. When
   * intent is generic ("跑 gate") both are listed; satisfaction is
   * disjunctive (any one dispatched is enough).
   */
  expectedTools: string[];
  /** Lowercased pattern keys that fired, for inspect / debug. */
  matchedPatterns: string[];
  /** True iff the original detection was generic (any one suffices). */
  generic: boolean;
  /**
   *  (1b) — true iff at least one matched pattern is a
   * verification-question (the user is asking the agent to actually
   * RUN the gate), as opposed to a mention-only literal that just
   * happens to appear in the prompt (e.g. a card title containing
   * the phrase `npm run typecheck`, or harness self-description text
   * containing the substring `跑 gate`).  envelope-claim
   * semantics still key off `detected`; only auto-dispatch is gated
   * on this flag.
   */
  autodispatch: boolean;
}

export interface GateIntentSatisfaction {
  satisfied: boolean;
  missing: string[];
  matched: string[];
}

/**
 *  (1b) — per-pattern `autodispatch` flag.
 *
 * `autodispatch: true`  — pattern indicates the user is *asking the
 *                          agent to run the gate* ("build 还能过？",
 *                          "确认 typecheck", "跑 gate").
 *                          auto-dispatch should fire.
 *
 * `autodispatch: false` — pattern is a *bare mention* of a gate tool
 *                          name or shell command. Common in:
 *                          - card titles / kanban specs that list
 *                            `npm run typecheck` as an acceptance gate
 *                            (but the prompt is "implement Card X",
 *                            not "tell me whether typecheck passes");
 *                          - self-dev retry templates that describe
 *                            harness behavior (`harness 会自动跑 gate`);
 *                          - prose references like `gate.typecheck` /
 *                            `typecheck gate`.
 *                          Detected, listed in expectedTools, used by
 *                          's seal-time fabrication check —
 *                          but no 600s root gate runs unprompted.
 *
 * Aggregated by detectGateIntent via OR: if *any* matched pattern is
 * autodispatch=true, the intent autodispatches. (A prompt that both
 * mentions and verification-asks → verification dominates, correct.)
 */
const BUILD_GATE_PATTERNS: Array<{ key: string; re: RegExp; autodispatch: boolean }> = [
  { key: "build_gate_en", re: /\bbuild\s+gate\b/i, autodispatch: false },
  { key: "gate_dot_build", re: /\bgate\.build\b/i, autodispatch: false },
  { key: "npm_run_build", re: /\bnpm\s+run\s+build(?::web)?\b/i, autodispatch: false },
  { key: "build_haineng_guo", re: /build\s*(?:还能过|能不能过|过得去|过得了|能过吗|过吗|是否通过|通不通过)/i, autodispatch: true },
  { key: "queren_build", re: /(?:确认|验证|查|看|过|跑|跑一下|测一下|测)[\s\S]{0,8}build\s*(?:gate|还能过|能不能过|过|状态|通过|是否通过)/i, autodispatch: true },
];

const TYPECHECK_GATE_PATTERNS: Array<{ key: string; re: RegExp; autodispatch: boolean }> = [
  { key: "typecheck_gate_en", re: /\btypecheck\s+gate\b/i, autodispatch: false },
  { key: "gate_dot_typecheck", re: /\bgate\.typecheck\b/i, autodispatch: false },
  { key: "npm_run_typecheck", re: /\bnpm\s+run\s+typecheck\b/i, autodispatch: false },
  { key: "typecheck_haineng_guo", re: /typecheck\s*(?:还能过|能不能过|过得去|过得了|能过吗|过吗|是否通过|通不通过)/i, autodispatch: true },
  { key: "queren_typecheck", re: /(?:确认|验证|查|看|过|跑|跑一下|测一下|测)[\s\S]{0,8}typecheck\s*(?:gate|还能过|能不能过|过|状态|通过|是否通过)/i, autodispatch: true },
];

const GENERIC_GATE_PATTERNS: Array<{ key: string; re: RegExp; autodispatch: boolean }> = [
  { key: "run_the_gate", re: /\b(?:run|跑|过)[\s\S]{0,4}\bthe\b[\s\S]{0,4}gate\b/i, autodispatch: true },
  { key: "pao_gate", re: /跑[\s\S]{0,3}gate\b/i, autodispatch: true },
  { key: "guo_gate", re: /过[\s\S]{0,3}gate\b/i, autodispatch: true },
  { key: "gate_haineng_guo", re: /\bgate\b[\s\S]{0,5}还能过/i, autodispatch: true },
  { key: "gate_neng_bu_neng_guo", re: /\bgate\b[\s\S]{0,5}能不能过/i, autodispatch: true },
];

export function detectGateIntent(text: string): GateIntent {
  if (!text || text.length === 0) {
    return { detected: false, expectedTools: [], matchedPatterns: [], generic: false, autodispatch: false };
  }
  const matched: string[] = [];
  const expected = new Set<string>();
  let autodispatch = false;
  for (const { key, re, autodispatch: ad } of BUILD_GATE_PATTERNS) {
    if (re.test(text)) { expected.add("gate.build"); matched.push(key); autodispatch = autodispatch || ad; }
  }
  for (const { key, re, autodispatch: ad } of TYPECHECK_GATE_PATTERNS) {
    if (re.test(text)) { expected.add("gate.typecheck"); matched.push(key); autodispatch = autodispatch || ad; }
  }
  let genericFired = false;
  for (const { key, re, autodispatch: ad } of GENERIC_GATE_PATTERNS) {
    if (re.test(text)) { genericFired = true; matched.push(key); autodispatch = autodispatch || ad; }
  }
  if (genericFired && expected.size === 0) {
    expected.add("gate.build");
    expected.add("gate.typecheck");
  }
  if (expected.size === 0) {
    return { detected: false, expectedTools: [], matchedPatterns: matched, generic: false, autodispatch: false };
  }
  const generic = genericFired && expected.size === 2;
  return {
    detected: true,
    expectedTools: [...expected].sort(),
    matchedPatterns: matched,
    generic,
    autodispatch,
  };
}

/**
 * Cross-check `intent.expectedTools` against tool ids actually
 * dispatched during the round. For generic intent (both gate ids
 * listed), satisfaction is disjunctive — any one dispatch is enough.
 * For specific intent, every expected id must appear.
 */
export function checkGateIntentSatisfied(
  intent: GateIntent,
  dispatchedToolIds: ReadonlyArray<string>,
): GateIntentSatisfaction {
  if (!intent.detected) return { satisfied: true, missing: [], matched: [] };
  const dispatched = new Set(dispatchedToolIds);
  const matched = intent.expectedTools.filter(t => dispatched.has(t));
  if (intent.generic) {
    return matched.length > 0
      ? { satisfied: true, missing: [], matched }
      : { satisfied: false, missing: intent.expectedTools, matched: [] };
  }
  const missing = intent.expectedTools.filter(t => !dispatched.has(t));
  return { satisfied: missing.length === 0, missing, matched };
}

/**
 * User-visible warning line prepended to the reply when a gate-intent
 * prompt was not satisfied by an actual `gate.*` dispatch. Short,
 * uniform, easy for reviewers to grep on (mirrors
 * renderTruthfulnessWarning shape).
 */
export function renderGateIntentViolation(missing: string[]): string {
  if (missing.length === 0) return "";
  const list = missing.map(t => `\`${t}\``).join(", ");
  return `⚠️ Gate intent gate: 本轮 prompt 要求验证 ${list}，但 envelope 未记录对应 \`gate.*\` execution。任何关于 gate 通过 / 已跑 gate 的声明请视为未形成 evidence。`;
}

/**
 *  — detect explicit "do not call any tools" directives in a
 * user prompt. Used by the pre-finalize gate-intent dispatch guard to
 * decide whether to auto-dispatch the missing gate. Conservative:
 * matches only direct prohibitions (false negatives are safer than
 * false positives, since a false negative still lets  fail
 * the envelope honestly while a false positive would suppress the
 * auto-dispatch on a prompt where the user actually wanted a real
 * gate run).
 */
const NO_TOOL_PATTERNS: RegExp[] = [
  /不要调用[\s\S]{0,4}工具/,
  /不调用[\s\S]{0,4}工具/,
  /别调用[\s\S]{0,4}工具/,
  /禁止调用[\s\S]{0,4}工具/,
  /不要使用[\s\S]{0,4}工具/,
  /\bdo\s*not\s+call\b[\s\S]{0,16}\btools?\b/i,
  /\bdon'?t\s+call\b[\s\S]{0,16}\btools?\b/i,
  /\bwithout\s+calling\s+(?:any\s+)?tools?\b/i,
  /\bno\s+tool\s+(?:use|calls?)\b/i,
];

export function hasExplicitNoToolDirective(text: string): boolean {
  if (!text) return false;
  return NO_TOOL_PATTERNS.some(re => re.test(text));
}

/**
 *  — honest reply body for the no-tool gate-intent negative
 * path. Used to replace the model's (possibly fabricated) reply body
 * when the user explicitly forbade tool use AND requested gate
 * verification AND no gate was dispatched. The body is plain — Card
 * 200's `renderGateIntentViolation` warning is still prepended on top,
 * and the envelope marker is still appended on the bottom, so the
 * three-layer reply (warning + honest body + marker) replaces a model
 * line like "Build gate 通过了。" deterministically.
 */
export function renderNoToolGateIntentHonestReply(): string {
  return "本轮 prompt 显式禁止调用工具（如 \"不要调用任何工具\"），因此未运行任何 gate；无法验证 build / typecheck 是否通过。";
}

/**
 *  — explicit-no-gate-execution directive.
 *
 * Distinct from `hasExplicitNoToolDirective`: this matches prompts that
 * tell the agent *not to run gates* specifically (or not to run
 * build/typecheck) regardless of whether other tools are permitted.
 * The Discord-directed regression evidence from  showed two
 * failure shapes:
 *
 *   1. `constraint_confirm` prompt forbade *all* tools + asked to skip
 *      `gate.typecheck` → triggered both  warning and
 *      body replacement, hijacking the requested one-line answer.
 *
 *   2. `artifact-read-or-blocked` prompt allowed `artifact.read` but
 *      asked to skip `gate.typecheck` →  auto-dispatched the
 *      gate anyway (which timed out and produced confusing tail text).
 *
 * `hasExplicitNoToolDirective` only handles shape (1). This handles
 * shape (2) and acts as a second escape hatch for shape (1).
 *
 * Conservative by design — false negatives are safer than false
 * positives, because a missed negation leaves the existing Card
 * 200/207c/207d behavior intact (a real coding task that asks for
 * verification is unaffected). The complementary `replyMakesGatePassClaim`
 * fallback prevents over-fire on /207d even when this misses.
 */
const NO_GATE_PATTERNS: RegExp[] = [
  // Direct prohibitions in Chinese — "不要 / 别 / 禁止 / 不需要 / 无需 / 不用 跑 / 执行 / 运行 / 调用 (gate|typecheck|build)".
  /不要[\s\S]{0,6}(?:跑|执行|运行|调用|dispatch|启动)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /别[\s\S]{0,3}(?:跑|执行|运行|调用)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /禁止[\s\S]{0,6}(?:跑|执行|运行|调用)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /不需要[\s\S]{0,4}(?:跑|执行|运行)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /无需[\s\S]{0,4}(?:跑|执行|运行|调用)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /不用[\s\S]{0,4}(?:跑|执行|运行)[\s\S]{0,8}(?:gate|typecheck|build)/i,
  /(?:跳过|略过|忽略)[\s\S]{0,6}(?:gate|typecheck|build)/i,

  // Direct prohibitions in English.
  /\bdo\s*not\s+(?:run|execute|dispatch|call|invoke)[\s\S]{0,16}\b(?:gates?|typecheck|build)\b/i,
  /\bdon'?t\s+(?:run|execute|dispatch|call|invoke)[\s\S]{0,16}\b(?:gates?|typecheck|build)\b/i,
  /\bskip\s+(?:the\s+)?(?:gates?|typecheck|build)\b/i,
  /\bwithout\s+(?:running\s+)?(?:gates?|typecheck|build)\b/i,
  /\bno\s+(?:gates?|typecheck|build)\s+(?:execution|run|exec|dispatch|calls?)\b/i,
  /\bno\s+need\s+to\s+(?:run|execute|dispatch)[\s\S]{0,16}\b(?:gates?|typecheck|build)\b/i,

  // Observation-only mode declarations.
  /\bobservation[\s-]+only\b/i,
  /观察[\s-]?(?:模式|only)/i,
];

export function hasExplicitNoGateDirective(text: string): boolean {
  if (!text) return false;
  return NO_GATE_PATTERNS.some(re => re.test(text));
}

/**
 *  — reply-side detector: does the model's reply *claim* a
 * build/typecheck/gate pass?
 *
 * 's warning and 's body replacement exist to flag a
 * specific failure: the model fabricates "build gate 通过了" without
 * running the gate. When the model's reply doesn't actually make such
 * a claim (e.g. a one-line `constraint_confirm: PASS` observation),
 * the warning/replacement is theatre. This detector gates both call
 * sites so they only fire when there is something to flag.
 *
 * Anchored on `build` / `typecheck` / `gate.<x>` / standalone `gate`
 * tokens combined with explicit pass verbs / states. Generic words like
 * `PASS` or `成功` alone are NOT matches — they appear in legit
 * non-gate contexts (Discord regression confirmations, structured
 * status fields, e.g. `constraint_confirm: PASS`). The anchoring is
 * deliberately tight to avoid suppressing the warning on real coding
 * tasks where the model claims "typecheck PASS" / "build OK".
 */
const REPLY_GATE_PASS_CLAIM_PATTERNS: RegExp[] = [
  // Chinese — "build gate 通过", "typecheck gate 通过", "gate.build 通过", etc.
  /(?:build|typecheck)\s*gate\s*(?:已|都)?(?:通过|过了|过完|过去了|成功|跑过|跑了|跑完)/i,
  /gate\.(?:build|typecheck)\s*(?:已|都)?(?:通过|过了|过完|过去了|成功|跑过|跑了|跑完)/i,
  /(?:跑|执行|运行)了?\s*(?:build|typecheck)\s*gate/i,
  /(?:跑|执行|运行)了?\s*gate\.(?:build|typecheck)/i,
  /(?:已跑|跑过|跑完|执行完|完成)\s*(?:gate\.(?:build|typecheck)|(?:build|typecheck)\s*gate)/i,
  // Chinese — "build/typecheck 通过 / 已通过 / 成功" when paired with an explicit gate-context word.
  /\bgate\b[\s\S]{0,12}(?:通过|过了|成功|没问题|无问题|绿)/i,
  /(?:build|typecheck)\s*(?:已|都)?(?:通过|过了|成功)\s*(?:gate|exit|check)?/i,

  // English — "build gate passed", "gate.typecheck OK", "ran build gate", etc.
  /\b(?:build|typecheck)\s+gate\s+(?:passed|passes|pass|ok|green|succeed(?:ed)?|completed)\b/i,
  /\bgate\.(?:build|typecheck)\s+(?:passed|passes|pass|ok|green|succeed(?:ed)?|completed)\b/i,
  /\bran\s+(?:the\s+)?(?:build|typecheck)\s+gate\b/i,
  /\bran\s+(?:the\s+)?gate\.(?:build|typecheck)\b/i,
  /\b(?:build|typecheck)\s+(?:succeeded|succeeds|passed|passes|completed|finished|ok|green)\b/i,
  /\bgate\s+(?:passed|passes|succeed(?:ed)?|completed|green)\b/i,
];

export function replyMakesGatePassClaim(reply: string): boolean {
  if (!reply) return false;
  return REPLY_GATE_PASS_CLAIM_PATTERNS.some(re => re.test(reply));
}
