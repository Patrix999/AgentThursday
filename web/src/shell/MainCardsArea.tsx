import type { WorkspaceSnapshot } from "../../shared/schema";
import { CurrentTaskCard } from "../cards/CurrentTaskCard";
import { LatestResultCard } from "../cards/LatestResultCard";
import { PendingApprovalCard } from "../cards/PendingApprovalCard";
import { NeedReplyCard } from "../cards/NeedReplyCard";

type Props = {
  snapshot: WorkspaceSnapshot | null;
  /** Card 80: mobile branch sets this true so PendingApprovalCard doesn't
   *  render its in-card Approve/Reject — MobileComposer hoists them. */
  hideApprovalActions?: boolean;
};

export function MainCardsArea({ snapshot, hideApprovalActions = false }: Props) {
  return (
    <section className="grid gap-3 p-4 lg:grid-cols-2">
      <CurrentTaskCard task={snapshot?.currentTask ?? null} />
      <LatestResultCard result={snapshot?.latestResult ?? null} />
      <PendingApprovalCard
        approval={snapshot?.pendingApproval ?? null}
        hideActions={hideApprovalActions}
      />
      <NeedReplyCard replyNeed={snapshot?.replyNeed ?? null} />
    </section>
  );
}
