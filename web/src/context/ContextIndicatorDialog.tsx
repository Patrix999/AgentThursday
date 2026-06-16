import { useEffect, useMemo, useState } from "react";
import { contextChipLabel } from "../components/contextChip";
import { fetchActiveContext, fetchContextHistory } from "../api/contextActions";
import type { ActiveContext, ContextHistoryEntry, ContextInspectResult } from "../../shared/schema";
import { useSharedContextInspect } from "./ContextInspectProvider";

type Props = {
  instanceName?: string | null;
  maxLen?: number;
  testId: string;
  className?: string;
};

/**
 *   +  — context chip is a first-class indicator,
 * not part of the debug/inspect surface. Clicking opens this read-only
 * dialog instead of navigating to `/inspect#context`, so it remains
 * useful when `AGENT_THURSDAY_DEBUG_SURFACE_MODE=disable` hides Inspect.
 *
 *  — dialog content / visual matches the desktop ContextRail
 * (rail + hover card) reference: identity row, model + budget summary
 * with stacked composition bar, threshold lines (soft / auto / danger
 * with % of window), system-overhead breakdown, and a closed-context
 * history disclosure. Read-only — no mutation buttons, no `/inspect`
 * navigation, no SOUL / system / tool schema text. Sized for 360px
 * mobile width.
 */
export function ContextIndicatorChip({ instanceName, maxLen, testId, className }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        className={className}
        aria-label="Open context indicator"
        onClick={() => setOpen(true)}
      >
        <span className="text-[10px] uppercase tracking-wide text-cyan-500">ctx</span>
        <span className="font-mono truncate max-w-[14rem]">
          {contextChipLabel(instanceName ?? undefined, maxLen ? { maxLen } : undefined)}
        </span>
      </button>
      {open && <ContextIndicatorDialog instanceName={instanceName} onClose={() => setOpen(false)} />}
    </>
  );
}

function ContextIndicatorDialog({ instanceName, onClose }: { instanceName?: string | null; onClose: () => void }) {
  const inspect = useSharedContextInspect();
  const [active, setActive] = useState<ActiveContext | null>(null);
  const [history, setHistory] = useState<ContextHistoryEntry[] | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [a, h] = await Promise.all([fetchActiveContext(), fetchContextHistory()]);
        if (!mounted) return;
        setActive(a);
        setHistory(h?.contexts ?? []);
      } catch (e) {
        if (mounted) setIdentityError(String(e));
      }
    }
    void load();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      mounted = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const closedCount = (history ?? []).filter((c) => !c.isActive).length;
  const data = inspect.data;
  const budget = data?.contextBudget ?? null;
  const inBudgetMode = !!budget && budget.modelMaxTokens !== null && budget.modelMaxTokens > 0 && budget.usedTokens !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-12 pb-12 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Context indicator"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-cyan-800/70 bg-slate-950 shadow-2xl shadow-cyan-950/30 text-xs text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-cyan-500">Context indicator</div>
            <div className="font-mono text-cyan-200 truncate">{contextChipLabel(instanceName ?? undefined, { maxLen: 24 })}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close context indicator"
          >
            Close
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          {/* Identity */}
          {identityError && (
            <div className="rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-rose-300">
              context indicator error: {identityError}
            </div>
          )}
          {!identityError && !active && <div className="text-slate-500">loading context identity…</div>}
          {active && (
            <section className="rounded border border-slate-800 bg-slate-900/70 p-3 space-y-1.5">
              <SectionHeader>identity</SectionHeader>
              <KVRow label="active" value={shortContextId(active.contextId)} mono tone="cyan" />
              <KVRow label="opened" value={fmtTimestamp(active.createdAt)} mono />
              <KVRow label="reason" value={active.reason ?? "(none)"} />
              <KVRow label="history" value={closedCount > 0 ? `${closedCount} closed context(s)` : "first context"} />
              {instanceName && <KVRow label="agent" value={instanceName} mono />}
            </section>
          )}

          {/* Budget — same numbers/colors the rail's HeadroomBody hover card shows */}
          {data && budget && (
            <section className="rounded border border-slate-800 bg-slate-900/70 p-3 space-y-2">
              <SectionHeader source={budget.source}>context budget</SectionHeader>
              <BudgetSummary data={data} budget={budget} />
              {inBudgetMode && <CompositionBar data={data} budget={budget} />}
              <CompositionLegend />
              <ThresholdRows budget={budget} />
              <SystemOverheadBreakdown budget={budget} />
              {budget.source !== "provider" && (
                <p className="text-[10px] italic text-slate-500">
                  {budget.source === "estimated"
                    ? "Window is a conservative fallback estimate (provider hasn't reported yet)."
                    : "Window unavailable — rail / dialog show message-stack fallback."}
                </p>
              )}
            </section>
          )}
          {!data && !inspect.error && <div className="text-slate-500">loading context budget…</div>}
          {inspect.error && (
            <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-amber-300">
              context inspect unavailable: {inspect.error}
            </div>
          )}

          {/* History (collapsed) */}
          {(history ?? []).length > 1 && (
            <details className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200">
                Context history ({history?.length ?? 0})
              </summary>
              <ul className="mt-2 space-y-1 text-[10px]">
                {(history ?? []).slice(0, 8).map((c) => (
                  <li key={c.contextId} className="flex gap-2 text-slate-400">
                    <span className="font-mono text-slate-300">{shortContextId(c.contextId)}</span>
                    <span className={c.isActive ? "text-cyan-300" : "text-slate-500"}>
                      {c.isActive ? "active" : "closed"}
                    </span>
                    <span className="ml-auto truncate text-slate-500">{c.reason ?? ""}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="text-[10px] leading-relaxed text-slate-500">
            Read-only status indicator. Inspect and debug actions are gated by deployment config (<code className="font-mono text-slate-400">AGENT_THURSDAY_DEBUG_SURFACE_MODE</code>).
            Numbers only — no SOUL / system / tool schema text shown.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Budget body ────────────────────────────────────────────────────────

function BudgetSummary({
  data,
  budget,
}: {
  data: ContextInspectResult;
  budget: NonNullable<ContextInspectResult["contextBudget"]>;
}) {
  const max = budget.modelMaxTokens;
  const used = budget.usedTokens;
  const headroom = (max !== null && used !== null) ? Math.max(0, max - used) : null;
  const usedPct = (max !== null && used !== null && max > 0) ? (used / max) * 100 : null;
  const dialogTok = budget.visibleDialogTokens;
  return (
    <div className="space-y-1">
      <KVRow label="model max" value={fmtTokens(max)} mono />
      <KVRow label="used" value={used === null ? "—" : `${fmtTokens(used)}${usedPct !== null ? ` · ${usedPct.toFixed(1)}%` : ""}`} mono />
      <KVRow label="headroom" value={fmtTokens(headroom)} mono />
      <KVRow
        label="dialog"
        value={dialogTok === null ? "unavailable" : fmtTokens(dialogTok)}
        mono
        muted={dialogTok === null}
      />
      <KVRow label="msgs" value={`${data.visibleMessages.length} / ${data.totalMessageCount}`} muted />
    </div>
  );
}

function CompositionBar({
  data,
  budget,
}: {
  data: ContextInspectResult;
  budget: NonNullable<ContextInspectResult["contextBudget"]>;
}) {
  // Mirror ContextRail buildBudgetSegments scaling so the bar's
  // composition matches what the desktop rail draws — same tokens
  // distributed across user / assistant / tool / system overhead +
  // headroom remainder.
  const max = budget.modelMaxTokens ?? 0;
  const used = budget.usedTokens ?? 0;
  if (max <= 0) return null;
  const sysOH = budget.systemOverheadTokens ?? 0;
  const dialogTok = budget.visibleDialogTokens ?? 0;
  const cappedUsed = Math.min(used, max);
  const scale = used > 0 ? cappedUsed / used : 1;
  const headroomTok = Math.max(0, max - cappedUsed);
  const userMsgs = data.visibleMessages.filter((m) => m.role === "user").length;
  const toolMsgs = data.visibleMessages.filter((m) => (m.parts ?? []).some((p) => p.type === "tool")).length;
  const assistantMsgs = data.visibleMessages.filter((m) => m.role === "assistant" && !(m.parts ?? []).some((p) => p.type === "tool")).length;
  const dialogDenom = Math.max(1, userMsgs + assistantMsgs + toolMsgs);
  const dialogUserTok = dialogTok * scale * (userMsgs / dialogDenom);
  const dialogAssistantTok = dialogTok * scale * (assistantMsgs / dialogDenom);
  const dialogToolTok = dialogTok * scale * (toolMsgs / dialogDenom);
  const scaledSysOH = sysOH * scale;

  // Threshold lines on the horizontal bar — soft / auto / danger.
  const thresholds: Array<{ at: number | null; tone: "soft" | "auto" | "danger" }> = [
    { at: budget.softCompactAt ?? null, tone: "soft" },
    { at: budget.autoCompactAt, tone: "auto" },
    { at: budget.dangerAt, tone: "danger" },
  ];

  const segments: Array<{ tone: SegmentTone; tokens: number; label: string; messages?: number }> = [
    { tone: "system-overhead" as const, tokens: scaledSysOH, label: "system" },
    { tone: "user" as const, tokens: dialogUserTok, label: "user", messages: userMsgs },
    { tone: "assistant" as const, tokens: dialogAssistantTok, label: "assistant", messages: assistantMsgs },
    { tone: "tool" as const, tokens: dialogToolTok, label: "tool", messages: toolMsgs },
    { tone: "headroom" as const, tokens: headroomTok, label: "headroom" },
  ].filter((s) => s.tokens > 0);

  return (
    <div className="space-y-1">
      <div
        className="relative h-3 w-full overflow-hidden rounded border border-slate-700/70 bg-slate-800/95"
        aria-label="Context window composition"
      >
        <div className="flex h-full w-full">
          {segments.map((seg, i) => (
            <div
              key={`${seg.tone}-${i}`}
              className={`${TONE_BG[seg.tone]} h-full`}
              style={{ flexBasis: `${(seg.tokens / max) * 100}%`, flexGrow: 0 }}
              title={`${seg.label}: ${fmtTokens(seg.tokens)}${seg.messages !== undefined ? ` · ${seg.messages} msg` : ""}`}
            />
          ))}
        </div>
        {thresholds.map((t) =>
          t.at !== null && t.at >= 0 && t.at <= max ? (
            <span
              key={t.tone}
              className={`absolute top-0 bottom-0 w-px ${THRESHOLD_BG[t.tone]}`}
              style={{ left: `${(t.at / max) * 100}%` }}
              aria-hidden="true"
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function CompositionLegend() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
      <LegendRow swatch={TONE_BG["system-overhead"]} label="system overhead" />
      <LegendRow swatch={TONE_BG.user} label="user" />
      <LegendRow swatch={TONE_BG.assistant} label="assistant" />
      <LegendRow swatch={TONE_BG.tool} label="tool / other" />
      <LegendRow swatch="bg-transparent border border-slate-600" label="headroom" />
      <LegendRow swatch={THRESHOLD_BG.soft} label="soft compact" thin />
      <LegendRow swatch={THRESHOLD_BG.auto} label="auto compact" thin />
      <LegendRow swatch={THRESHOLD_BG.danger} label="danger" thin />
    </div>
  );
}

function ThresholdRows({ budget }: { budget: NonNullable<ContextInspectResult["contextBudget"]> }) {
  const max = budget.modelMaxTokens;
  const fmt = (n: number | null): string => {
    if (n === null) return "—";
    if (max === null || max <= 0) return fmtTokens(n);
    const pct = (n / max) * 100;
    return `${fmtTokens(n)} (${pct.toFixed(1)}%)`;
  };
  return (
    <div className="space-y-0.5 border-t border-slate-800 pt-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">thresholds</div>
      <KVRow label="soft compact" value={fmt(budget.softCompactAt ?? null)} mono muted />
      <KVRow label="auto compact" value={fmt(budget.autoCompactAt)} mono />
      <KVRow label="danger" value={fmt(budget.dangerAt)} mono />
    </div>
  );
}

function SystemOverheadBreakdown({ budget }: { budget: NonNullable<ContextInspectResult["contextBudget"]> }) {
  const total = budget.systemOverheadTokens;
  const bd = budget.systemOverheadBreakdown ?? {};
  const rows = useMemo(() => {
    const list: Array<[string, number | undefined]> = [
      ["SOUL", bd.soul],
      ["tools", bd.tools],
      ["skills", bd.skills],
      ["system prompt", bd.systemPrompt],
      ["other", bd.other],
    ];
    return list.filter(([, v]) => v !== undefined);
  }, [bd]);
  if (total === null && rows.length === 0) return null;
  return (
    <div className="space-y-0.5 border-t border-slate-800 pt-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">system overhead</div>
      <KVRow label="total" value={fmtTokens(total)} mono />
      {rows.map(([label, v]) => (
        <KVRow key={label} label={label} value={fmtTokens(v ?? null)} mono muted />
      ))}
    </div>
  );
}

// ── Visual primitives ──────────────────────────────────────────────────

type SegmentTone = "headroom" | "user" | "assistant" | "tool" | "system-overhead";

const TONE_BG: Record<SegmentTone, string> = {
  headroom: "bg-transparent",
  user: "bg-sky-400/80",
  assistant: "bg-emerald-400/70",
  tool: "bg-fuchsia-400/70",
  "system-overhead": "bg-slate-500/70",
};

const THRESHOLD_BG: Record<"soft" | "auto" | "danger", string> = {
  soft: "bg-amber-400/60",
  auto: "bg-orange-400/85",
  danger: "bg-rose-400/85",
};

function SectionHeader({ children, source }: { children: React.ReactNode; source?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{children}</span>
      {source && <span className="text-[9px] uppercase tracking-wide text-slate-500">{source}</span>}
    </div>
  );
}

function KVRow({ label, value, mono, muted, tone }: { label: string; value: string; mono?: boolean; muted?: boolean; tone?: "cyan" }) {
  const valueCls = [
    mono ? "font-mono" : "",
    muted ? "text-slate-500" : tone === "cyan" ? "text-cyan-200" : "text-slate-100",
    "truncate text-right",
  ].join(" ");
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={muted ? "text-slate-500" : "text-slate-400"}>{label}</span>
      <span className={valueCls}>{value}</span>
    </div>
  );
}

function LegendRow({ swatch, label, thin }: { swatch: string; label: string; thin?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block ${thin ? "w-3 h-px" : "w-2.5 h-2.5 rounded-sm"} ${swatch}`} />
      <span className="text-slate-400">{label}</span>
    </div>
  );
}

function shortContextId(id: string): string {
  const stripped = id.startsWith("ctx_") ? id.slice(4) : id;
  return stripped.length > 12 ? `${stripped.slice(0, 8)}…` : stripped;
}

function fmtTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(ms);
  }
}

function fmtTokens(n: number | null): string {
  if (n === null) return "—";
  const v = Math.round(n);
  if (v >= 100_000) return `${(v / 1000).toFixed(0)}K`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 1_000) return `${(v / 1000).toFixed(2)}K`;
  return v.toLocaleString();
}
