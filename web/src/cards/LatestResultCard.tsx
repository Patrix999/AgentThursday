import type { ArtifactView } from "../../shared/schema";

export function LatestResultCard({ result }: { result: ArtifactView | null }) {
  if (!result) {
    return (
      <Card label="Latest Result">
        <div className="text-sm text-slate-400">No result yet.</div>
      </Card>
    );
  }
  return (
    <Card label="Latest Result">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm text-slate-100 font-medium break-words">{result.title}</div>
        <div className="text-xs text-slate-500 shrink-0">{relativeTime(result.createdAt)}</div>
      </div>
      <div className="mt-2 text-xs text-slate-400">{result.kind}</div>
      <div className="mt-2 text-sm text-slate-300 whitespace-pre-wrap break-words">
        {result.textSummary}
      </div>
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

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
