import type { InspectSnapshot } from "../../shared/schema";
import { SearchResultsPanel } from "./SearchResultsPanel";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { ExecutionResultPanel } from "./ExecutionResultPanel";
import { WorkspaceChangePanel } from "./WorkspaceChangePanel";
import { ManagerLifecyclePanel } from "./ManagerLifecyclePanel";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

type Intent = NonNullable<InspectSnapshot["actionUiIntents"]>[number];

/**
 *  — body-only renderer for an `ActionUiIntent`.
 *
 * Pre-247 this component wrapped its own `<article>` with border / bg /
 * shadow + a duplicate header (badge, title, time). That double-wrapped
 * inside ActivityFeed's accordion item border, producing the card-in-
 * card nesting operator called out. 247 removes the inner chrome and the
 * duplicate header — the accordion already supplies all of that.
 *
 * Render contract now: optional summary line, then the per-tool panel
 * picked by `component.name`. No outer box, no second timestamp.
 */
export function ActivityCard({ intent }: { intent: Intent }) {
  //  — lifecycle annotation injected by the backend pairing
  // pass: one accordion item per ACTION (dispatch+result), with status.
  const lc = (intent.component.props as { lifecycle?: { status?: unknown; durationMs?: unknown } } | null)?.lifecycle;
  const lcStatus = lc && typeof lc.status === "string" ? lc.status : null;
  const lcDuration = lc && typeof lc.durationMs === "number" ? lc.durationMs : null;
  const autoDispatched = (intent.component.props as { autoDispatched?: unknown } | null)?.autoDispatched === true;
  return (
    <div className="space-y-1.5">
      {autoDispatched && (
        <span className="mr-2 inline-block rounded bg-slate-800 px-1.5 text-[10px] text-slate-400 font-mono align-middle" title="harness 自动触发（gate-intent 守卫），非 agent 主动调用">🤖 auto</span>
      )}
      {lcStatus !== null && (
        <p className="text-[11px] font-mono inline">
          {lcStatus === "running" && <span className="text-amber-400">⏳ running…</span>}
          {lcStatus === "ok" && (
            <span className="text-emerald-400">✓ done{lcDuration !== null ? ` in ${formatDuration(lcDuration)}` : ""}</span>
          )}
          {lcStatus === "error" && (
            <span className="text-rose-400">✗ failed{lcDuration !== null ? ` after ${formatDuration(lcDuration)}` : ""}</span>
          )}
        </p>
      )}
      {intent.summary && (
        <p className="text-xs text-slate-400 break-words leading-snug">{intent.summary}</p>
      )}
      <ComponentBody name={intent.component.name} props={intent.component.props} />
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

/**
 *  — dispatch to the per-component renderer based on the
 * backend-supplied `component.name`. Each renderer takes a defensive
 * narrowing of `props: unknown` so a malformed/unknown shape degrades
 * gracefully rather than crashing the feed.
 */
function ComponentBody({ name, props }: { name: string; props: unknown }) {
  if (name === "WorkflowRunPanel") {
    const p = (props ?? {}) as {
      runId?: unknown; status?: unknown; sourceTaskId?: unknown; agentId?: unknown;
    };
    return (
      <WorkflowRunPanel
        runId={typeof p.runId === "string" ? p.runId : null}
        status={typeof p.status === "string" ? p.status : null}
        sourceTaskId={typeof p.sourceTaskId === "string" ? p.sourceTaskId : null}
        agentId={typeof p.agentId === "string" ? p.agentId : null}
      />
    );
  }
  if (name === "SearchResultsPanel") {
    const p = (props ?? {}) as {
      queryPreview?: unknown; mode?: unknown; sourceId?: unknown;
      sourceIdsCount?: unknown; strategy?: unknown; pathPreview?: unknown;
      maxResults?: unknown;
    };
    if (typeof p.queryPreview !== "string") return null;
    const pp = props as { resultPreview?: unknown };
    return (
      <SearchResultsPanel
        queryPreview={p.queryPreview}
        mode={typeof p.mode === "string" ? p.mode : null}
        sourceId={typeof p.sourceId === "string" ? p.sourceId : null}
        sourceIdsCount={typeof p.sourceIdsCount === "number" ? p.sourceIdsCount : null}
        strategy={typeof p.strategy === "string" ? p.strategy : null}
        pathPreview={typeof p.pathPreview === "string" ? p.pathPreview : null}
        maxResults={typeof p.maxResults === "number" ? p.maxResults : null}
        resultPreview={typeof pp.resultPreview === "string" ? pp.resultPreview : null}
      />
    );
  }
  if (name === "FilePreviewPanel") {
    const p = (props ?? {}) as {
      sourceId?: unknown; pathPreview?: unknown; maxBytes?: unknown;
    };
    if (typeof p.sourceId !== "string" || typeof p.pathPreview !== "string") return null;
    const fp = props as { resultPreview?: unknown };
    return (
      <FilePreviewPanel
        sourceId={p.sourceId}
        pathPreview={p.pathPreview}
        maxBytes={typeof p.maxBytes === "number" ? p.maxBytes : null}
        resultPreview={typeof fp.resultPreview === "string" ? fp.resultPreview : null}
      />
    );
  }
  if (name === "ExecutionResultPanel") {
    const p = (props ?? {}) as {
      variant?: unknown; tier?: unknown; preview?: unknown;
      reason?: unknown; sandboxId?: unknown;
    };
    const variant = p.variant === "sandbox" ? "sandbox" : "execute";
    return (
      <ExecutionResultPanel
        variant={variant}
        tier={typeof p.tier === "number" ? p.tier : null}
        preview={typeof p.preview === "string" ? p.preview : null}
        reason={typeof p.reason === "string" ? p.reason : null}
        sandboxId={typeof p.sandboxId === "string" ? p.sandboxId : null}
              autoDispatched={(props as { autoDispatched?: unknown }).autoDispatched === true}
      />
    );
  }
  if (name === "WorkspaceChangePanel") {
    const p = (props ?? {}) as {
      mutationKind?: unknown; path?: unknown;
      key?: unknown; checkpoint?: unknown;
    };
    const mutationKind = typeof p.mutationKind === "string" ? p.mutationKind : "mutation";
    return (
      <WorkspaceChangePanel
        mutationKind={mutationKind}
        path={typeof p.path === "string" ? p.path : null}
        key_={typeof p.key === "string" ? p.key : null /* react reserves `key` */}
        checkpoint={typeof p.checkpoint === "string" ? p.checkpoint : null}
      />
    );
  }
  if (name === "GenericToolEventCard") {
    return <ToolPropsRow props={props} />;
  }
  if (name === "ManagerLifecyclePanel") {
    const p = (props ?? {}) as {
      family?: unknown; phase?: unknown; status?: unknown;
      agentId?: unknown; agentName?: unknown; taskId?: unknown;
      envelopeId?: unknown; conversationId?: unknown; source?: unknown;
      model?: unknown; skillset?: unknown; agentStatus?: unknown;
      agentCount?: unknown; includeArchived?: unknown;
      textPreview?: unknown; textTruncated?: unknown; textBytes?: unknown;
      replyPreview?: unknown; replyTruncated?: unknown; replyLength?: unknown;
      loopTriggered?: unknown; errorCode?: unknown;
      errorMessagePreview?: unknown; changedFields?: unknown;
    };
    const family = p.family;
    const phase = p.phase;
    if (
      (family !== "agent_list" && family !== "agent_message"
        && family !== "agent_create" && family !== "agent_update")
      || (phase !== "dispatch" && phase !== "result" && phase !== "error")
    ) return null;
    return (
      <ManagerLifecyclePanel
        family={family}
        phase={phase}
        status={typeof p.status === "string" ? p.status : null}
        agentId={typeof p.agentId === "string" ? p.agentId : null}
        agentName={typeof p.agentName === "string" ? p.agentName : null}
        taskId={typeof p.taskId === "string" ? p.taskId : null}
        envelopeId={typeof p.envelopeId === "string" ? p.envelopeId : null}
        conversationId={typeof p.conversationId === "string" ? p.conversationId : null}
        source={typeof p.source === "string" ? p.source : null}
        model={typeof p.model === "string" ? p.model : null}
        skillset={typeof p.skillset === "string" ? p.skillset : null}
        agentStatus={typeof p.agentStatus === "string" ? p.agentStatus : null}
        agentCount={typeof p.agentCount === "number" ? p.agentCount : null}
        includeArchived={typeof p.includeArchived === "boolean" ? p.includeArchived : null}
        textPreview={typeof p.textPreview === "string" ? p.textPreview : null}
        textTruncated={typeof p.textTruncated === "boolean" ? p.textTruncated : null}
        textBytes={typeof p.textBytes === "number" ? p.textBytes : null}
        replyPreview={typeof p.replyPreview === "string" ? p.replyPreview : null}
        replyTruncated={typeof p.replyTruncated === "boolean" ? p.replyTruncated : null}
        replyLength={typeof p.replyLength === "number" ? p.replyLength : null}
        loopTriggered={typeof p.loopTriggered === "boolean" ? p.loopTriggered : null}
        errorCode={typeof p.errorCode === "string" ? p.errorCode : null}
        errorMessagePreview={
          typeof p.errorMessagePreview === "string" ? p.errorMessagePreview : null
        }
        changedFields={
          Array.isArray(p.changedFields)
            ? p.changedFields.filter((s): s is string => typeof s === "string")
            : null
        }
      />
    );
  }
  return null;
}

/**
 *  — compact properties row for generic tool events. Backend
 * forwards a whitelisted subset of pre-truncated fields: `toolName`,
 * `subEvent`, `taskId`, plus opportunistic `pathPreview` and `sourceId`
 * for path-shaped events like `tool.content_list`. The accordion title
 * already shows `Tool: <name> (<subEvent>)`, so this body focuses on
 * the operator-useful correlators (path, source, task).
 */
function ToolPropsRow({ props }: { props: unknown }) {
  const p = (props ?? {}) as {
    toolName?: string; subEvent?: string | null; taskId?: string | null;
    pathPreview?: string | null; sourceId?: string | null;
  };
  const hasTool = typeof p.toolName === "string" && p.toolName.length > 0;
  const hasPath = typeof p.pathPreview === "string" && p.pathPreview.length > 0;
  const hasSource = typeof p.sourceId === "string" && p.sourceId.length > 0;
  const hasTask = typeof p.taskId === "string" && p.taskId.length > 0;
  if (!hasTool && !hasPath && !hasSource && !hasTask) {
    return <p className="text-xs text-slate-500 italic">No structured params logged.</p>;
  }
  return (
    <dl className="grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-0.5 text-xs items-baseline">
      {hasTool && (
        <>
          <dt className="text-slate-500">tool</dt>
          <dd className="text-slate-300 font-mono break-all">
            {p.toolName}
            {p.subEvent && <span className="text-slate-500"> · {p.subEvent}</span>}
          </dd>
        </>
      )}
      {hasPath && (
        <>
          <dt className="text-slate-500">path</dt>
          <dd className="text-slate-300 font-mono break-all">{p.pathPreview}</dd>
        </>
      )}
      {hasSource && (
        <>
          <dt className="text-slate-500">source</dt>
          <dd className="text-slate-400 font-mono break-all">{p.sourceId}</dd>
        </>
      )}
      {hasTask && (
        <>
          <dt className="text-slate-500">task</dt>
          <dd className="text-slate-400 font-mono break-all">{p.taskId}</dd>
        </>
      )}
    </dl>
  );
}
