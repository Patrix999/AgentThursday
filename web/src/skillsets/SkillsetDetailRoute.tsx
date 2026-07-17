import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getSkillsetLoaderDetail,
  getSkillsetOptions,
  getSkillsetRuntime,
  getSkillsetTools,
  type SkillsetDetailEntry,
  type SkillsetLoaderDetail,
  type SkillsetOption,
  type SkillsetRuntimeSummary,
  type SkillsetToolRow,
  type SkillsetToolsResponse,
} from "../api/skillsets";
import {
  deriveRuntimeCapabilitySnapshot,
  resolveRuntimeState,
  type RuntimeCapabilitySnapshot,
  type RuntimeState,
  type RuntimeStateInfo,
} from "../../../src/skillset/runtimeCapabilitySnapshot";
import { ActiveAgentContextStrip } from "./ActiveAgentContextStrip";
import { SkillsetEditPanel } from "./SkillsetEditPanel";
import { SkillsetsLayout } from "./SkillsetsLayout";

/**
 * `/skillsets/:id` detail view.
 *
 * Read-only manifest / runtime view for a single skillset id. Each of
 * the four upstream fetches tracks its own error tuple so a single
 * endpoint failure cannot blank the page. Compact rendering (named
 * sections, badges); the raw payload sits behind a collapsible
 * `<details>` for verifiers who want to read the wire shape.
 */
export function SkillsetDetailRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const [options, setOptions] = useState<SkillsetOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillsetLoaderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tools, setTools] = useState<SkillsetToolsResponse | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<SkillsetRuntimeSummary | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    if (id.length === 0) return;
    let cancelled = false;
    setOptions(null); setOptionsError(null);
    setDetail(null); setDetailError(null);
    setTools(null); setToolsError(null);
    setRuntime(null); setRuntimeError(null);
    getSkillsetOptions()
      .then(r => { if (!cancelled) setOptions(r ?? []); })
      .catch(e => { if (!cancelled) setOptionsError(String(e)); });
    getSkillsetLoaderDetail()
      .then(r => { if (!cancelled) setDetail(r); })
      .catch(e => { if (!cancelled) setDetailError(String(e)); });
    getSkillsetTools(id)
      .then(r => { if (!cancelled) setTools(r); })
      .catch(e => { if (!cancelled) setToolsError(String(e)); });
    getSkillsetRuntime()
      .then(r => { if (!cancelled) setRuntime(r); })
      .catch(e => { if (!cancelled) setRuntimeError(String(e)); });
    return () => { cancelled = true; };
  }, [id]);

  const optionMatch = options?.find(o => o.id === id) ?? null;
  const detailEntry: SkillsetDetailEntry | null =
    detail?.entries.find(e => e.skillset_id === id) ?? null;
  const toolRows: SkillsetToolRow[] = tools?.skillsets[id] ?? [];
  const selectable = options !== null && optionMatch !== null;

  const runtimeState = resolveRuntimeState(id, runtime);
  const snapshot = deriveRuntimeCapabilitySnapshot({
    id,
    detailEntry,
    toolRows,
    runtime,
  });

  const stillLoading =
    options === null && detail === null && tools === null && runtime === null &&
    optionsError === null && detailError === null && toolsError === null && runtimeError === null;

  const known =
    optionMatch !== null ||
    detailEntry !== null ||
    runtimeState.state !== "absent";

  return (
    <SkillsetsLayout label="Detail" backTo="/skillsets" backLabel="← Skillsets">
      <div className="space-y-4">
        <ActiveAgentContextStrip />

        {stillLoading && <div className="text-sm text-slate-500">Loading…</div>}

        {(optionsError || detailError || toolsError || runtimeError) && (
          <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300 space-y-0.5">
            {optionsError && <div>Selectable list unavailable: {optionsError}</div>}
            {detailError && <div>Loader detail unavailable: {detailError}</div>}
            {toolsError && <div>Tool table unavailable: {toolsError}</div>}
            {runtimeError && <div>Runtime summary unavailable: {runtimeError}</div>}
          </div>
        )}

        {!stillLoading && !known && (
          <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
            Skillset not found: <span className="font-mono">{id}</span>
          </div>
        )}

        {known && (
          <>
            <header className="space-y-1">
              <div className="text-lg text-slate-100">
                {optionMatch?.name ?? id}
              </div>
              <div className="text-xs text-slate-500 font-mono">{id}</div>
              {optionMatch?.description && (
                <div className="text-sm text-slate-300">{optionMatch.description}</div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <RuntimeBadge state={runtimeState.state} />
                {detailEntry && (
                  <span className="text-xs text-slate-500 font-mono">
                    v{detailEntry.skillset_version}
                  </span>
                )}
                {selectable && (
                  <span
                    className="text-[10px] uppercase tracking-wide text-sky-300 border border-sky-700/60 rounded px-1.5 py-0.5"
                    title="Offered in the create-cloud-agent flow"
                  >
                    selectable
                  </span>
                )}
              </div>
            </header>

            <SkillsetEditPanel id={id} />

            <RuntimeCapabilitySnapshotPanel snapshot={snapshot} />

            <SkillsSection entry={detailEntry} />

            <ToolsSection
              rows={toolRows}
              loadedAt={tools?.loaded_at ?? null}
              empty={tools !== null && toolRows.length === 0}
            />

            {runtime && (
              <AgentToolsSection
                runtime={runtime}
                skillsetId={id}
              />
            )}

            <RawPayloadSection
              optionMatch={optionMatch}
              detailEntry={detailEntry}
              toolRows={toolRows}
              runtimeState={runtimeState.raw}
            />
          </>
        )}
      </div>
    </SkillsetsLayout>
  );
}

function RuntimeBadge(props: { state: RuntimeState }) {
  const styles: Record<RuntimeState, { label: string; cls: string }> = {
    loaded: { label: "Loaded", cls: "text-emerald-300 border-emerald-700/60" },
    disabled: { label: "Disabled", cls: "text-amber-300 border-amber-700/60" },
    rejected: { label: "Rejected", cls: "text-rose-300 border-rose-700/60" },
    absent: { label: "Not active", cls: "text-slate-400 border-slate-700" },
  };
  const s = styles[props.state];
  return (
    <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${s.cls}`}>
      {s.label}
    </span>
  );
}

/**
 * Runtime capability snapshot.
 *
 * Operator-facing explainer for "what can this skillset actually do
 * right now": runtime state + consequence sentence, counts of declared
 * skills, tool contracts, active-agent bindings, approval-required,
 * stub-only, missing-handler, event-emitting; tier distribution and
 * SOUL caps. Read-only — no enable/disable, no enforcement.
 *
 * Copy was reviewed by agentD on 2026-05-26 (Discord msg
 * `100000000000000009`): drop implementation jargon, merge
 * stub-only / missing-handler labels into self-explanatory phrasing,
 * and use the plain "Skillset cap: … · Total runtime: …" caps line.
 */
function RuntimeCapabilitySnapshotPanel(props: {
  snapshot: RuntimeCapabilitySnapshot;
}) {
  const s = props.snapshot;
  const consequence = consequenceCopy(s.state, s.reason);
  const tierKeys = Object.keys(s.tier_distribution).sort();

  return (
    <section className="rounded border border-slate-800 bg-slate-900/40 px-3 py-3 space-y-2">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        Runtime capability snapshot
      </div>
      <div className="text-sm text-slate-200">{consequence}</div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <CountChip label="Declared skills" value={s.counts.declared_skills} />
        <CountChip label="Tool contracts" value={s.counts.tool_contracts} />
        <CountChip
          label="Available to active agent"
          value={s.counts.active_agent_bindings}
          title="Tools currently bound on the active agent for this skillset"
        />
        <CountChip
          label="Awaits approval"
          value={s.counts.approval_required}
          tone={s.counts.approval_required > 0 ? "amber" : "neutral"}
        />
        <CountChip
          label="Stub only"
          value={s.counts.not_implemented}
          tone={s.counts.not_implemented > 0 ? "rose" : "neutral"}
          title="Contract is declared but no implementation in code"
        />
        <CountChip
          label="Missing handler"
          value={s.counts.no_handler}
          tone={s.counts.no_handler > 0 ? "rose" : "neutral"}
          title="Contract has an implementation but no live binding on this agent"
        />
        <CountChip
          label="Emits events"
          value={s.counts.event_emitting}
          title="Tool contracts that emit events when called"
        />
      </div>

      {tierKeys.length > 0 && (
        <div className="text-xs text-slate-400">
          <span className="text-slate-500">Tier mix</span>{" "}
          {tierKeys
            .map((k) => `tier ${k}: ${s.tier_distribution[k]}`)
            .join(" · ")}
        </div>
      )}

      {s.caps && (
        <div className="text-xs text-slate-400">
          Skillset cap: {s.caps.per_skillset_token_cap.toLocaleString()} tokens
          {" · "}
          Total runtime: {s.caps.total_soul_token_estimate.toLocaleString()} /
          {" "}
          {s.caps.total_soul_token_cap.toLocaleString()}
        </div>
      )}
    </section>
  );
}

function consequenceCopy(state: RuntimeState, reason: string | null): string {
  switch (state) {
    case "loaded":
      return "This skillset is active in the current build and can contribute tools.";
    case "disabled":
      return reason
        ? `Disabled (${reason}). Managers will not see tools from this skillset until it is enabled.`
        : "Managers will not see tools from this skillset until it is enabled.";
    case "rejected":
      return "This skillset couldn't load, so no tools are available from it.";
    case "absent":
      return "This skillset is known but not part of the current runtime.";
  }
}

function CountChip(props: {
  label: string;
  value: number;
  tone?: "neutral" | "amber" | "rose";
  title?: string;
}) {
  const toneCls =
    props.tone === "amber"
      ? "text-amber-300"
      : props.tone === "rose"
      ? "text-rose-300"
      : "text-slate-200";
  return (
    <div
      className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5"
      title={props.title}
    >
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {props.label}
      </div>
      <div className={`text-sm ${toneCls}`}>{props.value}</div>
    </div>
  );
}

function SkillsSection(props: { entry: SkillsetDetailEntry | null }) {
  const entry = props.entry;
  return (
    <section>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Skills</div>
      {entry === null ? (
        <div className="text-sm text-slate-500 italic">
          (loader detail not available for this skillset)
        </div>
      ) : entry.skills.length === 0 ? (
        <div className="text-sm text-slate-500 italic">(no skills declared)</div>
      ) : (
        <ul className="space-y-1.5">
          {entry.skills.map(s => (
            <li
              key={s.id}
              className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2"
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm text-slate-100 font-medium">{s.name}</span>
                <span className="text-xs text-slate-500 font-mono">{s.id}</span>
                <span className="text-[10px] uppercase tracking-wide text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">
                  tier {s.tier}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">
                  {s.capability_class}
                </span>
                {!s.prompt_segment_present && (
                  <span
                    className="text-[10px] uppercase tracking-wide text-amber-300 border border-amber-700/60 rounded px-1.5 py-0.5"
                    title="No prompt_segment set in manifest"
                  >
                    no prompt segment
                  </span>
                )}
              </div>
              {s.tools.length > 0 && (
                <div className="mt-1 text-xs text-slate-400">
                  <span className="text-slate-500">tools</span>{" "}
                  <span className="font-mono">{s.tools.join(", ")}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolsSection(props: {
  rows: SkillsetToolRow[];
  loadedAt: string | null;
  empty: boolean;
}) {
  return (
    <section>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Tool contracts</div>
      {props.rows.length === 0 ? (
        <div className="text-sm text-slate-500 italic">
          {props.empty
            ? "(no tool contracts exposed; only loaded skillsets surface here)"
            : "(loading or unavailable)"}
        </div>
      ) : (
        <ul className="space-y-1">
          {props.rows.map(t => (
            <li
              key={t.name}
              className="flex items-baseline gap-2 flex-wrap text-sm text-slate-200"
            >
              <span className="font-mono">{t.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">
                tier {t.tier}
              </span>
              {t.approval_required && (
                <span className="text-[10px] uppercase tracking-wide text-amber-300 border border-amber-700/60 rounded px-1.5 py-0.5">
                  approval
                </span>
              )}
              {!t.implemented && (
                <span className="text-[10px] uppercase tracking-wide text-rose-300 border border-rose-700/60 rounded px-1.5 py-0.5">
                  not implemented
                </span>
              )}
              {t.emit_events.length > 0 && (
                <span className="text-xs text-slate-500">
                  emits {t.emit_events.join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.loadedAt && (
        <div className="text-xs text-slate-500 mt-1">
          Tool table loaded {props.loadedAt}
        </div>
      )}
    </section>
  );
}

function AgentToolsSection(props: {
  runtime: SkillsetRuntimeSummary;
  skillsetId: string;
}) {
  const bindings = props.runtime.agent_tools.filter(b => b.skillset_id === props.skillsetId);
  if (bindings.length === 0) return null;
  return (
    <section>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
        Active-agent tool bindings
      </div>
      <ul className="space-y-1">
        {bindings.map(b => (
          <li
            key={b.ai_sdk_name}
            className="flex items-baseline gap-2 flex-wrap text-sm text-slate-200"
          >
            <span className="font-mono">{b.ai_sdk_name}</span>
            <span className="text-xs text-slate-500 font-mono">
              {b.skill_id}/{b.tool_id}
            </span>
            {!b.has_handler && (
              <span className="text-[10px] uppercase tracking-wide text-rose-300 border border-rose-700/60 rounded px-1.5 py-0.5">
                no handler
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RawPayloadSection(props: {
  optionMatch: SkillsetOption | null;
  detailEntry: SkillsetDetailEntry | null;
  toolRows: SkillsetToolRow[];
  runtimeState: RuntimeStateInfo["raw"];
}) {
  const payload = {
    option: props.optionMatch,
    detail: props.detailEntry,
    tools: props.toolRows,
    runtime: props.runtimeState,
  };
  return (
    <details className="rounded border border-slate-800 bg-slate-900/30 px-3 py-2">
      <summary className="text-xs uppercase tracking-wide text-slate-400 cursor-pointer">
        Raw payload
      </summary>
      <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap break-words font-mono">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}
