/**
 *  — generic tool capability inspect classifier.
 *
 * Implements the readiness/dispatch shape behind
 * `GET /api/inspect/tool/<tool_id>`. Pure function over:
 *   - the global `TOOL_CONTRACTS` registry (hand-written + generated)
 *   - the global `AGENT_DISPATCH_HANDLERS` adapter registry
 *   - the runtime `SkillsetRuntimeSummary` (so operator-disable is
 *     respected — see `feedback_agent_surface_inspect_must_use_active_state`)
 *   - a static map of legacy direct-safe surface names from
 *     `_buildM81AgentSafeReadTools()` and the hand-coded `getTools()`
 *     entries (review_project_status, write_checkpoint, …).
 *
 * Five readiness states + 404:
 *   - `dynamic_ready`            contract present, implemented,
 *                                surface fetch_path, handler bound,
 *                                runtime tool_id present
 *   - `legacy_direct`            contract present, implemented, but
 *                                surfaced via  legacy direct wiring
 *                                (do_method) rather than dynamic registry
 *   - `contract_only_no_handler` contract present, implemented, but
 *                                neither dynamic handler nor legacy wiring
 *   - `declared_not_implemented` contract present, implemented=false
 *   - `legacy_direct_no_contract` not in contract registry but exposed
 *                                via legacy / hand-coded getTools surface
 *   - `unknown_tool`             not in any surface (route returns 404)
 *
 * The response never contains secret values; only the `env_binding`
 * NAME is returned (the binding's value is never read here).
 */

import { getContract } from "./contractRegistry";
import { AGENT_DISPATCH_HANDLERS } from "./dispatchRegistry";
import type { SkillsetRuntimeSummary } from "./runtimeSnapshot";

/**
 * Canonical contract tool_id → legacy direct surface name as wired by
 * `buildAgentSafeReadTools` in `agentToolBinding.ts`. Update this map
 * whenever a new safe-read tool is added on the legacy direct path.
 */
const CANONICAL_TO_LEGACY_DIRECT: Record<string, string> = {
  "repo.read": "repo_read",
  "repo.grep": "repo_grep",
  "repo.prepare": "repo_prepare",
  "repo.write": "repo_write",
  "repo.patch": "repo_patch",
  "git.status": "git_status",
  "git.show": "git_show",
  "git.log": "git_log",
  "gate.typecheck": "gate_typecheck",
  "gate.build": "gate_build",
};

/**
 * Legacy safe-read surface tool names from
 * `_buildM81AgentSafeReadTools()`. These appear in `getTools()` even
 * though `evidence_get` has no canonical contract counterpart.
 */
const LEGACY_DIRECT_SURFACE_NAMES: ReadonlySet<string> = new Set([
  "repo_read",
  "repo_grep",
  "repo_prepare",
  "repo_write",
  "repo_patch",
  "git_status",
  "git_show",
  "git_log",
  "gate_typecheck",
  "gate_build",
  "evidence_get",
]);

/**
 * Hand-coded `getTools()` entries that are not part of the safe-read
 * legacy surface, but also have no canonical contract registry entry.
 * These appear in `AgentThursdayAgent.getTools()` via the  per-family
 * builder spreads (Cards 271-276):
 *
 *   - `browserTools.ts`       → `browse`
 *   - `conversationTools.ts`  → `conversation_search`
 *   - `contentTools.ts`       → `content_sources`, `content_list`,
 *                               `content_read`, `content_search`
 *   - `coreTools.ts`          → `review_project_status`,
 *                               `write_checkpoint`, `review_note`,
 *                               `advance_kanban_card`
 *   - `memoryTools.ts`        → `remember`, `recall`
 *   - `executionTools.ts`     → `execute`
 *
 *  closed the pre-existing drift  §4 flagged: this
 * set previously held only Cards 274 + 276 names (5 of 13) and the
 * remaining 8 names classified as `unknown_tool` even though they
 * were exposed via legacy hand-coded `tool({...})` entries. Widening
 * is metadata-only — model-facing capability is unchanged.
 */
const LEGACY_HAND_CODED_NAMES: ReadonlySet<string> = new Set([
  // browser ()
  "browse",
  // conversation ()
  "conversation_search",
  // content ()
  "content_sources",
  "content_list",
  "content_read",
  "content_search",
  // core ()
  "review_project_status",
  "write_checkpoint",
  "review_note",
  "advance_kanban_card",
  // memory ()
  "remember",
  "recall",
  // execute ()
  "execute",
]);

export type ToolReadiness =
  | "dynamic_ready"
  | "legacy_direct"
  | "contract_only_no_handler"
  | "declared_not_implemented"
  | "legacy_direct_no_contract"
  | "unknown_tool";

export interface InspectToolResult {
  tool_id: string;
  contract_present: boolean;
  implemented: boolean | null;
  dispatch_path: { surface: string | null; identifier: string | null };
  tier: number | null;
  /** Binding NAME only — value is never read or returned. */
  env_binding: string | null;
  handler_present: boolean;
  runtime_tool_id_present: boolean;
  agent_binding:
    | {
        ai_sdk_name: string;
        skillset_id: string;
        skill_id: string;
        has_handler: boolean;
      }
    | null;
  legacy_direct_tool: string | null;
  readiness: ToolReadiness;
  reason: string;
}

export interface ClassifyToolCtx {
  summary: Pick<SkillsetRuntimeSummary, "tool_ids" | "agent_tools">;
}

export function classifyTool(toolId: string, ctx: ClassifyToolCtx): InspectToolResult {
  const contract = getContract(toolId);
  const handlerPresent = AGENT_DISPATCH_HANDLERS.has(toolId);
  const runtimeToolIds = new Set(ctx.summary.tool_ids);
  const runtimePresent = runtimeToolIds.has(toolId);
  const binding = ctx.summary.agent_tools.find(b => b.tool_id === toolId);
  const agentBinding = binding
    ? {
        ai_sdk_name: binding.ai_sdk_name,
        skillset_id: binding.skillset_id,
        skill_id: binding.skill_id,
        has_handler: binding.has_handler,
      }
    : null;

  // Path A: no canonical contract.
  if (!contract) {
    if (LEGACY_DIRECT_SURFACE_NAMES.has(toolId) || LEGACY_HAND_CODED_NAMES.has(toolId)) {
      return {
        tool_id: toolId,
        contract_present: false,
        implemented: null,
        dispatch_path: { surface: null, identifier: null },
        tier: null,
        env_binding: null,
        handler_present: handlerPresent,
        runtime_tool_id_present: runtimePresent,
        agent_binding: agentBinding,
        legacy_direct_tool: toolId,
        readiness: "legacy_direct_no_contract",
        reason:
          "Exposed via legacy getTools() wiring (safe-read surface or hand-coded entry); not in canonical contract registry.",
      };
    }
    return {
      tool_id: toolId,
      contract_present: false,
      implemented: null,
      dispatch_path: { surface: null, identifier: null },
      tier: null,
      env_binding: null,
      handler_present: handlerPresent,
      runtime_tool_id_present: runtimePresent,
      agent_binding: agentBinding,
      legacy_direct_tool: null,
      readiness: "unknown_tool",
      reason: "Tool id is not in the contract registry and not in any known legacy surface.",
    };
  }

  // Path B: contract exists. Project non-sensitive fields.
  const legacyDirect = CANONICAL_TO_LEGACY_DIRECT[toolId] ?? null;
  const base = {
    tool_id: toolId,
    contract_present: true,
    implemented: contract.implemented,
    dispatch_path: {
      surface: contract.dispatch_path.surface,
      identifier: contract.dispatch_path.identifier,
    },
    tier: contract.tier,
    // Only the binding name; never the value.
    env_binding: contract.env_binding ?? null,
    handler_present: handlerPresent,
    runtime_tool_id_present: runtimePresent,
    agent_binding: agentBinding,
    legacy_direct_tool: legacyDirect,
  };

  if (!contract.implemented) {
    return {
      ...base,
      readiness: "declared_not_implemented",
      reason: "Contract declares implemented=false; tool is not callable from any surface.",
    };
  }

  // implemented=true — three sub-cases.
  const dynamicSupportedSurface = contract.dispatch_path.surface === "fetch_path";
  if (dynamicSupportedSurface && handlerPresent && runtimePresent) {
    return {
      ...base,
      readiness: "dynamic_ready",
      reason:
        "Contract implemented, surface fetch_path, dynamic adapter handler bound, runtime registry exposes the tool_id.",
    };
  }

  if (legacyDirect) {
    return {
      ...base,
      readiness: "legacy_direct",
      reason:
        "Contract implemented; surfaced through legacy  safe-read direct wiring rather than the dynamic registry.",
    };
  }

  return {
    ...base,
    readiness: "contract_only_no_handler",
    reason:
      "Contract declares implemented=true, but no dynamic adapter handler and no legacy direct wiring exposes it.",
  };
}
