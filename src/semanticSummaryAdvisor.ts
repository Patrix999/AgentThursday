/**
 *  v2  — Semantic Summary Advisor scaffold.
 *
 * Optional model-assisted layer that runs ON TOP of the deterministic
 *  compact summary. The advisor never replaces the deterministic
 * substrate —  stays the default, fallback-safe path; this
 * module produces an enriched summary text + audit metadata, with
 * automatic fallback whenever the model is unavailable, errors, times
 * out, or returns output that fails the deterministic validator.
 *
 * Harness research lessons applied (see  spec):
 *   1. Harness state is ground truth — advisor input includes
 *      sanitized audit evidence, never raw tool payloads / reasoning.
 *   2. Fallback-safe — null client / failure / validation breach all
 *      route to the deterministic fallback without blocking compaction.
 *   3. Tool output offloaded — prompt template instructs the model to
 *      reference paths / commit ids / event ids rather than embed raw
 *      payloads.
 *   4. Bounded outputs + audit — every advisor invocation records
 *      `audit{}` with prompt version, model id, latency, and quality
 *      flags so the operator can review what happened.
 *   5. Action-class taxonomy — prompt asks the model to classify
 *      assistant content into harness action classes.
 *   6. Generic capability + strong constraints + strong verification —
 *      the validator enforces preserved-anchor presence, prefix
 *      preservation, and leak detection on every model output.
 *
 * This file is a SCAFFOLD: it defines types, prompt template, validator,
 * and orchestrator, and exposes `runSemanticSummaryAdvisor()` taking an
 * optional `SemanticAdvisorClient`. No concrete model client is wired
 * inside the worker yet — when none is configured, the advisor returns
 * `{ ok:false, fallbackReason:"no_advisor_client_configured" }` and the
 * apply path uses the deterministic summary unchanged.
 */

export type SemanticSummaryRole = "user" | "assistant";

export type SemanticSummaryPreservedPoint = {
  index: number;
  reasons: string[];
  preview: string;
};

export type SemanticSummarySourceTurn = {
  id: string;
  index: number;
  role: SemanticSummaryRole;
  text: string;
  toolNames: string[];
};

export type SemanticSummaryAuditEvidence = {
  eventId?: string;
  eventType?: string;
  // Sanitized — strings/numbers/bools or short paths only. Caller is
  // responsible for stripping secrets/payloads before handing in.
  payload?: Record<string, string | number | boolean | null>;
};

export type SemanticSummaryAdvisorRequest = {
  fromMessageId: string;
  toMessageId: string;
  sourceCompactionId: string | null;
  deterministicSummary: string;
  preservedPoints: readonly SemanticSummaryPreservedPoint[];
  sanitizedSource: readonly SemanticSummarySourceTurn[];
  auditEvidence?: readonly SemanticSummaryAuditEvidence[];
  // Operator hint: phase boundary that triggered this run. Used in audit
  // for later analysis (does semantic advisor help more at task
  // boundaries than mid-debug?).
  trigger?: "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";
};

export type SemanticSummaryQualityFlag =
  | "model_unavailable"
  | "model_timeout"
  | "model_error"
  | "anchor_violation_detected"
  | "header_missing"
  | "raw_payload_leak_detected"
  | "input_truncated"
  | "output_truncated"
  | "low_confidence";

export type SemanticMemoryCandidateType = "fact" | "instruction" | "decision" | "task" | "event";

export type SemanticMemoryCandidate = {
  type: SemanticMemoryCandidateType;
  text: string;
  // Source pointers, e.g. ["msg:#12", "file:src/foo.ts", "commit:abc123"].
  sourceRefs: string[];
};

export type SemanticSummaryTrigger = "manual" | "high_pressure" | "phase_boundary" | "degradation_suspicion";

export type SemanticSummaryAudit = {
  sourceCompactionId: string | null;
  fromMessageId: string;
  toMessageId: string;
  deterministicSummaryHash: string;
  semanticModel: string | null;
  semanticPromptVersion: string;
  trigger: SemanticSummaryTrigger | null;
  createdAt: string;
  fallbackReason: string | null;
  qualityFlags: SemanticSummaryQualityFlag[];
  latencyMs: number | null;
};

export type SemanticSummaryAdvisorResult = {
  ok: boolean;
  // Enriched summary text when ok===true; null when ok===false (caller
  // uses deterministic fallback).
  enrichedSummary: string | null;
  audit: SemanticSummaryAudit;
  memoryCandidates: SemanticMemoryCandidate[];
};

export type ModelCallRequest = {
  systemPrompt: string;
  userMessage: string;
  promptVersion: string;
  // Hard timeout the orchestrator should impose. Client SHOULD honor it
  // and reject if exceeded; the orchestrator additionally races on its
  // own setTimeout for defense-in-depth.
  timeoutMs: number;
};

export type ModelCallResponse = {
  text: string;
  latencyMs: number;
  modelId: string;
};

export type SemanticAdvisorClient = {
  // Stable identifier for audit (e.g. "workers-ai/kimi-k2"). Read once
  // at call time; not assumed to be a constant.
  readonly modelId: string;
  callModel(request: ModelCallRequest): Promise<ModelCallResponse>;
};

export const SEMANTIC_PROMPT_VERSION = "v1.0";
export const SEMANTIC_DEFAULT_TIMEOUT_MS = 12_000;
const SEMANTIC_MAX_OUTPUT_CHARS = 8_000;
const COMPACT_HEADER_PREFIX = "Compact summary of ";
const SEMANTIC_BLOCK_HEADER = "Semantic summary:";

// Cheap deterministic 32-bit FNV-1a hash. Adequate for fingerprinting
// the deterministic summary in audit rows; not a cryptographic hash.
export function hashSummaryForAudit(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a32:${h.toString(16).padStart(8, "0")}`;
}

const SECRET_LEAK_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBEGIN [A-Z ]+PRIVATE KEY\b/i,
];

const PAYLOAD_LEAK_PATTERNS: RegExp[] = [
  /\breasoning(?:_text|Trace)?\s*[:=]/i,
  /\bsystem prompt\s*[:=]/i,
  /\braw tool output\b/i,
];

export function buildSemanticAdvisorPrompt(
  req: SemanticSummaryAdvisorRequest,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt = [
    "You are a context compaction advisor.",
    "Produce a concise *Semantic summary:* block that will be inserted into a deterministic compaction summary.",
    "",
    "Hard constraints (violation = the deterministic summary will be used instead, audited as quality failure):",
    "1. Do NOT invent facts not present in the inputs.",
    "2. Preserve every line in the deterministic 'Important preserved points' block VERBATIM in your output (you may quote with the same text).",
    "3. Do NOT include raw tool input/output, raw reasoning text, secrets, or untrusted-content wrapper boilerplate.",
    "4. Prefer references — file paths, commit ids, event ids, deploy versions — over copying payloads.",
    "5. Mark superseded ideas as superseded; do not silently delete them.",
    "6. Keep uncertainty explicit (\"unverified\", \"claimed\", \"not yet observed\").",
    "",
    "Output format (Markdown):",
    "Semantic summary:",
    "- User intent / decisions: ...",
    "- Assistant actions / conclusions: ...",
    "- Current state / unresolved next steps: ...",
    "- Superseded or discarded context: ...",
    "- Evidence references: ...",
    "",
    "Classify each assistant action in one of the harness action classes when relevant:",
    "tool_dispatch | artifact_update | verification | handoff | claim_only | superseded.",
    "",
    "If you are uncertain whether a claim is supported by audited evidence, mark it `claim_only`.",
    "Output ONLY the `Semantic summary:` block — no preamble, no closing remarks, no other sections.",
  ].join("\n");

  const lines: string[] = [];
  lines.push(`Range: messages [${req.fromMessageId} .. ${req.toMessageId}]`);
  if (req.trigger) lines.push(`Trigger: ${req.trigger}`);
  if (req.sourceCompactionId) lines.push(`Compaction: ${req.sourceCompactionId}`);
  lines.push("");
  lines.push("=== Deterministic compact summary (substrate, do not contradict) ===");
  lines.push(req.deterministicSummary);
  lines.push("");
  if (req.preservedPoints.length > 0) {
    lines.push("=== Preserved points (must remain verbatim in your output) ===");
    for (const pp of req.preservedPoints) {
      const preview = pp.preview.replace(/\s+/g, " ").trim();
      const reasonLabel = pp.reasons.length > 0 ? `[${pp.reasons.join(", ")}] ` : "";
      lines.push(`- ${reasonLabel}#${pp.index}: ${preview}`);
    }
    lines.push("");
  }
  if (req.sanitizedSource.length > 0) {
    lines.push("=== Sanitized source slice ===");
    for (const t of req.sanitizedSource) {
      const role = t.role === "user" ? "USER" : "AGENT";
      const toolSuffix = t.toolNames.length > 0 ? ` [tools: ${t.toolNames.join(", ")}]` : "";
      lines.push(`- #${t.index} ${role}${toolSuffix}: ${t.text}`);
    }
    lines.push("");
  }
  if (req.auditEvidence && req.auditEvidence.length > 0) {
    lines.push("=== Audit evidence (harness ground truth, prefer these over assistant narration) ===");
    for (const e of req.auditEvidence) {
      const id = e.eventId ?? "?";
      const type = e.eventType ?? "?";
      const payloadKv = e.payload
        ? Object.entries(e.payload)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ")
        : "";
      lines.push(`- ${id} ${type} ${payloadKv}`.trimEnd());
    }
    lines.push("");
  }
  lines.push("Now produce the `Semantic summary:` block per the system prompt rules.");

  return { systemPrompt, userMessage: lines.join("\n") };
}

export type SemanticValidationResult = {
  ok: boolean;
  flags: SemanticSummaryQualityFlag[];
  reason: string | null;
};

export function validateSemanticSummary(
  modelOutput: string,
  preservedPoints: readonly SemanticSummaryPreservedPoint[],
): SemanticValidationResult {
  const flags: SemanticSummaryQualityFlag[] = [];

  if (modelOutput.length === 0) {
    return { ok: false, flags: ["model_error"], reason: "empty_output" };
  }
  if (modelOutput.length > SEMANTIC_MAX_OUTPUT_CHARS) {
    flags.push("output_truncated");
  }
  // The advisor block, when inserted by the orchestrator, must be
  // wrapped above the deterministic body and below the deterministic
  // header. Refuse model output that already injects the
  // `Compact summary of` header — it would compete with the
  // deterministic header and break synthetic detection.
  if (modelOutput.includes(COMPACT_HEADER_PREFIX)) {
    return {
      ok: false,
      flags: [...flags, "anchor_violation_detected"],
      reason: "model_output_includes_deterministic_header",
    };
  }
  // Output must open with the labeled block. Strip leading whitespace
  // before checking. A semantic advisor response without the explicit
  // label is too ambiguous to splice safely into a compact summary.
  const trimmed = modelOutput.trimStart();
  if (!trimmed.startsWith(SEMANTIC_BLOCK_HEADER)) {
    return {
      ok: false,
      flags: [...flags, "header_missing"],
      reason: "semantic_header_missing",
    };
  }
  // Anchor preservation: every preserved-point preview must appear in
  // the model output verbatim after whitespace normalization.
  // is an advisor scaffold, so keep the validator strict: if the model
  // cannot repeat the preserved point, the deterministic summary wins.
  const normalizedOutput = modelOutput.replace(/\s+/g, " ");
  for (const pp of preservedPoints) {
    const needle = pp.preview.replace(/\s+/g, " ").trim();
    if (needle.length === 0) continue;
    if (!normalizedOutput.includes(needle)) {
      return {
        ok: false,
        flags: [...flags, "anchor_violation_detected"],
        reason: `preserved_point_missing:#${pp.index}`,
      };
    }
  }
  for (const re of SECRET_LEAK_PATTERNS) {
    if (re.test(modelOutput)) {
      return {
        ok: false,
        flags: [...flags, "raw_payload_leak_detected"],
        reason: "secret_pattern_detected",
      };
    }
  }
  for (const re of PAYLOAD_LEAK_PATTERNS) {
    if (re.test(modelOutput)) {
      return {
        ok: false,
        flags: [...flags, "raw_payload_leak_detected"],
        reason: "payload_pattern_detected",
      };
    }
  }
  return { ok: true, flags, reason: null };
}

export function spliceSemanticBlockIntoSummary(
  deterministicSummary: string,
  semanticBlock: string,
): string {
  const trimmedBlock = semanticBlock.trimEnd();
  const lines = deterministicSummary.split("\n");
  if (lines.length === 0) {
    // Defensive: empty deterministic should never happen. Return as-is.
    return deterministicSummary;
  }
  const header = lines[0];
  // Keep preserved points as the first high-priority body section when
  // present, matching the /145 safety ordering. If there is no
  // preserved-points block, insert immediately after the header.
  const preservedIdx = lines.findIndex((line) => line === "Important preserved points from compacted range:");
  if (preservedIdx >= 0) {
    let insertIdx = preservedIdx + 1;
    while (insertIdx < lines.length && lines[insertIdx].trim().length > 0) insertIdx++;
    const before = lines.slice(0, insertIdx).join("\n");
    const after = lines.slice(insertIdx).join("\n");
    return `${before}\n\n${trimmedBlock}${after.length > 0 ? `\n${after}` : ""}`;
  }
  const rest = lines.slice(1).join("\n");
  return `${header}\n\n${trimmedBlock}\n${rest.startsWith("\n") ? rest : `\n${rest}`}`;
}

export async function runSemanticSummaryAdvisor(
  req: SemanticSummaryAdvisorRequest,
  client: SemanticAdvisorClient | null,
  options?: { timeoutMs?: number },
): Promise<SemanticSummaryAdvisorResult> {
  const createdAt = new Date().toISOString();
  const deterministicSummaryHash = hashSummaryForAudit(req.deterministicSummary);
  const baseAudit = {
    sourceCompactionId: req.sourceCompactionId,
    fromMessageId: req.fromMessageId,
    toMessageId: req.toMessageId,
    deterministicSummaryHash,
    semanticPromptVersion: SEMANTIC_PROMPT_VERSION,
    trigger: req.trigger ?? null,
    createdAt,
    latencyMs: null as number | null,
  };

  if (!client) {
    return {
      ok: false,
      enrichedSummary: null,
      audit: {
        ...baseAudit,
        semanticModel: null,
        fallbackReason: "no_advisor_client_configured",
        qualityFlags: ["model_unavailable"],
      },
      memoryCandidates: [],
    };
  }

  const { systemPrompt, userMessage } = buildSemanticAdvisorPrompt(req);
  const timeoutMs = options?.timeoutMs ?? SEMANTIC_DEFAULT_TIMEOUT_MS;

  let response: ModelCallResponse;
  try {
    response = await raceTimeout(
      client.callModel({
        systemPrompt,
        userMessage,
        promptVersion: SEMANTIC_PROMPT_VERSION,
        timeoutMs,
      }),
      timeoutMs,
    );
  } catch (e) {
    const isTimeout = e instanceof Error && e.message === "advisor_timeout";
    return {
      ok: false,
      enrichedSummary: null,
      audit: {
        ...baseAudit,
        semanticModel: client.modelId,
        fallbackReason: isTimeout ? "model_timeout" : `model_error:${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
        qualityFlags: [isTimeout ? "model_timeout" : "model_error"],
      },
      memoryCandidates: [],
    };
  }

  const validation = validateSemanticSummary(response.text, req.preservedPoints);
  if (!validation.ok) {
    return {
      ok: false,
      enrichedSummary: null,
      audit: {
        ...baseAudit,
        semanticModel: response.modelId,
        latencyMs: response.latencyMs,
        fallbackReason: `validation_failed:${validation.reason ?? "unknown"}`,
        qualityFlags: validation.flags,
      },
      memoryCandidates: [],
    };
  }

  const enrichedSummary = spliceSemanticBlockIntoSummary(req.deterministicSummary, response.text);
  return {
    ok: true,
    enrichedSummary,
    audit: {
      ...baseAudit,
      semanticModel: response.modelId,
      latencyMs: response.latencyMs,
      fallbackReason: null,
      qualityFlags: validation.flags,
    },
    // Memory candidate extraction is intentionally deferred — the
    // current scaffold returns []. A future card can add a deterministic
    // parser over the model output's "User intent / decisions" bullets.
    memoryCandidates: [],
  };
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("advisor_timeout")), ms);
    }),
  ]);
}
