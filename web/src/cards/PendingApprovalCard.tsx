import { useState } from "react";
import type { ApprovalView } from "../../shared/schema";
import { approveMutation, rejectMutation, approveTool, rejectTool } from "../api/actions";

export function PendingApprovalCard({
  approval,
  hideActions = false,
}: {
  approval: ApprovalView | null;
  /**
   * Card 80: when true (mobile), suppress in-card Approve/Reject buttons —
   * `MobileComposer` hoists them into the bottom action bar so they sit
   * in thumb-reach with the home indicator inset.
   */
  hideActions?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false); // optimistic dismissal

  if (!approval || hidden) {
    return (
      <Card label="Pending Approval">
        <div className="text-sm text-slate-400">No approvals waiting.</div>
      </Card>
    );
  }

  async function run(fn: () => Promise<{ ok: boolean; status: number; error?: string }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (res.ok) {
      setHidden(true); // polling will reconcile within 3s
    } else if (res.status !== 401) {
      // 401 is handled globally by SecretGate via postJson; surface anything else
      setError(res.error ?? `HTTP ${res.status}`);
    }
    setBusy(false);
  }

  if (approval.kind === "tool") {
    return (
      <Card label="Pending Approval">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-violet-300 px-2 py-0.5 rounded bg-violet-900/60">tool</span>
          <span className="text-sm text-slate-100 font-medium">{approval.toolName}</span>
        </div>
        <div className="mt-2 text-sm text-slate-300 break-words">{approval.reason}</div>
        {!hideActions && (
          <Actions
            busy={busy}
            onApprove={() => void run(() => approveTool(approval.toolCallId))}
            onReject={() => void run(() => rejectTool(approval.toolCallId))}
          />
        )}
        {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
      </Card>
    );
  }

  // mutation
  return (
    <Card label="Pending Approval">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-amber-300 px-2 py-0.5 rounded bg-amber-900/60">mutation</span>
        {approval.cardRef && (
          <span className="text-xs text-slate-400">{approval.cardRef}</span>
        )}
      </div>
      <div className="mt-2 text-sm text-slate-300 break-words">{approval.reason}</div>
      <pre className="mt-2 text-xs text-slate-300 bg-slate-950/60 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
        {clipLines(approval.diffSnippet, 8)}
      </pre>
      {!hideActions && (
        <Actions
          busy={busy}
          onApprove={() => void run(() => approveMutation(approval.mutationId))}
          onReject={() => void run(() => rejectMutation(approval.mutationId))}
        />
      )}
      {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
    </Card>
  );
}

function Actions({
  busy,
  onApprove,
  onReject,
}: {
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-3 flex gap-2">
      <button
        disabled={busy}
        onClick={onApprove}
        className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
      >
        {busy ? "…" : "Approve"}
      </button>
      <button
        disabled={busy}
        onClick={onReject}
        className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
      >
        {busy ? "…" : "Reject"}
      </button>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function clipLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…(+${lines.length - maxLines} more lines)`;
}
