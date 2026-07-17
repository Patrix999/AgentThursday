type Props = {
  sourceId: string;
  pathPreview: string;
  maxBytes?: number | null;
  // bounded content preview (first ~30 lines / byte-capped).
  resultPreview?: string | null;
};

/**
 * File preview panel. v1 surfaces which file was read,
 * from which content source, with what byte cap. The actual file
 * content is NOT in the `event_log` payload (returned to agent
 * directly), so this panel doesn't show an excerpt. an earlier revision will
 * add workspace mutation/diff focus; this card is read-side only.
 */
export function FilePreviewPanel(props: Props) {
  return (
    <div className="mt-2 space-y-2">
      {props.resultPreview && (
        <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-950/60 p-2 text-[11px] leading-snug text-slate-300 whitespace-pre-wrap break-words max-h-64">
          {props.resultPreview}
        </pre>
      )}
      <Row label="path">
        <span className="text-slate-200 font-mono break-all">{props.pathPreview}</span>
      </Row>
      <Row label="source">
        <span className="text-slate-300 break-all">{props.sourceId}</span>
      </Row>
      {props.maxBytes !== null && props.maxBytes !== undefined && (
        <Row label="cap">
          <span className="text-slate-400">{formatBytes(props.maxBytes)}</span>
        </Row>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
