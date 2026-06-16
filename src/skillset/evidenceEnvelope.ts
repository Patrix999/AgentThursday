/**
 * Evidence envelope runtime.
 *
 * Per `` §1-§5
 * the four-ring schema is intent → execution[] → evidence → self_verify
 * with envelope_status ∈ {draft, sealed, failed}.
 *
 * v1 keeps envelopes in-memory inside an AgentThursdayAgent DO. They survive
 * a single task and can be inspected via /api/inspect/evidence/<id>.
 * Persistence to event_log happens via the agent's logEvent (each
 * mutation also emits an `evidence.envelope.<verb>` event so a
 * cross-DO query can reconstruct envelopes if needed).
 *
 * The runtime is intentionally narrow:
 *   - createDraft(intent) → envelope_id
 *   - addExecution(envelope_id, exec)
 *   - addEvidence(envelope_id, kind, value)
 *   - seal(envelope_id) → final envelope (computes self_verify)
 */

import type { GateResult } from "./gateRunner";

export type EnvelopeStatus = "draft" | "sealed" | "failed";

export interface ExpectedOutput {
  type: string;
  description: string;
  acceptance_check?: string;
}

export interface IntentEnvelope {
  source: "task_card" | "plan_step" | "human_directive" | "subagent_delegation";
  source_ref: string;
  declared_goal: string;
  expected_output: ExpectedOutput[];
  preconditions?: string[];
  workflow_pattern?: string;
}

export interface ToolCallRecord {
  tool_id: string;
  input_hash: string;
  dispatched_at: string;
  surface?: string;
  agent_reason?: string;
  //  — short JSON summary of the tool input so envelope inspectors
  // can see what the agent actually asked for without rehydrating raw
  // input. Capped (~512 chars) by the producer to avoid blowing up
  // envelope size or leaking large arguments. `input_hash` remains the
  // canonical identity field; this is purely an inspectability aid.
  input_summary?: string;
}

export interface ToolResultRecord {
  status: "ok" | "error" | "timeout";
  output?: unknown;
  error?: { reason: string; retriable: boolean; details?: string };
  finished_at: string;
  duration_ms: number;
}

export interface ExecutionEnvelope {
  step_index: number;
  tool_call: ToolCallRecord;
  tool_result: ToolResultRecord;
}

export interface DiffEvidence {
  paths: string[];
  unified_diff: string;
  source_tool_call_index: number;
}

export interface GateLogEvidence {
  gate_target: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  source_tool_call_index: number;
}

/**
 *  —  approval decision evidence entry.
 *
 * Carried inside `EvidenceData.approval_decision` so verifier replay
 * can read the audit trail of an approval (who decided, when, signature
 * reference). Per  ADR §D5, the raw reviewer signature MUST
 * NEVER appear here — only `signature_hash` (HMAC over the approval
 * payload) or `signature_ref` (external store key). The type forbids a
 * raw signature field by construction so a future card cannot
 * accidentally widen the surface.
 */
export interface ApprovalDecisionEvidence {
  token_id: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  tier: number;
  decision: "granted" | "denied";
  reviewer_id: string;
  signature_hash?: string;
  signature_ref?: string;
  decided_at: string;
  expires_at: string;
}

export interface EvidenceData {
  diff?: DiffEvidence[];
  gate_logs?: GateLogEvidence[];
  external_artifacts?: Array<{ kind: string; ref: string }>;
  approval_decision?: ApprovalDecisionEvidence[];
}

export interface SelfVerifyEnvelope {
  intent_evidence_consistent: boolean;
  claimed_tools_dispatched: string[];
  evidenced_tools_dispatched: string[];
  fabricated_tools: string[];
  required_envelope_check: {
    intent: "present" | "missing";
    execution: "present" | "missing" | "partial";
    evidence: "present" | "missing" | "partial";
    self_verify: "present";
  };
  verdict: "pass" | "partial" | "fail";
  verdict_reason?: string;
}

export interface EvidenceEnvelope {
  envelope_id: string;
  task_id: string;
  skillset_id: string;
  agent_id: string;
  schema_version: string;
  timestamps: { started_at: string; finished_at?: string };
  intent: IntentEnvelope;
  execution: ExecutionEnvelope[];
  evidence: EvidenceData;
  self_verify?: SelfVerifyEnvelope;
  envelope_status: EnvelopeStatus;
}

export interface CreateDraftInput {
  task_id: string;
  skillset_id: string;
  agent_id: string;
  intent: IntentEnvelope;
}

/**
 *  — optional mutation hook so the owning DO can persist a
 * bounded snapshot of the envelope to durable SQL storage. The store
 * stays pure (in-memory map); persistence is the DO's concern. The hook
 * fires after every accepted mutation (createDraft, addExecution when
 * not rejected, addGateEvidence, addDiffEvidence, seal). The DO is
 * expected to wrap its own try/catch — store-side failures must not
 * break tool execution.
 */
export interface EnvelopeStoreOptions {
  onMutate?: (env: EvidenceEnvelope) => void;
  /**
   *  — surface persistence failures the store would otherwise
   * silently swallow inside `notifyMutate`. The DO wires this to a
   * structured `evidence.envelope.persist.error` event so an
   * `onMutate` SQL throw doesn't leave a draft envelope un-persisted
   * with no diagnostic. Optional; default behavior is still fail-soft.
   */
  onMutateError?: (env: EvidenceEnvelope, err: unknown) => void;
}

export class EnvelopeStore {
  private envelopes = new Map<string, EvidenceEnvelope>();
  private onMutate?: (env: EvidenceEnvelope) => void;
  private onMutateError?: (env: EvidenceEnvelope, err: unknown) => void;

  constructor(opts?: EnvelopeStoreOptions) {
    this.onMutate = opts?.onMutate;
    this.onMutateError = opts?.onMutateError;
  }

  private notifyMutate(env: EvidenceEnvelope): void {
    if (!this.onMutate) return;
    try {
      this.onMutate(env);
    } catch (err) {
      //  — fail-soft on the mutation path, but expose the
      // failure via the optional error hook so the DO can log it.
      if (this.onMutateError) {
        try { this.onMutateError(env, err); } catch { /* nested fail-soft */ }
      }
    }
  }

  createDraft(input: CreateDraftInput): EvidenceEnvelope {
    const envelope_id = `env-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const env: EvidenceEnvelope = {
      envelope_id,
      task_id: input.task_id,
      skillset_id: input.skillset_id,
      agent_id: input.agent_id,
      schema_version: "0.1.0",
      timestamps: { started_at: new Date().toISOString() },
      intent: input.intent,
      execution: [],
      evidence: {},
      envelope_status: "draft",
    };
    this.envelopes.set(envelope_id, env);
    this.notifyMutate(env);
    return env;
  }

  get(envelope_id: string): EvidenceEnvelope | undefined {
    return this.envelopes.get(envelope_id);
  }

  list(): EvidenceEnvelope[] {
    return Array.from(this.envelopes.values()).sort((a, b) =>
      a.timestamps.started_at < b.timestamps.started_at ? 1 : -1,
    );
  }

  /**
   *  — re-hydration path for restoring an envelope from
   * persistent storage (e.g. `envelope_snapshots` SQL) into the
   * in-memory map after a DO isolate restart / hibernation. The
   * source of truth for `adopt()` is durable storage, so this MUST
   * NOT call `notifyMutate` — doing so would echo the payload back
   * into the persistence layer for no benefit and would risk
   * write storms when a sweeper rehydrates many drafts at once.
   * Subsequent mutations (addExecution / addGateEvidence / seal)
   * still notify normally because those represent new state.
   */
  adopt(env: EvidenceEnvelope): void {
    this.envelopes.set(env.envelope_id, env);
  }

  addExecution(envelope_id: string, exec: Omit<ExecutionEnvelope, "step_index">): ExecutionEnvelope | null {
    const env = this.envelopes.get(envelope_id);
    if (!env || env.envelope_status !== "draft") return null;
    const step: ExecutionEnvelope = { ...exec, step_index: env.execution.length };
    env.execution.push(step);
    this.notifyMutate(env);
    return step;
  }

  addGateEvidence(envelope_id: string, gate: GateResult, executionIdx: number): void {
    const env = this.envelopes.get(envelope_id);
    if (!env || env.envelope_status !== "draft") return;
    const logs = env.evidence.gate_logs ?? [];
    logs.push({
      gate_target: gate.target,
      exit_code: gate.exit_code,
      stdout: gate.stdout,
      stderr: gate.stderr,
      duration_ms: gate.duration_ms,
      source_tool_call_index: executionIdx,
    });
    env.evidence.gate_logs = logs;
    this.notifyMutate(env);
  }

  /**
   *  C — INTENTIONALLY UNWIRED. No production call site promotes
   * `repo.write` / `repo.patch` diffs into `evidence.diff`; the bounded
   * diff stays in `execution[].tool_result` (visible to inspect), and the
   * evidence ring is satisfied by gate logs ONLY (see `seal()`'s
   * `requiredCheck.evidence`). Retained for schema/API completeness and as
   * the single seam if a future card decides diffs should count as seal
   * evidence. If you wire it, you MUST revisit the  B
   * `missing_gate_evidence` gate: promoting diffs here would let a
   * gate-less mutation satisfy the evidence ring and silently defeat that
   * gate.
   */
  addDiffEvidence(envelope_id: string, paths: string[], unified_diff: string, executionIdx: number): void {
    const env = this.envelopes.get(envelope_id);
    if (!env || env.envelope_status !== "draft") return;
    const arr = env.evidence.diff ?? [];
    arr.push({ paths, unified_diff, source_tool_call_index: executionIdx });
    env.evidence.diff = arr;
    this.notifyMutate(env);
  }

  /**
   * Compute self_verify and seal. After sealing the envelope is
   * immutable. claimedTools is what the agent claims it ran (e.g.
   * derived from the agent's reply text); evidencedTools is computed
   * from execution[].tool_call.tool_id. fabricated = claimed - evidenced.
   *
   *  — `opts.readOnlySafe` lets a pure read-only / answer-only
   * turn pass even with empty execution + evidence rings. Caller is
   * responsible for proving the turn is read-only safe (no gate intent
   * on prompt, no gate intent on raw model reply, no tools dispatched);
   * this routine still requires fabricated_tools=[] and intent ring
   * present, and still fails on any failing gate log if one is
   * somehow attached. Default is `false` so sweepers and any other
   * caller without a read-only-safe proof retain the existing strict
   * ring-presence contract.
   *
   *  — `opts.readIntentObserved` records that the prompt
   * asked the agent to read a repo file but no read-side tool was
   * dispatched. When set with `execution: "missing"`, the seal emits
   * the dedicated reason string `read_intent_no_execution` instead of
   * the generic `envelope missing required ring(s)`, so reviewers can
   * grep on the file-inspection-without-evidence shape. Optional and
   * defaults to false — existing callers retain prior verdict reasons.
   *
   *  — `opts.mutationIntentObservedUnwrapped` records that the
   * supplier dispatched an unwrapped mutation tool (Think workspace
   * `write` / `delete` / `edit`) during the round, but none of those
   * calls landed in the envelope's execution ring. Setting this:
   *   - disables the read-only-safe pass short-circuit (a mutation
   *     intent can never seal as `read_only_no_action_required`),
   *   - emits the dedicated reason `mutation_intent_unwrapped_execution`
   *     when execution is missing — takes precedence over
   *     `read_intent_no_execution` because the mutation is the
   *     stronger audit signal.
   *
   *  — `opts.mutationIntentNoExecution` records that the prompt
   * itself asked for a write/delete/edit/patch on a repo-shaped path
   * (`detectMutationIntent` fired) AND `totalToolCalls === 0`. The model
   * produced a mutation narrative with zero supplier dispatch. Setting
   * this:
   *   - disables the read-only-safe pass short-circuit (the prompt
   *     declared mutation intent, so a no-op short-circuit would let
   *     a hallucinated "done" reach the user),
   *   - emits the dedicated reason `mutation_intent_no_execution` when
   *     execution is missing. Precedence: `mutation_intent_unwrapped_execution`
   *     (, supplier actually dispatched something) takes
   *     priority because that's a stronger gap; this reason ranks above
   *     `read_intent_no_execution` because mutation intent is the
   *     stronger audit signal than read intent.
   *
   *  C — `opts.mutationToolsExpected` records that the prompt has
   * mutation intent. At seal time, if execution contains NO mutation tool
   * call (`repo.write` / `repo.patch`), the envelope fails with reason
   * `missing_mutation_evidence`. This is a stronger gate than :
   * - 295e fires only when execution is entirely empty.
   * - 382 C also fires when execution has read-only tools (e.g. only
   *   `repo.read`/`repo.glob`) but no mutation tool — the subagent
   *   "looked but never wrote", which the  dogfood revealed as the
   *   dominant failure shape. Precedence: ranks above
   *   `mutation_intent_no_execution` (subsumes the empty case),
   *   below `mutation_intent_unwrapped_execution` (supplier-side leak is
   *   still the strongest signal).
   */
  seal(
    envelope_id: string,
    claimedTools: string[],
    opts?: {
      readOnlySafe?: boolean;
      readIntentObserved?: boolean;
      mutationIntentObservedUnwrapped?: boolean;
      mutationIntentNoExecution?: boolean;
      mutationToolsExpected?: boolean;
    },
  ): EvidenceEnvelope | null {
    const env = this.envelopes.get(envelope_id);
    if (!env) return null;
    if (env.envelope_status !== "draft") return env;
    const readOnlySafe = opts?.readOnlySafe === true;
    const readIntentObserved = opts?.readIntentObserved === true;
    const mutationIntentObservedUnwrapped =
      opts?.mutationIntentObservedUnwrapped === true;
    const mutationIntentNoExecution =
      opts?.mutationIntentNoExecution === true;
    const mutationToolsExpected = opts?.mutationToolsExpected === true;
    const evidenced = new Set(env.execution.map(e => e.tool_call.tool_id));
    //  C — mutation tool ids that satisfy `mutationToolsExpected`.
    // Closed list: `repo.write` / `repo.patch` are the first-party mutation
    // surfaces. `git.commit` and similar shell-backed tools are deliberately
    // excluded — the card spec scopes the gate to repo-write evidence, not
    // commit emission (which `manager.task_merge` handles separately).
    const MUTATION_TOOL_IDS = new Set(["repo.write", "repo.patch"]);
    const hasMutationToolInExecution = env.execution.some(e =>
      MUTATION_TOOL_IDS.has(e.tool_call.tool_id),
    );
    const evidencedList = Array.from(evidenced).sort();
    const claimedSet = new Set(claimedTools);
    const fabricated = Array.from(claimedSet).filter(t => !evidenced.has(t)).sort();
    const requiredCheck = {
      intent: env.intent ? ("present" as const) : ("missing" as const),
      execution: env.execution.length > 0 ? ("present" as const) : ("missing" as const),
      //  C — the evidence ring is satisfied by gate logs ONLY.
      // `addDiffEvidence` is intentionally unwired (see its definition):
      // repo.write / repo.patch diffs stay in `execution[].tool_result`
      // (visible to inspect) and are NOT promoted into `evidence.diff`, so
      // a mutation that skips gates correctly leaves this ring "missing"
      // (→  B `missing_gate_evidence`). The always-empty `diff`
      // term is dropped here to make the gates-only contract explicit in
      // code rather than implied by dead code.
      evidence:
        (env.evidence.gate_logs?.length ?? 0) > 0
          ? ("present" as const)
          : ("missing" as const),
      self_verify: "present" as const,
    };
    const consistent = fabricated.length === 0;
    //  — when the envelope contains gate evidence, the seal
    // verdict must reflect whether those gates actually succeeded.
    // Previously the seal contract only validated ring presence and
    // fabrication, so a `gate.build` that hit `tsc: not found` (exit
    // 127, phases=[]) could still produce `verdict=pass`, which broke
    // the  demo contract: "the build gate failed but the envelope
    // says pass". Canonical signal is `evidence.gate_logs[].exit_code`
    // — that's the seal-time persisted record, not the in-flight
    // execution[].tool_result.output payload.
    const failingGate = (env.evidence.gate_logs ?? []).find(g => g.exit_code !== 0);
    //  — read-only pass eligibility: prompt + reply both free
    // of gate intent, zero tools dispatched, zero claimed, no failing
    // gate log. Intent ring must still be present; consistency must
    // still hold. Any one of these failing falls back to the strict
    // path (which will fail on missing rings, as today).
    //  — mutation intent observed in supplier-signal but
    // never wrapped into envelope execution disqualifies the
    // read-only-safe short-circuit. A write/delete must never be
    // sealed as `read_only_no_action_required`.
    const readOnlyPassEligible =
      readOnlySafe &&
      !mutationIntentObservedUnwrapped &&
      !mutationIntentNoExecution &&
      !mutationToolsExpected &&
      requiredCheck.intent === "present" &&
      requiredCheck.execution === "missing" &&
      requiredCheck.evidence === "missing" &&
      consistent &&
      !failingGate &&
      claimedSet.size === 0;
    let verdict: SelfVerifyEnvelope["verdict"];
    let reason: string | undefined;
    if (readOnlyPassEligible) {
      verdict = "pass";
      reason = "read_only_no_action_required";
    } else if (
      requiredCheck.intent === "missing" ||
      requiredCheck.execution === "missing" ||
      requiredCheck.evidence === "missing"
    ) {
      verdict = "fail";
      //  — supplier dispatched an unwrapped mutation tool
      // (`write` / `delete` / `edit`) but execution ring is missing.
      // Takes precedence over `missing_mutation_evidence` and
      // `read_intent_no_execution` because supplier actually
      // dispatched something outside the envelope.
      if (mutationIntentObservedUnwrapped && requiredCheck.execution === "missing") {
        reason = "mutation_intent_unwrapped_execution";
      } else if (mutationToolsExpected && requiredCheck.execution === "missing" && requiredCheck.intent === "present") {
        //  C — prompt declared mutation intent AND execution
        // ring is empty (so trivially no `repo.write` / `repo.patch`
        // call landed). Subsumes 's
        // `mutation_intent_no_execution` reason for this subcase.
        // Note: the "execution present but only read tools" subcase
        // is handled by the dedicated outer branch below — gating here
        // on `execution === "missing"` avoids false-firing when the
        // missing ring is `evidence` and a mutation tool DID dispatch
        // but its diff evidence is what's missing.
        reason = "missing_mutation_evidence";
      } else if (mutationIntentNoExecution && requiredCheck.execution === "missing" && requiredCheck.intent === "present") {
        //  — legacy code path for callers that haven't yet
        // wired the  C `mutationToolsExpected` opt. Preserved
        // so older smoke fixtures keep their reason string until
        // migrated.
        reason = "mutation_intent_no_execution";
      } else if (readIntentObserved && requiredCheck.execution === "missing" && requiredCheck.intent === "present") {
        //  — prompt asked for a repo-file read but no
        // read-side tool was dispatched. Emit a dedicated reason
        // string so this shape is greppable separately from the
        // generic missing-rings fail.
        reason = "read_intent_no_execution";
      } else if (
        hasMutationToolInExecution &&
        requiredCheck.evidence === "missing" &&
        requiredCheck.intent === "present"
      ) {
        //  B — a real `repo.write` / `repo.patch` landed in the
        // execution ring (so this is NOT "looked but never wrote"), yet
        // the evidence ring is empty: no gate_logs. The agent mutated the
        // worktree but never ran a gate to verify it (the  381 dogfood
        // shape — narrated "I'll run typecheck" without a real gate call).
        // Emit a dedicated reason so verifiers can distinguish "wrote but
        // didn't verify" from `missing_mutation_evidence` (never wrote) and
        // from other ring gaps. Reachable only because `evidence` is the
        // ring that triggered this block — execution is present here, since
        // a mutation tool is in it, and intent is present by guard.
        reason = "missing_gate_evidence";
      } else {
        reason = "envelope missing required ring(s)";
      }
    } else if (mutationToolsExpected && !hasMutationToolInExecution) {
      //  C — execution ring has tool calls (so missing-rings
      // didn't fire), but none of them are mutation tools. The subagent
      // "looked but never wrote" — the  dogfood's dominant failure
      // shape. Hard gate.
      verdict = "fail";
      reason = "missing_mutation_evidence";
    } else if (!consistent) {
      verdict = "fail";
      reason = `claimed tools not in execution: ${fabricated.join(", ")}`;
    } else if (failingGate) {
      verdict = "fail";
      reason = `gate failed: ${failingGate.gate_target} exit ${failingGate.exit_code}`;
    } else {
      verdict = "pass";
    }
    env.self_verify = {
      intent_evidence_consistent: consistent,
      claimed_tools_dispatched: claimedTools,
      evidenced_tools_dispatched: evidencedList,
      fabricated_tools: fabricated,
      required_envelope_check: requiredCheck,
      verdict,
      verdict_reason: reason,
    };
    env.timestamps.finished_at = new Date().toISOString();
    env.envelope_status = verdict === "fail" ? "failed" : "sealed";
    this.notifyMutate(env);
    return env;
  }
}
