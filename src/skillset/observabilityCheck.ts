/**
 * toolEvents observability consistency check.
 *
 * 178 §6.2 designates `toolEvents` as the **primary source** and
 * `trace.supplier.signal.summary[].steps[].toolCallNames` (after
 * 117 normalization, these arrive flattened as `toolCallNames` on
 * the per-task summary) as the **cross-check source**.
 *
 * If a tool name appears in trace but not in toolEvents, the fabric
 * is leaking observability — exactly the  gap  is meant to
 * close. This module produces a gap report so:
 *   - inspect can render `toolEvents_gap` warnings,
 *   - QA suites () can assert "no gap" as part of acceptance,
 *   - and downstream telemetry can alert on regression.
 *
 * Pure module: takes already-fetched arrays, returns a report. Caller
 * (server.ts inspect endpoint) handles SQL.
 */

export interface ToolEventLike {
  toolName: string;
}

/**
 * Extract `toolCallNames` from a parsed `supplier.signal.summary`
 * payload, tolerating four known shapes (per 187a spec):
 *
 *   1. { toolCallNames: [...] }
 *   2. { summary: { toolCallNames: [...] } }
 *   3. { summary: { steps: [{ toolCallNames: [...] }, ...] } }
 *   4. { steps: [{ toolCallNames: [...] }, ...] }
 *
 * Each shape contributes its array; results are flattened, deduped,
 * and filtered to non-empty strings. Normalization (strip `tool.` /
 * verb suffixes) is intentionally left to `computeToolEventsGap` so
 * the extractor stays a pure shape walker.
 */
export function extractTraceToolCallNames(payload: unknown): string[] {
  const collected = new Set<string>();
  const pushAll = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === "string" && item.length > 0) {
        collected.add(item);
      }
    }
  };
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  // shape 1: top-level
  pushAll(root.toolCallNames);
  // shape 4: top-level steps
  if (Array.isArray(root.steps)) {
    for (const step of root.steps) {
      if (step && typeof step === "object") {
        pushAll((step as Record<string, unknown>).toolCallNames);
      }
    }
  }
  // shape 2 + 3: under `summary`
  const summary = root.summary;
  if (summary && typeof summary === "object") {
    const s = summary as Record<string, unknown>;
    pushAll(s.toolCallNames);
    if (Array.isArray(s.steps)) {
      for (const step of s.steps) {
        if (step && typeof step === "object") {
          pushAll((step as Record<string, unknown>).toolCallNames);
        }
      }
    }
  }
  return Array.from(collected).sort();
}

export interface ToolEventsGapReport {
  traceTools: string[];
  toolEventsTools: string[];
  missingInToolEvents: string[];
  extraInToolEvents: string[];
  gapDetected: boolean;
}

/**
 *  — agent-facing snake_case tool names map back to the
 * canonical  dotted contract names. AI SDK forbids dots in tool
 * names so 188 had to register `repo_read` etc. on the agent surface
 * while the underlying dispatcher still emits `tool.repo.read.*`.
 * Without this mapping the gap checker would flag the snake_case
 * trace entries as "missing in toolEvents" even though the dotted
 * events are right there.
 *
 * Mapping is intentional one-way: agent name → contract name. New
 * AI-SDK names added to 188+ binding must be appended here.
 */
const AGENT_NAME_TO_CONTRACT: Record<string, string> = {
  repo_read: "repo.read",
  repo_grep: "repo.grep",
  git_status: "git.status",
  git_show: "git.show",
  gate_typecheck: "gate.typecheck",
  evidence_get: "evidence.get",
};

/**
 * Normalize a tool event name: strip the `tool.` prefix if present,
 * collapse `.dispatch` / `.result` / `.error` / `.approval_*` /
 * `.dry_run_succeeded` suffixes so the comparison runs on logical
 * tool names, then map any agent-facing snake_case name back to its
 * canonical dotted contract name (188a).
 */
function normalizeToolName(name: string): string {
  let n = name.trim();
  if (n.startsWith("tool.")) n = n.slice("tool.".length);
  // strip the trailing event verb if it matches a known suffix
  const suffixes = [
    ".dispatch",
    ".result",
    ".error",
    ".approval_request",
    ".approval_granted",
    ".approval_denied",
    ".dry_run_succeeded",
  ];
  for (const s of suffixes) {
    if (n.endsWith(s)) {
      n = n.slice(0, n.length - s.length);
      break;
    }
  }
  // 188a: agent-facing snake_case → canonical dotted contract name.
  if (Object.prototype.hasOwnProperty.call(AGENT_NAME_TO_CONTRACT, n)) {
    n = AGENT_NAME_TO_CONTRACT[n];
  }
  return n;
}

export function computeToolEventsGap(
  toolEvents: ReadonlyArray<ToolEventLike>,
  traceToolNames: ReadonlyArray<string>,
): ToolEventsGapReport {
  const traceSet = new Set<string>();
  for (const t of traceToolNames) {
    if (typeof t !== "string" || t.length === 0) continue;
    traceSet.add(normalizeToolName(t));
  }
  const eventsSet = new Set<string>();
  for (const ev of toolEvents) {
    if (!ev || typeof ev.toolName !== "string") continue;
    eventsSet.add(normalizeToolName(ev.toolName));
  }
  const missingInToolEvents = Array.from(traceSet)
    .filter(t => !eventsSet.has(t))
    .sort();
  const extraInToolEvents = Array.from(eventsSet)
    .filter(t => !traceSet.has(t))
    .sort();
  return {
    traceTools: Array.from(traceSet).sort(),
    toolEventsTools: Array.from(eventsSet).sort(),
    missingInToolEvents,
    extraInToolEvents,
    gapDetected: missingInToolEvents.length > 0,
  };
}
