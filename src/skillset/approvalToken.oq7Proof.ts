/**
 * an earlier revision OQ7 — type-level proof that the current evidence envelope
 * accepts `evidence.approval_decision` as a closed-set member.
 *
 * an earlier revision ADR OQ7 asks: does the existing envelope schema admit an
 * `approval_decision` evidence entry, or do we need a separate an earlier revision
 * schema patch? This module is the proof: the literal below typechecks
 * iff `EvidenceData` has an `approval_decision?: ApprovalDecisionEvidence[]`
 * field whose element type also accepts the runtime shape the contract
 * registry refers to (`evidence.approval_decision`).
 *
 * If a future change tightens or removes the field, `tsc` (which the card
 * gate runs) fails on this file and the regression is caught at PR time.
 *
 * NOTE: this is **type-only**. It is not imported anywhere. The exported
 * symbol exists so the file is not flagged as dead by the TS unused-file
 * pass; it has no runtime side effect and never executes.
 */
import type {
  ApprovalDecisionEvidence,
  EvidenceData,
  EvidenceEnvelope,
} from "./evidenceEnvelope";

const _approvalEntry: ApprovalDecisionEvidence = {
  token_id: "tok_abcdef0123456789",
  agent_id: "agent.dev.agentc",
  tool_id: "git.commit",
  input_hash: "deadbeefcafebabe",
  tier: 4,
  decision: "granted",
  reviewer_id: "reviewer.agentp",
  signature_hash: "feedface00000000",
  decided_at: "2026-05-09T00:00:00.000Z",
  expires_at: "2026-05-09T00:30:00.000Z",
};

const _evidence: EvidenceData = {
  approval_decision: [_approvalEntry],
};

const _envelope: EvidenceEnvelope = {
  envelope_id: "env-test-approval",
  task_id: "t-test",
  skillset_id: "software-dev",
  agent_id: "agent.dev.agentc",
  schema_version: "0.1.0",
  timestamps: { started_at: "2026-05-09T00:00:00.000Z" },
  intent: {
    source: "task_card",
    source_ref: "kanban/212a",
    declared_goal: "approve a T4 commit",
    expected_output: [],
  },
  execution: [],
  evidence: _evidence,
  envelope_status: "draft",
};

// `signature_ref` variant — also typechecks.
const _approvalEntryRefVariant: ApprovalDecisionEvidence = {
  token_id: "tok_0123456789abcdef",
  agent_id: "agent.dev.agentc",
  tool_id: "git.push",
  input_hash: "0123456789abcdef",
  tier: 5,
  decision: "denied",
  reviewer_id: "reviewer.agentp",
  signature_ref: "approval-store://2026/05/09/tok_0123",
  decided_at: "2026-05-09T00:05:00.000Z",
  expires_at: "2026-05-09T00:20:00.000Z",
};

export const __OQ7_PROOF__ = {
  envelope: _envelope,
  ref_variant: _approvalEntryRefVariant,
} as const;
