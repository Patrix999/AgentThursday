/**
 * Action UI Intent backend builder.
 *
 * Pure derive-on-read translation layer: takes recent `event_log` rows
 * (the same shape `getInspectSnapshot()` already pulls into `trace[]`)
 * and produces a capped, schema-validated `ActionUiIntent[]` view that
 * 's frontend ActivityFeed consumes.
 *
 * v1 invariants (per kanban + milestone red lines):
 *   - **No persisted intent event** — derived fresh on every inspect read.
 *     Avoids schema churn cascading into consumers (/119/121).
 *   - **No model-declared `@component`** — that's + P2; v1 only maps
 *     known event types to a fixed set of component names.
 *   - **Raw payload hidden by default** — generic cards include only
 *     event type / timestamp / taskId / short summary. Tool events do
 *     NOT carry full prompts, raw Discord bodies, raw provider payloads,
 *     or secrets through this surface.  will do per-tool richer
 *     extraction with explicit sanitization.
 *   - **Raw `trace[]` unchanged** — intents are an INDEX, not a
 *     replacement.
 *
 * Pure: no I/O, no env, no SDK. Caller (`AgentThursdayAgent`) feeds rows in.
 */

export type ActionUiIntentType =
  | "agent.degradation"
  | "agent.pause"
  | "generic.tool_event"
  | "generic.event";

export type ActionUiIntentPriority = "primary" | "secondary" | "debug";

export type ActionUiIntentRegion = "top" | "feed" | "debug";

export type ActionUiIntentSize = "compact" | "medium" | "large";

export type ActionUiIntent = {
  id: string;
  taskId: string | null;
  sourceEventType: string;
  sourceEventAt: number;
  type: ActionUiIntentType;
  priority: ActionUiIntentPriority;
  title: string;
  summary?: string;
  component: {
    name: "DegradationCard" | "PauseCard" | "GenericToolEventCard" | "GenericEventCard";
    props: Record<string, unknown>;
  };
  placementHint: {
    region: ActionUiIntentRegion;
    size: ActionUiIntentSize;
    focusPath?: string | null;
  };
  safety: {
    rawPayloadHidden: boolean;
    truncated: boolean;
  };
  createdAt: number;
};

export type ActionUiIntentSourceRow = {
  event_type: string;
  payload: string;
  created_at: number;
  trace_id: string | null;
};

export type BuildIntentsOptions = {
  /** Max number of rows to consider. Caller should already cap, but
   * defending against runaway inputs is cheap. Default 100. */
  rowLimit?: number;
  /** Max intents to emit (newest-first). Default 30. */
  intentLimit?: number;
  /** Now timestamp for `createdAt`. Defaults to `Date.now()`. */
  now?: number;
};

const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_INTENT_LIMIT = 30;
const TITLE_CAP = 80;
const SUMMARY_CAP = 200;

function truncate(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, cap), truncated: true };
}

function safeParse(payload: string): { value: Record<string, unknown> | null; raw: string } {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, raw: payload };
    }
    return { value: null, raw: payload };
  } catch {
    return { value: null, raw: payload };
  }
}

function strField(p: Record<string, unknown> | null, key: string): string | null {
  if (!p) return null;
  const v = p[key];
  return typeof v === "string" ? v : null;
}

function arrField<T = unknown>(p: Record<string, unknown> | null, key: string): T[] {
  if (!p) return [];
  const v = p[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

function buildIntentId(row: ActionUiIntentSourceRow): string {
  // Stable per-row id. event_type + created_at uniquely identifies a row
  // in our event_log under normal load (two events sharing exact ms is
  // rare and would just produce a duplicate UI card, not a crash).
  return `${row.event_type}-${row.created_at}`;
}

/**
 * Map `degradation.summary` rows for inspect/diagnostics. the operator clarified
 * degradation/pause should remain conversation-first in the default user
 * flow, so v1 keeps these intents in the debug region rather than
 * top-pinning them into the future ActivityFeed shell.
 */
function mapDegradationSummary(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const state = (parsed && typeof parsed.state === "string") ? parsed.state : "normal";
  const reasons = arrField<string>(parsed, "reasons");
  const evidenceRefs = arrField<string>(parsed, "evidenceRefs");
  const taskId = strField(parsed, "taskId");
  const recommendedAction = strField(parsed, "recommendedAction");
  const titleCore = `Degradation: ${state}`;
  const title = truncate(titleCore, TITLE_CAP).text;
  const summarySrc = reasons.length > 0
    ? `${state} — ${reasons.join(", ")}`
    : `${state}`;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "agent.degradation",
    priority: "debug",
    title,
    summary: summaryT.text,
    component: {
      name: "DegradationCard",
      props: {
        state,
        reasons,
        evidenceRefs,
        recommendedAction,
        modelProfile: parsed?.modelProfile ?? null,
      },
    },
    placementHint: {
      region: "debug",
      size: state === "normal" ? "compact" : "medium",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: false,
      truncated: summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * Map pause-related lifecycle events for inspect/diagnostics. The
 * default user-facing pause/resume behavior remains conversational
 * (), not a forced visible web component.
 */
function mapPause(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const taskId = strField(parsed, "taskId");
  const reasons = arrField<string>(parsed, "reasons");
  const evidenceRefs = arrField<string>(parsed, "evidenceRefs");
  const recommendedAction = strField(parsed, "recommendedAction");
  const subtype = row.event_type === "loop.pause.awaiting_resume"
    ? "awaiting-resume"
    : "needs-human";
  const titleCore = subtype === "awaiting-resume"
    ? "Pause: awaiting resume"
    : "Pause: needs human";
  const summarySrc = reasons.length > 0
    ? `${subtype} — ${reasons.join(", ")}`
    : subtype;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "agent.pause",
    priority: "debug",
    title: truncate(titleCore, TITLE_CAP).text,
    summary: summaryT.text,
    component: {
      name: "PauseCard",
      props: {
        subtype,
        reasons,
        evidenceRefs,
        recommendedAction,
      },
    },
    placementHint: {
      region: "debug",
      size: "medium",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: false,
      truncated: summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * Map any `tool.*` event to the generic tool event card.  will
 * later add per-tool components for search/read/execution that supersede
 * this generic mapping for those specific event types.
 *
 * Safety: only `toolName` (derived from event_type), `taskId`, and
 * timestamp are exposed. We deliberately do NOT pass through the parsed
 * payload to the card — generic v1 must not leak prompts, raw Discord
 * bodies, query strings, or any user-supplied content beyond what's
 * already public via raw trace.
 */
function mapToolEvent(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const after = row.event_type.slice("tool.".length);
  const segments = after.split(".");
  const toolName = segments[0] ?? after;
  const subEvent = segments.slice(1).join(".") || null;
  const taskId = strField(parsed, "taskId");
  const titleCore = subEvent ? `Tool: ${toolName} (${subEvent})` : `Tool: ${toolName}`;

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "generic.tool_event",
    priority: "secondary",
    title: truncate(titleCore, TITLE_CAP).text,
    summary: undefined,
    component: {
      name: "GenericToolEventCard",
      props: {
        toolName,
        subEvent,
        taskId,
      },
    },
    placementHint: {
      region: "feed",
      size: "compact",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: true,
      truncated: false,
    },
    createdAt: now,
  };
}

/**
 * Catch-all for events we haven't given a dedicated mapping yet. They go
 * into the debug region at low priority so the frontend feed isn't
 * polluted with internal lifecycle noise (`task.submitted`,
 * `task.lifecycle.finalized`, `recovery.policy.changed`, etc.).
 */
function mapGeneric(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const taskId = strField(parsed, "taskId");
  const titleCore = `Event: ${row.event_type}`;
  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "generic.event",
    priority: "debug",
    title: truncate(titleCore, TITLE_CAP).text,
    summary: undefined,
    component: {
      name: "GenericEventCard",
      props: {
        eventType: row.event_type,
        taskId,
      },
    },
    placementHint: {
      region: "debug",
      size: "compact",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: true,
      truncated: false,
    },
    createdAt: now,
  };
}

function classifyAndMap(
  row: ActionUiIntentSourceRow,
  now: number,
): ActionUiIntent {
  const { value: parsed } = safeParse(row.payload);
  if (row.event_type === "degradation.summary") return mapDegradationSummary(row, parsed, now);
  if (row.event_type === "loop.pause.needs_human" || row.event_type === "loop.pause.awaiting_resume") {
    return mapPause(row, parsed, now);
  }
  if (row.event_type.startsWith("tool.")) return mapToolEvent(row, parsed, now);
  return mapGeneric(row, parsed, now);
}

/**
 * Main builder. Caller passes recent event_log rows newest-first; we
 * cap inputs and outputs, fail-soft per row (a malformed payload becomes
 * a generic event, not a crash), and never throw.
 */
export function buildActionUiIntents(
  rows: ActionUiIntentSourceRow[],
  options?: BuildIntentsOptions,
): ActionUiIntent[] {
  const rowLimit = options?.rowLimit ?? DEFAULT_ROW_LIMIT;
  const intentLimit = options?.intentLimit ?? DEFAULT_INTENT_LIMIT;
  const now = options?.now ?? Date.now();

  const out: ActionUiIntent[] = [];
  const window = rows.slice(0, rowLimit);
  for (const row of window) {
    if (out.length >= intentLimit) break;
    try {
      out.push(classifyAndMap(row, now));
    } catch {
      // Defensive: any unexpected throw inside per-row mapping degrades
      // to a generic event so a single bad row never empties the panel.
      try {
        out.push(mapGeneric(row, null, now));
      } catch { /* truly unrecoverable; skip */ }
    }
  }
  return out;
}
