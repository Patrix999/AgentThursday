/**
 * `ChannelHubAgent` propose-patch artifact helpers, extracted
 * from `src/channelHub.ts`.
 *
 * `proposePatchArtifactImpl(agent, input)` and
 * `inspectPatchArtifactsImpl(agent, input)` carry the same behavior the
 * inline @callable methods previously had. The decorator + public method
 * signature stay on `ChannelHubAgent`; only the body delegates here.
 *
 * Redaction contract preserved verbatim:
 *  - `inspect` strips `patch_text`; only `patch_text_length` (UTF-8
 *    bytes) is surfaced.
 *  - `propose` fails closed on policy reject (no row written).
 */

import type { Agent } from "agents";
import {
  ARTIFACT_ID_RE,
  BASE_SHA_RE,
  PATCH_TEXT_MAX_BYTES,
  SUMMARY_MAX_BYTES,
  computePatchInputHash,
  evaluatePatchPolicy,
  generatePatchArtifactId,
  type PatchPolicyResult,
} from "../skillset/patchPolicy";
import {
  type PatchArtifactInspectRow,
  safeParseArray,
  safeParsePolicyCheck,
  safeParseRedactionCheck,
} from "./mappers";

export type ChannelHubPatchArtifactsHost = Agent<Env, Record<string, never>>;

export type ProposePatchArtifactInput = {
  tool_id?: unknown;
  target_paths?: unknown;
  patch_text?: unknown;
  summary?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
  envelope_id?: unknown;
  conversation_id?: unknown;
  base_sha?: unknown;
};

export type ProposePatchArtifactResult =
  | { ok: true; artifact_id: string; row: PatchArtifactInspectRow }
  | {
      ok: false;
      error: string;
      detail?: {
        denied_paths?: { path: string; reason: string }[];
        redaction_hits?: { category: string; count: number }[];
        policy_version?: string;
      };
    };

export async function proposePatchArtifactImpl(
  agent: ChannelHubPatchArtifactsHost,
  input: ProposePatchArtifactInput,
): Promise<ProposePatchArtifactResult> {
  const ID_RE = /^[A-Za-z0-9_.:\-\/]{1,256}$/;

  const toolId = typeof input.tool_id === "string" ? input.tool_id.trim() : "";
  if (!ID_RE.test(toolId)) {
    return { ok: false, error: "tool_id_invalid" };
  }

  if (!Array.isArray(input.target_paths)) {
    return { ok: false, error: "target_paths_required" };
  }
  if (input.target_paths.length === 0) {
    return { ok: false, error: "target_paths_empty" };
  }
  if (input.target_paths.length > 32) {
    return { ok: false, error: "target_paths_too_many" };
  }
  const targetPaths: string[] = [];
  for (const p of input.target_paths) {
    if (typeof p !== "string") {
      return { ok: false, error: "target_paths_non_string" };
    }
    targetPaths.push(p);
  }

  const patchText = typeof input.patch_text === "string" ? input.patch_text : "";
  if (patchText.length === 0) {
    return { ok: false, error: "patch_text_required" };
  }
  // Byte length cap. UTF-8 byte length, not char count.
  const patchBytes = new TextEncoder().encode(patchText).byteLength;
  if (patchBytes > PATCH_TEXT_MAX_BYTES) {
    return { ok: false, error: "patch_text_too_large" };
  }

  const summaryRaw = typeof input.summary === "string" ? input.summary : "";
  if (summaryRaw.length === 0) {
    return { ok: false, error: "summary_required" };
  }
  const summaryBytes = new TextEncoder().encode(summaryRaw).byteLength;
  if (summaryBytes > SUMMARY_MAX_BYTES) {
    return { ok: false, error: "summary_too_large" };
  }
  const summary = summaryRaw;

  const agentId = typeof input.agent_id === "string" ? input.agent_id.trim() : "";
  if (!ID_RE.test(agentId)) {
    return { ok: false, error: "agent_id_invalid" };
  }
  const taskId = typeof input.task_id === "string" && input.task_id.length > 0
    ? input.task_id.trim() : null;
  if (taskId !== null && !ID_RE.test(taskId)) {
    return { ok: false, error: "task_id_invalid" };
  }
  const envelopeId = typeof input.envelope_id === "string" && input.envelope_id.length > 0
    ? input.envelope_id.trim() : null;
  if (envelopeId !== null && !ID_RE.test(envelopeId)) {
    return { ok: false, error: "envelope_id_invalid" };
  }
  const conversationId = typeof input.conversation_id === "string" && input.conversation_id.length > 0
    ? input.conversation_id.trim() : null;
  if (conversationId !== null && !ID_RE.test(conversationId)) {
    return { ok: false, error: "conversation_id_invalid" };
  }

  // optional caller-supplied 40-hex git SHA. Stored as the
  // pinned base tree the patch was authored against; `applyPatchDryRun`
  // compares it (case-insensitively) to the sandbox-resolved
  // `head_sha` and fails closed on mismatch without consuming the
  // approval. Null is allowed for historical compat; null-base
  // artifacts skip the mismatch check.
  const baseShaRaw = typeof input.base_sha === "string" && input.base_sha.length > 0
    ? input.base_sha.trim() : null;
  if (baseShaRaw !== null && !BASE_SHA_RE.test(baseShaRaw)) {
    return { ok: false, error: "base_sha_invalid" };
  }
  const baseSha = baseShaRaw === null ? null : baseShaRaw.toLowerCase();

  const policy: PatchPolicyResult = evaluatePatchPolicy({
    target_paths: targetPaths,
    patch_text: patchText,
    summary,
  });

  if (!policy.passed) {
    return {
      ok: false,
      error: "policy_failed",
      detail: {
        denied_paths: policy.denied_paths,
        redaction_hits: policy.redaction_hits,
        policy_version: policy.policy_version,
      },
    };
  }

  const inputHash = await computePatchInputHash({
    tool_id: toolId,
    target_paths: policy.allowed_paths,
    patch_text: patchText,
  });

  const artifactId = generatePatchArtifactId();
  const now = Date.now();
  const targetPathsJson = JSON.stringify(policy.allowed_paths);
  const policyCheckJson = JSON.stringify({
    passed: true,
    allowed_paths: policy.allowed_paths,
    denied_paths: [],
    policy_version: policy.policy_version,
  });
  const redactionCheckJson = JSON.stringify({
    passed: true,
    hits: [],
    policy_version: policy.policy_version,
  });

  agent.sql`
    INSERT INTO propose_patch_artifacts (
      artifact_id, kind, status, created_at,
      agent_id, task_id, envelope_id, conversation_id,
      tool_id, target_paths, input_hash,
      patch_format, patch_text, summary,
      policy_check, redaction_check, policy_version,
      base_sha
    ) VALUES (
      ${artifactId}, 'propose_patch', 'proposed', ${now},
      ${agentId}, ${taskId}, ${envelopeId}, ${conversationId},
      ${toolId}, ${targetPathsJson}, ${inputHash},
      'unified_diff', ${patchText}, ${summary},
      ${policyCheckJson}, ${redactionCheckJson}, ${policy.policy_version},
      ${baseSha}
    )
  `;

  const row: PatchArtifactInspectRow = {
    artifact_id: artifactId,
    kind: "propose_patch",
    status: "proposed",
    created_at: now,
    agent_id: agentId,
    task_id: taskId,
    envelope_id: envelopeId,
    conversation_id: conversationId,
    tool_id: toolId,
    target_paths: policy.allowed_paths,
    input_hash: inputHash,
    patch_format: "unified_diff",
    patch_text_length: patchBytes,
    summary,
    policy_check: {
      passed: true,
      allowed_paths: policy.allowed_paths,
      denied_paths: [],
      policy_version: policy.policy_version,
    },
    redaction_check: {
      passed: true,
      hits: [],
      policy_version: policy.policy_version,
    },
    policy_version: policy.policy_version,
    base_sha: baseSha,
  };

  return { ok: true, artifact_id: artifactId, row };
}

export type InspectPatchArtifactsInput = {
  artifact_id?: string;
  status?: "proposed" | "all";
  limit?: number;
};

export function inspectPatchArtifactsImpl(
  agent: ChannelHubPatchArtifactsHost,
  input: InspectPatchArtifactsInput,
): { rows: PatchArtifactInspectRow[] } {
  const limitRaw = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  type ArtifactQRow = {
    artifact_id: string;
    kind: string;
    status: string;
    created_at: number;
    agent_id: string;
    task_id: string | null;
    envelope_id: string | null;
    conversation_id: string | null;
    tool_id: string;
    target_paths: string;
    input_hash: string;
    patch_format: string;
    patch_text: string;
    summary: string;
    policy_check: string;
    redaction_check: string;
    policy_version: string;
    base_sha: string | null;
  };

  let rows: ArtifactQRow[] = [];
  if (typeof input.artifact_id === "string" && input.artifact_id.length > 0) {
    if (!ARTIFACT_ID_RE.test(input.artifact_id)) return { rows: [] };
    rows = agent.sql<ArtifactQRow>`
      SELECT artifact_id, kind, status, created_at,
             agent_id, task_id, envelope_id, conversation_id,
             tool_id, target_paths, input_hash,
             patch_format, patch_text, summary,
             policy_check, redaction_check, policy_version,
             base_sha
      FROM propose_patch_artifacts
      WHERE artifact_id = ${input.artifact_id}
      LIMIT 1
    `;
  } else {
    const status = input.status ?? "proposed";
    if (status === "all") {
      rows = agent.sql<ArtifactQRow>`
        SELECT artifact_id, kind, status, created_at,
               agent_id, task_id, envelope_id, conversation_id,
               tool_id, target_paths, input_hash,
               patch_format, patch_text, summary,
               policy_check, redaction_check, policy_version,
               base_sha
        FROM propose_patch_artifacts
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (status === "proposed") {
      rows = agent.sql<ArtifactQRow>`
        SELECT artifact_id, kind, status, created_at,
               agent_id, task_id, envelope_id, conversation_id,
               tool_id, target_paths, input_hash,
               patch_format, patch_text, summary,
               policy_check, redaction_check, policy_version,
               base_sha
        FROM propose_patch_artifacts
        WHERE status = 'proposed'
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      return { rows: [] };
    }
  }

  const inspectRows: PatchArtifactInspectRow[] = rows.map((r) => {
    const targetPaths = safeParseArray<string>(r.target_paths);
    const patchBytes = new TextEncoder().encode(r.patch_text).byteLength;
    const policyCheck = safeParsePolicyCheck(r.policy_check);
    const redactionCheck = safeParseRedactionCheck(r.redaction_check);
    return {
      artifact_id: r.artifact_id,
      kind: r.kind,
      status: r.status,
      created_at: r.created_at,
      agent_id: r.agent_id,
      task_id: r.task_id,
      envelope_id: r.envelope_id,
      conversation_id: r.conversation_id,
      tool_id: r.tool_id,
      target_paths: targetPaths,
      input_hash: r.input_hash,
      patch_format: r.patch_format,
      patch_text_length: patchBytes,
      summary: r.summary,
      policy_check: policyCheck,
      redaction_check: redactionCheck,
      policy_version: r.policy_version,
      base_sha: r.base_sha,
    };
  });
  return { rows: inspectRows };
}
