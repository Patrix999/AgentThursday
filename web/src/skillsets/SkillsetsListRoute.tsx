import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  buildSkillsetRows,
  type SkillsetRow,
  type SkillsetRowStatus,
} from "../../../src/agent/skillsetStatusRows";
import {
  getSkillsetLoaderDetail,
  getSkillsetOptions,
  getSkillsetRuntime,
  type SkillsetLoaderDetail,
  type SkillsetOption,
  type SkillsetRuntimeSummary,
} from "../api/skillsets";
import { ActiveAgentContextStrip } from "./ActiveAgentContextStrip";
import { SkillsetsLayout } from "./SkillsetsLayout";

/**
 * `/skillsets` list view.
 *
 * Three independent fetches (options / runtime / loader detail) each
 * track their own `[data, error]` tuple so one failure cannot blank
 * the page. The pure `buildSkillsetRows` mapper merges whatever loaded;
 * missing data falls back to safe defaults.
 */
export function SkillsetsListRoute() {
  const [options, setOptions] = useState<SkillsetOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<SkillsetRuntimeSummary | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillsetLoaderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSkillsetOptions()
      .then(r => { if (!cancelled) setOptions(r ?? []); })
      .catch(e => { if (!cancelled) setOptionsError(String(e)); });
    getSkillsetRuntime()
      .then(r => { if (!cancelled) setRuntime(r); })
      .catch(e => { if (!cancelled) setRuntimeError(String(e)); });
    getSkillsetLoaderDetail()
      .then(r => { if (!cancelled) setDetail(r); })
      .catch(e => { if (!cancelled) setDetailError(String(e)); });
    return () => {
      cancelled = true;
    };
  }, []);

  const stillLoading =
    options === null && runtime === null && detail === null &&
    optionsError === null && runtimeError === null && detailError === null;

  const rows = buildSkillsetRows({
    options: options ?? [],
    runtime,
    detail: detail ? { entries: detail.entries } : null,
  });

  return (
    <SkillsetsLayout label="List">
      <div className="space-y-3">
        <ActiveAgentContextStrip />
        {(optionsError || runtimeError || detailError) && (
          <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300 space-y-0.5">
            {optionsError && <div>Selectable list unavailable: {optionsError}</div>}
            {runtimeError && <div>Runtime summary unavailable: {runtimeError}</div>}
            {detailError && <div>Loader detail unavailable: {detailError}</div>}
            <div className="text-rose-400/80">
              Rows below were merged from whatever loaded successfully.
            </div>
          </div>
        )}
        {stillLoading && <div className="text-sm text-slate-500">Loading…</div>}
        {!stillLoading && rows.length === 0 && (
          <div className="rounded border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-400 text-center">
            No skillsets reported.
          </div>
        )}
        {rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map(row => <SkillsetRowItem key={row.id} row={row} />)}
          </ul>
        )}
        {runtime && (
          <div className="text-xs text-slate-500 pt-1">
            Runtime snapshot: schema {runtime.schema_version}, loaded{" "}
            {runtime.loaded_at}, reload #{runtime.reload_count}.
          </div>
        )}
      </div>
    </SkillsetsLayout>
  );
}

function SkillsetRowItem(props: { row: SkillsetRow }) {
  const r = props.row;
  return (
    <li>
      <Link
        to={`/skillsets/${encodeURIComponent(r.id)}`}
        className="block rounded border border-slate-800 bg-slate-900/60 hover:border-slate-600 px-3 py-2"
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-slate-100 font-medium">{r.name}</span>
          <span className="text-xs text-slate-500 font-mono">{r.id}</span>
          <StatusBadge status={r.status} />
          {r.selectable && (
            <span
              className="text-[10px] uppercase tracking-wide text-sky-300 border border-sky-700/60 rounded px-1.5 py-0.5"
              title="Offered in the create-cloud-agent flow"
            >
              selectable
            </span>
          )}
          {r.version && (
            <span className="text-xs text-slate-500 font-mono">v{r.version}</span>
          )}
        </div>
        {r.description && (
          <div className="mt-1 text-xs text-slate-400">{r.description}</div>
        )}
        <div className="mt-1 flex gap-3 flex-wrap text-xs text-slate-500">
          <span><span className="text-slate-600">skills</span> {r.skillCount}</span>
          <span><span className="text-slate-600">tools</span> {r.toolCount}</span>
          {r.status === "disabled" && r.disabledReason && (
            <span className="text-amber-300">
              <span className="text-slate-600">reason</span> {r.disabledReason}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

const STATUS_STYLES: Record<SkillsetRowStatus, { label: string; cls: string; title: string }> = {
  loaded: {
    label: "loaded",
    cls: "text-emerald-300 border-emerald-700/60",
    title: "Skillset is loaded into the runtime",
  },
  disabled: {
    label: "disabled",
    cls: "text-amber-300 border-amber-700/60",
    title: "Operator-disabled at runtime",
  },
  rejected: {
    label: "rejected",
    cls: "text-rose-300 border-rose-700/60",
    title: "Loader rejected this skillset (see detail)",
  },
  unknown: {
    label: "unknown",
    cls: "text-slate-400 border-slate-700",
    title: "Neither runtime nor loader reported this id",
  },
};

function StatusBadge(props: { status: SkillsetRowStatus }) {
  const s = STATUS_STYLES[props.status];
  return (
    <span
      className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${s.cls}`}
      title={s.title}
    >
      {s.label}
    </span>
  );
}
