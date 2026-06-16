import type { ContextInspectResult } from "../../shared/schema";
import { pressurePillClasses, type ContextPressure } from "./contextPressure";

/**
 * UI atoms shared between `ContextRail` (popover) and
 * `ContextPanel` (Inspect tab). Extracted from `ContextRail.tsx` so the
 * deeper Inspect-tab view can reuse the same sanitized-rendering rules
 * without duplicating logic.
 *
 * Sanitization rule (defense-in-depth on top of server-side sanitization):
 *   - only `parts[].text` and `parts[].toolName` are read
 *   - tool input/output previews are NEVER read here, even though the
 *     server provides 240-char truncated previews
 *   - reasoning/system/file parts are filtered server-side; we never
 *     special-case them here
 */

export type SanitizedMessage = ContextInspectResult["visibleMessages"][number];

export function PressurePill({ pressure }: { pressure: ContextPressure }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-mono ${pressurePillClasses(pressure.level)}`}
      title={pressure.reason}
    >
      <span>pressure</span>
      <span>·</span>
      <span>{pressure.label}</span>
    </span>
  );
}

export function recommendationToneClasses(level: "growing" | "high"): string {
  return level === "high"
    ? "border border-orange-700/70 bg-orange-950/40 text-orange-200"
    : "border border-amber-700/60 bg-amber-950/40 text-amber-200";
}

export function SummaryRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? "text-slate-500" : ""}`}>
      <span className="text-slate-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export function TokenBlock({
  label,
  stats,
}: {
  label: string;
  stats: { in: number; out: number; total: number } | null;
}) {
  if (!stats) {
    return (
      <div className="mt-2 text-[11px] text-slate-500 italic">
        {label} tok <span className="font-mono">unavailable</span>
      </div>
    );
  }
  return (
    <div className="mt-2 text-[11px] text-slate-400">
      <span className="text-slate-500">{label} tok</span>{" "}
      <span className="font-mono">{stats.in}↓ {stats.out}↑ = {stats.total}</span>
    </div>
  );
}

export function TurnPreview({ message, index }: { message: SanitizedMessage; index?: number }) {
  const tonePill =
    message.role === "user"
      ? "bg-sky-900/60 text-sky-200"
      : message.parts.some((p) => p.type === "tool")
        ? "bg-fuchsia-900/60 text-fuchsia-200"
        : "bg-emerald-900/60 text-emerald-200";
  const previewText = firstTextPreview(message);
  const toolNames = collectToolNames(message);
  //  — surface a stable per-block index and the truncated flag
  // so operators can correlate hover entries to the rail segments.
  // `truncated` reads only the sanitized parts; raw text never reaches
  // the client.
  const truncated = message.parts.some((p) => Boolean((p as { truncated?: boolean }).truncated));
  return (
    <div className="rounded bg-slate-950/60 border border-slate-800 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px]">
        {typeof index === "number" && (
          <span className="font-mono text-slate-500">#{index}</span>
        )}
        <span className={`px-1 rounded ${tonePill}`}>{message.role}</span>
        {toolNames.length > 0 && (
          <span className="font-mono text-slate-400">{toolNames.join(", ")}</span>
        )}
        {truncated && (
          <span className="text-amber-300/80">·truncated</span>
        )}
        {message.partsDropped > 0 && (
          <span className="text-slate-500">·{message.partsDropped} dropped</span>
        )}
      </div>
      {previewText && (
        <div className="mt-0.5 text-[11px] text-slate-300 line-clamp-2">{previewText}</div>
      )}
    </div>
  );
}

//  — protected/system blocks must not leak content. Render a
// placeholder row so operators see they exist (count + safety note) but
// never see raw prompt / SOUL / tool payload text. The server-side
// sanitization already strips system messages out of `visibleMessages`,
// so this row is purely informational from the count.
export function ProtectedBlocksPlaceholder({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1 text-[10px] text-slate-500 italic">
      <span className="font-mono text-slate-400">·protected</span>{" "}
      {count} system block{count === 1 ? "" : "s"} hidden — content not exposed
    </div>
  );
}

export function firstTextPreview(m: SanitizedMessage): string | null {
  for (const part of m.parts) {
    if (part.type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) return text.trim();
    }
  }
  return null;
}

export function collectToolNames(m: SanitizedMessage): string[] {
  const names: string[] = [];
  for (const part of m.parts) {
    if (part.type !== "tool") continue;
    const name = (part as { toolName?: unknown }).toolName;
    if (typeof name === "string" && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

export function SummaryLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-emerald-300/70">{label}</span>
      <span className={mono ? "font-mono truncate" : "truncate"}>{value}</span>
    </div>
  );
}
