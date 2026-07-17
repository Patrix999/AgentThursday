/**
 * Context inspect + reset pure helpers.
 *
 * Sanitize Think SDK `UIMessage[]` into a small, safe view-model the
 * inspect surface and CLI can show. NO sql, NO DO access here — caller
 * passes in `getMessages()` output and a sanitization budget; we return
 * a structured slice with raw prompt content / large tool payloads
 * stripped or truncated.
 *
 * Red lines (see milestone):
 *   - never expose system prompts / SOUL / secrets
 *   - never include reasoning parts (private)
 *   - never dump tool input/output in inspect payload — expose only tool metadata
 */
import type { UIMessage } from "ai";

export type SanitizedMessagePart =
  | { type: "text"; text: string; truncated: boolean }
  | {
      type: "tool";
      toolName: string | null;
      toolCallId: string | null;
      state: string | null;
      truncated: boolean;
    }
  | { type: "other"; kind: string };

export type SanitizedMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: SanitizedMessagePart[];
  partsDropped: number;
};

export type ContextInspectViewModel = {
  totalMessageCount: number;
  byRole: { user: number; assistant: number; system: number };
  visibleMessages: SanitizedMessage[];
  visibleStartIndex: number;
  truncated: boolean;
  sanitizedAt: number;
};

const DEFAULT_LAST_N = 20;
const DEFAULT_TEXT_BUDGET = 1200;

export function sanitizeMessage(
  msg: UIMessage,
  textBudget = DEFAULT_TEXT_BUDGET,
): SanitizedMessage {
  const parts: SanitizedMessagePart[] = [];
  let dropped = 0;
  for (const raw of msg.parts ?? []) {
    const p = raw as Record<string, unknown>;
    const t = typeof p.type === "string" ? (p.type as string) : "";
    if (t === "text") {
      const text = typeof p.text === "string" ? p.text : "";
      const cut = text.length > textBudget;
      parts.push({ type: "text", text: cut ? text.slice(0, textBudget) : text, truncated: cut });
    } else if (t === "reasoning") {
      // Private reasoning channel — never expose.
      dropped++;
    } else if (t.startsWith("tool-") || t === "dynamic-tool") {
      const toolName = typeof p.toolName === "string"
        ? p.toolName
        : (t.startsWith("tool-") ? t.slice("tool-".length) : null);
      const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : null;
      const state = typeof p.state === "string" ? p.state : null;
      // Do not expose tool input/output previews in inspect payloads.
      // The UI only needs metadata for local tool/tool-segment labels;
      // raw or previewed payloads can contain user/private content.
      const inputWasPresent = p.input !== undefined && p.input !== null;
      const outputWasPresent = (p.output ?? p.result) !== undefined && (p.output ?? p.result) !== null;
      parts.push({
        type: "tool",
        toolName,
        toolCallId,
        state,
        truncated: inputWasPresent || outputWasPresent,
      });
    } else if (t === "step-start") {
      // Boundary marker — useful but no content; drop silently.
      dropped++;
    } else {
      parts.push({ type: "other", kind: t || "unknown" });
    }
  }
  return {
    id: msg.id,
    role: msg.role,
    parts,
    partsDropped: dropped,
  };
}

/**
 * deterministic compact-summary builder. NO LLM call.
 * an earlier revision layered preserved-points lift onto an earlier revision's chronological
 * "Turns:" block. an earlier revision restructures the body so the main payload is
 * **role-separated**: user intent and assistant execution land in their
 * own deduped sections, with the chronological trace demoted to a small
 * truncated tail. Synthetic detection still keys off the first line
 * (`Compact summary of …`).
 *
 * Tool input/output is NEVER included — only tool *names*. Reasoning /
 * system parts are silently dropped. Wrapper boilerplate (an earlier revision
 * `BOILERPLATE_PATTERNS`) is stripped per message before extraction so
 * the summary doesn't echo Discord/untrusted-content framing.
 */
const COMPACT_PER_TURN_TEXT_BUDGET = 160;
const COMPACT_TOTAL_BUDGET = 4_000;
const ROLE_SECTION_BUDGET = 1_500;
const TURNS_TRACE_PER_LINE_BUDGET = 100;
const TURNS_TRACE_TAIL_COUNT = 5;
const PRESERVED_POINT_TEXT_BUDGET = 200;

export type CompactSummaryPreservedPoint = {
  index: number;
  reasons: string[];
  preview: string;
};

export type CompactSummaryInput = {
  messages: readonly UIMessage[];
  fromIndex: number; // inclusive
  toIndex: number;   // inclusive
  // medium-tier anchors lifted into a "preserved important
  // points" block at the top. Empty / absent → block is omitted but
  // role-separated sections still render.
  preservedPoints?: readonly CompactSummaryPreservedPoint[];
};

export type CompactSummary = {
  text: string;
  rangeSize: number;
  textCharsIncluded: number;
  truncated: boolean;
};

type RoleBullet = { text: string; toolNames: string[] };

function extractRoleBullet(m: UIMessage): RoleBullet | null {
  let preview = "";
  const toolNames: string[] = [];
  for (const raw of m.parts ?? []) {
    const p = raw as Record<string, unknown>;
    const t = typeof p.type === "string" ? (p.type as string) : "";
    if (t === "text" && typeof p.text === "string") {
      if (preview.length === 0) preview = p.text;
    } else if (t.startsWith("tool-") || t === "dynamic-tool") {
      const name = typeof p.toolName === "string"
        ? p.toolName
        : (t.startsWith("tool-") ? t.slice("tool-".length) : "");
      if (name && !toolNames.includes(name)) toolNames.push(name);
    }
  }
  const cleaned = stripBoilerplate(preview).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0 && toolNames.length === 0) return null;
  return { text: cleaned, toolNames };
}

function collectRoleBullets(slice: readonly UIMessage[], role: "user" | "assistant"): RoleBullet[] {
  const bullets: RoleBullet[] = [];
  const seen = new Set<string>();
  for (const m of slice) {
    if (m.role !== role) continue;
    const b = extractRoleBullet(m);
    if (b === null) continue;
    const key = `${b.text}::${b.toolNames.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(b);
  }
  return bullets;
}

function buildRoleSection(
  header: string,
  bullets: readonly RoleBullet[],
  budget: number,
  noun: string,
): { lines: string[]; truncated: boolean; charsUsed: number } {
  const lines: string[] = [header];
  let used = header.length + 1;
  let truncated = false;
  let included = 0;
  for (const b of bullets) {
    let body = b.text;
    if (body.length > COMPACT_PER_TURN_TEXT_BUDGET) {
      body = `${body.slice(0, COMPACT_PER_TURN_TEXT_BUDGET)}…`;
    }
    const toolSuffix = b.toolNames.length > 0 ? ` [tools: ${b.toolNames.join(", ")}]` : "";
    const line = body.length > 0 ? `- ${body}${toolSuffix}` : `- ${toolSuffix.trimStart()}`;
    if (used + line.length + 1 > budget) {
      const omitted = bullets.length - included;
      const trailer = `… (${omitted} more ${noun} message(s) omitted)`;
      lines.push(trailer);
      used += trailer.length + 1;
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    included++;
  }
  return { lines, truncated, charsUsed: used };
}

function buildTurnsTrace(
  slice: readonly UIMessage[],
  budget: number,
): { lines: string[]; truncated: boolean; charsUsed: number } {
  const tail = slice.slice(-TURNS_TRACE_TAIL_COUNT);
  const lines: string[] = [];
  let used = 0;
  let truncated = slice.length > tail.length;
  for (const m of tail) {
    if (m.role === "system") continue;
    const role = m.role === "user" ? "USER" : "AGENT";
    const b = extractRoleBullet(m);
    if (b === null) continue;
    let body = b.text;
    if (body.length > TURNS_TRACE_PER_LINE_BUDGET) {
      body = `${body.slice(0, TURNS_TRACE_PER_LINE_BUDGET)}…`;
    }
    const toolSuffix = b.toolNames.length > 0 ? ` [tools: ${b.toolNames.join(", ")}]` : "";
    const line = body.length > 0 ? `- ${role}${toolSuffix}: ${body}` : `- ${role}${toolSuffix}`;
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, truncated, charsUsed: used };
}

export function buildCompactSummary(input: CompactSummaryInput): CompactSummary {
  const { messages, fromIndex, toIndex, preservedPoints } = input;
  if (fromIndex < 0 || toIndex >= messages.length || toIndex < fromIndex) {
    throw new Error(`buildCompactSummary: invalid range [${fromIndex}..${toIndex}] for ${messages.length} messages`);
  }
  const slice = messages.slice(fromIndex, toIndex + 1);
  const header = `Compact summary of ${slice.length} message(s) [indices ${fromIndex}..${toIndex}], created ${new Date().toISOString()}.`;
  const lines: string[] = [header, ""];
  let totalChars = header.length + 1;
  let truncated = false;

  // 1. Important preserved points — an earlier revision. Highest priority below the
  //    header so they survive the global budget cap.
  if (preservedPoints && preservedPoints.length > 0) {
    const ppHeader = "Important preserved points from compacted range:";
    lines.push(ppHeader);
    totalChars += ppHeader.length + 1;
    for (const pp of preservedPoints) {
      const trimmedPreview = stripBoilerplate(pp.preview).replace(/\s+/g, " ").trim();
      const cappedPreview = trimmedPreview.length > PRESERVED_POINT_TEXT_BUDGET
        ? `${trimmedPreview.slice(0, PRESERVED_POINT_TEXT_BUDGET)}…`
        : trimmedPreview;
      const reasonLabel = pp.reasons.length > 0 ? `[${pp.reasons.join(", ")}] ` : "";
      const line = `- ${reasonLabel}#${pp.index}: ${cappedPreview}`;
      lines.push(line);
      totalChars += line.length + 1;
    }
    lines.push("");
    totalChars += 1;
  }

  // 2. Role-separated summaries — an earlier revision. User intent is consumable
  //    independently of assistant execution. Both are deduped against
  //    repeated boilerplate / identical messages so wrapper noise from
  //    the same upstream channel collapses to a single bullet.
  const userBullets = collectRoleBullets(slice, "user");
  const assistantBullets = collectRoleBullets(slice, "assistant");

  if (userBullets.length > 0) {
    const remaining = COMPACT_TOTAL_BUDGET - totalChars;
    const sectionBudget = Math.min(ROLE_SECTION_BUDGET, remaining);
    if (sectionBudget > "User messages summary:".length + 4) {
      const section = buildRoleSection("User messages summary:", userBullets, sectionBudget, "user");
      for (const line of section.lines) {
        lines.push(line);
        totalChars += line.length + 1;
      }
      lines.push("");
      totalChars += 1;
      if (section.truncated) truncated = true;
    } else {
      truncated = true;
    }
  }

  if (assistantBullets.length > 0) {
    const remaining = COMPACT_TOTAL_BUDGET - totalChars;
    const sectionBudget = Math.min(ROLE_SECTION_BUDGET, remaining);
    if (sectionBudget > "Assistant/model messages summary:".length + 4) {
      const section = buildRoleSection(
        "Assistant/model messages summary:",
        assistantBullets,
        sectionBudget,
        "assistant",
      );
      for (const line of section.lines) {
        lines.push(line);
        totalChars += line.length + 1;
      }
      lines.push("");
      totalChars += 1;
      if (section.truncated) truncated = true;
    } else {
      truncated = true;
    }
  }

  // 3. Optional chronological tail — fallback only. Skipped entirely if
  //    the role sections already consumed the budget.
  const traceHeader = "Turns (chronological tail):";
  if (totalChars + traceHeader.length + 4 < COMPACT_TOTAL_BUDGET) {
    const remaining = COMPACT_TOTAL_BUDGET - totalChars - (traceHeader.length + 1);
    if (remaining > 20) {
      const trace = buildTurnsTrace(slice, remaining);
      if (trace.lines.length > 0) {
        lines.push(traceHeader);
        totalChars += traceHeader.length + 1;
        for (const line of trace.lines) {
          lines.push(line);
          totalChars += line.length + 1;
        }
        if (trace.truncated) truncated = true;
      }
    } else {
      truncated = true;
    }
  } else {
    truncated = true;
  }

  const text = lines.join("\n");
  return {
    text,
    rangeSize: slice.length,
    textCharsIncluded: text.length,
    truncated,
  };
}

/**
 * Conversation Archive chunk builder. Produces ALL
 * messages from a context's message log without the an earlier revision `lastN`
 * cap, suitable for durable archival. Reuses an earlier revision sanitization
 * helpers + an earlier revision boilerplate stripping; never exposes raw system /
 * SOUL / reasoning / tool-payload content.
 *
 * Two text fields per chunk:
 *   - `text`: original sanitized turn text (audit-quality, kept verbatim)
 *   - `indexText`: boilerplate-stripped variant for search index reuse
 * Both are derived from the same sanitized parts; only `indexText`
 * passes through `stripBoilerplate` so the search side can reduce
 * Discord wrapper noise without losing the audit-side original.
 */
export type ArchiveChunkInput = {
  messageId: string;
  messageIndex: number;
  role: "user" | "assistant" | "system";
  text: string;
  indexText: string;
  isSyntheticCompaction: boolean;
};

export function buildArchiveChunks(messages: readonly UIMessage[]): ArchiveChunkInput[] {
  const chunks: ArchiveChunkInput[] = [];
  messages.forEach((m, i) => {
    const synthetic = isSyntheticCompactionMessage(m);
    let text = "";
    if (m.role === "system") {
      // an earlier revision contract: never expose system prompt / SOUL content.
      // The archive records that a system message existed at this
      // index but the body stays empty so a leak via search/audit is
      // structurally impossible.
      if (!synthetic) return;
    } else {
      const sanitized = sanitizeMessage(m);
      const parts: string[] = [];
      for (const p of sanitized.parts) {
        if (p.type === "text") {
          if (p.text.length > 0) parts.push(p.text);
        } else if (p.type === "tool" && p.toolName) {
          // Tool name only — never input/output payloads .
          parts.push(`[tool:${p.toolName}]`);
        }
      }
      text = parts.join("\n").trim();
    }
    if (text.length === 0 && !synthetic) return;
    const indexText = stripBoilerplate(text).replace(/\s+/g, " ").trim();
    chunks.push({
      messageId: m.id,
      messageIndex: i,
      role: m.role,
      text,
      indexText,
      isSyntheticCompaction: synthetic,
    });
  });
  return chunks;
}

/**
 * context snapshot view-model. Surface enough sanitized,
 * stable information for the an earlier revision anchor classifier and an earlier revision
 * compact planner to reason about the current model-visible view +
 * compaction overlay without reaching for raw SDK internals.
 *
 * Synthetic compaction detection (an earlier revision/an earlier revision smoke): the SDK
 * overlays a single message at the position of a compacted range;
 * empirically its id begins with `compaction_` today, while the earlier
 * spec guessed `compaction-`. Conservatively accept either prefix OR the
 * an earlier revision deterministic summary marker. Either signal is enough — both
 * sides should agree, but if a future SDK change shifts the marker we
 * still want planner-side caution.
 *
 * `compactedRanges` resolves `fromMessageId` / `toMessageId` against the
 * FULL message list (not the lastN slice). A range whose endpoints
 * cannot be resolved is surfaced with `isResolvableInCurrentView:false`
 * so the planner can flag it as a hazard rather than silently ignoring
 * it.
 */

const COMPACT_SUMMARY_TEXT_MARKER = "Compact summary of";
const SNAPSHOT_SUMMARY_PREVIEW_BUDGET = 600;

export type ContextSnapshotMessage = {
  id: string;
  index: number;
  role: "user" | "assistant" | "system";
  parts: SanitizedMessagePart[];
  partsDropped: number;
  isSyntheticCompaction: boolean;
  anchorEligible: boolean;
};

export type ContextSnapshotCompactedRange = {
  id: string;
  fromMessageId: string;
  toMessageId: string;
  summaryPreview: string;
  summaryLength: number;
  createdAt: string;
  fromIndex: number | null;
  toIndex: number | null;
  isResolvableInCurrentView: boolean;
};

export type ContextSnapshotViewModel = {
  totalMessageCount: number;
  visibleStartIndex: number;
  messages: ContextSnapshotMessage[];
  compactedRanges: ContextSnapshotCompactedRange[];
  messageIsSyntheticCompaction: Record<string, boolean>;
  sanitizedAt: number;
};

export type StoredCompactionInput = {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
};

// SDK observed empirically (an earlier revision smoke 2026-05-01) to prefix synthetic
// compaction message ids with `compaction_<rangeId>` (underscore). The
// an earlier revision spec mentioned `compaction-` (hyphen); accept both so a future
// SDK rename in either direction doesn't silently disable the guard.
// The text-marker fallback below catches shaped summaries even
// if the prefix changes again.
export function isSyntheticCompactionMessage(msg: UIMessage): boolean {
  if (typeof msg.id === "string" && /^compaction[_-]/.test(msg.id)) return true;
  for (const raw of msg.parts ?? []) {
    const p = raw as Record<string, unknown>;
    if (typeof p.type === "string" && p.type === "text") {
      const t = typeof p.text === "string" ? p.text : "";
      if (t.startsWith(COMPACT_SUMMARY_TEXT_MARKER)) return true;
    }
  }
  return false;
}

export function buildContextSnapshot(
  messages: readonly UIMessage[],
  compactions: readonly StoredCompactionInput[],
  lastN: number = DEFAULT_LAST_N,
): ContextSnapshotViewModel {
  const total = messages.length;
  const cap = Math.max(0, Math.min(lastN, 200));
  const start = Math.max(0, total - cap);

  const idIndex = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.id) idIndex.set(m.id, i);
  });

  const messageIsSyntheticCompaction: Record<string, boolean> = {};
  for (const m of messages) {
    if (m.id) messageIsSyntheticCompaction[m.id] = isSyntheticCompactionMessage(m);
  }

  const slice = messages.slice(start);
  const out: ContextSnapshotMessage[] = [];
  slice.forEach((m, i) => {
    const index = start + i;
    const synthetic = !!messageIsSyntheticCompaction[m.id];
    let parts: SanitizedMessagePart[];
    let dropped: number;
    if (m.role === "system") {
      parts = [];
      dropped = (m.parts ?? []).length;
    } else {
      const sanitized = sanitizeMessage(m);
      parts = sanitized.parts;
      dropped = sanitized.partsDropped;
    }
    const anchorEligible = m.role !== "system" && !synthetic;
    out.push({
      id: m.id,
      index,
      role: m.role,
      parts,
      partsDropped: dropped,
      isSyntheticCompaction: synthetic,
      anchorEligible,
    });
  });

  const compactedRanges: ContextSnapshotCompactedRange[] = compactions.map((c) => {
    const fiRaw = idIndex.get(c.fromMessageId);
    const tiRaw = idIndex.get(c.toMessageId);
    const fromIndex = fiRaw === undefined ? null : fiRaw;
    const toIndex = tiRaw === undefined ? null : tiRaw;
    const len = c.summary.length;
    const summaryPreview = len > SNAPSHOT_SUMMARY_PREVIEW_BUDGET
      ? `${c.summary.slice(0, SNAPSHOT_SUMMARY_PREVIEW_BUDGET)}…`
      : c.summary;
    return {
      id: c.id,
      fromMessageId: c.fromMessageId,
      toMessageId: c.toMessageId,
      summaryPreview,
      summaryLength: len,
      createdAt: c.createdAt,
      fromIndex,
      toIndex,
      isResolvableInCurrentView: fromIndex !== null && toIndex !== null,
    };
  });

  return {
    totalMessageCount: total,
    visibleStartIndex: start,
    messages: out,
    compactedRanges,
    messageIsSyntheticCompaction,
    sanitizedAt: Date.now(),
  };
}

/**
 * Build a sanitized view-model over the last `lastN` messages. System
 * messages are kept in `byRole` counts but filtered from `visibleMessages`
 * — Think SDK shouldn't store them, but if any leak in we still hide
 * their content from the inspect surface.
 */
export function buildContextInspect(
  messages: readonly UIMessage[],
  lastN: number = DEFAULT_LAST_N,
): ContextInspectViewModel {
  const total = messages.length;
  const byRole = { user: 0, assistant: 0, system: 0 };
  for (const m of messages) {
    if (m.role === "user") byRole.user++;
    else if (m.role === "assistant") byRole.assistant++;
    else if (m.role === "system") byRole.system++;
  }
  const cap = Math.max(0, Math.min(lastN, 200));
  const start = Math.max(0, total - cap);
  const slice = messages.slice(start);
  const visibleMessages: SanitizedMessage[] = [];
  for (const m of slice) {
    if (m.role === "system") continue;
    visibleMessages.push(sanitizeMessage(m));
  }
  return {
    totalMessageCount: total,
    byRole,
    visibleMessages,
    visibleStartIndex: start,
    truncated: total > cap,
    sanitizedAt: Date.now(),
  };
}

/**
 * deterministic anchor classifier.
 *
 * Labels each message in a an earlier revision snapshot with anchor reasons so the
 * an earlier revision planner can later refuse to compact ranges that contain
 * anchors. Pure: no LLM, no DO access; uses snapshot's already-sanitized
 * text parts only — never touches raw system / SOUL / reasoning / tool
 * payloads.
 *
 * Anchor decision = OR of any matched reason. System messages and
 * synthetic compaction messages are forced to `isAnchor:false` regardless
 * of content.
 */

export type ContextAnchorReason =
  | "first-k"
  | "explicit-anchor"
  | "rule-or-constraint"
  | "long-user-briefing"
  | "memory-or-workflow-instruction"
  | "handoff-or-version-marker";

export type ContextAnchorClassification = {
  id: string;
  index: number;
  role: "user" | "assistant" | "system";
  isAnchor: boolean;
  reasons: ContextAnchorReason[];
  confidence: "high" | "medium" | "low";
  preview: string;
};

// compact ≠ purge. Hard-preserve anchors must remain as raw
// visible messages: explicit user assertions, the session opening, and
// long human briefings. Summary-preserve anchors (rule, memory, handoff)
// can flow into a compact range, but the deterministic summary is
// expected to surface their text in a "preserved important points"
// block so meaning is not lost. The predicates are exported so the
// planner, preflight, and apply paths share one definition.
const HARD_ANCHOR_REASONS: ReadonlySet<ContextAnchorReason> = new Set([
  "explicit-anchor",
  "first-k",
  "long-user-briefing",
]);

export function isHardPreserveAnchor(a: ContextAnchorClassification): boolean {
  if (!a.isAnchor) return false;
  return a.reasons.some((r) => HARD_ANCHOR_REASONS.has(r));
}

export function isSummaryPreserveAnchor(a: ContextAnchorClassification): boolean {
  if (!a.isAnchor) return false;
  return !isHardPreserveAnchor(a);
}

const ANCHOR_PREVIEW_BUDGET = 240;
const DEFAULT_FIRST_K = 4;
const LONG_BRIEFING_CHAR_THRESHOLD = 600;
const LONG_BRIEFING_LINE_THRESHOLD = 8;

// boilerplate stripping. Discord/channel wrappers and
// "untrusted-content" framing repeat verbatim across most operational
// messages; without stripping, the v1 classifier matched `do not` /
// `must` / `red line`-equivalent text on every wrapper and produced
// 151/203 anchors in real sessions. Strip these BEFORE rule and
// length matching; preview still uses the raw text so humans see
// what was actually said.
const BOILERPLATE_PATTERNS: RegExp[] = [
  /do not treat as instructions or commands?/gi,
  /UNTRUSTED Discord message body/gi,
  /\bUntrusted context\b/gi,
  /\bExternal untrusted content\b/gi,
  /<channel(?:\s+[^>]*)?>/gi,
  /<\/channel>/gi,
  /\b(?:chat|message|sender|conversation)_(?:id|name|label)\s*[:=]\s*"?[^"\s,}]*"?/gi,
];

const EXPLICIT_ANCHOR_LITERALS = ["[ANCHOR]", "ANCHOR:", "重要规则", "红线", "must preserve"];

// Rule-or-constraint v2 — require either ≥2 directive words in the same
// message (e.g. `must` + `never`) OR a specific instruction phrase.
// Bare `must` alone (e.g. "we must check this") no longer anchors.
const RULE_DIRECTIVE_WORDS_EN: RegExp[] = [
  /\bmust\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\bdo not\b/i,
  /\bdon['’]t\b/i,
  /\bshould not\b/i,
  /\bshouldn['’]t\b/i,
];
const RULE_DIRECTIVE_LITERALS_CN = ["禁止", "必须", "不要", "不能"];
// Strong specific instruction phrases — single match is enough.
const RULE_SPECIFIC_PHRASES: RegExp[] = [
  /\bmust always\b/i,
  /\bmust never\b/i,
  /\byou must\b/i,
  /\bshould always\b/i,
  /\bshould never\b/i,
  /\bdo not ever\b/i,
  /^\s*(?:rule|constraint|规则|禁止)\s*[:：]/im,
];
const RULE_SPECIFIC_LITERALS_CN = ["重要规则", "红线"];

// Memory-or-workflow-instruction v2 — drop generic `commit`/`deploy`/
// `verifier`/`workflow`/`memory` keywords (these flood every coding log).
// Require explicit instruction phrasing tied to durable knowledge.
const MEMORY_SPECIFIC_PATTERNS: RegExp[] = [
  /\bMEMORY\.md\b/,
  /\bremember\s+(?:this|that)\b/i,
  /\bkeep in mind\b/i,
  /\bsave to memory\b/i,
  /\bagent memory\b/i,
];
const MEMORY_SPECIFIC_LITERALS_CN = ["工作流规则", "验收规则", "记住", "请记住", "记忆中"];

// Handoff-or-version-marker v2 — drop generic `Card N`, `v2`, ``,
// `handoff`, `checkpoint`. Require unambiguous handoff phrasing.
const HANDOFF_SPECIFIC_PATTERNS: RegExp[] = [
  /\bhandoff summary\b/i,
  /\bcontext save\b/i,
  /\bpre-compaction\b/i,
  /\bsession handoff\b/i,
];
const HANDOFF_SPECIFIC_LITERALS_CN = ["交接摘要", "上下文保存"];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function extractAnchorText(parts: ContextSnapshotMessage["parts"]): string {
  let out = "";
  for (const p of parts) {
    if (p.type === "text") {
      out += (out.length > 0 ? "\n" : "") + p.text;
    }
  }
  return out;
}

function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of BOILERPLATE_PATTERNS) {
    out = out.replace(re, " ");
  }
  return out;
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n++;
  return n;
}

function countLiteralMatches(text: string, literals: readonly string[]): number {
  let n = 0;
  for (const lit of literals) if (text.includes(lit)) n++;
  return n;
}

function buildPreview(text: string, budget = ANCHOR_PREVIEW_BUDGET): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > budget ? `${single.slice(0, budget)}…` : single;
}

function matchesAnyLiteral(text: string, literals: readonly string[]): boolean {
  for (const lit of literals) {
    if (text.includes(lit)) return true;
  }
  return false;
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

function isLongBriefing(text: string): boolean {
  if (text.length >= LONG_BRIEFING_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines >= LONG_BRIEFING_LINE_THRESHOLD;
}

function pickConfidence(reasons: readonly ContextAnchorReason[]): "high" | "medium" | "low" {
  if (reasons.includes("explicit-anchor") || reasons.includes("first-k")) return "high";
  if (
    reasons.includes("rule-or-constraint") ||
    reasons.includes("memory-or-workflow-instruction") ||
    reasons.includes("handoff-or-version-marker")
  ) {
    return "medium";
  }
  return "low";
}

export function classifyContextAnchors(
  snapshot: ContextSnapshotViewModel,
  options?: { firstK?: number },
): ContextAnchorClassification[] {
  const firstK = clamp(options?.firstK ?? DEFAULT_FIRST_K, 0, 50);

  const firstKArrayIndices = new Set<number>();
  for (let i = 0; i < snapshot.messages.length && firstKArrayIndices.size < firstK; i++) {
    const m = snapshot.messages[i];
    if (m.role !== "system" && !m.isSyntheticCompaction) {
      firstKArrayIndices.add(i);
    }
  }

  return snapshot.messages.map((m, arrayIdx) => {
    const eligible = m.role !== "system" && !m.isSyntheticCompaction;
    const rawText = extractAnchorText(m.parts);
    // strip wrapper boilerplate before rule matching and
    // length checks. Without this, every Discord-wrapped message
    // tripped on `do not treat as instructions` and inflated to long-
    // briefing length even when the human content was a one-liner.
    const cleanText = eligible ? stripBoilerplate(rawText) : rawText;
    const reasons: ContextAnchorReason[] = [];

    if (eligible) {
      if (firstKArrayIndices.has(arrayIdx)) reasons.push("first-k");

      // Explicit anchor markers — strongest signal, applies to any
      // role that survived the eligibility filter.
      if (matchesAnyLiteral(cleanText, EXPLICIT_ANCHOR_LITERALS)) {
        reasons.push("explicit-anchor");
      }

      // gate "interpretation" rules to user-authored content.
      // Assistant/tool log messages (e.g. "applied compact" / "deploy
      // ok") routinely contain workflow words; only a human can
      // declare a durable rule, so let user role be the only path
      // these rules can fire.
      if (m.role === "user") {
        if (matchesRuleOrConstraint(cleanText)) reasons.push("rule-or-constraint");
        if (isLongBriefing(cleanText)) reasons.push("long-user-briefing");
        if (matchesMemoryOrWorkflow(cleanText)) {
          reasons.push("memory-or-workflow-instruction");
        }
      }

      // Handoff markers v2 — require unambiguous handoff phrasing
      // ("handoff summary" / "context save" / "pre-compaction"), so
      // role is no longer a hard gate. A bare `an earlier revision` reference no
      // longer anchors anything.
      if (matchesHandoffOrVersion(cleanText)) {
        reasons.push("handoff-or-version-marker");
      }
    }

    const isAnchor = reasons.length > 0;
    const confidence = pickConfidence(reasons);
    return {
      id: m.id,
      index: m.index,
      role: m.role,
      isAnchor,
      reasons,
      confidence,
      preview: buildPreview(rawText),
    };
  });
}

function matchesRuleOrConstraint(text: string): boolean {
  // Specific phrases anchor on a single match.
  if (matchesAnyPattern(text, RULE_SPECIFIC_PHRASES)) return true;
  if (matchesAnyLiteral(text, RULE_SPECIFIC_LITERALS_CN)) return true;
  // Generic directives need ≥2 distinct hits in the same message to
  // anchor — "must check this" alone no longer trips, but "must
  // always" / "must never" / two separate directives stacked do.
  const hits =
    countMatches(text, RULE_DIRECTIVE_WORDS_EN)
    + countLiteralMatches(text, RULE_DIRECTIVE_LITERALS_CN);
  return hits >= 2;
}

function matchesMemoryOrWorkflow(text: string): boolean {
  if (matchesAnyPattern(text, MEMORY_SPECIFIC_PATTERNS)) return true;
  if (matchesAnyLiteral(text, MEMORY_SPECIFIC_LITERALS_CN)) return true;
  return false;
}

function matchesHandoffOrVersion(text: string): boolean {
  if (matchesAnyPattern(text, HANDOFF_SPECIFIC_PATTERNS)) return true;
  if (matchesAnyLiteral(text, HANDOFF_SPECIFIC_LITERALS_CN)) return true;
  return false;
}

/**
 * deterministic compact-plan builder. Pure: no LLM, no DO
 * access, no audit row. Consumes a an earlier revision snapshot + an earlier revision anchor
 * classifications and returns a dry-run plan describing safe contiguous
 * non-anchor middle ranges that are candidates for compaction. The
 * planner refuses to propose ranges that would cross anchors, synthetic
 * compaction nodes, or hazardous unresolved compaction record endpoints.
 *
 * The plan is consumed by `applyCompactPlan`, which re-runs all pre-flight
 * checks against a fresh snapshot before each `addCompaction` call. The
 * planner's role here is best-effort proposal, not enforcement.
 */

export type CompactPlanStrategy = {
  lastN: number;
  firstK: number;
  keepRecent: number;
  minRangeMessages: number;
  pressureThreshold: number;
};

export type CompactPlanPreservedView = {
  id: string;
  index: number;
  reasons: string[];
  preview: string;
};

export type SummaryPreservedAnchor = {
  id: string;
  index: number;
  reasons: string[];
  preview: string;
};

export type CompactPlanRangeView = {
  rangeId: string;
  fromMessageId: string;
  toMessageId: string;
  fromIndex: number;
  toIndex: number;
  messageCount: number;
  estimatedReduction: number;
  previews: string[];
  // medium-tier anchors (rule-or-constraint / memory-or-
  // workflow / handoff-or-version) that fall inside this range. The
  // apply path enriches the deterministic an earlier revision summary with these
  // points so meaning is preserved even though the original messages
  // are no longer raw-visible. Optional + omitted when empty.
  summaryPreservedAnchors?: SummaryPreservedAnchor[];
};

export type CompactPlanRejection = {
  reason: string;
  detail: string;
};

export type CompactPlanResultView = {
  planId: string;
  strategy: CompactPlanStrategy;
  snapshot: { totalMessageCount: number; visibleStartIndex: number; sanitizedAt: number };
  pressure: { beforeMessages: number; estimatedAfterMessages: number; estimatedReduction: number };
  preserved: CompactPlanPreservedView[];
  ranges: CompactPlanRangeView[];
  rejected: CompactPlanRejection[];
  createdAt: string;
};

const COMPACT_PLAN_PREVIEW_BUDGET = 120;

function shortPreview(parts: ContextSnapshotMessage["parts"]): string {
  const text = extractAnchorText(parts);
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > COMPACT_PLAN_PREVIEW_BUDGET
    ? `${single.slice(0, COMPACT_PLAN_PREVIEW_BUDGET)}…`
    : single;
}

function randomToken(): string {
  // Crypto random preferred; fall back to Math.random when running in a
  // context that doesn't expose `crypto.randomUUID` (older Node test runs).
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function buildCompactPlan(
  snapshot: ContextSnapshotViewModel,
  anchors: readonly ContextAnchorClassification[],
  options: CompactPlanStrategy,
): CompactPlanResultView {
  const { keepRecent, minRangeMessages, pressureThreshold } = options;
  const total = snapshot.totalMessageCount;
  const messages = snapshot.messages;

  const anchorById = new Map<string, ContextAnchorClassification>();
  for (const a of anchors) anchorById.set(a.id, a);

  const preservedIds = new Set<string>();
  const preserved: CompactPlanPreservedView[] = [];

  // 1. Synthetic compactions, system messages, and HARD-tier anchors
  //    are preserved as raw visible messages. medium anchors
  //    (rule-or-constraint / memory-or-workflow / handoff-or-version)
  //    deliberately do NOT break runs here; they flow into compact
  //    ranges and the apply path lifts their text into the summary.
  for (const m of messages) {
    if (m.isSyntheticCompaction) {
      preservedIds.add(m.id);
      preserved.push({
        id: m.id,
        index: m.index,
        reasons: ["synthetic-compaction"],
        preview: shortPreview(m.parts),
      });
      continue;
    }
    if (m.role === "system") {
      preservedIds.add(m.id);
      preserved.push({
        id: m.id,
        index: m.index,
        reasons: ["system-message"],
        preview: "",
      });
      continue;
    }
    const anchor = anchorById.get(m.id);
    if (anchor && isHardPreserveAnchor(anchor)) {
      preservedIds.add(m.id);
      preserved.push({
        id: m.id,
        index: m.index,
        reasons: anchor.reasons,
        preview: shortPreview(m.parts),
      });
    }
  }

  // 2. Last keepRecent non-synthetic messages preserved as current
  //    working set.
  let kept = 0;
  for (let i = messages.length - 1; i >= 0 && kept < keepRecent; i--) {
    const m = messages[i];
    if (m.isSyntheticCompaction) continue;
    if (!preservedIds.has(m.id)) {
      preservedIds.add(m.id);
      preserved.push({
        id: m.id,
        index: m.index,
        reasons: ["recent-tail"],
        preview: shortPreview(m.parts),
      });
    }
    kept++;
  }

  // 3. Hazard: messages that are endpoints of unresolved stored
  //    compactions get preserved. Their sibling endpoint may be missing
  //    entirely, but any side that DID resolve into the visible view is
  //    treated as opaque rather than compacted across.
  const rejected: CompactPlanRejection[] = [];
  for (const cr of snapshot.compactedRanges) {
    if (cr.isResolvableInCurrentView) continue;
    if (cr.fromIndex !== null) {
      const m = messages.find((x) => x.id === cr.fromMessageId);
      if (m && !preservedIds.has(m.id)) {
        preservedIds.add(m.id);
        preserved.push({
          id: m.id,
          index: m.index,
          reasons: [`hazard-from-unresolved-compaction:${cr.id}`],
          preview: shortPreview(m.parts),
        });
      }
    }
    if (cr.toIndex !== null) {
      const m = messages.find((x) => x.id === cr.toMessageId);
      if (m && !preservedIds.has(m.id)) {
        preservedIds.add(m.id);
        preserved.push({
          id: m.id,
          index: m.index,
          reasons: [`hazard-to-unresolved-compaction:${cr.id}`],
          preview: shortPreview(m.parts),
        });
      }
    }
    rejected.push({
      reason: "unresolved_compaction_record",
      detail: `compactionId=${cr.id} fromIndex=${cr.fromIndex} toIndex=${cr.toIndex}`,
    });
  }

  // 4. Pressure short-circuit: total below threshold → no-op plan.
  if (total < pressureThreshold) {
    rejected.push({
      reason: "below_pressure_threshold",
      detail: `totalMessageCount=${total} pressureThreshold=${pressureThreshold}`,
    });
    return {
      planId: randomToken(),
      strategy: options,
      snapshot: {
        totalMessageCount: snapshot.totalMessageCount,
        visibleStartIndex: snapshot.visibleStartIndex,
        sanitizedAt: snapshot.sanitizedAt,
      },
      pressure: {
        beforeMessages: total,
        estimatedAfterMessages: total,
        estimatedReduction: 0,
      },
      preserved,
      ranges: [],
      rejected,
      createdAt: new Date().toISOString(),
    };
  }

  // 5. Walk visible messages and collect maximal contiguous runs of
  //    non-preserved, non-synthetic messages. Synthetic messages break
  //    runs (they're already preserved but reaffirm the boundary).
  //    Medium anchors  are NOT in preservedIds so they flow
  //    through; flushRun lifts them into `summaryPreservedAnchors`.
  const ranges: CompactPlanRangeView[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const breakHere = preservedIds.has(m.id) || m.isSyntheticCompaction;
    if (!breakHere) {
      if (runStart === null) runStart = i;
      continue;
    }
    if (runStart !== null) {
      flushRun(messages, runStart, i - 1, minRangeMessages, ranges, rejected, anchorById);
      runStart = null;
    }
  }
  if (runStart !== null) {
    flushRun(messages, runStart, messages.length - 1, minRangeMessages, ranges, rejected, anchorById);
  }

  // 6. overclassification diagnostic. If anchors dominate
  //    the view AND the dominant kind is generic-keyword (no explicit
  //    anchor / first-k / long-briefing component), surface a warning
  //    so the operator notices the classifier likely mis-fired before
  //    accepting the tiny resulting plan. Does not change the plan
  //    itself — explicit anchors stay preserved either way.
  const eligibleAnchors = anchors.filter((a) => a.isAnchor);
  if (snapshot.totalMessageCount > 0 && eligibleAnchors.length > 0) {
    const ratio = eligibleAnchors.length / snapshot.totalMessageCount;
    let genericOnly = 0;
    for (const a of eligibleAnchors) {
      const hasStrong = a.reasons.some(
        (r) => r === "explicit-anchor" || r === "first-k" || r === "long-user-briefing",
      );
      if (!hasStrong) genericOnly++;
    }
    const genericShare = genericOnly / eligibleAnchors.length;
    if (ratio > 0.5 && genericShare > 0.5) {
      rejected.push({
        reason: "anchor_overclassification_suspected",
        detail: `anchors=${eligibleAnchors.length}/${snapshot.totalMessageCount} (${(ratio * 100).toFixed(0)}%); ${genericOnly} of ${eligibleAnchors.length} anchors are generic-keyword only`,
      });
    }
  }

  // 7. Estimate reduction (single synthetic message replaces the range).
  const estReduction = ranges.reduce((acc, r) => acc + (r.messageCount - 1), 0);
  return {
    planId: randomToken(),
    strategy: options,
    snapshot: {
      totalMessageCount: snapshot.totalMessageCount,
      visibleStartIndex: snapshot.visibleStartIndex,
      sanitizedAt: snapshot.sanitizedAt,
    },
    pressure: {
      beforeMessages: total,
      estimatedAfterMessages: total - estReduction,
      estimatedReduction: estReduction,
    },
    preserved,
    ranges,
    rejected,
    createdAt: new Date().toISOString(),
  };
}

function flushRun(
  messages: readonly ContextSnapshotMessage[],
  startArrayIdx: number,
  endArrayIdx: number,
  minRange: number,
  ranges: CompactPlanRangeView[],
  rejected: CompactPlanRejection[],
  anchorById: ReadonlyMap<string, ContextAnchorClassification>,
): void {
  const messageCount = endArrayIdx - startArrayIdx + 1;
  if (messageCount < minRange) {
    rejected.push({
      reason: "range_too_small",
      detail: `count=${messageCount} minRangeMessages=${minRange} startIndex=${messages[startArrayIdx].index} endIndex=${messages[endArrayIdx].index}`,
    });
    return;
  }
  const fromMsg = messages[startArrayIdx];
  const toMsg = messages[endArrayIdx];
  const previews: string[] = [];
  for (let i = startArrayIdx; i <= endArrayIdx && previews.length < 3; i++) {
    previews.push(shortPreview(messages[i].parts));
  }
  // collect medium-tier anchors that fell into this range
  // so the apply path can preserve their text in the summary. Hard
  // anchors never reach here (they break runs upstream).
  const summaryPreservedAnchors: SummaryPreservedAnchor[] = [];
  for (let i = startArrayIdx; i <= endArrayIdx; i++) {
    const m = messages[i];
    const a = anchorById.get(m.id);
    if (a && isSummaryPreserveAnchor(a)) {
      summaryPreservedAnchors.push({
        id: m.id,
        index: m.index,
        reasons: a.reasons,
        preview: shortPreview(m.parts),
      });
    }
  }
  const range: CompactPlanRangeView = {
    rangeId: randomToken(),
    fromMessageId: fromMsg.id,
    toMessageId: toMsg.id,
    fromIndex: fromMsg.index,
    toIndex: toMsg.index,
    messageCount,
    estimatedReduction: messageCount - 1,
    previews,
  };
  if (summaryPreservedAnchors.length > 0) {
    range.summaryPreservedAnchors = summaryPreservedAnchors;
  }
  ranges.push(range);
}
