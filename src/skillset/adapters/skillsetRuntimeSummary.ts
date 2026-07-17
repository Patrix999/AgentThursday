/**
 * demo adapter for the YAML-sourced `skillset.runtime_summary`
 * tool contract.
 *
 * Reads the current skillset runtime snapshot (no operator-disable
 * state — that lives on the agent SQL surface, which a generic
 * dispatch handler does not have access to per the design target's
 * adapter contract) and returns a non-sensitive subset suitable for
 * the agent and small-d to self-inspect.
 *
 * Side effects: none. No secret read, no network egress, no write.
 *
 * Registration: top-level `registerDispatchHandler()` call. The
 * `tool_id` literal is intentionally absent from `dispatchRegistry.ts`
 * — it lives here so adding a new tool requires zero edits to the
 * registry module itself.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  buildSkillsetRuntimeSnapshot,
  summarizeSnapshot,
} from "../runtimeSnapshot";

const TOOL_ID = "skillset.runtime_summary";

export interface SkillsetRuntimeSummaryEvidence {
  schema_version: string;
  skillset_ids: { loaded: string[]; rejected: string[] };
  tool_ids: string[];
  total_soul_token_estimate: number;
  per_skillset_token_cap: number;
  total_soul_token_cap: number;
  status: "ok";
}

const inputSchema = z.object({}).strict();

registerDispatchHandler<Record<string, never>, SkillsetRuntimeSummaryEvidence>({
  tool_id: TOOL_ID,
  inputSchema,
  execute: async (_input, env) => {
    const envRec = (env ?? {}) as Record<string, unknown>;
    const snap = buildSkillsetRuntimeSnapshot({
      env: envRec,
      envLookup: b => {
        const v = envRec[b];
        return typeof v === "string" ? v : undefined;
      },
      reload_count: 0,
    });
    const summary = summarizeSnapshot(snap);
    return {
      schema_version: summary.schema_version,
      skillset_ids: {
        loaded: [...summary.skillset_ids.loaded],
        rejected: [...summary.skillset_ids.rejected],
      },
      tool_ids: [...summary.tool_ids],
      total_soul_token_estimate: summary.total_soul_token_estimate,
      per_skillset_token_cap: summary.per_skillset_token_cap,
      total_soul_token_cap: summary.total_soul_token_cap,
      status: "ok",
    };
  },
});
