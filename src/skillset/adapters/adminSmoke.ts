/**
 * adapter for `admin.smoke` dynamic tool.
 *
 * Stateless adapter: synthesizes an in-process Request, runs the
 * composition-root's `requireSecret` umbrella, then delegates to
 * `handleSandboxExecRoutes()` directly. The model-visible input is a
 * closed-enum `case_id`; the actual endpoint, command, sandbox_id,
 * and timeout come from the adapter-side CASE_ALLOWLIST table. The
 * agent never sees `AGENT_THURSDAY_SHARED_SECRET` — it is read from `env` at
 * the adapter boundary and injected into the synthesized Request's
 * header.
 *
 * Result shape (output_schema in docs/tools/admin.smoke.0.1.0.yaml):
 *   { status: "ok",      case_id, http_status, response, evidence }
 *   { status: "blocked", case_id, http_status?, blocked: { reason, message } }
 *
 * Blocked reasons:
 *   - missing_secret_binding   — env.AGENT_THURSDAY_SHARED_SECRET unset (503 from requireSecret)
 *   - auth_failed              — requireSecret returned 401 (should not happen — we inject)
 *   - missing_sandbox_binding  — env.Sandbox unset / not a DurableObjectNamespace
 *   - missing_agent_binding    — env.AgentThursdayAgent unset (an earlier revision cliStubProbe cases)
 *   - stub_call_failed         — DO stub method threw (an earlier revision cliStubProbe cases)
 *   - route_misconfigured      — handleSandboxExecRoutes returned null
 *
 * Hard boundaries:
 *   - no env.SELF.fetch() — direct handler call only;
 *   - secret literal is replaceAll-redacted to "[REDACTED]" in
 *     stdout/stderr (guarded for empty string);
 *   - stdout/stderr capped at 1024 chars with truncated_* flags;
 *   - no extension to new endpoints without editing CASE_ALLOWLIST
 *     AND docs/tools/admin.smoke.0.1.0.yaml's case_id enum.
 *
 * Step 5 aggregate validation surface gap. Step 6
 * (an earlier revision–286) extracted context/archive/compaction surfaces from
 * `AgentThursdayAgent` into free functions on `src/agent/{archiveOps,
 * compactionOps,contextOps}.ts`. The byte-equivalent extraction needs
 * end-to-end validation, but the original `admin.smoke` v1 closed
 * enum (`sandbox-exec-printf`, `remember-ack-empty-fallback`) didn't
 * cover any of those surfaces, so directed-validation (agentD) had no
 * way to assert the Step 6 chain preserves behavior. an earlier revision adds
 * four `kind: "cliStubProbe"` cases that exercise read-only / no-op
 * surfaces of the Step 6 free functions via real `AgentThursdayAgent` DO
 * stub calls. Mutation-bearing surfaces (resetContext, newContext,
 * runContextHygiene, compactContext, applyCompactPlan) are
 * deliberately NOT exposed — they would alter production session
 * state. The cases use only read calls and a single no-op
 * `switchContext` self-target whose `kind: "noop"` branch is
 * non-destructive by construction.
 */

import { z } from "zod";
import { getAgentByName } from "agents";

import { registerDispatchHandler } from "../dispatchRegistry";
import { requireSecret } from "../../auth";
import { handleSandboxExecRoutes } from "../../routes/sandboxExecRoutes";
import { applyRememberAckFallback } from "../../replyEmptyFallback";
import { DEMO_INSTANCE } from "../../demoConstants";
import { CHANNEL_HUB_INSTANCE } from "../../channel";
import {
  buildDashboardSectionFree,
  type ChannelHubOutboxStub,
  type DashboardSectionDeps,
} from "../../agent/dashboardOps";
import { readWorkerVersionMetadata } from "../../agent/dashboardHelpers";
import type { DashboardCore, DashboardSection } from "../../agent/dashboardTypes";
import type {
  ActiveContext,
  ContextInspectResult,
  SwitchContextResult,
  CompactPlanResult,
  CompactPlanInput,
} from "../../schema/context";
import type { ArchiveInspectSummary } from "../../schema/archive";

// Narrow callable surface of the AgentThursdayAgent DO that this adapter exercises.
// Declared locally so we never `import type { AgentThursdayAgent } from
// "../../server"` — that pull would drag src/server.ts into the
// scripts/tsconfig program graph (scripts/tsconfig.json deliberately
// scopes types to `node` and does not load `@cloudflare/workers-types`,
// which server.ts's `this.env` access requires). Keeping this stub
// surface narrow also matches the an earlier revision Host-pattern discipline.
interface AgentThursdayAgentStubSurface {
  getActiveContextId(): Promise<ActiveContext>;
  inspectContext(input?: { lastN?: number }): Promise<ContextInspectResult>;
  switchContext(input: {
    contextId: string;
    reason?: string | null;
  }): Promise<SwitchContextResult>;
  compactPlan(input?: CompactPlanInput): Promise<CompactPlanResult>;
  getArchiveInspectSummary(input?: {
    recentLimit?: number;
    perContextLimit?: number;
  }): Promise<ArchiveInspectSummary>;
  // added for `cli-status-dashboard-shape-smoke`. Read-only
  // RPC @callable on `AgentThursdayAgent`; same surface the /cli/status route
  // composes. Returns a `DashboardCore` shape (DO-side; route layer
  // appends the outbox section via `buildDashboardSectionFree`).
  getDashboardCore(): Promise<DashboardCore>;
}

type GetAgentByNameNarrow = (
  ns: unknown,
  name: string,
) => Promise<AgentThursdayAgentStubSurface>;

// narrow cast for ChannelHub stub resolution used by
// `cli-status-dashboard-shape-smoke`. Avoids `import type {
// ChannelHubAgent } from "../../channelHub"` (an earlier revision documented that
// such an import poisons tsc's view of `this.env` inside
// `channelHub.ts`). `ChannelHubOutboxStub` exposes only the two
// outbox-read methods `buildDashboardSectionFree` consumes; production
// `ChannelHubAgent` is assignment-compatible because the structural
// subset has fewer required fields.
type GetChannelHubStubNarrow = (
  ns: unknown,
  name: string,
) => Promise<ChannelHubOutboxStub>;

const ADMIN_SMOKE_TOOL_ID = "admin.smoke";
const OUTPUT_CAP_BYTES = 1024;
const REDACTION_PLACEHOLDER = "[REDACTED]";
const TEXT_ENCODER = new TextEncoder();

// an earlier revision fixed inputs — deterministic predicate exercise; the
// agent only picks `case_id`, the literals come from the allowlist
// like an earlier revision's HTTP body inputs.
const REMEMBER_ACK_FIXTURE_INPUT = "" as const;
const REMEMBER_ACK_FIXTURE_ACK = "已记下：今天天气晴朗" as const;

type CaseId =
  | "sandbox-exec-printf"
  | "remember-ack-empty-fallback"
  | "context-active-inspect-smoke"
  | "context-lifecycle-noop-smoke"
  | "compaction-plan-dry-run-smoke"
  | "archive-inspect-smoke"
  | "cli-status-dashboard-shape-smoke";

type CliStubProbeId =
  | "context-active-inspect-smoke"
  | "context-lifecycle-noop-smoke"
  | "compaction-plan-dry-run-smoke"
  | "archive-inspect-smoke";

type AllowlistedCase =
  | {
      kind: "http";
      path: string;
      method: "POST";
      body: Record<string, unknown>;
    }
  | {
      kind: "fn";
      // in-process helper invocation, no Request synthesis.
      // The adapter supplies fixture inputs; closed shape means we never
      // accept agent-provided text (no injection / no secret).
      helper: "applyRememberAckFallback";
    }
  | {
      // narrow AgentThursdayAgent DO stub invocation. Each probe id
      // pins a specific stub method + read-only / no-op argument shape;
      // no model input is forwarded to the stub. Returns a structural
      // summary (counts, top-level keys, kind flags) — never raw
      // messages, archive payloads, summaries, or previews.
      kind: "cliStubProbe";
      probe: CliStubProbeId;
    }
  | {
      // `/cli/status` dashboard-section composition probe.
      // Synthesizes a `GET /cli/status` Request through `requireSecret`
      // (adapter-side secret mediation), then composes the dashboard
      // section in-process by calling `stub.getDashboardCore()` followed
      // by `buildDashboardSectionFree({getChannelHubStub,
      // readWorkerVersionMetadata}, core)`. Returns presence booleans +
      // shape evidence only; never the raw dashboard payload, never
      // session/loopReview/policy/pending/debugTrace/usage fields, and
      // never the route's lazy `sweepStaleDraftEnvelopes` mutation.
      kind: "cliStatusProbe";
    };

const CASE_ALLOWLIST: Record<CaseId, AllowlistedCase> = {
  "sandbox-exec-printf": {
    kind: "http",
    path: "/api/sandbox/exec",
    method: "POST",
    body: {
      command: "printf card268-e2e",
      sandbox_id: "agentthursday-card268-smoke",
      timeout_seconds: 10,
    },
  },
  "remember-ack-empty-fallback": {
    kind: "fn",
    helper: "applyRememberAckFallback",
  },
  "context-active-inspect-smoke": {
    kind: "cliStubProbe",
    probe: "context-active-inspect-smoke",
  },
  "context-lifecycle-noop-smoke": {
    kind: "cliStubProbe",
    probe: "context-lifecycle-noop-smoke",
  },
  "compaction-plan-dry-run-smoke": {
    kind: "cliStubProbe",
    probe: "compaction-plan-dry-run-smoke",
  },
  "archive-inspect-smoke": {
    kind: "cliStubProbe",
    probe: "archive-inspect-smoke",
  },
  "cli-status-dashboard-shape-smoke": {
    kind: "cliStatusProbe",
  },
};

const inputSchema = z.object({
  case_id: z.enum([
    "sandbox-exec-printf",
    "remember-ack-empty-fallback",
    "context-active-inspect-smoke",
    "context-lifecycle-noop-smoke",
    "compaction-plan-dry-run-smoke",
    "archive-inspect-smoke",
    "cli-status-dashboard-shape-smoke",
  ] as const),
});

type Input = z.infer<typeof inputSchema>;

interface SandboxOkOutput {
  status: "ok";
  case_id: "sandbox-exec-printf";
  http_status: number;
  response: {
    stdout: string;
    stderr: string;
    exit_code: number;
    success: boolean;
    timed_out: boolean;
    sandbox_id: string;
    timeout_seconds: number;
  };
  evidence: {
    stdout_bytes: number;
    stderr_bytes: number;
    truncated_stdout: boolean;
    truncated_stderr: boolean;
    redaction_applied: boolean;
  };
}

interface RememberAckOkOutput {
  status: "ok";
  case_id: "remember-ack-empty-fallback";
  response: {
    final_reply: string;
    fallback_applied: boolean;
  };
  evidence: {
    input_was_empty: boolean;
    ack_present: boolean;
    final_reply_equals_ack: boolean;
  };
}

// `cliStubProbe` outputs. One discriminated branch per
// probe case_id. Each carries a structural summary (counts / boolean
// flags / top-level keys) and an `evidence.free_fn_path_exercised`
// list naming the Step 6 free functions whose DO delegate was invoked.
// Mutation flags are explicit so reviewers can confirm no production
// state changed.
interface ContextActiveInspectOkOutput {
  status: "ok";
  case_id: "context-active-inspect-smoke";
  response: {
    context_id_present: boolean;
    total_message_count: number;
    visible_messages_count: number;
    by_role_user: number;
    by_role_assistant: number;
    by_role_system: number;
    has_context_budget: boolean;
    sanitized_at: number;
  };
  evidence: {
    inspect_top_keys: string[];
    free_fn_path_exercised: string[];
    destructive_mutation: false;
  };
}

interface ContextLifecycleNoopOkOutput {
  status: "ok";
  case_id: "context-lifecycle-noop-smoke";
  response: {
    previous_context_id_present: boolean;
    new_context_id_present: boolean;
    previous_equals_new: boolean;
    activated_at: number;
  };
  evidence: {
    switch_was_noop: boolean;
    free_fn_path_exercised: string[];
    destructive_mutation: false;
  };
}

interface CompactionPlanDryRunOkOutput {
  status: "ok";
  case_id: "compaction-plan-dry-run-smoke";
  response: {
    plan_id_present: boolean;
    total_message_count: number;
    visible_start_index: number;
    ranges_count: number;
    rejected_count: number;
    preserved_count: number;
    before_messages: number;
    estimated_after_messages: number;
  };
  evidence: {
    rejected_reasons: string[];
    plan_strategy_keys: string[];
    free_fn_path_exercised: string[];
    destructive_mutation: false;
  };
}

interface ArchiveInspectOkOutput {
  status: "ok";
  case_id: "archive-inspect-smoke";
  response: {
    archive_chunk_total: number;
    archive_context_count: number;
    flush_total: number;
    flush_failed_total: number;
    retrieval_total: number;
    recent_flushes_count: number;
    recent_retrievals_count: number;
    counts_by_context_count: number;
    generated_at: number;
  };
  evidence: {
    summary_top_keys: string[];
    free_fn_path_exercised: string[];
    destructive_mutation: false;
  };
}

// closed shape for `cli-status-dashboard-shape-smoke`. All
// fields are derived from `DashboardSection`. No raw outbox row, no
// patch-apply payload, no envelope_id leak — only presence booleans,
// closed-enum `*_kind` discriminators, drift-flag whitelist names, and
// the structural top-level key set. `http_status` is the literal `200`
// the synthesized Request would have returned had it gone through the
// real route layer; we set it explicitly because the adapter never
// runs the actual handler (route is auth-gated by the same
// `requireSecret` we already invoked).
interface CliStatusDashboardShapeOkOutput {
  status: "ok";
  case_id: "cli-status-dashboard-shape-smoke";
  http_status: 200;
  response: {
    current_task_present: boolean;
    latest_envelope_present: boolean;
    latest_outbox_present: boolean;
    patch_apply_outbox_present: boolean;
    drift_flags_present: boolean;
    version_present: boolean;
    latest_outbox_kind: "row" | "missing" | "unknown";
    patch_apply_outbox_kind: "row" | "missing" | "unknown";
    drift_flag_count: number;
    drift_flag_names: string[];
    version_fields_present: {
      instance_name: boolean;
      service_version: boolean;
      worker_version_id: boolean;
      worker_version_tag: boolean;
      worker_version_timestamp: boolean;
    };
  };
  evidence: {
    dashboard_top_keys: string[];
    free_fn_path_exercised: string[];
    destructive_mutation: false;
  };
}

interface BlockedOutput {
  status: "blocked";
  case_id: CaseId;
  http_status?: number;
  blocked: {
    reason:
      | "missing_secret_binding"
      | "missing_sandbox_binding"
      | "missing_agent_binding"
      | "stub_call_failed"
      | "auth_failed"
      | "route_misconfigured";
    message: string;
  };
}

type Output =
  | SandboxOkOutput
  | RememberAckOkOutput
  | ContextActiveInspectOkOutput
  | ContextLifecycleNoopOkOutput
  | CompactionPlanDryRunOkOutput
  | ArchiveInspectOkOutput
  | CliStatusDashboardShapeOkOutput
  | BlockedOutput;

interface AdminSmokeEnv {
  AGENT_THURSDAY_SHARED_SECRET?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
  Sandbox?: unknown;
  AgentThursdayAgent?: unknown;
  ChannelHubAgent?: unknown;
  VERSION_METADATA?: unknown;
}

function capAndRedact(
  raw: unknown,
  secret: string | undefined,
): { value: string; bytes: number; truncated: boolean; redacted: boolean } {
  const s = typeof raw === "string" ? raw : "";
  let redacted = false;
  let out = s;
  if (secret && secret.length > 0 && out.includes(secret)) {
    out = out.split(secret).join(REDACTION_PLACEHOLDER);
    redacted = true;
  }
  const bytes = TEXT_ENCODER.encode(out).byteLength;
  const truncated = bytes > OUTPUT_CAP_BYTES;
  if (truncated) out = capUtf8String(out, OUTPUT_CAP_BYTES);
  return { value: out, bytes, truncated, redacted };
}

function capUtf8String(value: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const ch of value) {
    const len = TEXT_ENCODER.encode(ch).byteLength;
    if (used + len > maxBytes) break;
    used += len;
    out += ch;
  }
  return out;
}

// conservative compactPlan inputs. Designed to NEVER produce
// surprising state: even on a high-pressure context, these inputs
// almost always yield zero ranges + populated rejected[] reasons,
// because `keepRecent: 200` preserves the trailing 200 messages and
// `pressureThreshold: 100000` is well above any realistic real-world
// message count. The probe asserts compactPlan's structural shape,
// not that it finds work to do.
const COMPACTION_PLAN_PROBE_INPUT = {
  lastN: 50,
  firstK: 0,
  keepRecent: 200,
  minRangeMessages: 8,
  pressureThreshold: 100000,
} as const;

const ARCHIVE_INSPECT_PROBE_INPUT = {
  recentLimit: 3,
  perContextLimit: 2,
} as const;

// Cast through the narrow surface — see the AgentThursdayAgentStubSurface comment
// above for why we do not pass a concrete AgentThursdayAgent generic here.
const resolveAgent = getAgentByName as unknown as GetAgentByNameNarrow;

async function getRegistryStub(env: AdminSmokeEnv): Promise<AgentThursdayAgentStubSurface> {
  return resolveAgent(env.AgentThursdayAgent, DEMO_INSTANCE);
}

async function getCanonicalActiveStubForProbe(
  env: AdminSmokeEnv,
): Promise<AgentThursdayAgentStubSurface> {
  // Mirror `getCanonicalActiveContextDoName` semantics without
  // requiring a real Request: ask the registry for the active
  // pointer, then build a stub against that DO name. If the registry
  // itself is the canonical active (default in deployments),
  // both stubs target the same DO.
  const registry = await getRegistryStub(env);
  let name = DEMO_INSTANCE;
  try {
    const active: ActiveContext = await registry.getActiveContextId();
    if (
      typeof active?.contextId === "string"
      && active.contextId.length > 0
      && active.contextId.length <= 200
    ) {
      name = active.contextId;
    }
  } catch {
    // Registry unreachable / pointer empty — fall back to DEMO_INSTANCE.
  }
  return resolveAgent(env.AgentThursdayAgent, name);
}

async function runCliStubProbe(
  probe: CliStubProbeId,
  env: AdminSmokeEnv,
): Promise<Output> {
  if (probe === "context-active-inspect-smoke") {
    const registry = await getRegistryStub(env);
    const active: ActiveContext = await registry.getActiveContextId();
    const activeStub = await getCanonicalActiveStubForProbe(env);
    const inspect: ContextInspectResult = await activeStub.inspectContext({ lastN: 1 });
    return {
      status: "ok",
      case_id: "context-active-inspect-smoke",
      response: {
        context_id_present:
          typeof active.contextId === "string" && active.contextId.length > 0,
        total_message_count: inspect.totalMessageCount,
        visible_messages_count: inspect.visibleMessages.length,
        by_role_user: inspect.byRole.user,
        by_role_assistant: inspect.byRole.assistant,
        by_role_system: inspect.byRole.system,
        has_context_budget:
          inspect.contextBudget !== null && typeof inspect.contextBudget === "object",
        sanitized_at: inspect.sanitizedAt,
      },
      evidence: {
        inspect_top_keys: Object.keys(inspect).sort(),
        free_fn_path_exercised: [
          "getActiveContextIdFree",
          "inspectContextFree",
        ],
        destructive_mutation: false,
      },
    };
  }

  if (probe === "context-lifecycle-noop-smoke") {
    const registry = await getRegistryStub(env);
    const active: ActiveContext = await registry.getActiveContextId();
    // an earlier revision safety: hand the registry its own current active id so
    // `switchContext` hits the no-op branch (`previousContextId ===
    // newContextId`). No-op branch is non-destructive by construction
    // — it emits a `context.switch` event with `kind: "noop"` and
    // returns the same id; it does NOT clear messages, archive, or
    // change the active pointer.
    if (
      typeof active.contextId !== "string"
      || active.contextId.length === 0
    ) {
      return {
        status: "blocked",
        case_id: "context-lifecycle-noop-smoke",
        blocked: {
          reason: "stub_call_failed",
          message: "active context id is empty; cannot synthesize no-op switch",
        },
      };
    }
    const result: SwitchContextResult = await registry.switchContext({
      contextId: active.contextId,
      reason: "card287-noop-smoke",
    });
    const noop =
      typeof result.previousContextId === "string"
      && result.previousContextId === result.newContextId;
    return {
      status: "ok",
      case_id: "context-lifecycle-noop-smoke",
      response: {
        previous_context_id_present:
          typeof result.previousContextId === "string"
          && result.previousContextId.length > 0,
        new_context_id_present:
          typeof result.newContextId === "string"
          && result.newContextId.length > 0,
        previous_equals_new: noop,
        activated_at: result.activatedAt,
      },
      evidence: {
        switch_was_noop: noop,
        free_fn_path_exercised: [
          "getActiveContextIdFree",
          "switchContextFree",
        ],
        destructive_mutation: false,
      },
    };
  }

  if (probe === "compaction-plan-dry-run-smoke") {
    const stub = await getCanonicalActiveStubForProbe(env);
    const plan: CompactPlanResult = await stub.compactPlan(COMPACTION_PLAN_PROBE_INPUT);
    return {
      status: "ok",
      case_id: "compaction-plan-dry-run-smoke",
      response: {
        plan_id_present: typeof plan.planId === "string" && plan.planId.length > 0,
        total_message_count: plan.snapshot.totalMessageCount,
        visible_start_index: plan.snapshot.visibleStartIndex,
        ranges_count: plan.ranges.length,
        rejected_count: plan.rejected.length,
        preserved_count: plan.preserved.length,
        before_messages: plan.pressure.beforeMessages,
        estimated_after_messages: plan.pressure.estimatedAfterMessages,
      },
      evidence: {
        rejected_reasons: plan.rejected.map((r) => r.reason).sort(),
        plan_strategy_keys: Object.keys(plan.strategy).sort(),
        free_fn_path_exercised: ["compactPlanFree"],
        destructive_mutation: false,
      },
    };
  }

  if (probe === "archive-inspect-smoke") {
    const registry = await getRegistryStub(env);
    const summary: ArchiveInspectSummary = await registry.getArchiveInspectSummary(ARCHIVE_INSPECT_PROBE_INPUT);
    return {
      status: "ok",
      case_id: "archive-inspect-smoke",
      response: {
        archive_chunk_total: summary.totals.archiveChunkTotal,
        archive_context_count: summary.totals.archiveContextCount,
        flush_total: summary.totals.flushTotal,
        flush_failed_total: summary.totals.flushFailedTotal,
        retrieval_total: summary.totals.retrievalTotal,
        recent_flushes_count: summary.recentFlushes.length,
        recent_retrievals_count: summary.recentRetrievals.length,
        counts_by_context_count: summary.countsByContext.length,
        generated_at: summary.generatedAt,
      },
      evidence: {
        summary_top_keys: Object.keys(summary).sort(),
        free_fn_path_exercised: ["getArchiveInspectSummaryFree"],
        destructive_mutation: false,
      },
    };
  }

  // Unreachable per the discriminated union; defensive guard for future
  // probe ids added to CliStubProbeId without a runtime branch.
  const _exhaustive: never = probe;
  throw new Error(`runCliStubProbe: unhandled probe '${String(_exhaustive)}'`);
}

// narrow ChannelHub resolver via the documented narrow cast.
const resolveChannelHub = getAgentByName as unknown as GetChannelHubStubNarrow;

/**
 * `cli-status-dashboard-shape-smoke`.
 *
 * Exercises the dashboard composition slice of `/cli/status` so a
 * directed-validation agent (agentD) can confirm the production
 * `/cli/status.dashboard` shape without seeing `AGENT_THURSDAY_SHARED_SECRET`
 * and without gaining general curl/shell access.
 *
 * Honest-labeling boundary:
 *   - This probe DOES exercise: `requireSecret` (adapter-side secret
 *     mediation), `AgentThursdayAgent.getDashboardCore` @callable (DO-side
 *     core via `getDashboardCoreFree`), and
 *     `buildDashboardSectionFree` (route-layer fail-soft cross-DO
 *     outbox/version composition).
 *   - This probe does NOT exercise: the lazy
 *     `sweepStaleDraftEnvelopes` background call the real /cli/status
 *     fires-and-forgets, nor the other six stub calls the route
 *     composes (`getCliSession`, `getDeveloperLoopReview`,
 *     `getApprovalPolicy`, `getPendingToolApproval`, `getDebugTrace`,
 *     `getUsageStats`). the operator / agentP chose this scope so the probe is
 *     read-only and non-mutating; if a future revision needs full
 *     route equivalence, open a follow-up card.
 *
 * Returns a closed presence-booleans + `*_kind` discriminator set;
 * never returns the raw dashboard payload, outbox row payload,
 * patch-apply payload, or shared secret.
 */
async function runCliStatusProbe(env: AdminSmokeEnv): Promise<Output> {
  if (!env.AgentThursdayAgent) {
    return {
      status: "blocked",
      case_id: "cli-status-dashboard-shape-smoke",
      blocked: {
        reason: "missing_agent_binding",
        message:
          "env.AgentThursdayAgent binding is not present; cli-status-dashboard-shape-smoke cannot reach the AgentThursdayAgent DO",
      },
    };
  }

  const headers = new Headers();
  if (typeof env.AGENT_THURSDAY_SHARED_SECRET === "string" && env.AGENT_THURSDAY_SHARED_SECRET.length > 0) {
    headers.set("X-AgentThursday-Secret", env.AGENT_THURSDAY_SHARED_SECRET);
  }
  const url = new URL("http://internal/cli/status");
  const req = new Request(url.toString(), { method: "GET", headers });
  const authResp = requireSecret(req, env);
  if (authResp) {
    const reason: BlockedOutput["blocked"]["reason"] =
      authResp.status === 503 ? "missing_secret_binding" : "auth_failed";
    return {
      status: "blocked",
      case_id: "cli-status-dashboard-shape-smoke",
      http_status: authResp.status,
      blocked: {
        reason,
        message:
          reason === "missing_secret_binding"
            ? "AGENT_THURSDAY_SHARED_SECRET is not set; cannot run secret-gated cli-status dashboard probe"
            : "requireSecret rejected the synthesized request",
      },
    };
  }

  let core: DashboardCore;
  try {
    const stub = await getRegistryStub(env);
    core = await stub.getDashboardCore();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "blocked",
      case_id: "cli-status-dashboard-shape-smoke",
      blocked: {
        reason: "stub_call_failed",
        message: `getDashboardCore threw: ${message.slice(0, 200)}`,
      },
    };
  }

  const deps: DashboardSectionDeps = {
    getChannelHubStub: () => resolveChannelHub(env.ChannelHubAgent, CHANNEL_HUB_INSTANCE),
    readWorkerVersionMetadata: () => readWorkerVersionMetadata(env as unknown as Env),
  };

  let dashboard: DashboardSection;
  try {
    dashboard = await buildDashboardSectionFree(deps, core);
  } catch (e) {
    // buildDashboardSectionFree is fail-soft internally — catching is a
    // defensive guard, not an expected path.
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "blocked",
      case_id: "cli-status-dashboard-shape-smoke",
      blocked: {
        reason: "stub_call_failed",
        message: `buildDashboardSectionFree threw: ${message.slice(0, 200)}`,
      },
    };
  }

  const latestOutboxKind: "row" | "missing" | "unknown" =
    typeof dashboard.latest_outbox === "object" && dashboard.latest_outbox !== null
      ? "row"
      : dashboard.latest_outbox;
  const patchApplyOutboxKind: "row" | "missing" | "unknown" =
    typeof dashboard.patch_apply_outbox === "object" && dashboard.patch_apply_outbox !== null
      ? "row"
      : dashboard.patch_apply_outbox;

  const version = dashboard.version;

  return {
    status: "ok",
    case_id: "cli-status-dashboard-shape-smoke",
    http_status: 200,
    response: {
      current_task_present:
        dashboard.current_task !== null && typeof dashboard.current_task === "object",
      latest_envelope_present: dashboard.latest_envelope !== null,
      latest_outbox_present:
        typeof dashboard.latest_outbox === "object" && dashboard.latest_outbox !== null,
      patch_apply_outbox_present:
        typeof dashboard.patch_apply_outbox === "object"
          && dashboard.patch_apply_outbox !== null,
      drift_flags_present: Array.isArray(dashboard.drift_flags),
      version_present: typeof dashboard.version === "object" && dashboard.version !== null,
      latest_outbox_kind: latestOutboxKind,
      patch_apply_outbox_kind: patchApplyOutboxKind,
      drift_flag_count: dashboard.drift_flags.length,
      drift_flag_names: [...dashboard.drift_flags].sort(),
      version_fields_present: {
        instance_name:
          typeof version.instance_name === "string" && version.instance_name.length > 0,
        service_version:
          typeof version.service_version === "string" && version.service_version.length > 0,
        worker_version_id: typeof version.worker_version_id === "string",
        worker_version_tag: typeof version.worker_version_tag === "string",
        worker_version_timestamp: typeof version.worker_version_timestamp === "string",
      },
    },
    evidence: {
      dashboard_top_keys: Object.keys(dashboard).sort(),
      free_fn_path_exercised: ["getDashboardCoreFree", "buildDashboardSectionFree"],
      destructive_mutation: false,
    },
  };
}

registerDispatchHandler<Input, Output>({
  tool_id: ADMIN_SMOKE_TOOL_ID,
  inputSchema,
  execute: async (input, envUnknown): Promise<Output> => {
    const env = (envUnknown ?? {}) as AdminSmokeEnv;
    const caseId = input.case_id;
    const spec = CASE_ALLOWLIST[caseId];

    if (spec.kind === "fn") {
      // deterministic helper-driven validation. No env
      // bindings, no HTTP synthesis. Predicate exercise of an earlier revision.
      const result = applyRememberAckFallback({
        replyText: REMEMBER_ACK_FIXTURE_INPUT,
        rememberAck: REMEMBER_ACK_FIXTURE_ACK,
      });
      return {
        status: "ok",
        case_id: "remember-ack-empty-fallback",
        response: {
          final_reply: result.replyText,
          fallback_applied: result.fallbackApplied,
        },
        evidence: {
          input_was_empty: REMEMBER_ACK_FIXTURE_INPUT.length === 0,
          ack_present: REMEMBER_ACK_FIXTURE_ACK.length > 0,
          final_reply_equals_ack: result.replyText === REMEMBER_ACK_FIXTURE_ACK,
        },
      };
    }

    if (spec.kind === "cliStubProbe") {
      // Step 5 aggregate validation surfaces. Each probe
      // pins a single read-only / no-op stub method on `AgentThursdayAgent`
      // (registry instance, DEMO_INSTANCE) and returns a structural
      // summary. No raw message text, no archive payloads, no
      // summary previews are forwarded. Mutation is bounded to the
      // documented no-op `switchContext` self-target branch.
      if (!env.AgentThursdayAgent) {
        return {
          status: "blocked",
          case_id: caseId,
          blocked: {
            reason: "missing_agent_binding",
            message:
              "env.AgentThursdayAgent binding is not present; admin.smoke cannot reach the AgentThursdayAgent DO",
          },
        };
      }
      try {
        return await runCliStubProbe(spec.probe, env);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          status: "blocked",
          case_id: caseId,
          blocked: {
            reason: "stub_call_failed",
            message: `cliStubProbe '${spec.probe}' threw: ${message.slice(0, 200)}`,
          },
        };
      }
    }

    if (spec.kind === "cliStatusProbe") {
      // dashboard-section composition probe (see
      // `runCliStatusProbe` honest-labeling docstring for the route
      // equivalence boundary).
      return await runCliStatusProbe(env);
    }

    if (!env.Sandbox) {
      return {
        status: "blocked",
        case_id: caseId,
        blocked: {
          reason: "missing_sandbox_binding",
          message:
            "env.Sandbox binding is not present; admin.smoke cannot reach the sandbox container",
        },
      };
    }

    const headers = new Headers({ "content-type": "application/json" });
    if (typeof env.AGENT_THURSDAY_SHARED_SECRET === "string" && env.AGENT_THURSDAY_SHARED_SECRET.length > 0) {
      headers.set("X-AgentThursday-Secret", env.AGENT_THURSDAY_SHARED_SECRET);
    }
    const url = new URL(`http://internal${spec.path}`);
    const req = new Request(url.toString(), {
      method: spec.method,
      headers,
      body: JSON.stringify(spec.body),
    });

    const authResp = requireSecret(req, env);
    if (authResp) {
      const reason: BlockedOutput["blocked"]["reason"] =
        authResp.status === 503 ? "missing_secret_binding" : "auth_failed";
      return {
        status: "blocked",
        case_id: caseId,
        http_status: authResp.status,
        blocked: {
          reason,
          message:
            reason === "missing_secret_binding"
              ? "AGENT_THURSDAY_SHARED_SECRET is not set; cannot run secret-gated admin smoke"
              : "requireSecret rejected the synthesized request",
        },
      };
    }

    const resp = await handleSandboxExecRoutes(req, url, env as unknown as Env);
    if (resp === null) {
      return {
        status: "blocked",
        case_id: caseId,
        blocked: {
          reason: "route_misconfigured",
          message: `handleSandboxExecRoutes returned null for ${spec.method} ${spec.path}`,
        },
      };
    }

    const body = (await resp.json()) as {
      stdout?: unknown;
      stderr?: unknown;
      exit_code?: unknown;
      success?: unknown;
      timed_out?: unknown;
      sandbox_id?: unknown;
      timeout_seconds?: unknown;
    };
    const secret = env.AGENT_THURSDAY_SHARED_SECRET;
    const stdout = capAndRedact(body.stdout, secret);
    const stderr = capAndRedact(body.stderr, secret);
    return {
      status: "ok",
      case_id: "sandbox-exec-printf",
      http_status: resp.status,
      response: {
        stdout: stdout.value,
        stderr: stderr.value,
        exit_code: typeof body.exit_code === "number" ? body.exit_code : -1,
        success: body.success === true,
        timed_out: body.timed_out === true,
        sandbox_id: typeof body.sandbox_id === "string" ? body.sandbox_id : "",
        timeout_seconds:
          typeof body.timeout_seconds === "number" ? body.timeout_seconds : 0,
      },
      evidence: {
        stdout_bytes: stdout.bytes,
        stderr_bytes: stderr.bytes,
        truncated_stdout: stdout.truncated,
        truncated_stderr: stderr.truncated,
        redaction_applied: stdout.redacted || stderr.redacted,
      },
    };
  },
});
