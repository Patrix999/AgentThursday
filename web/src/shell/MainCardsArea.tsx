import type { WorkspaceSnapshot } from "../../shared/schema";
import { PendingApprovalCard } from "../cards/PendingApprovalCard";
import { NeedReplyCard } from "../cards/NeedReplyCard";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  /** mobile branch sets this true so PendingApprovalCard doesn't render
   * its in-card Approve/Reject — MobileComposer hoists them. */
  hideApprovalActions?: boolean;
};

/**
 * v2.5 (an earlier revision v2.5): renders only the two action-bearing cards —
 * `PendingApprovalCard` (when an approval is waiting) and
 * `NeedReplyCard` (when the agent is waiting on the user). The current
 * task title is now part of `SummaryStream` as a user message, and its
 * lifecycle / loopStage / ladderTier / readyForNextRound badges live
 * in `TopStatusBar`. When neither card has data the whole section
 * returns null so the default shell stays calm.
 */
export function MainCardsArea({ snapshot, hideApprovalActions = false }: Props) {
  const approval = snapshot?.pendingApproval ?? null;
  const replyNeed = snapshot?.replyNeed ?? null;

  if (!approval && !replyNeed) return null;

  return (
    <section className="grid gap-3 p-4 lg:grid-cols-2">
      {approval && (
        <PendingApprovalCard approval={approval} hideActions={hideApprovalActions} />
      )}
      {replyNeed && <NeedReplyCard replyNeed={replyNeed} />}
    </section>
  );
}
