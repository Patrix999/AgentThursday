type Props = {
  queryPreview: string;
  mode?: string | null;
  sourceId?: string | null;
  sourceIdsCount?: number | null;
  strategy?: string | null;
  pathPreview?: string | null;
  maxResults?: number | null;
  // first matches as `file:line: text` (byte-capped).
  resultPreview?: string | null;
};

/**
 * Search results panel. v1 surfaces what was searched and
 * where, not the hits themselves (search hits aren't persisted in
 * `event_log`; they're returned to the agent reply directly). When
 * we later persist `tool.content_search.ok` follow-up events we can
 * extend this panel with hit rows. Defensive rendering: any missing
 * field falls back to "—".
 */
export function SearchResultsPanel(props: Props) {
  const queryPreview = safeStr(props.queryPreview);
  const sourceLabel = props.sourceId
    ? props.sourceId
    : props.sourceIdsCount !== null && props.sourceIdsCount !== undefined
      ? `${props.sourceIdsCount} sources`
      : "all sources";
  return (
    <div className="mt-2">
      <Row label="query">
        <span className="text-slate-200 font-mono break-all">"{queryPreview}"</span>
      </Row>
      <Row label="source">
        <span className="text-slate-300 break-all">{sourceLabel}</span>
        {props.mode && <span className="text-slate-500"> · {props.mode}</span>}
      </Row>
      {props.strategy && (
        <Row label="strategy">
          <span className="text-slate-400">{props.strategy}</span>
        </Row>
      )}
      {props.pathPreview && (
        <Row label="path">
          <span className="text-slate-400 font-mono break-all">{props.pathPreview}</span>
        </Row>
      )}
      {props.maxResults != null && (
        <Row label="hits">
          <span className="text-slate-400">{props.maxResults}</span>
        </Row>
      )}
      {props.resultPreview && (
        <pre className="mt-1 overflow-x-auto rounded border border-slate-800 bg-slate-950/60 p-2 text-[11px] leading-snug text-slate-300 whitespace-pre-wrap break-words max-h-64">
          {props.resultPreview}
        </pre>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr] gap-x-3 text-xs items-baseline">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function safeStr(s: unknown): string {
  return typeof s === "string" && s.length > 0 ? s : "—";
}
