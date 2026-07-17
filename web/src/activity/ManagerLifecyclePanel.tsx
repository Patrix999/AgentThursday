import { Fragment } from "react";

type Phase = "dispatch" | "result" | "error";
type Family = "agent_list" | "agent_message" | "agent_create" | "agent_update";

type Props = {
  family: Family;
  phase: Phase;
  status?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  taskId?: string | null;
  envelopeId?: string | null;
  conversationId?: string | null;
  source?: string | null;
  model?: string | null;
  skillset?: string | null;
  agentStatus?: string | null;
  agentCount?: number | null;
  includeArchived?: boolean | null;
  textPreview?: string | null;
  textTruncated?: boolean | null;
  textBytes?: number | null;
  replyPreview?: string | null;
  replyTruncated?: boolean | null;
  replyLength?: number | null;
  loopTriggered?: boolean | null;
  errorCode?: string | null;
  errorMessagePreview?: string | null;
  changedFields?: string[] | null;
};

/**
 * Activity panel for manager tool lifecycle intents
 * (`type: "tool.lifecycle"`, `component.name: "ManagerLifecyclePanel"`).
 *
 * Renders correlator rows (agent / task / envelope / conversation /
 * source), text/reply previews as wrap-safe blocks, and per-family
 * chips (model / skillset / status / changedFields / agent count /
 * include_archived / loop). Error phase surfaces `errorCode` + an
 * error message block.
 *
 * Body only — accordion header (badge + title + time) and the one-line
 * summary above are owned by `ActivityFeed` / `ActivityCard`.
 *
 * All props arrive already-redacted from the backend mapper; this
 * component never re-derives, never fetches, never formats raw JSON.
 */
export function ManagerLifecyclePanel(props: Props) {
  const correlators: Array<{ label: string; value: string }> = [];
  if (props.agentId) correlators.push({ label: "agent", value: props.agentId });
  if (props.conversationId) correlators.push({ label: "conv", value: props.conversationId });
  if (props.taskId) correlators.push({ label: "task", value: props.taskId });
  if (props.envelopeId) correlators.push({ label: "env", value: props.envelopeId });
  if (props.source) correlators.push({ label: "via", value: props.source });

  const chips: Array<{ label: string; tone?: "ok" | "warn" }> = [];
  if (props.status) chips.push({ label: props.status });
  if (props.agentStatus) chips.push({ label: props.agentStatus });
  if (props.model) chips.push({ label: props.model });
  if (props.skillset) chips.push({ label: props.skillset });
  if (props.agentCount !== null && props.agentCount !== undefined) {
    chips.push({ label: `${props.agentCount} agents` });
  }
  if (props.includeArchived === true) chips.push({ label: "incl. archived" });
  if (props.loopTriggered === true) chips.push({ label: "loop triggered", tone: "ok" });
  if (props.changedFields && props.changedFields.length > 0) {
    chips.push({ label: `changed: ${props.changedFields.join(", ")}` });
  }

  const showText =
    props.phase === "dispatch"
    && props.family === "agent_message"
    && typeof props.textPreview === "string"
    && props.textPreview.length > 0;
  const showReply =
    props.phase === "result"
    && props.family === "agent_message"
    && typeof props.replyPreview === "string"
    && props.replyPreview.length > 0;
  const showError =
    props.phase === "error"
    && (props.errorCode || (typeof props.errorMessagePreview === "string"
      && props.errorMessagePreview.length > 0));

  const hasAny =
    correlators.length > 0 || chips.length > 0 || showText || showReply || showError;
  if (!hasAny) return null;

  return (
    <div className="mt-2 space-y-2">
      {correlators.length > 0 && (
        <dl className="grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-0.5 text-xs items-baseline">
          {correlators.map((c) => (
            <Fragment key={c.label}>
              <dt className="text-slate-500">{c.label}</dt>
              <dd className="text-slate-300 font-mono break-all">{c.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {showText && (
        <PreviewBlock
          label="text"
          body={props.textPreview as string}
          truncated={props.textTruncated === true}
          fullLength={props.textBytes ?? null}
          lengthUnit="c"
        />
      )}

      {showReply && (
        <PreviewBlock
          label="reply"
          body={props.replyPreview as string}
          truncated={props.replyTruncated === true}
          fullLength={props.replyLength ?? null}
          lengthUnit="c"
        />
      )}

      {showError && (
        <div className="space-y-1">
          {props.errorCode && (
            <div className="grid grid-cols-[3.5rem_1fr] gap-x-3 text-xs items-baseline">
              <span className="text-slate-500">code</span>
              <span className="text-amber-300 font-mono break-all">{props.errorCode}</span>
            </div>
          )}
          {props.errorMessagePreview && (
            <pre className="text-xs bg-amber-950/30 border border-amber-900/40 rounded p-2 text-amber-100 whitespace-pre-wrap break-words font-mono">
              {props.errorMessagePreview}
            </pre>
          )}
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip, i) => (
            <span
              key={`${chip.label}-${i}`}
              className={
                chip.tone === "ok"
                  ? "text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-200"
                  : "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300"
              }
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewBlock(props: {
  label: string;
  body: string;
  truncated: boolean;
  fullLength: number | null;
  lengthUnit: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-mono">
        {props.label}
        {props.truncated && props.fullLength !== null && (
          <span className="ml-2 text-slate-600 normal-case tracking-normal">
            truncated · {props.fullLength}
            {props.lengthUnit}
          </span>
        )}
      </div>
      <pre className="text-xs bg-slate-950/60 rounded p-2 text-slate-200 whitespace-pre-wrap break-words font-mono">
        {props.body}
      </pre>
    </div>
  );
}
