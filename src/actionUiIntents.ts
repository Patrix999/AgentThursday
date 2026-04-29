/**
 * M7.6 Card 125 — Action UI Intent backend builder.
 *
 * Pure derive-on-read translation layer: takes recent `event_log` rows
 * (the same shape `getInspectSnapshot()` already pulls into `trace[]`)
 * and produces a capped, schema-validated `ActionUiIntent[]` view that
 * Card 126's frontend ActivityFeed consumes.
 *
 * v1 invariants (per kanban + M7.6 milestone red lines):
 *   - **No persisted intent event** — derived fresh on every inspect read.
 *     Avoids schema churn cascading into M7.5 consumers (Card 117/119/121).
 *   - **No model-declared `@component`** — that's M7.7+ P2; v1 only maps
 *     known event types to a fixed set of component names.
 *   - **Raw payload hidden by default** — generic cards include only
 *     event type / timestamp / taskId / short summary. Tool events do
 *     NOT carry full prompts, raw Discord bodies, raw provider payloads,
 *     or secrets through this surface. Card 127 will do per-tool richer
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
  | "generic.event"
  // Card 127 — tool-specific intent types. Each upgrades a known tool
  // event family into a dedicated panel with a whitelisted prop set.
  | "tool.search_results"
  | "tool.file_read"
  | "tool.execution_result"
  // Card 128 — workspace mutation intent. Recognizes write-shaped tool
  // events (checkpoint writes + future tool.workspace.* prefix). Carries
  // an optional file path through `placementHint.focusPath` so the
  // frontend can ask the workspace file manager to open it.
  | "tool.workspace_mutation";

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
    name:
      | "DegradationCard"
      | "PauseCard"
      | "GenericToolEventCard"
      | "GenericEventCard"
      | "SearchResultsPanel"
      | "FilePreviewPanel"
      | "ExecutionResultPanel"
      | "WorkspaceChangePanel";
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
 * Map `degradation.summary` rows for inspect/diagnostics. Pat clarified
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
 * (Card 120), not a forced visible web component.
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
 * Map any `tool.*` event to the generic tool event card. Card 127 will
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

/**
 * Card 127 — search-tool mapper. Recognizes `tool.content_search`
 * (and any sibling search-flavored events). Whitelists ONLY the
 * pre-truncated preview fields the tool already logged via Card 102's
 * `slice(0, 80)` discipline; never forwards full query/path/payload.
 *
 * Result hits are NOT in the event_log payload (they go directly to
 * the agent reply), so v1 SearchResultsPanel surfaces the call's
 * intent (what was searched, in which source(s), with what strategy)
 * rather than the result rows. If a future card persists hits as a
 * `tool.content_search.ok` follow-up event we'd extend this mapper.
 *
 * Returns null if the payload doesn't look like a search call (caller
 * falls back to `mapToolEvent` generic chrome).
 */
function mapSearchResults(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const queryPreview = strField(parsed, "queryPreview");
  if (!queryPreview) return null;
  const sourceId = strField(parsed, "sourceId");
  const sourceIdsCount = typeof parsed.sourceIdsCount === "number" ? parsed.sourceIdsCount : null;
  const mode = strField(parsed, "mode");
  const strategy = strField(parsed, "strategy");
  const pathPreview = strField(parsed, "pathPreview");
  const maxResults = typeof parsed.maxResults === "number" ? parsed.maxResults : null;
  const taskId = strField(parsed, "taskId");

  const titleCore = `Search: ${queryPreview}`;
  const titleT = truncate(titleCore, TITLE_CAP);
  const summarySrc = sourceId
    ? `in ${sourceId}${strategy ? ` · ${strategy}` : ""}`
    : `${mode ?? "multi"}${sourceIdsCount !== null ? ` · ${sourceIdsCount} sources` : ""}${strategy ? ` · ${strategy}` : ""}`;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.search_results",
    priority: "secondary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "SearchResultsPanel",
      props: {
        queryPreview,
        mode,
        sourceId,
        sourceIdsCount,
        strategy,
        pathPreview,
        maxResults,
      },
    },
    placementHint: {
      region: "feed",
      size: "medium",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: true, // raw tool payload stays in Inspect; props are whitelisted previews only
      truncated: titleT.truncated || summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * Card 127 — file-read mapper. Recognizes `tool.content_read` (and
 * `tool.content_list` is intentionally excluded — listing is a
 * navigation event, not a "the agent read this file" surface).
 *
 * The tool.content_read payload only logs path/sourceId/maxBytes —
 * NOT the file content — so this panel shows the intent of the read
 * (which file, in which source, how many bytes) rather than a preview.
 * Returns null if essential fields missing.
 */
function mapFileRead(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const sourceId = strField(parsed, "sourceId");
  const pathPreview = strField(parsed, "pathPreview");
  if (!pathPreview || !sourceId) return null;
  const maxBytes = typeof parsed.maxBytes === "number" ? parsed.maxBytes : null;
  const taskId = strField(parsed, "taskId");

  const titleCore = `File: ${pathPreview}`;
  const titleT = truncate(titleCore, TITLE_CAP);
  const summarySrc = `read from ${sourceId}${maxBytes !== null ? ` · cap ${maxBytes}b` : ""}`;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.file_read",
    priority: "secondary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "FilePreviewPanel",
      props: {
        sourceId,
        pathPreview,
        maxBytes,
      },
    },
    placementHint: {
      region: "feed",
      size: "medium",
      focusPath: pathPreview,
    },
    safety: {
      rawPayloadHidden: true, // raw tool payload stays in Inspect; props are whitelisted previews only
      truncated: titleT.truncated || summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * Card 127 — execution mapper. Recognizes `tool.execute` (Tier 2
 * codemode JS/TS via `@cloudflare/think/tools/execute`) and
 * `tool.sandbox_exec` (Tier 4 OS shell via Cloudflare Sandbox
 * container). Both already log a pre-truncated code/command preview
 * + tier label.
 *
 * Result stdout/stderr/exit code is NOT in the event_log (returned
 * directly to the agent), so v1 ExecutionResultPanel shows the call's
 * intent (which tier, what code/command preview). Future card can
 * persist `.ok` / `.error` follow-up events for richer rendering.
 * Returns null if essential fields missing.
 */
function mapExecution(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const tier = typeof parsed.tier === "number" ? parsed.tier : null;
  const codePreview = strField(parsed, "codePreview");
  const commandPreview = strField(parsed, "command_preview");
  const preview = codePreview ?? commandPreview;
  if (!preview && tier === null) return null;
  const reason = strField(parsed, "reason");
  const sandboxId = strField(parsed, "sandbox_id");
  const taskId = strField(parsed, "taskId");

  const variant = row.event_type === "tool.sandbox_exec" ? "sandbox" : "execute";
  const titleCore = variant === "sandbox" ? `Run (sandbox): ${preview ?? ""}` : `Run: ${preview ?? ""}`;
  const titleT = truncate(titleCore, TITLE_CAP);
  const summarySrc = `tier ${tier ?? "?"}${reason ? ` · ${reason}` : ""}${sandboxId ? ` · ${sandboxId}` : ""}`;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.execution_result",
    priority: "secondary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "ExecutionResultPanel",
      props: {
        variant,
        tier,
        preview,
        reason,
        sandboxId,
      },
    },
    placementHint: {
      region: "feed",
      size: "medium",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: true, // raw tool payload stays in Inspect; props are whitelisted previews only
      truncated: titleT.truncated || summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * Card 128 — workspace mutation mapper. Recognizes write-shaped tool
 * events that change persisted state, with two concrete sources today:
 *
 *   - `tool.write_checkpoint` — agent's own checkpoint write (the
 *     checkpoint key is stored, not a workspace file path). v1 surfaces
 *     it as a workspace-state mutation card; the focusPath is null
 *     because a checkpoint key isn't a file path the workspace file
 *     manager can open.
 *   - `tool.workspace.<op>` (forward-compat) — when future cards
 *     instrument `createWorkspaceTools` from `@cloudflare/think` to
 *     emit per-op events, this mapper picks them up automatically.
 *     The mapper looks for `path` / `pathPreview` / `filePath` fields
 *     and uses whichever is present as the focusPath, enabling the
 *     "Open in workspace" affordance in `WorkspaceChangePanel`.
 *
 * Returns null if the row isn't write-shaped or required fields are
 * missing → caller falls back to `mapToolEvent` generic chrome.
 */
function mapWorkspaceMutation(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const taskId = strField(parsed, "taskId");

  // Branch 1: checkpoint write (current concrete signal).
  if (row.event_type === "tool.write_checkpoint") {
    const key = strField(parsed, "key");
    const checkpoint = strField(parsed, "checkpoint");
    if (!key && !checkpoint) return null;
    const titleCore = `Workspace: checkpoint ${key ?? "—"}`;
    const titleT = truncate(titleCore, TITLE_CAP);
    const summaryT = truncate(checkpoint ?? "checkpoint persisted", SUMMARY_CAP);
    return {
      id: buildIntentId(row),
      taskId,
      sourceEventType: row.event_type,
      sourceEventAt: row.created_at,
      type: "tool.workspace_mutation",
      priority: "secondary",
      title: titleT.text,
      summary: summaryT.text,
      component: {
        name: "WorkspaceChangePanel",
        props: {
          mutationKind: "checkpoint",
          key,
          checkpoint,
          path: null, // not a filesystem path
        },
      },
      placementHint: {
        region: "feed",
        size: "compact",
        // Checkpoint key isn't a file path → no focusPath. Frontend
        // will not show the "Open in workspace" affordance.
        focusPath: null,
      },
      safety: {
        rawPayloadHidden: true, // raw workspace payload stays in Inspect; props are whitelisted previews only
        truncated: titleT.truncated || summaryT.truncated,
      },
      createdAt: now,
    };
  }

  // Branch 2: future tool.workspace.<op> events.
  if (row.event_type.startsWith("tool.workspace.")) {
    const op = row.event_type.slice("tool.workspace.".length).split(".")[0] || "mutation";
    const path = strField(parsed, "path") ?? strField(parsed, "pathPreview") ?? strField(parsed, "filePath");
    if (!path) return null;
    const titleCore = `Workspace ${op}: ${path}`;
    const titleT = truncate(titleCore, TITLE_CAP);
    return {
      id: buildIntentId(row),
      taskId,
      sourceEventType: row.event_type,
      sourceEventAt: row.created_at,
      type: "tool.workspace_mutation",
      priority: "secondary",
      title: titleT.text,
      summary: undefined,
      component: {
        name: "WorkspaceChangePanel",
        props: {
          mutationKind: op,
          path,
          key: null,
          checkpoint: null,
        },
      },
      placementHint: {
        region: "feed",
        size: "medium",
        // Real workspace file path → enables WorkspaceChangePanel's
        // "Open in workspace" affordance via dispatchEvent.
        focusPath: path,
      },
      safety: {
        rawPayloadHidden: true, // raw workspace payload stays in Inspect; props are whitelisted previews only
        truncated: titleT.truncated,
      },
      createdAt: now,
    };
  }

  return null;
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
  // Card 127 — tool-specific upgraded mappers. Each returns null when
  // the payload lacks the whitelisted fields, so the caller falls back
  // to `mapToolEvent` generic chrome rather than rendering an empty
  // dedicated panel.
  if (row.event_type === "tool.content_search") {
    const intent = mapSearchResults(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type === "tool.content_read") {
    const intent = mapFileRead(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type === "tool.execute" || row.event_type === "tool.sandbox_exec") {
    const intent = mapExecution(row, parsed, now);
    if (intent) return intent;
  }
  // Card 128 — workspace mutation upgrade. Catches `tool.write_checkpoint`
  // today + `tool.workspace.<op>` forward-compat tomorrow. Falls through
  // to `mapToolEvent` if payload doesn't match either branch.
  if (row.event_type === "tool.write_checkpoint" || row.event_type.startsWith("tool.workspace.")) {
    const intent = mapWorkspaceMutation(row, parsed, now);
    if (intent) return intent;
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
