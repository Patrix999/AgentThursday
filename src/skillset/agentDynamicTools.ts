/**
 * generic agent-facing dynamic tool mapper.
 *
 * Walks the inspect-detail projection of currently loaded skillsets
 * (with an earlier revision env-binding capability-class downgrade already
 * applied), looks up each callable skill's tools in the contract
 * registry + agent dispatch registry, and emits an AI SDK
 * `tools` object the agent can spread into its `getTools()` output.
 *
 * Filter (a skill+tool pair is exposed only if ALL hold):
 *   1. skill.capability_class === "callable_tool_ready"
 *   2. tool contract exists and `implemented === true`
 *   3. tool contract dispatch_path.surface ∈ supported set
 *   4. dispatch registry has a handler for the canonical tool_id
 *
 * Tool name conversion: canonical `tool_id` (e.g. `"fyimd.convert_text"`)
 * → AI SDK key `tool_id.replace(/[^a-zA-Z0-9_]/g, "_")`. The canonical
 * id stays the event-name key (`tool.<canonical>.dispatch/result/error`)
 * so observability events remain stable across provider rename. No
 * provider-specific branching lives here.
 *
 * Description: composed from `skill.prompt_segment` (if present) and
 * `contract.description`, in that order, joined by " — ". The
 * dispatch registry never writes agent-facing description; the
 * authorship boundary stays at the skillset manifest + tool contract.
 */

import { tool } from "ai";

import { getContract, type ToolContract } from "./contractRegistry";
import {
  AGENT_DISPATCH_HANDLERS,
  type DispatchHandler,
} from "./dispatchRegistry";
import type { SkillDetailRow } from "./loader";
import { downgradeCapabilityClassByEnvBinding, summarizeLoaderDetail } from "./loader";
import type { LoaderState, SkillDescriptor } from "./types";
import {
  enrichManagerInputSummary,
  enrichManagerResultSummary,
} from "./managerToolEmission";
import { previewText } from "../safeTextPreview";

export type AgentDispatchSurface = "fetch_path";

const SUPPORTED_SURFACES: ReadonlySet<string> = new Set<AgentDispatchSurface>([
  "fetch_path",
]);

export interface DynamicToolBindingProof {
  ai_sdk_name: string;
  tool_id: string;
  skillset_id: string;
  skill_id: string;
  description: string;
  has_handler: boolean;
}

export interface BuildDynamicSkillToolsArgs {
  state: LoaderState;
  env: unknown;
  envLookup: (binding: string) => string | undefined;
  onDispatch?: (canonicalToolId: string, payload: Record<string, unknown>) => void;
  onResult?: (canonicalToolId: string, payload: Record<string, unknown>) => void;
  onError?: (canonicalToolId: string, payload: Record<string, unknown>) => void;
  // Override hook for tests; falls back to the live registries.
  contractsByToolId?: (toolId: string) => ToolContract | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlersByToolId?: (toolId: string) => DispatchHandler<any, any> | undefined;
  // optional per-handler context, threaded into `execute`
  // as the third arg. Stateful adapters (artifact.*) use it to reach
  // DO-side methods; stateless adapters ignore it.
  agentCtx?: unknown;
  // per-profile narrow. When set, candidates whose
  // `skillset_id` is not in this set are skipped (the dynamic tool
  // surface is restricted to the resolved effective skillset closure
  // for the active AgentProfile). When undefined, behavior is
  // unchanged: every loaded + non-operator-disabled skillset
  // contributes. The runtime-snapshot disable filter still wins —
  // this set layers ON TOP, not in place of, the snapshot's
  // operator-disabled filter.
  allowedSkillsetIds?: ReadonlySet<string>;
}

export function sanitizeAiSdkName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function composeAgentToolDescription(
  skill: Pick<SkillDescriptor, "prompt_segment">,
  contract: ToolContract,
): string {
  const skillFragment =
    typeof skill.prompt_segment === "string" ? skill.prompt_segment : "";
  const parts = [skillFragment, contract.description].filter(p => p.length > 0);
  return parts.join(" — ");
}

interface BoundCandidate {
  detailRow: SkillDetailRow;
  rawSkill: SkillDescriptor;
  skillsetId: string;
  contract: ToolContract;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: DispatchHandler<any, any>;
}

function collectBoundCandidates(args: BuildDynamicSkillToolsArgs): BoundCandidate[] {
  const contractLookup = args.contractsByToolId ?? getContract;
  const handlerLookup =
    args.handlersByToolId ??
    ((toolId: string) => AGENT_DISPATCH_HANDLERS.get(toolId));
  const detail = summarizeLoaderDetail(args.state);
  downgradeCapabilityClassByEnvBinding(detail, args.envLookup);
  const allowed = args.allowedSkillsetIds;
  const out: BoundCandidate[] = [];
  for (const entry of detail.entries) {
    if (entry.status !== "loaded") continue;
    // per-profile narrow. `allowed === undefined` keeps
    // legacy behavior (every loaded skillset contributes); a set
    // restricts to its members.
    if (allowed !== undefined && !allowed.has(entry.skillset_id)) continue;
    const cacheEntry = args.state.entries[entry.skillset_id];
    if (!cacheEntry) continue;
    for (const detailRow of entry.skills) {
      if (detailRow.capability_class !== "callable_tool_ready") continue;
      const rawSkill: SkillDescriptor | undefined = cacheEntry.manifest.skills.find(
        (s: SkillDescriptor) => s.id === detailRow.id,
      );
      if (!rawSkill) continue;
      for (const toolId of detailRow.tools) {
        const contract = contractLookup(toolId);
        if (!contract || !contract.implemented) continue;
        if (!SUPPORTED_SURFACES.has(contract.dispatch_path.surface)) continue;
        const handler = handlerLookup(toolId);
        if (!handler) continue;
        out.push({
          detailRow,
          rawSkill,
          skillsetId: entry.skillset_id,
          contract,
          handler,
        });
      }
    }
  }
  return out;
}

export function describeDynamicToolBindings(
  args: BuildDynamicSkillToolsArgs,
): DynamicToolBindingProof[] {
  return collectBoundCandidates(args).map(({ detailRow, rawSkill, skillsetId, contract, handler }) => ({
    ai_sdk_name: sanitizeAiSdkName(contract.tool_id),
    tool_id: contract.tool_id,
    skillset_id: skillsetId,
    skill_id: detailRow.id,
    description: composeAgentToolDescription(rawSkill, contract),
    has_handler: handler !== undefined,
  }));
}


export interface MissingHandlerReport {
  tool_id: string;
  skillset_id: string;
  skill_id: string;
  reason: "not_implemented" | "unsupported_surface" | "no_handler";
}

export function findMissingHandlers(args: BuildDynamicSkillToolsArgs): MissingHandlerReport[] {
  const contractLookup = args.contractsByToolId ?? getContract;
  const handlerLookup =
    args.handlersByToolId ??
    ((toolId: string) => AGENT_DISPATCH_HANDLERS.get(toolId));
  const detail = summarizeLoaderDetail(args.state);
  downgradeCapabilityClassByEnvBinding(detail, args.envLookup);
  const out: MissingHandlerReport[] = [];
  for (const entry of detail.entries) {
    if (entry.status !== "loaded") continue;
    for (const detailRow of entry.skills) {
      if (detailRow.capability_class !== "callable_tool_ready") continue;
      for (const toolId of detailRow.tools) {
        const contract = contractLookup(toolId);
        if (!contract || !contract.implemented) {
          out.push({ tool_id: toolId, skillset_id: entry.skillset_id, skill_id: detailRow.id, reason: "not_implemented" });
          continue;
        }
        if (!SUPPORTED_SURFACES.has(contract.dispatch_path.surface)) {
          out.push({ tool_id: toolId, skillset_id: entry.skillset_id, skill_id: detailRow.id, reason: "unsupported_surface" });
          continue;
        }
        if (!handlerLookup(toolId)) {
          out.push({ tool_id: toolId, skillset_id: entry.skillset_id, skill_id: detailRow.id, reason: "no_handler" });
        }
      }
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDynamicSkillTools(args: BuildDynamicSkillToolsArgs): Record<string, any> {
  const noop = () => {};
  const onDispatch = args.onDispatch ?? noop;
  const onResult = args.onResult ?? noop;
  const onError = args.onError ?? noop;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const { rawSkill, contract, handler } of collectBoundCandidates(args)) {
    const aiSdkName = sanitizeAiSdkName(contract.tool_id);
    const canonical = contract.tool_id;
    const description = composeAgentToolDescription(rawSkill, contract);
    out[aiSdkName] = tool({
      description,
      inputSchema: handler.inputSchema,
      execute: async (input: unknown) => {
        const inputObj =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const inputSummary: Record<string, unknown> = { tool: canonical };
        if (typeof inputObj.title === "string") {
          inputSummary.title_present = inputObj.title.length > 0;
        }
        if (typeof inputObj.content === "string") {
          inputSummary.content_bytes = inputObj.content.length;
        }
        if (canonical.startsWith("manager.")) {
          enrichManagerInputSummary(canonical, inputObj, inputSummary);
        }
        onDispatch(canonical, inputSummary);
        try {
          const result = await handler.execute(input, args.env, args.agentCtx);
          const resultRow = (result ?? {}) as Record<string, unknown>;
          const status = typeof resultRow.status === "string" ? resultRow.status : "unknown";
          const resultPayload: Record<string, unknown> = { tool: canonical, status };
          if (canonical.startsWith("manager.")) {
            enrichManagerResultSummary(canonical, resultRow, resultPayload);
          }
          onResult(canonical, resultPayload);
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorPayload: Record<string, unknown> = {
            tool: canonical,
            reason: "handler_exception",
          };
          if (canonical.startsWith("manager.")) {
            // manager handler errors can carry user-supplied
            // text (the agent's `text` arg surfaces in target-agent error
            // messages). Redact + cap before the payload reaches
            // event_log so raw inspect debug never sees ghp_/Bearer/
            // sk-/approval-token bytes. Mapper still re-redacts as
            // defense in depth.
            const safe = previewText(message, 200);
            errorPayload.message_snippet = safe.text;
            if (safe.truncated) errorPayload.message_truncated = true;
          } else {
            errorPayload.message_snippet = message.slice(0, 200);
          }
          onError(canonical, errorPayload);
          throw err;
        }
      },
    });
  }
  return out;
}
