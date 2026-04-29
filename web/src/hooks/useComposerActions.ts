import { useState } from "react";
import type { WorkspaceSnapshot } from "../../shared/schema";
import {
  submitTask,
  approveMutation,
  rejectMutation,
  approveTool,
  rejectTool,
} from "../api/actions";

/**
 * Shared composer logic — used by `Composer` (desktop) and `MobileComposer`
 * (Card 80) so the action body shapes (Card 79) stay in one place.
 *
 * The composer surfaces the user's two essential interactions: submit a new
 * task, and approve/reject the current pending mutation/tool. The
 * "force continue" affordance lives only in Inspect → RecoverActions
 * (debug-flavored) — duplicating it here was redundant.
 */
export function useComposerActions(snapshot: WorkspaceSnapshot | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingApproval = snapshot?.pendingApproval ?? null;

  async function run<T extends { ok: boolean; status: number; error?: string }>(
    fn: () => Promise<T>,
    onSuccess?: () => void,
  ) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (res.ok) {
      onSuccess?.();
    } else if (res.status !== 401) {
      setError(res.error ?? `HTTP ${res.status}`);
    }
    setBusy(false);
  }

  return {
    busy,
    error,
    pendingApproval,
    submit: (text: string, onSuccess?: () => void) =>
      run(() => submitTask(text), onSuccess),
    approve: () => {
      if (!pendingApproval) return Promise.resolve();
      return run(() =>
        pendingApproval.kind === "tool"
          ? approveTool(pendingApproval.toolCallId)
          : approveMutation(pendingApproval.mutationId),
      );
    },
    reject: () => {
      if (!pendingApproval) return Promise.resolve();
      return run(() =>
        pendingApproval.kind === "tool"
          ? rejectTool(pendingApproval.toolCallId)
          : rejectMutation(pendingApproval.mutationId),
      );
    },
  };
}
