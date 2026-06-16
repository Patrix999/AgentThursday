//  Step 10/11 — helper-only extraction of submitTask() phases A-S.
// Pure deciders/builders; no DO/this/IO access. Composition lives in
// server.ts `submitTask()`; this module is the byte-equivalent decision
// surface that submitTask() consults at each phase boundary.
//
//  preflight (``)
// maps submitTask() into 19 phases A-S. Helpers landed via:
//   -  (phase A — resume-intent short-circuit) `decideResumeShortCircuit`
//   -  (phase B/C — task identity + turn-scope reset)
//       `decideTaskIdentity`, `buildTurnScopeResetPatch`
//   -  (seal options derivation) `deriveSubmitTaskSealOpts`
//   -  (phase R reply assembly chain) `applyReplyAssemblyChain`
//   -  (phase Q prompt-intent guards)
//       `buildPromptIntentGuardDecision`, `buildVisibleReplySafetyDecision`
//   -  (phase S gate-intent autodispatch plan)
//       `buildGateIntentAutodispatchPlan`
//
// What this module owns now (exported decision/build helpers):
//   1. `decideResumeShortCircuit` — phase A; awaiting-resume bounce vs continue.
//   2. `decideTaskIdentity` — phase B; `source` / `isResubmit` / `taskObject`.
//   3. `buildTurnScopeResetPatch` — phase C; turn-scope state to clear at start.
//   4. `deriveSubmitTaskSealOpts` — derives envelope seal options.
//   5. `applyReplyAssemblyChain` — phase R; visible reply build (read-intent
//      fallback, mutation-intent fallback, mutation-unwrapped prepend, remember-ack).
//   6. `buildPromptIntentGuardDecision` — phase Q; intent gate before dispatch.
//   7. `buildVisibleReplySafetyDecision` — visible-reply pre-finalize safety.
//   8. `buildGateIntentAutodispatchPlan` — phase S; gate-intent triggered autodispatch.
//
// What stays in server.ts (per /305 preflight):
//   - `submitTask()` composition: orchestrates all helpers, owns saveMessages,
//     envelope CRUD calls, dispatch, `_currentTask*` state mutation, audit events.
//   - `_finalizeTaskTurn` and reply finalization (per  preflight verdict).
//   - DO-bound RPC handlers and CF Agents `@callable()` surfaces.
//
// Byte-equivalent contracts preserved across helpers:
//   - Phase A: `loop.pause.awaiting_resume` event name + payload field names
//     (`taskId`, `userTextPreview`); `userTextPreview = display.slice(0, 80)`;
//     paused result.taskId fallback `"paused"` while
//     renderAwaitingResumeMessage argument fallback is `null` — asymmetric in
//     pre-extraction source, MUST stay asymmetric.
//   - Phase A: explicit resume detection uses `isResumeIntent(display)`.
//   - Phase B: `source = task === dogfoodTask ? "dogfood" : "human"`;
//     `isResubmit = !!(prevTaskObj && prevTaskObj.title === display.slice(0, 120))`.
//   - Per-helper §Behavior contracts blocks are anchored at each Card-comment
//     block below; do not coalesce or paraphrase them.

import type { TaskObject } from "../types";
import { isResumeIntent, renderAwaitingResumeMessage } from "../pauseDecision";
import { emptySupplierTaskSignals, type SupplierTaskSignals } from "../supplierSignal";
import type {
  RememberAckFallbackInput,
  RememberAckFallbackResult,
  MutationIntentNoExecutionReplyInput,
  ReadIntentNoExecutionReplyInput,
  MutationUnwrappedPrependInput,
} from "../replyEmptyFallback";
import type { GateIntent, GateIntentSatisfaction } from "../skillset/gateIntent";
import type { ReadIntent } from "../skillset/readIntent";
import type { MutationIntent } from "../skillset/mutationIntent";
import { SUPPLIER_MUTATION_TOOL_NAMES } from "./envelopeOps";

export interface SubmitTaskResult {
  ok: boolean;
  taskId: string;
  loopTriggered: boolean;
  replyText: string;
  envelopeId: string | null;
}

export interface ResumeShortCircuitInput {
  display: string;
  waitingForHuman: boolean;
  prevTaskObj: TaskObject | null | undefined;
}

export type ResumeShortCircuitDecision =
  | {
      paused: true;
      result: SubmitTaskResult;
      logPayload: { taskId: string | null; userTextPreview: string };
    }
  | {
      paused: false;
      isExplicitResume: boolean;
    };

export function decideResumeShortCircuit(
  input: ResumeShortCircuitInput,
): ResumeShortCircuitDecision {
  const { display, waitingForHuman, prevTaskObj } = input;
  const isExplicitResume = waitingForHuman && isResumeIntent(display);
  if (waitingForHuman && !isExplicitResume) {
    return {
      paused: true,
      result: {
        ok: true,
        taskId: prevTaskObj?.id ?? "paused",
        loopTriggered: false,
        replyText: renderAwaitingResumeMessage(prevTaskObj?.id ?? null),
        envelopeId: null,
      },
      logPayload: {
        taskId: prevTaskObj?.id ?? null,
        userTextPreview: display.slice(0, 80),
      },
    };
  }
  return { paused: false, isExplicitResume };
}

//  Step 10  — helper-only extraction of submitTask() phase B
// (task identity decision) and phase C (turn-scope state reset).
//
// Phase B byte-equivalent contract ( §Behavior contracts):
//   - `source`: `task === dogfoodTask ? "dogfood" : "human"`.
//   - `isResubmit`: `!!(prevTaskObj && prevTaskObj.title === display.slice(0, 120))`.
//   - `taskObject` three branches:
//       1. explicit resume + prev → clone prev, status:"active", updatedAt: now;
//       2. resubmit → clone prev, status:"active", updatedAt: now;
//       3. new → makeTaskObject(display, source) (delegated to caller so
//          server.ts retains exclusive ownership of `task-${Date.now()}`
//          id minting + the inner Date.now() call points).
//   - `nextTaskTitle`: explicit-resume + prev → prevTaskObj.title; otherwise display.
//   - `nextStatePatchKind` signals the orchestrator's nextState branch:
//     "resume-or-resubmit" preserves `lastActionResult`; "new-task" sets
//     `lastActionResult: null`.
//
// `now` is supplied by the caller so the helper does not call `Date.now()`
// directly — that keeps the helper deterministic for smokes and lets the
// orchestrator share its `Date.now()` reading across the taskObject and
// the state patch's `updatedAt`.

export interface TaskIdentityInput {
  display: string;
  task: string;
  dogfoodTask: string;
  isExplicitResume: boolean;
  prevTaskObj: TaskObject | null | undefined;
  now: number;
  makeTaskObject: (display: string, source: TaskObject["source"]) => TaskObject;
}

export interface TaskIdentityDecision {
  source: TaskObject["source"];
  isResubmit: boolean;
  taskObject: TaskObject;
  nextTaskTitle: string;
  nextStatePatchKind: "resume-or-resubmit" | "new-task";
}

export function decideTaskIdentity(input: TaskIdentityInput): TaskIdentityDecision {
  const { display, task, dogfoodTask, isExplicitResume, prevTaskObj, now, makeTaskObject } = input;
  const source: TaskObject["source"] = task === dogfoodTask ? "dogfood" : "human";
  const isResubmit = !!(prevTaskObj && prevTaskObj.title === display.slice(0, 120));
  const taskObject: TaskObject = isExplicitResume && prevTaskObj
    ? { ...prevTaskObj, status: "active", updatedAt: now }
    : isResubmit && prevTaskObj
      ? { ...prevTaskObj, status: "active", updatedAt: now }
      : makeTaskObject(display, source);
  const nextTaskTitle = isExplicitResume && prevTaskObj ? prevTaskObj.title : display;
  const nextStatePatchKind: "resume-or-resubmit" | "new-task" =
    isExplicitResume || isResubmit ? "resume-or-resubmit" : "new-task";
  return { source, isResubmit, taskObject, nextTaskTitle, nextStatePatchKind };
}

// Phase C byte-equivalent contract:
//   - Exactly three slots reset; no more, no fewer.
//   - `supplierSignals`: fresh `emptySupplierTaskSignals()` (NOT a shared
//     reference —  collector mutates `.steps` and `.streamTruncatedSeen`).
//   - `truthfulnessVerdict`: `{ violationSeen: false, category: null }`.
//   - `rememberAck`: `null`.
//
// Returned as a plain object so the orchestrator destructures and assigns
// to its three private slots; this keeps the position in submitTask()
// (after task state setup, before envelope draft / saveMessages) stable.

export interface TurnScopeResetPatch {
  supplierSignals: SupplierTaskSignals;
  truthfulnessVerdict: { violationSeen: false; category: null };
  rememberAck: null;
}

export function buildTurnScopeResetPatch(): TurnScopeResetPatch {
  return {
    supplierSignals: emptySupplierTaskSignals(),
    truthfulnessVerdict: { violationSeen: false, category: null },
    rememberAck: null,
  };
}

//  Step 10  — helper-only extraction of submitTask() phase S
// finally-block seal derivation. Computes the read-only-safe 6-flag AND,
// dispatch counts, and `_finalizeTaskTurn` opts. Pure: no `this`/IO/await.
//
// Byte-equivalent contract ( §Behavior contracts):
//   - `wrappedDispatchCount = wrappedToolIds.length` (NOT deduped —
//     counts every dispatch including duplicate ids).
//   - `totalSupplierToolCalls = sum(supplierSignals.steps[*].toolCallCount)`.
//   - `promptMutationIntentNoExecution =
//        promptMutationIntentDetectedForSeal && totalSupplierToolCalls === 0`.
//   - `readOnlySafe` is the 6-flag AND:
//       1. !promptGateIntentDetectedForSeal
//       2. !replyGateIntentDetectedForSeal
//       3. !promptReadIntentDetectedForSeal
//       4. !mutationIntentObservedUnwrapped
//       5. !promptMutationIntentNoExecution
//       6. wrappedDispatchCount === 0
//   - `finalizeOpts.claimedTools = Array.from(new Set(wrappedToolIds)).sort()`.
//   - `finalizeOpts.source` = literal string `"submitTask.finally"`.
//   - `finalizeOpts.readIntentObserved = promptReadIntentDetectedForSeal`.
//   - `finalizeOpts.mutationIntentObservedUnwrapped` threaded as-is.
//   - `finalizeOpts.mutationIntentNoExecution = promptMutationIntentNoExecution`.
//
// The `envelopeId` guard (`if (envelopeId) { ... }`), the fail-soft
// try/catch around `_finalizeTaskTurn`, the `submitTask.seal.error` event,
// and the `_currentEnvelopeId` / `_currentTaskWrappedToolIds` reset all
// stay in the orchestrator — this helper only computes the seal opts.

export interface SealOptsInput {
  taskId: string;
  envelopeId: string;
  wrappedToolIds: ReadonlyArray<string>;
  supplierSignals: SupplierTaskSignals;
  promptGateIntentDetectedForSeal: boolean;
  replyGateIntentDetectedForSeal: boolean;
  promptReadIntentDetectedForSeal: boolean;
  mutationIntentObservedUnwrapped: boolean;
  promptMutationIntentDetectedForSeal: boolean;
}

export interface SealOptsDecision {
  wrappedDispatchCount: number;
  totalSupplierToolCalls: number;
  promptMutationIntentNoExecution: boolean;
  finalizeOpts: {
    taskId: string;
    envelopeId: string;
    source: "submitTask.finally";
    claimedTools: string[];
    readOnlySafe: boolean;
    readIntentObserved: boolean;
    mutationIntentObservedUnwrapped: boolean;
    mutationIntentNoExecution: boolean;
    //  C — mutation-tools-expected flag forwarded to seal(). True
    // whenever the prompt's mutation intent fired; the stronger
    // `missing_mutation_evidence` reason then fires whenever no
    // `repo.write` / `repo.patch` call landed in the execution ring.
    mutationToolsExpected: boolean;
  };
}

export function deriveSubmitTaskSealOpts(input: SealOptsInput): SealOptsDecision {
  const wrappedDispatchCount = input.wrappedToolIds.length;
  const totalSupplierToolCalls = input.supplierSignals.steps.reduce(
    (n, s) => n + s.toolCallCount,
    0,
  );
  const promptMutationIntentNoExecution =
    input.promptMutationIntentDetectedForSeal && totalSupplierToolCalls === 0;
  const readOnlySafe =
    !input.promptGateIntentDetectedForSeal &&
    !input.replyGateIntentDetectedForSeal &&
    !input.promptReadIntentDetectedForSeal &&
    !input.mutationIntentObservedUnwrapped &&
    !promptMutationIntentNoExecution &&
    !input.promptMutationIntentDetectedForSeal &&
    wrappedDispatchCount === 0;
  return {
    wrappedDispatchCount,
    totalSupplierToolCalls,
    promptMutationIntentNoExecution,
    finalizeOpts: {
      taskId: input.taskId,
      envelopeId: input.envelopeId,
      source: "submitTask.finally",
      claimedTools: Array.from(new Set(input.wrappedToolIds)).sort(),
      readOnlySafe,
      readIntentObserved: input.promptReadIntentDetectedForSeal,
      mutationIntentObservedUnwrapped: input.mutationIntentObservedUnwrapped,
      mutationIntentNoExecution: promptMutationIntentNoExecution,
      mutationToolsExpected: input.promptMutationIntentDetectedForSeal,
    },
  };
}

//  Step 11  — phase H reply assembly chain helper. Sequences
// the three reply-mutating steps that run between raw model output and
// the user-visible reply:
//
//   1. truthfulness gate    ( + 108a — claim-vs-event check; may
//                             also set _currentTaskTruthfulnessVerdict as a
//                             side effect inside the host callback)
//   2. supplier degradation marker ( — prepend ⚠️ when the
//                             per-turn supplier signal collector reports
//                             degradation)
//   3. remember-ack fallback  ( — when reply is empty/whitespace
//                             and a `remember` ack is present, surface
//                             the ack as the visible reply)
//
// Order is load-bearing: supplier marker must sit ABOVE truthfulness
// marker so reviewers see broad pipeline-degradation context before the
// specific claim-vs-event line; remember-ack fallback runs LAST so a
// non-empty reply produced by the gates is never overridden by an ack.
//
// Host injection contract: every IO/this-touching step is passed in as a
// callback. The helper itself has no `this`, no `await`, no `logEvent`,
// no `setAgentThursdayState`, no `_finalizeTaskTurn`. Verdict threading
// (`_currentTaskTruthfulnessVerdict`) stays owned by the orchestrator —
// it lives inside `applyTruthfulnessGate` which the orchestrator binds
// to `this` before passing in.

export interface ReplyAssemblyChainInput {
  rawReplyText: string;
  rememberAck: string | null | undefined;
  applyTruthfulnessGate: (text: string) => string;
  applySupplierDegradationMarker: (text: string) => string;
  applyRememberAckFallback: (
    input: RememberAckFallbackInput,
  ) => RememberAckFallbackResult;
}

export interface ReplyAssemblyChainResult {
  replyText: string;
  rememberAckApplied: boolean;
}

export function applyReplyAssemblyChain(
  input: ReplyAssemblyChainInput,
): ReplyAssemblyChainResult {
  const gatedReplyText = input.applyTruthfulnessGate(input.rawReplyText);
  const supplierMarkedReplyText = input.applySupplierDegradationMarker(gatedReplyText);
  const fallback = input.applyRememberAckFallback({
    replyText: supplierMarkedReplyText,
    rememberAck: input.rememberAck,
  });
  return {
    replyText: fallback.replyText,
    rememberAckApplied: fallback.fallbackApplied,
  };
}

//  Step 11  — prompt-side intent guard decision helper.
// Combines  (gate-intent reply finalization guard),
//  (read-intent detection), and  (mutation-intent
// detection) into a single decision builder. Output is a decision
// record + a deferred-event list; orchestrator owns logEvent, outer
// fail-soft catch, outer seal flag assignment, and replyText
// assignment.
//
// Helper invariants:
//   - no `this`, no `await`, no `logEvent`, no `setAgentThursdayState`, no
//     `_finalizeTaskTurn`.
//   - detection source is `display` (the human-visible prompt); the
//     orchestrator threads this in. Same input as resume-intent
//     semantics.
//   - read-intent and mutation-intent detection are each wrapped in
//     an internal fail-soft try/catch so a regex glitch in one
//     detector does not block the other (mirror of pre-extraction
//     source; the two siblings are independent of each other and
//     independent of gate-intent).
//   - gate detector throw propagates: the orchestrator's outer
//     try/catch handles it (matching pre-extraction behavior where
//     a thrown gate detector caused the whole guard block to fail
//     soft, leaving all three flags at their default false).
//   - dispatchedToolIds = Array.from(new Set(wrappedToolIds)) — does
//     NOT sort (matches  source; sort happens only for the
//     phase-S seal opts via  helper).
//   - : warning is only prepended when
//     `replyMakesGatePassClaim(replyText)` is true; otherwise the
//     warning_suppressed event is emitted instead and replyText is
//     untouched.

export type PromptIntentGuardEvent =
  | {
      type: "tool.read_intent.detected";
      payload: { taskId: string; matchedPatterns: string[] };
    }
  | {
      type: "tool.mutation_intent.detected";
      payload: { taskId: string; matchedPatterns: string[] };
    }
  | {
      type: "tool.gate_intent.violation";
      payload: {
        taskId: string;
        expectedTools: string[];
        matchedPatterns: string[];
        dispatchedToolIds: string[];
        missing: string[];
        generic: boolean;
      };
    }
  | {
      type: "tool.gate_intent.warning_suppressed";
      payload: {
        taskId: string;
        expectedTools: string[];
        matchedPatterns: string[];
        dispatchedToolIds: string[];
        missing: string[];
        generic: boolean;
        reason: "reply_no_gate_pass_claim";
      };
    }
  | {
      type: "tool.gate_intent.satisfied";
      payload: {
        taskId: string;
        expectedTools: string[];
        matchedPatterns: string[];
        matched: string[];
        generic: boolean;
      };
    };

export interface PromptIntentGuardInput {
  display: string;
  replyText: string;
  taskId: string;
  wrappedToolIds: string[];
  detectGateIntent: (text: string) => GateIntent;
  detectReadIntent: (text: string) => ReadIntent;
  detectMutationIntent: (text: string) => MutationIntent;
  checkGateIntentSatisfied: (
    gateIntent: GateIntent,
    dispatched: readonly string[],
  ) => GateIntentSatisfaction;
  replyMakesGatePassClaim: (reply: string) => boolean;
  renderGateIntentViolation: (missing: string[]) => string;
}

export interface PromptIntentGuardDecision {
  replyText: string;
  promptGateIntentDetectedForSeal: boolean;
  promptReadIntentDetectedForSeal: boolean;
  promptMutationIntentDetectedForSeal: boolean;
  promptMutationIntentMatchedPatterns: string[];
  events: PromptIntentGuardEvent[];
}

export function buildPromptIntentGuardDecision(
  input: PromptIntentGuardInput,
): PromptIntentGuardDecision {
  const events: PromptIntentGuardEvent[] = [];
  let replyText = input.replyText;
  let promptGateIntentDetectedForSeal = false;
  let promptReadIntentDetectedForSeal = false;
  let promptMutationIntentDetectedForSeal = false;
  let promptMutationIntentMatchedPatterns: string[] = [];

  //  — gate-intent detection. Throw here propagates so the
  // orchestrator's outer catch swallows everything (matching pre-
  // extraction behavior).
  const gateIntent = input.detectGateIntent(input.display);
  promptGateIntentDetectedForSeal = gateIntent.detected;

  //  — read-intent (independent of gate; sibling fail-soft).
  try {
    const readIntent = input.detectReadIntent(input.display);
    promptReadIntentDetectedForSeal = readIntent.detected;
    if (readIntent.detected) {
      events.push({
        type: "tool.read_intent.detected",
        payload: {
          taskId: input.taskId,
          matchedPatterns: readIntent.matchedPatterns,
        },
      });
    }
  } catch { /* fail-soft: read-intent regex glitch */ }

  //  — mutation-intent (independent of gate and read).
  try {
    const mutationIntent = input.detectMutationIntent(input.display);
    promptMutationIntentDetectedForSeal = mutationIntent.detected;
    promptMutationIntentMatchedPatterns = mutationIntent.matchedPatterns;
    if (mutationIntent.detected) {
      events.push({
        type: "tool.mutation_intent.detected",
        payload: {
          taskId: input.taskId,
          matchedPatterns: mutationIntent.matchedPatterns,
        },
      });
    }
  } catch { /* fail-soft: mutation-intent regex glitch */ }

  if (gateIntent.detected) {
    const dispatched = Array.from(new Set(input.wrappedToolIds));
    const sat = input.checkGateIntentSatisfied(gateIntent, dispatched);
    if (!sat.satisfied) {
      //  — only prepend the warning when the reply actually
      // claims the gate passed without dispatch. Otherwise emit
      // warning_suppressed and leave replyText alone.
      if (input.replyMakesGatePassClaim(replyText)) {
        const warning = input.renderGateIntentViolation(sat.missing);
        replyText = replyText && replyText.trim().length > 0
          ? `${warning}\n\n${replyText}`
          : warning;
        events.push({
          type: "tool.gate_intent.violation",
          payload: {
            taskId: input.taskId,
            expectedTools: gateIntent.expectedTools,
            matchedPatterns: gateIntent.matchedPatterns,
            dispatchedToolIds: dispatched,
            missing: sat.missing,
            generic: gateIntent.generic,
          },
        });
      } else {
        events.push({
          type: "tool.gate_intent.warning_suppressed",
          payload: {
            taskId: input.taskId,
            expectedTools: gateIntent.expectedTools,
            matchedPatterns: gateIntent.matchedPatterns,
            dispatchedToolIds: dispatched,
            missing: sat.missing,
            generic: gateIntent.generic,
            reason: "reply_no_gate_pass_claim",
          },
        });
      }
    } else {
      events.push({
        type: "tool.gate_intent.satisfied",
        payload: {
          taskId: input.taskId,
          expectedTools: gateIntent.expectedTools,
          matchedPatterns: gateIntent.matchedPatterns,
          matched: sat.matched,
          generic: gateIntent.generic,
        },
      });
    }
  }

  return {
    replyText,
    promptGateIntentDetectedForSeal,
    promptReadIntentDetectedForSeal,
    promptMutationIntentDetectedForSeal,
    promptMutationIntentMatchedPatterns,
    events,
  };
}

//  Step 11  — visible reply safety helper.
//
// Extracts the /e visible-recovery override and the
// unwrapped-mutation prepend from submitTask() into one pure decision.
// Helper returns the final `replyText`, the `mutationIntentObservedUnwrapped`
// flag (consumed downstream by `deriveSubmitTaskSealOpts`), and a list of
// deferred events. Orchestrator iterates `events` and wraps each
// `this.logEvent(...)` call in its own fail-soft try/catch (mirrors
// pre-extraction per-emit isolation).
//
// Byte-equivalent contracts ( §Behavior contracts):
//   - 295b/e visible override
//       * `totalToolCallsForOverride = supplierSignals.steps.reduce(
//           (n, s) => n + s.toolCallCount, 0)`
//       * mutation override priority: `if mutation ... else if read ...`
//         (mutually exclusive; never both)
//       * override requires `envelopeId` truthy
//       * mutation condition: `promptMutationIntentDetectedForSeal &&
//         totalToolCallsForOverride === 0`
//       * read condition: `promptReadIntentDetectedForSeal &&
//         totalToolCallsForOverride === 0`
//       * `partialText = replyText ?? ""` snapshot taken inside each branch
//       * events:
//         - `task.reply.mutation_intent_no_execution_fallback` payload
//           `{ taskId, envelopeId, matchedPatterns, partialReplyLen }`
//         - `task.reply.read_intent_no_execution_fallback` payload
//           `{ taskId, envelopeId, partialReplyLen }`
//   - 295d unwrapped-mutation prepend
//       * observed mutation names sourced from
//         `supplierSignals.steps[].toolCallNames`
//       * membership via `SUPPLIER_MUTATION_TOOL_NAMES`
//       * `observedMutationToolNames = Array.from(new Set(...)).sort()`
//         (dedupe AND lexicographic sort)
//       * `wrappedMutationCovered = wrappedToolIds.some(id =>
//         id === "repo.write" || id === "repo.delete")`
//       * `mutationIntentObservedUnwrapped = observedMutationToolNames
//         .length > 0 && !wrappedMutationCovered` (computed ALWAYS,
//         not gated by envelopeId — downstream seal seeks it)
//       * prepend requires `envelopeId && mutationIntentObservedUnwrapped`
//       * `modelReply = replyText ?? ""` snapshot taken before prepend
//       * event `task.reply.mutation_unwrapped_prepend` payload
//         `{ taskId, envelopeId, mutationTools, modelReplyLen }`
//   - Order: 295b/e override first, then 295d prepend. Note 295e
//     (mutation override) and 295d (unwrapped prepend) are partition-
//     exclusive on `totalToolCallsForOverride` (295e requires 0, 295d
//     requires observed mutation tools i.e. count > 0), but 295b (read
//     override) and 295d CAN co-fire when the prompt was read-intent
//     AND the supplier dispatched an unwrapped mutation tool.

export interface VisibleReplySafetyInput {
  replyText: string;
  envelopeId: string | null;
  taskId: string;
  promptReadIntentDetectedForSeal: boolean;
  promptMutationIntentDetectedForSeal: boolean;
  promptMutationIntentMatchedPatterns: string[];
  supplierSignals: SupplierTaskSignals;
  wrappedToolIds: string[];
  renderMutationIntentNoExecutionReply: (
    input: MutationIntentNoExecutionReplyInput,
  ) => string;
  renderReadIntentNoExecutionReply: (
    input: ReadIntentNoExecutionReplyInput,
  ) => string;
  renderMutationUnwrappedPrependWarning: (
    input: MutationUnwrappedPrependInput,
  ) => string;
}

export type VisibleReplySafetyEvent =
  | {
      type: "task.reply.mutation_intent_no_execution_fallback";
      payload: {
        taskId: string;
        envelopeId: string;
        matchedPatterns: string[];
        partialReplyLen: number;
      };
    }
  | {
      type: "task.reply.read_intent_no_execution_fallback";
      payload: {
        taskId: string;
        envelopeId: string;
        partialReplyLen: number;
      };
    }
  | {
      type: "task.reply.mutation_unwrapped_prepend";
      payload: {
        taskId: string;
        envelopeId: string;
        mutationTools: string[];
        modelReplyLen: number;
      };
    };

export interface VisibleReplySafetyDecision {
  replyText: string;
  mutationIntentObservedUnwrapped: boolean;
  events: VisibleReplySafetyEvent[];
}

export function buildVisibleReplySafetyDecision(
  input: VisibleReplySafetyInput,
): VisibleReplySafetyDecision {
  const {
    envelopeId,
    taskId,
    promptReadIntentDetectedForSeal,
    promptMutationIntentDetectedForSeal,
    promptMutationIntentMatchedPatterns,
    supplierSignals,
    wrappedToolIds,
    renderMutationIntentNoExecutionReply,
    renderReadIntentNoExecutionReply,
    renderMutationUnwrappedPrependWarning,
  } = input;

  let replyText = input.replyText;
  const events: VisibleReplySafetyEvent[] = [];

  const totalToolCallsForOverride = supplierSignals.steps.reduce(
    (n, s) => n + s.toolCallCount,
    0,
  );

  if (
    envelopeId &&
    promptMutationIntentDetectedForSeal &&
    totalToolCallsForOverride === 0
  ) {
    const partialText = replyText ?? "";
    replyText = renderMutationIntentNoExecutionReply({
      envelopeId,
      taskId,
      matchedPatterns: promptMutationIntentMatchedPatterns,
      partialText,
    });
    events.push({
      type: "task.reply.mutation_intent_no_execution_fallback",
      payload: {
        taskId,
        envelopeId,
        matchedPatterns: promptMutationIntentMatchedPatterns,
        partialReplyLen: partialText.length,
      },
    });
  } else if (
    envelopeId &&
    promptReadIntentDetectedForSeal &&
    totalToolCallsForOverride === 0
  ) {
    const partialText = replyText ?? "";
    replyText = renderReadIntentNoExecutionReply({
      envelopeId,
      taskId,
      partialText,
    });
    events.push({
      type: "task.reply.read_intent_no_execution_fallback",
      payload: {
        taskId,
        envelopeId,
        partialReplyLen: partialText.length,
      },
    });
  }

  const seen = new Set<string>();
  for (const step of supplierSignals.steps) {
    for (const name of step.toolCallNames ?? []) {
      if (typeof name === "string" && SUPPLIER_MUTATION_TOOL_NAMES.has(name)) {
        seen.add(name);
      }
    }
  }
  const observedMutationToolNames = Array.from(seen).sort();
  const wrappedMutationCovered = wrappedToolIds.some(
    (id) => id === "repo.write" || id === "repo.delete",
  );
  const mutationIntentObservedUnwrapped =
    observedMutationToolNames.length > 0 && !wrappedMutationCovered;

  if (envelopeId && mutationIntentObservedUnwrapped) {
    const modelReply = replyText ?? "";
    replyText = renderMutationUnwrappedPrependWarning({
      envelopeId,
      taskId,
      mutationTools: observedMutationToolNames,
      modelReply,
    });
    events.push({
      type: "task.reply.mutation_unwrapped_prepend",
      payload: {
        taskId,
        envelopeId,
        mutationTools: observedMutationToolNames,
        modelReplyLen: modelReply.length,
      },
    });
  }

  return {
    replyText,
    mutationIntentObservedUnwrapped,
    events,
  };
}

//  Step 12  —  pre-finalize positive gate-intent
// autodispatch guard. Helper-only decision/plan extraction. Orchestrator
// retains all host-owned side effects:
//   - outer try/catch + `tool.gate_intent.guard.error` log
//   - `this.logEvent(...)` for every event
//   - `await this.devShellGateRun({ target })`
//   - `await recordGateExecution(...)` +  pinned envelope/task
//     capture before the long await
//   - `_currentTaskWrappedToolIds` / `_pinnedWrappedToolIdsByTask`
//     mutation, `tool.gate_intent.autodispatch.pinned_attribution`,
//     `evidence.envelope.add_execution_skipped`
//   - `tool.gate_intent.autodispatch.success` / `.error`
//   - final replyText note assignment
//
// Byte-equivalent contracts ( §Behavior contracts):
//   - Detection source remains `display`.
//   - `detectGateIntent(display)` throw propagates so the orchestrator's
//     outer catch logs `tool.gate_intent.guard.error`.
//   - `dispatched = Array.from(new Set(wrappedToolIds))` — dedupe only,
//     NOT sorted (matches  source).
//   - `checkGateIntentSatisfied(intent, dispatched)` semantics unchanged.
//   - If `sat.satisfied` → `kind: "none"`, no events, replyText untouched.
//   - Skip branches (each emit guard.skipped FIRST, then any extra event):
//       * noTool with `replyMakesGatePassClaim(replyText)` true:
//           guard.skipped reason `explicit_no_tool_directive` →
//           replyText replaced via `renderNoToolGateIntentHonestReply()` →
//           `tool.gate_intent.no_tool_reply.replaced`
//       * noTool with no pass-claim:
//           guard.skipped reason `explicit_no_tool_directive` →
//           `tool.gate_intent.no_tool_reply.skipped` reason
//           `reply_no_gate_pass_claim`; replyText untouched
//       * explicit no-gate directive:
//           guard.skipped reason `explicit_no_gate_directive`
//       * mention-only (`!promptIntent.autodispatch`):
//           guard.skipped reason `mention_only_no_autodispatch`
//   - Run-gate branch (`kind: "run_gate"`):
//       * Target: `const missing0 = sat.missing[0] ?? "gate.build";
//         target = missing0 === "gate.typecheck" ? "typecheck" : "build"`
//       * `startEvent` carries `tool.gate_intent.autodispatch.start`
//         payload exactly. Orchestrator logs it BEFORE the long await.
//       * `replyText` is returned unchanged in the plan; orchestrator
//         appends the success/failure note after the gate completes.

export type GateAutodispatchSkipEvent =
  | {
      type: "tool.gate_intent.guard.skipped";
      payload: {
        taskId: string;
        envelopeId: string | null;
        reason:
          | "explicit_no_tool_directive"
          | "explicit_no_gate_directive"
          | "mention_only_no_autodispatch";
        expectedTools: string[];
        matchedPatterns: string[];
      };
    }
  | {
      type: "tool.gate_intent.no_tool_reply.replaced";
      payload: {
        taskId: string;
        envelopeId: string | null;
        expectedTools: string[];
      };
    }
  | {
      type: "tool.gate_intent.no_tool_reply.skipped";
      payload: {
        taskId: string;
        envelopeId: string | null;
        reason: "reply_no_gate_pass_claim";
        expectedTools: string[];
      };
    };

export type GateAutodispatchStartEvent = {
  type: "tool.gate_intent.autodispatch.start";
  payload: {
    taskId: string;
    envelopeId: string | null;
    target: "build" | "typecheck";
    expectedTools: string[];
    missing: string[];
    matchedPatterns: string[];
  };
};

export type GateAutodispatchPlan =
  | { kind: "none"; replyText: string; events: [] }
  | { kind: "skip_no_tool"; replyText: string; events: GateAutodispatchSkipEvent[] }
  | { kind: "skip_no_gate"; replyText: string; events: GateAutodispatchSkipEvent[] }
  | { kind: "skip_mention_only"; replyText: string; events: GateAutodispatchSkipEvent[] }
  | {
      kind: "run_gate";
      replyText: string;
      target: "build" | "typecheck";
      missing: string[];
      matchedPatterns: string[];
      expectedTools: string[];
      startEvent: GateAutodispatchStartEvent;
    };

export interface GateAutodispatchPlanInput {
  display: string;
  replyText: string;
  taskId: string;
  envelopeId: string | null;
  wrappedToolIds: string[];
  detectGateIntent: (text: string) => GateIntent;
  hasExplicitNoToolDirective: (text: string) => boolean;
  hasExplicitNoGateDirective: (text: string) => boolean;
  checkGateIntentSatisfied: (
    gateIntent: GateIntent,
    dispatched: readonly string[],
  ) => GateIntentSatisfaction;
  replyMakesGatePassClaim: (reply: string) => boolean;
  renderNoToolGateIntentHonestReply: () => string;
}

export function buildGateIntentAutodispatchPlan(
  input: GateAutodispatchPlanInput,
): GateAutodispatchPlan {
  const {
    display,
    taskId,
    envelopeId,
    wrappedToolIds,
    detectGateIntent,
    hasExplicitNoToolDirective,
    hasExplicitNoGateDirective,
    checkGateIntentSatisfied,
    replyMakesGatePassClaim,
    renderNoToolGateIntentHonestReply,
  } = input;
  let replyText = input.replyText;

  // detectGateIntent throw propagates to orchestrator outer catch (
  // precedent). The orchestrator logs `tool.gate_intent.guard.error` there.
  const promptIntent = detectGateIntent(display);
  if (!promptIntent.detected) {
    return { kind: "none", replyText, events: [] };
  }

  const noTool = hasExplicitNoToolDirective(display);
  const dispatched = Array.from(new Set(wrappedToolIds));
  const sat = checkGateIntentSatisfied(promptIntent, dispatched);

  if (sat.satisfied) {
    // Model already dispatched — nothing for the guard to do.
    return { kind: "none", replyText, events: [] };
  }

  if (noTool) {
    const events: GateAutodispatchSkipEvent[] = [];
    events.push({
      type: "tool.gate_intent.guard.skipped",
      payload: {
        taskId,
        envelopeId,
        reason: "explicit_no_tool_directive",
        expectedTools: promptIntent.expectedTools,
        matchedPatterns: promptIntent.matchedPatterns,
      },
    });
    if (replyMakesGatePassClaim(replyText)) {
      replyText = renderNoToolGateIntentHonestReply();
      events.push({
        type: "tool.gate_intent.no_tool_reply.replaced",
        payload: {
          taskId,
          envelopeId,
          expectedTools: promptIntent.expectedTools,
        },
      });
    } else {
      events.push({
        type: "tool.gate_intent.no_tool_reply.skipped",
        payload: {
          taskId,
          envelopeId,
          reason: "reply_no_gate_pass_claim",
          expectedTools: promptIntent.expectedTools,
        },
      });
    }
    return { kind: "skip_no_tool", replyText, events };
  }

  if (hasExplicitNoGateDirective(display)) {
    return {
      kind: "skip_no_gate",
      replyText,
      events: [
        {
          type: "tool.gate_intent.guard.skipped",
          payload: {
            taskId,
            envelopeId,
            reason: "explicit_no_gate_directive",
            expectedTools: promptIntent.expectedTools,
            matchedPatterns: promptIntent.matchedPatterns,
          },
        },
      ],
    };
  }

  if (!promptIntent.autodispatch) {
    return {
      kind: "skip_mention_only",
      replyText,
      events: [
        {
          type: "tool.gate_intent.guard.skipped",
          payload: {
            taskId,
            envelopeId,
            reason: "mention_only_no_autodispatch",
            expectedTools: promptIntent.expectedTools,
            matchedPatterns: promptIntent.matchedPatterns,
          },
        },
      ],
    };
  }

  // Run-gate branch. Target selection mirrors src/server.ts:1860-1861.
  const missing0 = sat.missing[0] ?? "gate.build";
  const target: "build" | "typecheck" =
    missing0 === "gate.typecheck" ? "typecheck" : "build";
  return {
    kind: "run_gate",
    replyText,
    target,
    missing: sat.missing,
    matchedPatterns: promptIntent.matchedPatterns,
    expectedTools: promptIntent.expectedTools,
    startEvent: {
      type: "tool.gate_intent.autodispatch.start",
      payload: {
        taskId,
        envelopeId,
        target,
        expectedTools: promptIntent.expectedTools,
        missing: sat.missing,
        matchedPatterns: promptIntent.matchedPatterns,
      },
    },
  };
}

// ──  — dangling-intent detection ────────────────────────────
// RCA  (task-mq7rv2gt):
// a reply that ANNOUNCES an action ("我来访问…：" / "let me …:") while
// the whole task dispatched zero wrapped tools is a silent
// fake-complete — the channel sees the announcement, the task is
// `completed`, and no follow-up will ever come. The truthfulness gate
// doesn't cover this (no false claim about a PAST call). Detection is
// deliberately conservative: the terminal-colon signature matched both
// observed prod incidents; broad announce-phrase matching is excluded
// to avoid flagging legitimate text-only answers.
export interface DanglingIntentInput {
  display: string;
  replyText: string;
  wrappedToolCount: number;
  hasExplicitNoToolDirective: (text: string) => boolean;
}

export interface DanglingIntentDecision {
  detected: boolean;
  matched_pattern: string | null;
}

// Announcement must LEAD the reply (first 30 chars): real announcements
// open the turn ("我来访问…：" at char 0); courtesy closers ("如有需要请
// 让我来跟进：") carry the same phrases mid/late and must not flag.
const DANGLING_ANNOUNCE_RE =
  /(我来|我将|我现在|我马上|接下来我|让我来|我再试|再试一次|我去|let me|i['’]ll|i will|i am going to)/i;

export function detectDanglingIntent(
  input: DanglingIntentInput,
): DanglingIntentDecision {
  const { display, replyText, wrappedToolCount, hasExplicitNoToolDirective } =
    input;
  if (wrappedToolCount > 0) return { detected: false, matched_pattern: null };
  const trimmed = replyText.trim();
  if (trimmed.length === 0) return { detected: false, matched_pattern: null };
  if (!/[:：]$/.test(trimmed)) return { detected: false, matched_pattern: null };
  if (hasExplicitNoToolDirective(display)) {
    return { detected: false, matched_pattern: null };
  }
  const announce = DANGLING_ANNOUNCE_RE.exec(trimmed.slice(0, 30));
  if (announce !== null) {
    return { detected: true, matched_pattern: `announce_colon:${announce[1]}` };
  }
  return { detected: false, matched_pattern: null };
}

export function renderDanglingIntentNote(): string {
  return "（系统注记：本回复宣布了行动但未调用任何工具，任务未实际执行——请重试或细化指令。）";
}

// ──  — per-turn inference step cap ──────────────────────────
// Think SDK defaults `maxSteps` to 10 and agentthursday never overrode it; 381
// attempt #3 (task-5fe8f9df) hit exactly 10 steps with EVERY step
// finishing `tool-calls` — the model was cut off mid-work and the turn
// ended with an empty visible reply. Real software-dev turns need
// 30-60+ steps. Resolved from env `AGENT_THURSDAY_TURN_MAX_STEPS`; clamped so a
// typo can neither restore the wall (<10) nor unbound the loop (>120).
export function resolveTurnMaxSteps(envValue: unknown): number {
  const DEFAULT = 48;
  const n = typeof envValue === "string" && envValue.trim() !== ""
    ? Number(envValue)
    : typeof envValue === "number"
      ? envValue
      : NaN;
  if (!Number.isFinite(n)) return DEFAULT;
  return Math.min(120, Math.max(10, Math.floor(n)));
}
