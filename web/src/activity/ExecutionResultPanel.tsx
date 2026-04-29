type Props = {
  variant: "execute" | "sandbox";
  tier?: number | null;
  preview?: string | null;
  reason?: string | null;
  sandboxId?: string | null;
};

/**
 * Card 127 — Execution result panel. v1 surfaces what was run and at
 * which tier, not stdout/stderr (results aren't persisted in
 * `event_log`; returned to agent directly). The preview is already
 * truncated at the call site (200 chars for `tool.execute`,
 * 80 chars for `tool.sandbox_exec`); we render with `<code>`
 * styling and `whitespace-pre-wrap` so multi-line code/commands
 * stay readable.
 */
export function ExecutionResultPanel(props: Props) {
  const tierLabel = props.tier !== null && props.tier !== undefined ? `Tier ${props.tier}` : null;
  return (
    <div className="mt-2">
      <Row label={props.variant === "sandbox" ? "command" : "code"}>
        {props.preview ? (
          <pre className="text-xs bg-slate-950/60 rounded p-2 text-slate-200 whitespace-pre-wrap break-words font-mono overflow-x-auto">
            {props.preview}
          </pre>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </Row>
      <Row label="env">
        <span className="text-slate-300">
          {props.variant === "sandbox" ? "sandbox container" : "codemode"}
        </span>
        {tierLabel && <span className="text-slate-500"> · {tierLabel}</span>}
        {props.sandboxId && (
          <span className="text-slate-500"> · {props.sandboxId}</span>
        )}
      </Row>
      {props.reason && (
        <Row label="reason">
          <span className="text-slate-400">{props.reason}</span>
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr] gap-x-3 text-xs items-baseline mb-1">
      <span className="text-slate-500 pt-1">{label}</span>
      <span>{children}</span>
    </div>
  );
}
