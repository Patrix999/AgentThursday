/**
 * Action UI Intent backend builder.
 *
 * Pure derive-on-read translation layer: takes recent `event_log` rows
 * (the same shape `getInspectSnapshot()` already pulls into `trace[]`)
 * and produces a capped, schema-validated `ActionUiIntent[]` view that
 * an earlier revision's frontend ActivityFeed consumes.
 *
 * v1 invariants (per kanban + milestone red lines):
 *   - **No persisted intent event** — derived fresh on every inspect read.
 *     Avoids schema churn cascading into consumers .
 *   - **No model-declared `@component`** — that's + P2; v1 only maps
 *     known event types to a fixed set of component names.
 *   - **Raw payload hidden by default** — generic cards include only
 *     event type / timestamp / taskId / short summary. Tool events do
 *     NOT carry full prompts, raw Discord bodies, raw provider payloads,
 *     or secrets through this surface. an earlier revision will do per-tool richer
 *     extraction with explicit sanitization.
 *   - **Raw `trace[]` unchanged** — intents are an INDEX, not a
 *     replacement.
 *
 * Pure: no I/O, no env, no SDK. Caller (`AgentThursdayAgent`) feeds rows in.
 */

import { previewText, redactSecrets } from "./safeTextPreview";

export type ActionUiIntentType =
  | "agent.degradation"
  | "agent.pause"
  | "generic.tool_event"
  | "generic.event"
  // tool-specific intent types. Each upgrades a known tool
  // event family into a dedicated panel with a whitelisted prop set.
  | "tool.search_results"
  | "tool.file_read"
  | "tool.execution_result"
  // workspace mutation intent. Recognizes write-shaped tool
  // events (checkpoint writes + future tool.workspace.* prefix). Carries
  // an optional file path through `placementHint.focusPath` so the
  // frontend can ask the workspace file manager to open it.
  | "tool.workspace_mutation"
  // manager tool lifecycle. Recognizes the four manager
  // tool families (agent_list / agent_message / agent_create /
  // agent_update) across dispatch / result / error phases, surfacing
  // safe whitelisted fields (agent_id, task_id, envelope_id, counts,
  // bounded redacted previews) for the right-side Activity panel.
  | "tool.lifecycle"
  // workflow-era activity: executor run started/terminal
  // events + executor-dispatched subagent terminal events (trace_id
  // prefixed `wfr-`). Links the feed to /workflow-runs.
  | "workflow.run";

export type ActionUiIntentPriority = "primary" | "secondary" | "debug";

export type ActionUiIntentRegion = "top" | "feed" | "debug";

export type ActionUiIntentSize = "compact" | "medium" | "large";

/**
 * Default activity-feed membership — the SAME filter the console's
 * `ActivityFeed.tsx` (`isDefaultFeedIntent`) applies, ported here so the
 * owner-scoped user-app feed surfaces byte-identical "activity": drops
 * debug / degradation / pause / lifecycle-noise (`generic.event` such as
 * `agent.woken`), keeps the model's real tool actions — dispatch
 * (`tool.lifecycle`), browser/search, file read, file/repo write
 * (`tool.workspace_mutation`), execution, and workflow runs.
 */
export function isDefaultFeedIntent(
  // Structural-minimal param (only the 3 fields read) so this works for BOTH
  // the builder's `ActionUiIntent` (props: Record) and the schema's
  // `InspectSnapshot["actionUiIntents"]` item (props: unknown).
  intent: {
    priority: ActionUiIntentPriority;
    type: ActionUiIntentType;
    placementHint: { region: ActionUiIntentRegion };
  },
): boolean {
  if (intent.priority === "debug") return false;
  if (intent.placementHint.region === "debug") return false;
  if (intent.type === "agent.degradation") return false;
  if (intent.type === "agent.pause") return false;
  return (
    intent.type === "generic.tool_event"
    || intent.type === "tool.search_results"
    || intent.type === "tool.file_read"
    || intent.type === "tool.execution_result"
    || intent.type === "tool.workspace_mutation"
    || intent.type === "tool.lifecycle"
    || intent.type === "workflow.run"
  );
}

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
      | "WorkspaceChangePanel"
      | "ManagerLifecyclePanel"
      | "WorkflowRunPanel";
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

// UTF-8 byte-cap for result previews (multi-byte safe; the
// an earlier revision lesson: a `.length` cap lets `'界'.repeat(N)` blow the budget).
const RESULT_PREVIEW_BYTE_CAP = 1536;
function bytePreview(s: string, cap: number = RESULT_PREVIEW_BYTE_CAP): { text: string; truncated: boolean } {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= cap) return { text: s, truncated: false };
  return { text: new TextDecoder().decode(bytes.slice(0, cap)) + "\n…", truncated: true };
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
 * , not a forced visible web component.
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
 * Map any `tool.*` event to the generic tool event card. an earlier revision will
 * later add per-tool components for search/read/execution that supersede
 * this generic mapping for those specific event types.
 *
 * Safety: only `toolName` (derived from event_type), `taskId`,
 * timestamp, and a whitelisted set of pre-truncated preview fields are
 * exposed. We deliberately do NOT pass through the parsed payload to the
 * card — generic v1 must not leak prompts, raw Discord bodies, query
 * strings, or any user-supplied content beyond what's already public via
 * raw trace.
 *
 * also forward `pathPreview` / `sourceId` when the tool
 * already pre-truncated them at the logEvent boundary (e.g.
 * `tool.content_list`). These are the same caps an earlier revision applies, so
 * surfacing them here doesn't widen any leak window.
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
  const pathPreview = strField(parsed, "pathPreview");
  const sourceId = strField(parsed, "sourceId");
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
        pathPreview,
        sourceId,
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
 * search-tool mapper. Recognizes `tool.content_search`
 * (and any sibling search-flavored events). Whitelists ONLY the
 * pre-truncated preview fields the tool already logged via an earlier revision's
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
 * file-read mapper. Recognizes `tool.content_read` (and
 * `tool.content_list` is intentionally excluded — listing is a
 * navigation event, not a "the agent read this file" surface).
 *
 * The tool.content_read payload only logs path/sourceId/maxBytes —
 * NOT the file content — so this panel shows the intent of the read
 * (which file, in which source, how many bytes) rather than a preview.
 * Returns null if essential fields missing.
 */
function numericField(parsed: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function mapFileRead(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const sourceId = strField(parsed, "sourceId") ?? strField(parsed, "source") ?? "repo";
  const pathPreview = strField(parsed, "pathPreview") ?? strField(parsed, "path") ?? strField(parsed, "filePath");
  if (!pathPreview || !sourceId) return null;
  const maxBytes = numericField(parsed, "maxBytes", "max_bytes");
  const taskId = strField(parsed, "taskId");
  const sizeBytes = numericField(parsed, "sizeBytes", "size", "size_bytes", "bytesRead");
  const lineCount = numericField(parsed, "lineCount", "linesRead");
  const truncated = parsed.truncated === true;
  const truncatedBytes = numericField(parsed, "truncatedBytes", "truncated_bytes");
  // bounded content preview (set upstream in the
  // repo.read.result branch where the content is still in the payload).
  const resultPreviewRaw = strField(parsed, "resultPreview");
  const resultPreview = resultPreviewRaw !== null ? bytePreview(resultPreviewRaw) : null;

  const titleCore = `${truncated ? "⚠️ " : ""}File: ${pathPreview}`;
  const titleT = truncate(titleCore, TITLE_CAP);
  let summarySrc = `read from ${sourceId}`;
  if (maxBytes !== null) summarySrc += ` · cap ${maxBytes}b`;
  if (sizeBytes !== null) summarySrc += ` · ${sizeBytes}b`;
  if (lineCount !== null) summarySrc += ` · ${lineCount} lines`;
  if (truncated) summarySrc += ` · ⚠️ truncated${truncatedBytes !== null ? ` (${truncatedBytes}b dropped)` : ""}`;
  const summaryT = truncate(summarySrc, SUMMARY_CAP);

  return {
    id: buildIntentId(row),
    taskId,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.file_read",
    priority: truncated ? "primary" : "secondary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "FilePreviewPanel",
      props: {
        sourceId,
        pathPreview,
        maxBytes,
        sizeBytes,
        lineCount,
        truncated,
        truncatedBytes,
        ...(resultPreview !== null ? { resultPreview: resultPreview.text } : {}),
      },
    },
    placementHint: {
      region: "feed",
      size: "medium",
      focusPath: pathPreview,
    },
    safety: {
      rawPayloadHidden: true, // raw tool payload stays in Inspect; props are whitelisted previews only
      truncated: truncated || titleT.truncated || summaryT.truncated,
    },
    createdAt: now,
  };
}

/**
 * execution mapper. Recognizes `tool.execute` (Tier 2
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
 * workspace mutation mapper. Recognizes write-shaped tool
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

/**
 * manager tool lifecycle mapper. Recognizes
 * `tool.manager.<family>.<phase>` events for the four families the
 * card scopes:
 *   - agent_list (dispatch / result)
 *   - agent_message (dispatch / result / error)
 *   - agent_create (dispatch / result / error)
 *   - agent_update (dispatch / result / error)
 *
 * Whitelist-extracts only the fields `managerToolEmission` already
 * bounds + redacts at the emission boundary. Never forwards raw
 * payload back into intent props; never includes provider responses,
 * raw prompts, or full file contents.
 *
 * Returns null when the row doesn't match the manager pattern, so
 * the caller falls back to `mapToolEvent` generic chrome.
 */
const MANAGER_LIFECYCLE_PATTERN =
  /^tool\.manager\.(agent_list|agent_message|agent_create|agent_update)\.(dispatch|result|error)$/;

type ManagerLifecycleFamily =
  | "agent_list"
  | "agent_message"
  | "agent_create"
  | "agent_update";
type ManagerLifecyclePhase = "dispatch" | "result" | "error";

interface ManagerLifecycleProps {
  family: ManagerLifecycleFamily;
  phase: ManagerLifecyclePhase;
  status: string | null;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  envelopeId: string | null;
  conversationId: string | null;
  source: string | null;
  model: string | null;
  skillset: string | null;
  agentStatus: string | null;
  agentCount: number | null;
  includeArchived: boolean | null;
  textPreview: string | null;
  textTruncated: boolean;
  textBytes: number | null;
  replyPreview: string | null;
  replyTruncated: boolean;
  replyLength: number | null;
  loopTriggered: boolean | null;
  errorCode: string | null;
  errorMessagePreview: string | null;
  changedFields: string[] | null;
}

function emptyLifecycleProps(
  family: ManagerLifecycleFamily,
  phase: ManagerLifecyclePhase,
): ManagerLifecycleProps {
  return {
    family,
    phase,
    status: null,
    agentId: null,
    agentName: null,
    taskId: null,
    envelopeId: null,
    conversationId: null,
    source: null,
    model: null,
    skillset: null,
    agentStatus: null,
    agentCount: null,
    includeArchived: null,
    textPreview: null,
    textTruncated: false,
    textBytes: null,
    replyPreview: null,
    replyTruncated: false,
    replyLength: null,
    loopTriggered: null,
    errorCode: null,
    errorMessagePreview: null,
    changedFields: null,
  };
}

function mapManagerLifecycle(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  const match = MANAGER_LIFECYCLE_PATTERN.exec(row.event_type);
  if (!match) return null;
  const family = match[1] as ManagerLifecycleFamily;
  const phase = match[2] as ManagerLifecyclePhase;

  const props = emptyLifecycleProps(family, phase);

  if (parsed) {
    props.agentId = strField(parsed, "agent_id");
    props.status = strField(parsed, "status");
    props.envelopeId = strField(parsed, "envelope_id");
    props.taskId = strField(parsed, "task_id");
    props.conversationId = strField(parsed, "conversation_id");
    props.source = strField(parsed, "source");
    props.model = strField(parsed, "model");
    props.skillset = strField(parsed, "skillset");
    props.agentName = strField(parsed, "name");
    props.agentStatus = strField(parsed, "agent_status");
    props.agentCount = numericField(parsed, "count", "agent_count");
    if (typeof parsed.include_archived === "boolean") props.includeArchived = parsed.include_archived;
    if (typeof parsed.loop_triggered === "boolean") props.loopTriggered = parsed.loop_triggered;
    props.replyLength = numericField(parsed, "reply_length");
    props.textBytes = numericField(parsed, "text_bytes");
    const textPreview = strField(parsed, "text_preview");
    if (textPreview) {
      props.textPreview = redactSecrets(textPreview);
      props.textTruncated = parsed.text_truncated === true;
    }
    const replyPreview = strField(parsed, "reply_preview");
    if (replyPreview) {
      props.replyPreview = redactSecrets(replyPreview);
      props.replyTruncated = parsed.reply_truncated === true;
    }
    props.errorCode = strField(parsed, "error_code") ?? strField(parsed, "reason");
    const errMsg = strField(parsed, "message_snippet") ?? strField(parsed, "error_message_preview");
    if (errMsg) {
      const pv = previewText(errMsg, SUMMARY_CAP);
      props.errorMessagePreview = pv.text;
    }
    const changedRaw = arrField<unknown>(parsed, "changed_fields");
    const changedFields = changedRaw.filter((s): s is string => typeof s === "string");
    if (changedFields.length > 0) props.changedFields = changedFields;
  }

  // Compose title + summary from extracted props only.
  const titleCore = buildManagerLifecycleTitle(props);
  const titleT = truncate(titleCore, TITLE_CAP);
  const summarySrc = buildManagerLifecycleSummary(props);
  const summaryT = summarySrc ? truncate(summarySrc, SUMMARY_CAP) : null;

  const priority: ActionUiIntentPriority = phase === "error" ? "primary" : "secondary";
  const truncatedFlag =
    titleT.truncated ||
    (summaryT?.truncated ?? false) ||
    props.textTruncated ||
    props.replyTruncated;

  const taskIdForRow = strField(parsed, "taskId") ?? props.taskId;

  return {
    id: buildIntentId(row),
    taskId: taskIdForRow,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.lifecycle",
    priority,
    title: titleT.text,
    summary: summaryT?.text,
    component: {
      name: "ManagerLifecyclePanel",
      props: props as unknown as Record<string, unknown>,
    },
    placementHint: {
      region: "feed",
      size: phase === "result" ? "medium" : "compact",
      focusPath: null,
    },
    safety: {
      rawPayloadHidden: true,
      truncated: truncatedFlag,
    },
    createdAt: now,
  };
}

function buildManagerLifecycleTitle(p: ManagerLifecycleProps): string {
  const target = p.agentName ?? p.agentId ?? "agent";
  switch (p.family) {
    case "agent_list":
      if (p.phase === "dispatch") return "Manager → list agents";
      if (p.phase === "result") {
        return p.agentCount !== null
          ? `Manager ✓ list agents (${p.agentCount})`
          : "Manager ✓ list agents";
      }
      return `Manager ✗ list agents${p.errorCode ? `: ${p.errorCode}` : ""}`;
    case "agent_message":
      if (p.phase === "dispatch") return `Manager → message ${target}`;
      if (p.phase === "result") {
        return `Manager ✓ message ${target}${p.status ? ` · ${p.status}` : ""}`;
      }
      return `Manager ✗ message ${target}${p.errorCode ? `: ${p.errorCode}` : ""}`;
    case "agent_create":
      if (p.phase === "dispatch") {
        return p.agentName ? `Manager → create ${p.agentName}` : "Manager → create agent";
      }
      if (p.phase === "result") return `Manager ✓ create ${target}`;
      return `Manager ✗ create${p.errorCode ? `: ${p.errorCode}` : ""}`;
    case "agent_update":
      if (p.phase === "dispatch") return `Manager → update ${target}`;
      if (p.phase === "result") return `Manager ✓ update ${target}`;
      return `Manager ✗ update ${target}${p.errorCode ? `: ${p.errorCode}` : ""}`;
  }
}

function buildManagerLifecycleSummary(p: ManagerLifecycleProps): string | null {
  const parts: string[] = [];
  if (p.family === "agent_message") {
    if (p.phase === "dispatch" && p.textPreview) parts.push(p.textPreview);
    if (p.phase === "result" && p.replyPreview) parts.push(p.replyPreview);
    if (p.phase === "result" && p.replyLength !== null) {
      parts.push(`reply ${p.replyLength}c`);
    }
    if (p.envelopeId) parts.push(`env ${p.envelopeId}`);
    if (p.taskId) parts.push(`task ${p.taskId}`);
  }
  if (p.family === "agent_create" || p.family === "agent_update") {
    if (p.model) parts.push(`model ${p.model}`);
    if (p.skillset) parts.push(`skillset ${p.skillset}`);
    if (p.agentStatus) parts.push(`status ${p.agentStatus}`);
    if (p.changedFields && p.changedFields.length > 0) {
      parts.push(`changed: ${p.changedFields.join(", ")}`);
    }
  }
  if (p.family === "agent_list" && p.phase === "result" && p.agentCount !== null) {
    parts.push(`${p.agentCount} agents`);
  }
  if (p.errorMessagePreview) parts.push(p.errorMessagePreview);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function classifyAndMap(
  row: ActionUiIntentSourceRow,
  now: number,
): ActionUiIntent {
  const { value: parsed } = safeParse(row.payload);
  // workflow-era events first (registry trace rows).
  if (row.event_type === "workflow.run.started" || row.event_type === "workflow.run.terminal") {
    return mapWorkflowRun(row, parsed, now);
  }
  if (
    (row.event_type === "manager.task.replied" || row.event_type === "manager.task.failed")
    && (row.trace_id ?? "").startsWith("wfr-")
  ) {
    return mapWorkflowSubagent(row, parsed, now);
  }
  if (row.event_type === "degradation.summary") return mapDegradationSummary(row, parsed, now);
  if (row.event_type === "loop.pause.needs_human" || row.event_type === "loop.pause.awaiting_resume") {
    return mapPause(row, parsed, now);
  }
  // manager tool lifecycle. Try the dedicated mapper
  // first for `tool.manager.<family>.<phase>` rows; fall through to
  // generic `tool.*` chrome only if the row doesn't match the
  // whitelisted family pattern.
  if (row.event_type.startsWith("tool.manager.")) {
    const intent = mapManagerLifecycle(row, parsed, now);
    if (intent) return intent;
  }
  // tool-specific upgraded mappers. Each returns null when
  // the payload lacks the whitelisted fields, so the caller falls back
  // to `mapToolEvent` generic chrome rather than rendering an empty
  // dedicated panel.
  if (row.event_type === "tool.content_search") {
    const intent = mapSearchResults(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type === "tool.content_read" || row.event_type === "tool.content_read.result") {
    const intent = mapFileRead(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type === "tool.repo.read.result") {
    const output = parsed && typeof parsed.output === "object" && parsed.output !== null
      ? parsed.output as Record<string, unknown>
      : null;
    const input = parsed && typeof parsed.input === "object" && parsed.input !== null
      ? parsed.input as Record<string, unknown>
      : null;
    const merged: Record<string, unknown> = {
      sourceId: "repo",
      ...(input ?? {}),
      ...(output ?? {}),
      ...(parsed ?? {}),
    };
    const content = typeof merged.content === "string" ? merged.content : null;
    if (content !== null && typeof merged.lineCount !== "number") {
      merged.lineCount = content.length === 0 ? 0 : content.split("\n").length;
    }
    // keep a bounded preview (first ~30 lines) so the feed
    // shows what was actually read; full content stays out of props.
    if (content !== null && content.length > 0) {
      merged.resultPreview = content.split("\n").slice(0, 30).join("\n");
    }
    delete merged.content;
    const intent = mapFileRead(row, merged, now);
    if (intent) return intent;
  }
  // gate result: ok/exit + bounded stdout (esp. on failure).
  if (/^tool\.gate\.[a-z_]+\.result$/.test(row.event_type)) {
    const intent = mapGateResult(row, parsed, now);
    if (intent) return intent;
  }
  // surface repo.grep results (count + first matches) instead
  // of the bare generic tool chrome.
  if (row.event_type === "tool.repo.grep.result") {
    const intent = mapGrepResult(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type === "tool.execute" || row.event_type === "tool.sandbox_exec") {
    const intent = mapExecution(row, parsed, now);
    if (intent) return intent;
  }
  // workspace mutation upgrade. Catches `tool.write_checkpoint`
  // today + `tool.workspace.<op>` forward-compat tomorrow. Falls through
  // to `mapToolEvent` if payload doesn't match either branch.
  if (row.event_type === "tool.write_checkpoint" || row.event_type.startsWith("tool.workspace.")) {
    const intent = mapWorkspaceMutation(row, parsed, now);
    if (intent) return intent;
  }
  if (row.event_type.startsWith("tool.")) return mapToolEvent(row, parsed, now);
  return mapGeneric(row, parsed, now);
}

// gate result mapper: ok/exit/duration + bounded stdout.
function mapGateResult(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const target = strField(parsed, "target") ?? "gate";
  const ok = parsed.ok === true;
  const exit = numericField(parsed, "exit_code", "exitCode");
  const durationMs = numericField(parsed, "duration_ms", "durationMs");
  const stdout = strField(parsed, "stdout");
  const preview = (!ok && stdout !== null) ? bytePreview(stdout) : null;
  const titleT = truncate(`${ok ? "✓" : "✗"} gate.${target}`, TITLE_CAP);
  const summaryT = truncate(
    `${ok ? "passed" : "failed"}${exit !== null ? ` · exit ${exit}` : ""}${durationMs !== null ? ` · ${Math.round(durationMs / 1000)}s` : ""}`,
    SUMMARY_CAP,
  );
  return {
    id: buildIntentId(row),
    // fall back to trace_id so the auto-dispatch key matches
    // the autodispatch.start row (which keys by taskId === trace).
    taskId: strField(parsed, "taskId") ?? row.trace_id,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.execution_result",
    priority: ok ? "secondary" : "primary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "ExecutionResultPanel",
      props: {
        variant: "execute",
        tier: null,
        preview: preview !== null ? preview.text : null,
        reason: ok ? null : `gate.${target} exit ${exit ?? "?"}`,
        sandboxId: null,
      },
    },
    placementHint: { region: "feed", size: "medium", focusPath: null },
    safety: { rawPayloadHidden: true, truncated: preview?.truncated ?? false },
    createdAt: now,
  };
}

// repo.grep result mapper: match count + first matches as a
// `file:line: text` preview, byte-capped.
function mapGrepResult(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent | null {
  if (!parsed) return null;
  const output = parsed.output && typeof parsed.output === "object"
    ? parsed.output as Record<string, unknown>
    : parsed;
  const input = parsed.input && typeof parsed.input === "object"
    ? parsed.input as Record<string, unknown>
    : null;
  const matches = Array.isArray(output.matches) ? output.matches : null;
  const pattern = strField(output, "pattern") ?? (input ? strField(input, "pattern") : null);
  if (matches === null && pattern === null) return null;
  const count = matches !== null ? matches.length : 0;
  const filesScanned = numericField(output, "files_scanned", "filesScanned");
  const lines = (matches ?? []).slice(0, 8).map((m) => {
    const mm = m as Record<string, unknown>;
    const file = typeof mm.file === "string" ? mm.file : "?";
    const line = typeof mm.line === "number" ? mm.line : "?";
    const text = typeof mm.text === "string" ? mm.text.slice(0, 160) : "";
    return `${file}:${line}: ${text}`;
  });
  const preview = lines.length > 0 ? bytePreview(lines.join("\n")) : null;
  const titleT = truncate(`Grep: ${pattern ?? "?"}`, TITLE_CAP);
  const summaryT = truncate(
    `${count} match${count === 1 ? "" : "es"}${filesScanned !== null ? ` · ${filesScanned} files scanned` : ""}`,
    SUMMARY_CAP,
  );
  return {
    id: buildIntentId(row),
    taskId: strField(parsed, "taskId"),
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "tool.search_results",
    priority: "secondary",
    title: titleT.text,
    summary: summaryT.text,
    component: {
      name: "SearchResultsPanel",
      props: {
        queryPreview: pattern ?? "?",
        mode: "grep",
        sourceId: "repo",
        sourceIdsCount: null,
        strategy: null,
        pathPreview: null,
        maxResults: count,
        ...(preview !== null ? { resultPreview: preview.text } : {}),
      },
    },
    placementHint: { region: "feed", size: "medium", focusPath: null },
    safety: { rawPayloadHidden: true, truncated: preview?.truncated ?? false },
    createdAt: now,
  };
}

// ── tool lifecycle pairing ───────────────────────────────
// A dispatch row and its matching result/error row are one ACTION, not
// two feed items (359b's original goal, previously only approximated
// for manager tools). Pairing key = event base name + trace_id. The
// dispatch row is skipped when paired; the result row carries a
// lifecycle annotation {status, durationMs}. An unpaired dispatch
// renders as the action itself with status "running".

const LIFECYCLE_SUFFIX_RE = /^(tool\..+)\.(dispatch|result|error)$/;

export type LifecycleAnnotation = {
  status: "running" | "ok" | "error";
  durationMs: number | null;
};

export type LifecycleAnnotatedRow = {
  row: ActionUiIntentSourceRow;
  lifecycle?: LifecycleAnnotation;
  skip?: boolean;
  // the paired dispatch's `input` (e.g. repo.read's file
  // path) carried onto the result row, whose payload often only has
  // `output`. Merged into the row payload before mapping.
  enrichInput?: Record<string, unknown>;
};

export function annotateLifecycleRows(
  rows: ActionUiIntentSourceRow[],
): LifecycleAnnotatedRow[] {
  const out: LifecycleAnnotatedRow[] = rows.map((row) => ({ row }));
  // pending: base|trace|agent → FIFO of {index, pathKey} dispatches.
  const pending = new Map<string, Array<{ index: number; pathKey: string }>>();
  const pathKeyOf = (payload: string): string => {
    const { value: parsed } = safeParse(payload);
    const input = parsed && typeof parsed.input === "object" && parsed.input !== null
      ? parsed.input as Record<string, unknown>
      : null;
    return (
      (input && typeof input.path === "string" ? input.path : null)
      ?? (parsed && typeof parsed.pathPreview === "string" ? parsed.pathPreview : null)
      ?? (parsed && typeof parsed.path === "string" ? parsed.path : null)
      ?? ""
    );
  };
  // Order-agnostic: walk in true chronological order (callers feed
  // newest-first in prod, but fixtures/tests may feed oldest-first).
  const chrono = out
    .map((_, i) => i)
    .sort((a, b) => out[a].row.created_at - out[b].row.created_at);
  for (const i of chrono) {
    const m = LIFECYCLE_SUFFIX_RE.exec(out[i].row.event_type);
    if (m === null) continue;
    // Same tool + same trace can interleave (two manager.agent_message
    // calls to different subagents; a burst of repo.read calls across
    // files — observed live on an earlier revision's dogfood feed). agent_id keys
    // the map; path matches two-tier: exact when the result echoes a
    // path, FIFO-oldest otherwise (result payloads don't always echo
    // the dispatch input).
    const { value: parsed } = safeParse(out[i].row.payload);
    const agentKey = parsed && typeof parsed.agent_id === "string" ? parsed.agent_id : "";
    const key = `${m[1]}|${out[i].row.trace_id ?? ""}|${agentKey}`;
    const pathKey = pathKeyOf(out[i].row.payload);
    const phase = m[2];
    if (phase === "dispatch") {
      const list = pending.get(key) ?? [];
      list.push({ index: i, pathKey });
      pending.set(key, list);
      continue;
    }
    const list = pending.get(key);
    let matched: { index: number; pathKey: string } | undefined;
    if (list && list.length > 0) {
      if (pathKey !== "") {
        const at = list.findIndex((e) => e.pathKey === pathKey);
        if (at >= 0) matched = list.splice(at, 1)[0];
      }
      if (matched === undefined && pathKey === "") {
        matched = list.shift();
      }
    }
    if (matched !== undefined) {
      out[matched.index].skip = true;
      out[i].lifecycle = {
        status: phase === "error" ? "error" : "ok",
        durationMs: Math.max(0, out[i].row.created_at - out[matched.index].row.created_at),
      };
      // carry the dispatch's input (file path etc.) forward.
      const { value: dispatchParsed } = safeParse(out[matched.index].row.payload);
      if (dispatchParsed && typeof dispatchParsed.input === "object" && dispatchParsed.input !== null) {
        out[i].enrichInput = dispatchParsed.input as Record<string, unknown>;
      }
    } else {
      out[i].lifecycle = {
        status: phase === "error" ? "error" : "ok",
        durationMs: null,
      };
    }
  }
  for (const list of pending.values()) {
    for (const e of list) {
      out[e.index].lifecycle = { status: "running", durationMs: null };
    }
  }
  return out;
}

// ── workflow-era mappers ─────────────────────────────────

function mapWorkflowRun(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const runId = strField(parsed, "run_id");
  const status = strField(parsed, "status");
  const sourceTaskId = strField(parsed, "source_task_id");
  const started = row.event_type === "workflow.run.started";
  const title = started
    ? `Workflow started: ${sourceTaskId ?? runId ?? "?"}`
    : `Workflow ${status ?? "terminal"}: ${runId ?? "?"}`;
  return {
    id: buildIntentId(row),
    taskId: row.trace_id,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "workflow.run",
    priority: started ? "secondary" : "primary",
    title: truncate(title, TITLE_CAP).text,
    summary: undefined,
    component: {
      name: "WorkflowRunPanel",
      props: {
        runId,
        status: started ? "started" : (status ?? "terminal"),
        sourceTaskId,
      },
    },
    placementHint: { region: "feed", size: "compact", focusPath: null },
    safety: { rawPayloadHidden: true, truncated: false },
    createdAt: now,
  };
}

function mapWorkflowSubagent(
  row: ActionUiIntentSourceRow,
  parsed: Record<string, unknown> | null,
  now: number,
): ActionUiIntent {
  const trace = row.trace_id ?? "";
  const runId = trace.includes("-p-") ? trace.split("-p-")[0] : null;
  const agentId = strField(parsed, "agent_id");
  const failed = row.event_type === "manager.task.failed";
  const agentShort = agentId !== null ? agentId.slice(0, 14) : "?";
  return {
    id: buildIntentId(row),
    taskId: row.trace_id,
    sourceEventType: row.event_type,
    sourceEventAt: row.created_at,
    type: "workflow.run",
    priority: failed ? "primary" : "secondary",
    title: truncate(`Subagent ${failed ? "failed" : "replied"}: ${agentShort}`, TITLE_CAP).text,
    summary: undefined,
    component: {
      name: "WorkflowRunPanel",
      props: {
        runId,
        status: failed ? "agent_failed" : "agent_replied",
        agentId,
        subagentTaskId: row.trace_id,
      },
    },
    placementHint: { region: "feed", size: "compact", focusPath: null },
    safety: { rawPayloadHidden: true, truncated: false },
    createdAt: now,
  };
}

/**
 * Main builder. Caller passes recent event_log rows newest-first; we
 * cap inputs and outputs, fail-soft per row (a malformed payload becomes
 * a generic event, not a crash), and never throw.
 */
// splice a paired dispatch's `input` into a result row's
// JSON payload so downstream mappers (repo.read needs the file path,
// which only lives on the dispatch) see it. Fail-soft: returns the
// original string on any parse error.
function mergeInputIntoPayload(payload: string, input: Record<string, unknown>): string {
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const existing = (obj as Record<string, unknown>).input;
      (obj as Record<string, unknown>).input = existing && typeof existing === "object"
        ? { ...input, ...(existing as Record<string, unknown>) }
        : input;
      return JSON.stringify(obj);
    }
  } catch { /* fall through */ }
  return payload;
}

export function buildActionUiIntents(
  rows: ActionUiIntentSourceRow[],
  options?: BuildIntentsOptions,
): ActionUiIntent[] {
  const rowLimit = options?.rowLimit ?? DEFAULT_ROW_LIMIT;
  const intentLimit = options?.intentLimit ?? DEFAULT_INTENT_LIMIT;
  const now = options?.now ?? Date.now();

  const out: ActionUiIntent[] = [];
  // collect (taskId|target) of harness auto-dispatched gates
  // (an earlier revision gate-intent guard) so the feed can mark them "🤖 auto"
  // instead of looking like the agent ran the gate itself.
  const autoGateKeys = new Set<string>();
  for (const r of rows.slice(0, rowLimit)) {
    if (r.event_type === "tool.gate_intent.autodispatch.start"
      || r.event_type === "tool.gate_intent.autodispatch.success") {
      const { value: p } = safeParse(r.payload);
      const taskId = (p ? strField(p, "taskId") : null) ?? r.trace_id;
      const target = p ? strField(p, "target") : null;
      if (taskId !== null && target !== null) autoGateKeys.add(`${taskId}|${target}`);
    }
  }
  // pair tool dispatch/result/error rows into single
  // lifecycle-annotated actions before mapping.
  const window = annotateLifecycleRows(rows.slice(0, rowLimit));
  for (const entry of window) {
    if (out.length >= intentLimit) break;
    if (entry.skip) continue;
    try {
      const sourceRow = entry.enrichInput
        ? { ...entry.row, payload: mergeInputIntoPayload(entry.row.payload, entry.enrichInput) }
        : entry.row;
      const intent = classifyAndMap(sourceRow, now);
      if (entry.lifecycle && intent.component.props && typeof intent.component.props === "object") {
        (intent.component.props as Record<string, unknown>).lifecycle = entry.lifecycle;
      }
      // mark harness-auto-dispatched gate intents.
      if (/^tool\.gate\.[a-z_]+\.result$/.test(intent.sourceEventType)
        && intent.component.props && typeof intent.component.props === "object") {
        const props = intent.component.props as Record<string, unknown>;
        const tid = intent.taskId ?? "";
        const tgt = typeof props.reason === "string" ? "" : ""; // target derived below
        void tgt;
        // mapGateResult stored target via reason "gate.<t> exit"; re-derive
        // from sourceEventType `tool.gate.<target>.result`.
        const mt = /^tool\.gate\.([a-z_]+)\.result$/.exec(intent.sourceEventType);
        const target = mt ? mt[1] : "";
        if (autoGateKeys.has(`${tid}|${target}`)) props.autoDispatched = true;
      }
      out.push(intent);
    } catch {
      // Defensive: any unexpected throw inside per-row mapping degrades
      // to a generic event so a single bad row never empties the panel.
      try {
        out.push(mapGeneric(entry.row, null, now));
      } catch { /* truly unrecoverable; skip */ }
    }
  }
  return out;
}
