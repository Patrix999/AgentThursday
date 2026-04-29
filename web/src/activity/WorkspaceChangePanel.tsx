type Props = {
  mutationKind: string;
  path?: string | null;
  /** Renamed from `key` to avoid React's reserved prop interception. */
  key_?: string | null;
  checkpoint?: string | null;
};

/**
 * Card 128 — Workspace mutation panel. Surfaces write-shaped agent
 * actions (checkpoint writes today + future workspace file ops) and
 * provides an "Open in workspace" affordance when the mutation
 * carries a real file path.
 *
 * The "Open in workspace" button dispatches a custom DOM event
 * (`agent-thursday:workspace:focus-path`) that `WorkspaceFileManager`
 * listens for. This avoids cross-cutting state lift while still
 * letting Card 128 wire focus into the existing read-only file
 * manager. Manual user focus is NOT stolen — focus only happens on
 * an explicit click.
 */
export function WorkspaceChangePanel(props: Props) {
  const path = typeof props.path === "string" && props.path.length > 0 ? props.path : null;
  const canFocusPath = path !== null && (path.includes("/") || path.includes("."));

  return (
    <div className="mt-2">
      <Row label="kind">
        <span className="text-slate-300">{props.mutationKind}</span>
      </Row>
      {path && (
        <Row label="path">
          <span className="text-slate-200 font-mono break-all">{path}</span>
        </Row>
      )}
      {props.key_ && (
        <Row label="key">
          <span className="text-slate-300 font-mono break-all">{props.key_}</span>
        </Row>
      )}
      {props.checkpoint && (
        <Row label="ref">
          <span className="text-slate-400 font-mono break-all">{props.checkpoint}</span>
        </Row>
      )}
      {canFocusPath && (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("agent-thursday:workspace:focus-path", { detail: { path } }),
            )
          }
          className="mt-2 text-xs px-2 py-1 rounded border border-cyan-800/60 bg-cyan-900/40 text-cyan-200 hover:bg-cyan-900/60"
        >
          Open in workspace
        </button>
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
