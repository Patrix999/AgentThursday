import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTruthfulness,
  decideTruthfulnessRework,
  detectOrchestrationClaim,
  renderTruthfulnessReworkCorrection,
  TRUTHFULNESS_REWORK_SENTINEL,
} from "./toolTruthfulness";

const KNOWN = ["browse", "recall", "remember", "list_memories", "dispatch", "write"] as const;
const set = (...names: string[]) => new Set(names);

// 2026-06-27 — agentD's actual fabricated 5-subagent hygiene report shape.
const FABRICATED_FANOUT = "5 个 subagent 全部建好、任务已派。5 个都返回了。汇总如下：P1 god-class…";

test("clean reply with a consistent claim → no violation", () => {
  const c = classifyTruthfulness("I called `browse` and read the page.", set("browse"), KNOWN);
  assert.equal(c.violation, false);
  assert.equal(c.category, null);
  assert.deepEqual(c.verdict.fabricated, []);
  assert.deepEqual(c.verdict.consistent, ["browse"]);
});

test("fabricated claim (claimed but not dispatched) → fabricated-claim violation", () => {
  const c = classifyTruthfulness("I called `browse` and here is what it returned.", set(), KNOWN);
  assert.equal(c.violation, true);
  assert.equal(c.category, "fabricated-claim");
  assert.deepEqual(c.verdict.fabricated, ["browse"]);
});

test("honest negation is NOT a claim → no violation", () => {
  const c = classifyTruthfulness("I did not call browse; I'm answering from memory.", set(), KNOWN);
  assert.equal(c.violation, false);
});

test("inline fenced json with no claim and no dispatch → inline-json-without-dispatch", () => {
  const text = "Here is the result:\n```json\n{\"ok\": true}\n```";
  const c = classifyTruthfulness(text, set(), KNOWN);
  assert.equal(c.violation, true);
  assert.equal(c.category, "inline-json-without-dispatch");
  assert.equal(c.fencedJsonCount, 1);
  assert.equal(c.inlineJsonWithoutDispatch, true);
});

test("raw tool-call schema in plain text (Kimi mode) → inline-json-without-dispatch", () => {
  const text = 'Calling it now: {"type":"function","name":"browse","arguments":{}}';
  const c = classifyTruthfulness(text, set(), KNOWN);
  assert.equal(c.violation, true);
  assert.equal(c.category, "inline-json-without-dispatch");
  assert.equal(c.rawSchemaCount, 1);
});

test("raw schema naming an UNKNOWN tool is not counted", () => {
  const text = '{"type":"function","name":"not_a_real_tool","arguments":{}}';
  const c = classifyTruthfulness(text, set(), KNOWN);
  assert.equal(c.rawSchemaCount, 0);
  assert.equal(c.violation, false);
});

test("fenced schema does not double-count as raw schema", () => {
  const text = '```json\n{"type":"function","name":"browse"}\n```';
  const c = classifyTruthfulness(text, set(), KNOWN);
  assert.equal(c.fencedJsonCount, 1);
  assert.equal(c.rawSchemaCount, 0, "a schema inside a fenced block is not also a raw schema");
  assert.equal(c.inlineJsonCount, 1);
});

test("inline json IS counted but NOT a violation when a real tool dispatched (size>0)", () => {
  const text = "Result:\n```json\n{\"ok\":true}\n```";
  const c = classifyTruthfulness(text, set("browse"), KNOWN);
  assert.equal(c.inlineJsonWithoutDispatch, false, "a real dispatch means the json is a legit echo");
  assert.equal(c.violation, false);
});

test("fabricated-claim takes category precedence over inline-json", () => {
  const text = "I called `recall`.\n```json\n{\"x\":1}\n```";
  const c = classifyTruthfulness(text, set(), KNOWN);
  assert.equal(c.violation, true);
  assert.equal(c.category, "fabricated-claim", "a fabricated claim is the primary category");
});

test("dispatchedToolNames is sorted + deduped from the actual set", () => {
  const c = classifyTruthfulness("done", set("write", "browse", "browse"), KNOWN);
  assert.deepEqual(c.dispatchedToolNames, ["browse", "write"]);
});

test("rework gate discriminator: pure fabrication has an empty actual set", () => {
  // The loop reworks ONLY when no real tool fired — this is the size===0 case.
  const c = classifyTruthfulness("I ran `dispatch`.", set(), KNOWN);
  assert.equal(c.violation, true);
  assert.equal(c.dispatchedToolNames.length, 0, "no real tool → safe to rework (nothing to re-fire)");
});

test("mixed-tool fabrication has a non-empty actual set → loop must fall back to warn", () => {
  const c = classifyTruthfulness("I ran `dispatch` and `browse`.", set("dispatch"), KNOWN);
  assert.equal(c.violation, true, "browse claimed but not dispatched → fabricated");
  assert.deepEqual(c.verdict.fabricated, ["browse"]);
  assert.ok(c.dispatchedToolNames.length > 0, "a real tool fired → must NOT rework (non-idempotent)");
});

// --- orchestration-fabrication (2026-06-27) ---

test("orchestration claim + no orchestration tool dispatched → fabricated-orchestration", () => {
  const c = classifyTruthfulness(FABRICATED_FANOUT, set(), KNOWN, false);
  assert.equal(c.violation, true);
  assert.equal(c.category, "fabricated-orchestration");
  assert.equal(c.orchestrationFabricated, true);
});

test("orchestration claim + orchestration tool DID dispatch → no violation", () => {
  // The real patch-verify turn: claimed a subagent AND dispatched agent_create.
  const c = classifyTruthfulness("Subagent 建好了。派任务。Subagent 返回了。", set("manager"), KNOWN, true);
  assert.equal(c.violation, false);
  assert.equal(c.orchestrationFabricated, false);
});

test("orchestration param omitted (legacy callers) → never flags orchestration", () => {
  const c = classifyTruthfulness(FABRICATED_FANOUT, set(), KNOWN);
  assert.equal(c.orchestrationFabricated, false);
  assert.equal(c.violation, false);
});

test("rework safety: fabricated orchestration with no real tool → rework path", () => {
  const c = classifyTruthfulness(FABRICATED_FANOUT, set(), KNOWN, false);
  const action = decideTruthfulnessRework({ replyEmpty: false, violation: c.violation, dispatchedRealTool: c.dispatchedToolNames.length !== 0 });
  assert.equal(action, "rework");
});

test("fabricated orchestration but an unrelated real tool fired → warn-fallback (no rework)", () => {
  const c = classifyTruthfulness(FABRICATED_FANOUT, set("browse"), KNOWN, false);
  assert.equal(c.violation, true);
  const action = decideTruthfulnessRework({ replyEmpty: false, violation: c.violation, dispatchedRealTool: c.dispatchedToolNames.length !== 0 });
  assert.equal(action, "warn-fallback");
});

test("named-tool fabrication takes category precedence over orchestration", () => {
  const c = classifyTruthfulness(`I called \`browse\`. ${FABRICATED_FANOUT}`, set(), KNOWN, false);
  assert.equal(c.category, "fabricated-claim");
});

test("orchestration correction names the orchestration tools + the two fixes", () => {
  const c = classifyTruthfulness(FABRICATED_FANOUT, set(), KNOWN, false);
  const msg = renderTruthfulnessReworkCorrection(c);
  assert.ok(/agent_create|workflow_execute/.test(msg), "names the orchestration tools");
  assert.ok(/Actually dispatch/i.test(msg) && /Rewrite/i.test(msg), "offers both fixes");
});

test("detectOrchestrationClaim: future intent / generic / negation / cross-turn are NOT claims", () => {
  assert.equal(detectOrchestrationClaim("我准备建 5 个 subagent 来跑这个任务"), false, "future intent");
  assert.equal(detectOrchestrationClaim("a subagent will return the result"), false, "future EN");
  assert.equal(detectOrchestrationClaim("没有建任何 subagent，直接答的"), false, "negation");
  assert.equal(detectOrchestrationClaim("刚才那 5 个 subagent 返回的结果是这样的"), false, "cross-turn reference, no completion particle");
  assert.equal(detectOrchestrationClaim(FABRICATED_FANOUT), true, "real completed fan-out claim");
});

// --- rework decision (the loop's safety logic, pure) ---

test("decide: violation + no real tool → rework", () => {
  assert.equal(decideTruthfulnessRework({ replyEmpty: false, violation: true, dispatchedRealTool: false }), "rework");
});

test("decide: violation + real tool dispatched → warn-fallback (never rework — non-idempotent)", () => {
  assert.equal(decideTruthfulnessRework({ replyEmpty: false, violation: true, dispatchedRealTool: true }), "warn-fallback");
});

test("decide: no violation → clean", () => {
  assert.equal(decideTruthfulnessRework({ replyEmpty: false, violation: false, dispatchedRealTool: false }), "clean");
});

test("decide: empty reply → skip (regardless of other flags)", () => {
  assert.equal(decideTruthfulnessRework({ replyEmpty: true, violation: true, dispatchedRealTool: false }), "skip");
});

test("decide: only 'rework' reworks — every other action stops the loop", () => {
  const actions = [
    decideTruthfulnessRework({ replyEmpty: true, violation: true, dispatchedRealTool: false }),
    decideTruthfulnessRework({ replyEmpty: false, violation: false, dispatchedRealTool: false }),
    decideTruthfulnessRework({ replyEmpty: false, violation: true, dispatchedRealTool: true }),
  ];
  assert.ok(actions.every((a) => a !== "rework"), "no non-pure-fabrication state may trigger a re-run");
});

// --- corrective message ---

test("correction names the fabricated tools + the two allowed fixes", () => {
  const c = classifyTruthfulness("I called `browse`.", set(), KNOWN);
  const msg = renderTruthfulnessReworkCorrection(c);
  assert.ok(msg.includes("`browse`"), "names the specific fabricated tool");
  assert.ok(/Actually call/i.test(msg) && /Rewrite/i.test(msg), "offers both fixes");
});

test("correction for inline-json case mentions the fake JSON, not a tool name", () => {
  const c = classifyTruthfulness("```json\n{\"ok\":true}\n```", set(), KNOWN);
  assert.equal(c.category, "inline-json-without-dispatch");
  const msg = renderTruthfulnessReworkCorrection(c);
  assert.ok(/JSON/i.test(msg));
});

test("sentinel is distinctive enough not to collide with real user prose", () => {
  assert.ok(TRUTHFULNESS_REWORK_SENTINEL.startsWith("[[agentthursday:"));
  assert.ok(!"I called browse and it worked".startsWith(TRUTHFULNESS_REWORK_SENTINEL));
});
