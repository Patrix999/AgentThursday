import type { WorkspaceSnapshot } from "../../shared/schema";
import { CurrentTaskCard } from "../cards/CurrentTaskCard";
import { PendingApprovalCard } from "../cards/PendingApprovalCard";
import { NeedReplyCard } from "../cards/NeedReplyCard";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  /** mobile branch sets this true so PendingApprovalCard doesn't render
   * its in-card Approve/Reject — MobileComposer hoists them. */
  hideApprovalActions?: boolean;
};

/**
 * Card 126 audit: this section now renders **only** signal-bearing cards
 * (current task / pending approval / reply need). The `LatestResultCard`
 * was always-on noise — its job is superseded by the Activity feed,
 * which renders per-tool cards as the model takes actions. When none of
 * the three remaining cards has data, the whole section returns null so
 * the default shell stays calm.
 */
export function MainCardsArea({ snapshot, hideApprovalActions = false }: Props) {
  const task = snapshot?.currentTask ?? null;
  const approval = snapshot?.pendingApproval ?? null;
  const replyNeed = snapshot?.replyNeed ?? null;

  if (!task && !approval && !replyNeed) return null;

  return (
    <section className="grid gap-3 p-4 lg:grid-cols-2">
      {task && <CurrentTaskCard task={task} />}
      {approval && (
        <PendingApprovalCard approval={approval} hideActions={hideApprovalActions} />
      )}
      {replyNeed && <NeedReplyCard replyNeed={replyNeed} />}
    </section>
  );
}
