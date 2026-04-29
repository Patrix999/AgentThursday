import type { InspectSnapshot } from "../../shared/schema";

export function LadderTimeline({ ladder }: { ladder: InspectSnapshot["ladder"] }) {
  if (ladder.length === 0) {
    return <Empty msg="No ladder activity yet." />;
  }
  return (
    <ol className="space-y-2 text-xs">
      {ladder.map((entry, i) => (
        <li
          key={`${entry.toolName}-${entry.at}-${i}`}
          className="flex gap-3 border-l-2 border-violet-700/60 pl-3 py-1"
        >
          <span className="shrink-0 w-12 text-violet-300 font-mono">tier {entry.tier}</span>
          <div className="min-w-0 flex-1">
            <div className="text-slate-200">{entry.toolName}</div>
            {entry.reason && (
              <div className="text-slate-400 break-words">{entry.reason}</div>
            )}
            <div className="text-slate-600">{new Date(entry.at).toLocaleTimeString()}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-sm text-slate-500">{msg}</div>;
}
