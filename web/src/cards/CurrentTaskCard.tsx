import type { TaskView } from "../../shared/schema";

export function CurrentTaskCard({ task }: { task: TaskView | null }) {
  if (!task) {
    return (
      <Card label="Current Task">
        <div className="text-sm text-slate-400">
          No active task. Use the composer below to submit one.
        </div>
      </Card>
    );
  }
  return (
    <Card label="Current Task">
      <div className="text-sm text-slate-100 font-medium break-words">{task.title}</div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Badge color="slate">{task.lifecycle}</Badge>
        <Badge color="sky">{task.loopStage}</Badge>
        {task.ladderTier !== null && <Badge color="violet">tier {task.ladderTier}</Badge>}
        {task.readyForNextRound && <Badge color="emerald">ready</Badge>}
      </div>
      {task.ladderReason && (
        <div className="mt-2 text-xs text-slate-400 break-words">{task.ladderReason}</div>
      )}
    </Card>
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

function Badge({ color, children }: { color: "slate" | "sky" | "violet" | "emerald"; children: React.ReactNode }) {
  const cls = {
    slate: "bg-slate-800 text-slate-300",
    sky: "bg-sky-900/60 text-sky-200",
    violet: "bg-violet-900/60 text-violet-200",
    emerald: "bg-emerald-900/60 text-emerald-200",
  }[color];
  return <span className={`px-2 py-0.5 rounded ${cls}`}>{children}</span>;
}
