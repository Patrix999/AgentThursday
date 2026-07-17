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
 * an earlier revision Track B — tagline-style claim detection.
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
  // ── an earlier revision (2026-04-29) — refusal/meta-claim patterns missed by the
  // existing regex when models say "I won't claim ..." / "在没有 X 的情况
  // 下声称调用了 Y" instead of the simple "我没调用" form. Real saga
  // example (an earlier revision case 4-bis): SOUL refusal text
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
    // pattern, matches an earlier revision case 4-bis verbatim shape.
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
 * 2026-06-27 — the orchestration-dispatch tools that PROVE a multi-subagent /
 * workflow fan-out actually happened. When a (manager) reply narrates a
 * completed fan-out ("建了 5 个 subagent，全部返回了") but NONE of these dispatched
 * in the round, the orchestration was fabricated — the failure mode the operator hit when
 * agentD reported a 5-subagent hygiene fan-out it never ran (0 workflow-run, 0
 * subagent created, 0 file reads). Caller computes `orchestrationDispatched` from
 * the same `tool.*` event_log the rest of the gate uses.
 */
export const ORCHESTRATION_DISPATCH_TOOL_IDS: readonly string[] = [
  "manager.agent_create",
  "manager.agent_message",
  "manager.workflow_execute",
  "manager.workflow_run_named",
];

// An orchestration noun adjacent to a COMPLETION marker, not negated → the reply
// claims a fan-out finished. Conservative (prefer false-negatives): the completion
// markers require a done-particle (了/好/完/已/全部/都 or an English past-tense verb),
// so future intent ("准备建 subagent") and bare description ("subagent 返回的结果",
// "a subagent will return") do NOT match. NOTE (v1 limitation): this catches TOTAL
// fabrication (0 orchestration tools dispatched); it does NOT catch under-count
// ("ran 1, claimed 5") because one real dispatch flips orchestrationDispatched true.
const ORCH_NOUN = "(?:subagents?|sub-agents?|子代理|fan[\\s-]?out|workflow)";
const ORCH_DONE = "(?:建好|建了|创建好?了|建立好?了|已(?:经)?(?:建|创建|派|分派)|派(?:发)?了|已派|分派了|返回了|都返回|全部返回|全部建好|跑完|跑好了|执行完|执行了|完成了|spawned|dispatched|created|launched|ran|executed|returned|finished|completed|came\\s+back)";

/**
 * Does `text` claim a COMPLETED subagent/workflow orchestration? Scans a small
 * window around each orchestration noun for a completion marker, skipping windows
 * the existing `isNegation` covers ("没建 subagent" / "did not spawn").
 */
export function detectOrchestrationClaim(text: string): boolean {
  if (!text) return false;
  const nounRe = new RegExp(ORCH_NOUN, "gi");
  const doneRe = new RegExp(ORCH_DONE, "i");
  let m: RegExpExecArray | null;
  while ((m = nounRe.exec(text)) !== null) {
    const idx = m.index;
    const window = text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + m[0].length + 60));
    if (isNegation(window)) continue;
    if (doneRe.test(window)) return true;
  }
  return false;
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

export type TruthfulnessClassification = {
  verdict: TruthfulnessResult;
  /** Tool names actually dispatched this round, sorted — for the violation payload. */
  dispatchedToolNames: string[];
  fencedJsonCount: number;
  rawSchemaCount: number;
  inlineJsonCount: number;
  /** Inline tool-call JSON with no claim AND no real dispatch — a fabricated result. */
  inlineJsonWithoutDispatch: boolean;
  /** Reply narrates a completed subagent/workflow fan-out but no orchestration tool dispatched. */
  orchestrationFabricated: boolean;
  /** True when the reply should be gated (fabricated claim OR inline-json OR fabricated orchestration). */
  violation: boolean;
  category: "fabricated-claim" | "fabricated-orchestration" | "inline-json-without-dispatch" | null;
};

/**
 * M9.4 (2026-06-25) — the side-effect-free CORE of the truthfulness gate.
 *
 * Given the assistant `text`, the set of tools that ACTUALLY dispatched this
 * round (read by the caller from event_log), and the known tool list, return the
 * full classification: fabricated-claim detection (`checkTruthfulness`) PLUS
 * inline-JSON-without-dispatch detection (fenced ```json blocks + raw
 * `{"type":"function","name":...}` schema outside fences). Extracted verbatim
 * from `applyTruthfulnessGate` so both the gate (warn/log) AND the rework loop
 * (the operator: "让 agent 返工，直到符合要求") share one detection contract — and so the
 * regex/category logic is unit-testable without a DO. No logging, no state.
 */
export function classifyTruthfulness(
  text: string,
  actualToolNames: ReadonlySet<string>,
  knownTools: readonly string[],
  // 2026-06-27 — whether any ORCHESTRATION_DISPATCH_TOOL_IDS fired this round
  // (caller reads it from the same event_log). Optional + checked `=== false` so
  // omitting it (existing callers/tests) never flags an orchestration violation.
  orchestrationDispatched?: boolean,
): TruthfulnessClassification {
  const claims = findToolClaims(text, knownTools);

  // an earlier revision Track B-4 — fenced ```json blocks: a model emitting a tool result
  // as text without dispatching is fabricating outside the tool-call frame.
  const fencedJsonCount = (text.match(/```json\b/gi) ?? []).length;
  // M7.6 v3 — raw tool-call schema JSON in plain text (Kimi sporadically emits
  // `{"type":"function","name":"<known-tool>",...}` instead of a structured call).
  // Counted OUTSIDE fenced blocks so a fenced schema doesn't double-count.
  let rawSchemaCount = 0;
  {
    const textWithoutFencedJson = text.replace(/```json\b[\s\S]*?```/gi, "");
    const re = /"\s*type\s*"\s*:\s*"\s*function\s*"[\s\S]{0,160}?"\s*name\s*"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g;
    let m: RegExpExecArray | null;
    const knownSet = new Set<string>(knownTools);
    while ((m = re.exec(textWithoutFencedJson)) !== null) {
      if (knownSet.has(m[1])) rawSchemaCount += 1;
    }
  }
  const inlineJsonCount = fencedJsonCount + rawSchemaCount;

  const verdict = checkTruthfulness(claims, actualToolNames);
  const inlineJsonWithoutDispatch =
    inlineJsonCount > 0 && actualToolNames.size === 0 && claims.length === 0;
  const orchestrationFabricated =
    orchestrationDispatched === false && detectOrchestrationClaim(text);
  const violation = verdict.fabricated.length > 0 || inlineJsonWithoutDispatch || orchestrationFabricated;
  // Precedence: a named-tool fabrication is the most specific; orchestration
  // fabrication next; bare inline-JSON last.
  const category: TruthfulnessClassification["category"] = !violation
    ? null
    : verdict.fabricated.length > 0
      ? "fabricated-claim"
      : orchestrationFabricated
        ? "fabricated-orchestration"
        : "inline-json-without-dispatch";

  return {
    verdict,
    dispatchedToolNames: [...actualToolNames].sort(),
    fencedJsonCount,
    rawSchemaCount,
    inlineJsonCount,
    inlineJsonWithoutDispatch,
    orchestrationFabricated,
    violation,
    category,
  };
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

/**
 * M7.6 v3 (2026-04-30) — render the user-visible warning when the
 * assistant emits tool-call-shaped JSON in plain text (fenced ```json
 * block or raw `{"type":"function","name":...}` schema) but no real
 * tool dispatch event was logged in the round. Distinct from the
 * fabricated-claim wording because the failure mode is "the model
 * produced a tool-call schema as text instead of invoking it" —
 * caught after live observation of Kimi sporadically dropping into
 * that mode.
 */
export function renderInlineJsonWarning(): string {
  return `⚠️ Truthfulness gate: this reply emits tool-call-shaped JSON inline but the trace shows no actual tool dispatch. The assistant likely produced a tool-call schema as text instead of invoking it. Treat the reply as unverified.`;
}

/**
 * 2026-06-27 — render the user-visible warning when the reply narrates a
 * completed subagent/workflow fan-out but the trace shows no orchestration tool
 * (`agent_create` / `agent_message` / `workflow_execute` / `workflow_run_named`)
 * dispatched this round. Caught after agentD reported a 5-subagent code-hygiene
 * fan-out it never executed (no workflow-run, no subagent created, no file read).
 */
export function renderOrchestrationFabricationWarning(): string {
  return `⚠️ Truthfulness gate: this reply describes running subagents / a workflow fan-out, but the trace shows no orchestration tool (agent_create / agent_message / workflow_execute) was dispatched this turn. The reported sub-results are unverified — treat them as not produced.`;
}

/**
 * M9.4 (2026-06-25) — sentinel that prefixes a rework CORRECTION message
 * injected into the dialog. The model must read the correction, but it's an
 * internal reprimand, not real user input — so `getDialogTurns` skips any user
 * message starting with this marker, keeping synthetic corrections out of Track
 * M memory consolidation. Must be distinctive enough not to collide with real
 * user text.
 */
export const TRUTHFULNESS_REWORK_SENTINEL = "[[agentthursday:truthfulness-rework]]";

export type TruthfulnessReworkAction = "rework" | "clean" | "warn-fallback" | "skip";

/**
 * M9.4 — the pure per-iteration decision of the rework loop, extracted so the
 * SAFETY invariant is unit-testable without a DO/model. Given the current
 * attempt's state:
 *   - `skip`          — empty reply, nothing to judge → stop the loop.
 *   - `clean`         — no violation → stop, surface the reply as-is.
 *   - `warn-fallback` — violation BUT a real tool dispatched this attempt; the
 *                       turn touched the world, so re-running could re-fire a
 *                       non-idempotent action — stop and let the warn-append run.
 *   - `rework`        — violation AND no real tool dispatched → safe to re-run.
 * The loop reworks ONLY on `rework`; every other action breaks. Budget + gate
 * mode are enforced by the loop around this (not here).
 */
export function decideTruthfulnessRework(args: {
  replyEmpty: boolean;
  violation: boolean;
  dispatchedRealTool: boolean;
}): TruthfulnessReworkAction {
  if (args.replyEmpty) return "skip";
  if (!args.violation) return "clean";
  if (args.dispatchedRealTool) return "warn-fallback";
  return "rework";
}

/**
 * M9.4 — the corrective instruction fed back to the model when a turn fabricated
 * a tool claim / inline-json result WITHOUT dispatching any real tool (the operator: "让
 * agent 返工，直到给出符合要求的结果"). Tells it exactly what was wrong and the two
 * acceptable fixes (actually call the tool, or drop the claim), then to reply
 * again. Only used on the safe `size===0` path, so re-running can't re-fire any
 * real side-effecting tool.
 */
export function renderTruthfulnessReworkCorrection(c: TruthfulnessClassification): string {
  if (c.category === "fabricated-claim" && c.verdict.fabricated.length > 0) {
    const list = c.verdict.fabricated.map(t => `\`${t}\``).join(", ");
    return (
      `Your previous reply states you used tool(s) ${list}, but no such tool call was actually dispatched this turn. ` +
      `That is not allowed — never claim a tool ran unless it actually ran.\n` +
      `Do ONE of these, then send the corrected reply:\n` +
      `1. Actually call ${list} now (if you genuinely need the result), then answer from the real result; OR\n` +
      `2. Rewrite your answer so it makes no claim that any tool was used.`
    );
  }
  if (c.category === "fabricated-orchestration") {
    return (
      `Your previous reply describes running subagents or a workflow fan-out (e.g. "created N subagents", "all returned"), ` +
      `but no orchestration tool (agent_create / agent_message / workflow_execute / workflow_run_named) was dispatched this turn. ` +
      `That is not allowed — never report sub-agent results you did not actually produce.\n` +
      `Do ONE of these, then send the corrected reply:\n` +
      `1. Actually dispatch the subagents / workflow now via the real tools, then report only their real results; OR\n` +
      `2. Rewrite your answer so it makes no claim that any subagent or workflow ran.`
    );
  }
  return (
    `Your previous reply contains tool-call-shaped JSON in the text, but no tool was actually dispatched this turn. ` +
    `Emitting a fake tool result is not allowed.\n` +
    `Either call the tool properly so a real result comes back, or remove the JSON and answer plainly — then send the corrected reply.`
  );
}

/**
 * Manager-tier truthfulness drift watched list.
 *
 * Layered on top of (NOT folded into) `KNOWN_TOOL_NAMES`. Keeping it
 * separate keeps an earlier revision behavior byte-identical for non-manager
 * flows and lets the manager-tier drift gate widen scope independently.
 *
 * Includes every canonical `manager.*` adapter currently registered
 * (kept in sync by the adapter-coverage guard in
 * `managerTruthfulnessDrift.test.ts`) plus the two workspace-write claim
 * verbs called out by ADR §7 — these are the verbs a manager reply would
 * use to claim file mutations that never actually happened in the same
 * turn trace.
 */
export const MANAGER_TIER_WATCHED_TOOL_NAMES: readonly string[] = [
  "manager.agent_create",
  "manager.agent_list",
  "manager.agent_message",
  "manager.agent_update",
  "manager.skillset_create",
  "manager.skillset_list",
  "manager.skillset_read",
  "manager.skillset_update",
  "manager.subagent_summaries",
  "manager.schedule_create",
  "manager.schedule_list",
  "manager.schedule_cancel",
  "manager.task_merge",
  "manager.task_complete",
  // agent-side workflow executor entry + run-tree read.
  "manager.workflow_execute",
  "manager.workflow_status",
  // named workflow store.
  "manager.workflow_save",
  "manager.workflow_list",
  "manager.workflow_run_named",
  "write",
  "edit",
];

export type ManagerTruthfulnessDriftPayload = {
  claimed_tool_ids: string[];
  observed_tool_ids: string[];
  missing_claims: string[];
  extra_observed: string[];
  has_drift: boolean;
};

/**
 * manager-tier truthfulness drift compute.
 *
 * Pure helper: given the manager reply text, the watched-tool list, and
 * the set of tool ids actually dispatched in the same turn, return the
 * drift payload. `missing_claims` is the load-bearing field — these are
 * watched tools the reply claims but the trace does not show.
 *
 * Conventions:
 *   - `claimed_tool_ids` and `observed_tool_ids` are sorted, de-duped
 *     intersections of the watched list with the reply / event_log.
 *   - `extra_observed` is dispatched-but-not-claimed; reported for
 *     observability symmetry but is NOT a drift signal on its own.
 *   - `has_drift === missing_claims.length > 0`. Reply mutation /
 *     blocking is the caller's choice; this helper is observation-only.
 *
 * Reuses `findToolClaims` so claim-detection semantics (negation +
 * tagline + identifier boundary) stay aligned with an earlier revision.
 */
export function computeManagerTruthfulnessDrift(
  replyText: string,
  watchedTools: readonly string[],
  observedToolIds: ReadonlySet<string>,
): ManagerTruthfulnessDriftPayload {
  const watchedSet = new Set(watchedTools);
  const claims = findToolClaims(replyText, watchedTools);
  const claimedSet = new Set<string>();
  for (const c of claims) claimedSet.add(c.tool);

  const observedWatched = new Set<string>();
  for (const id of observedToolIds) {
    if (watchedSet.has(id)) observedWatched.add(id);
  }

  const missing: string[] = [];
  for (const t of claimedSet) {
    if (!observedWatched.has(t)) missing.push(t);
  }
  const extra: string[] = [];
  for (const t of observedWatched) {
    if (!claimedSet.has(t)) extra.push(t);
  }

  const claimed_tool_ids = [...claimedSet].sort();
  const observed_tool_ids = [...observedWatched].sort();
  missing.sort();
  extra.sort();

  return {
    claimed_tool_ids,
    observed_tool_ids,
    missing_claims: missing,
    extra_observed: extra,
    has_drift: missing.length > 0,
  };
}
