/**
 * 175 schema TypeScript types — minimum surface for  loader.
 * Authority:
 *
 * Detail-level fields (input_contract / output_contract / per-tier
 * approval overrides etc.) are typed as `unknown` here and validated
 * at load time by 183 contract registry;  skeleton only enforces
 * the structural skeleton needed for V1/V3/V4/V5 invariants.
 */

export type Tier = 1 | 2 | 3 | 4 | 5;

export type SurfaceMode = "enable" | "readonly" | "disable";

export interface ApprovalSpec {
  required: boolean;
  scope?: "per_call" | "per_session" | "per_topic";
  reason_required?: boolean;
  reviewer?: string;
  token_lifetime_seconds?: number;
}

//  / 236 — provider-neutral generic extension fields.
// Each is intentionally optional: existing manifests (software-dev /
// research-stub) carry none of these today, and the loader / inspect
// surface must not require them. `capability_class` is a closed
// vocabulary that lets verifiers see whether a skill is meant to be
// instruction-only, declared-but-disabled, a callable tool without
// credentials, a callable tool ready to dispatch, or a human/verifier
// relay — without leaking provider-specific identity. `source_ref`
// and `evidence_requirements` stay `unknown` until a real consumer
// narrows them; passing through as `unknown` keeps the inspect surface
// useful without inventing a fake invariant (235 recommendation).
export type SkillCapabilityClass =
  | "instruction_only"
  | "declared_tool_disabled"
  | "callable_tool_no_secret"
  | "callable_tool_ready"
  | "human_or_verifier_relay";

export interface SkillDescriptor {
  id: string;
  name: string;
  description?: string;
  tier: Tier;
  tools: string[];
  prompt_segment?: string;
  input_contract?: unknown;
  output_contract?: unknown;
  requires_approval?: ApprovalSpec;
  capability_class?: SkillCapabilityClass;
  source_ref?: unknown;
  evidence_requirements?: unknown;
}

export interface WorkflowPattern {
  name: string;
  when?: string;
  steps: string[];
  completion_signal?: string;
}

export interface VerificationHook {
  name: string;
  trigger: string;
  action: string;
}

export interface ReasoningProtocol {
  principles: string[];
  anti_patterns?: string[];
  verification_hooks?: VerificationHook[];
}

export interface SafetyPolicy {
  policy_version: string;
  path_allowlist?: string[];
  path_denylist?: string[];
  cross_repo_writes?: "denied" | "requires_approval" | "denied_with_explicit_skillset";
  per_tool_overrides?: Record<string, ApprovalSpec>;
}

export interface SkillsetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  purpose: string;
  dependencies?: string[];
  tools: string[];
  skills: SkillDescriptor[];
  workflow_patterns: WorkflowPattern[];
  reasoning_protocol: ReasoningProtocol;
  evidence_protocol: unknown;
  safety_policy: SafetyPolicy;
  observability: unknown;
  policy: {
    surface_modes: SurfaceMode[];
    default_tier_cap: Tier;
    per_tier_approval?: Record<string, ApprovalSpec>;
    load_priority?: number;
  };
}

export type LoadStatus = "loaded" | "load_rejected";

export interface LoadError {
  code:
    | "v1_tools_subset"
    | "v3_tier_cap"
    | "v4_dependency_cycle"
    | "v5_id_conflict"
    | "v2_missing_tool_contract"
    | "soul_token_overflow"
    | "schema_invalid";
  message: string;
}

export interface CacheEntry {
  manifest: SkillsetManifest;
  source_yaml: string;
  source_sha: string;
  loaded_at: string;
  status: LoadStatus;
  validation_errors: LoadError[];
  soul_token_estimate: number;
}

export interface LoaderState {
  schema_version: string;
  loaded_at: string;
  total_soul_token_estimate: number;
  total_soul_token_cap: number;
  per_skillset_token_cap: number;
  entries: Record<string, CacheEntry>;
}
