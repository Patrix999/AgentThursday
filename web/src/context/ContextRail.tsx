import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextInspectResult } from "../../shared/schema";
import { useSharedContextInspect } from "./ContextInspectProvider";

type SegmentTone = "headroom" | "user" | "assistant" | "tool" | "system-overhead";

type HoverKind =
  | "headroom"
  | "user"
  | "assistant"
  | "tool"
  | "system-overhead"
  | "threshold-softCompact"
  | "threshold-autoCompact"
  | "threshold-danger";

type Segment = {
  key: string;
  tone: SegmentTone;
  fraction: number;
  hoverKind: HoverKind;
  /** Per-segment numbers that the hover card needs without re-deriving. */
  segmentTokens: number;
  segmentMessages: number;
};

const TONE_BG: Record<SegmentTone, string> = {
  headroom: "bg-transparent",
  user: "bg-sky-400/80",
  assistant: "bg-emerald-400/70",
  tool: "bg-fuchsia-400/70",
  "system-overhead": "bg-slate-500/70",
};

/**
 * M7.9 an earlier revision/i/j — context indicator rail.
 *
 *   - Full height represents the model's max context window (when known).
 *   - Used area is drawn from the bottom: system overhead, dialog
 *     (user/assistant/tool), then headroom on top.
 *   - Two horizontal threshold lines mark `autoCompactAt` and `dangerAt`.
 *   - 156j: hover/focus opens a small rich HTML hover card to the right
 *     of the rail. The card content is React, NEVER
 *     `dangerouslySetInnerHTML`, and never carries SOUL / system prompt /
 *     tool schema raw text. Only numbers, labels, and color legends.
 *   - Keyboard focus on a segment or threshold reveals the same content.
 *   - The card closes when the mouse leaves the rail+card region or focus
 *     moves elsewhere.
 *   - Fallback: when `modelMaxTokens` is unavailable AND `usedTokens` is
 *     null, the rail falls back to message-stack mode and shows a
 *     `window?` micro-label.
 */
export function ContextRail() {
  const { data } = useSharedContextInspect();
  const budget = data?.contextBudget;

  const inBudgetMode = useMemo(() => {
    return !!budget
      && budget.modelMaxTokens !== null
      && budget.modelMaxTokens > 0
      && budget.usedTokens !== null;
  }, [budget]);

  const segments = useMemo<Segment[]>(() => {
    if (!data) return [];
    if (inBudgetMode && budget) {
      return buildBudgetSegments(data, budget);
    }
    return buildFallbackSegments(data);
  }, [data, budget, inBudgetMode]);

  // hover card position tracks the segment / threshold
  // line center (relative to the rail container) so the card opens
  // next to what the user pointed at, not pinned at the top. The
  // top is clamped against the rail's height in HoverCard so it
  // doesn't slip off-screen near the rail's ends.
  const [hover, setHover] = useState<{ kind: HoverKind; topPx: number } | null>(null);
  const closeHover = () => setHover(null);
  const railRef = useRef<HTMLDivElement>(null);
  const computeTop = (target: HTMLElement): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const railRect = rail.getBoundingClientRect();
    const tgt = target.getBoundingClientRect();
    return tgt.top - railRect.top + tgt.height / 2;
  };
  const setHoverFor = (kind: HoverKind, target: HTMLElement | null) => {
    if (!target) { setHover({ kind, topPx: 0 }); return; }
    setHover({ kind, topPx: computeTop(target) });
  };

  return (
    <div
      ref={railRef}
      className="relative shrink-0"
      onMouseLeave={closeHover}
      onBlur={closeHover}
      aria-label="Context indicator"
    >
      <div className="w-4 h-full bg-slate-800/95 border-r border-cyan-400/25 flex flex-col shadow-[inset_-1px_0_0_rgba(34,211,238,0.22)]">
        {segments.length === 0 ? (
          <div
            className="flex-1 bg-gradient-to-b from-cyan-400/25 via-slate-900/55 to-emerald-400/20"
            aria-label="No context yet."
          />
        ) : (
          segments.map((seg) => (
            <button
              type="button"
              key={seg.key}
              tabIndex={0}
              className={`min-h-[2px] outline-none focus:ring-1 focus:ring-inset focus:ring-cyan-300/60 ${TONE_BG[seg.tone]}`}
              style={{ flexBasis: `${seg.fraction * 100}%`, flexGrow: 0 }}
              onMouseEnter={(e) => setHoverFor(seg.hoverKind, e.currentTarget)}
              onFocus={(e) => setHoverFor(seg.hoverKind, e.currentTarget)}
              aria-label={hoverLabel(seg.hoverKind)}
            />
          ))
        )}
      </div>

      {inBudgetMode && budget && budget.modelMaxTokens !== null && (
        <ThresholdLines
          modelMaxTokens={budget.modelMaxTokens}
          softCompactAt={budget.softCompactAt ?? null}
          autoCompactAt={budget.autoCompactAt}
          dangerAt={budget.dangerAt}
          onHoverSoft={(target) => setHoverFor("threshold-softCompact", target)}
          onHoverAuto={(target) => setHoverFor("threshold-autoCompact", target)}
          onHoverDanger={(target) => setHoverFor("threshold-danger", target)}
        />
      )}

      {!inBudgetMode && (
        <div
          className="absolute -top-3 left-0 text-[8px] text-slate-500 font-mono whitespace-nowrap"
          aria-label={
            budget?.source === "unavailable"
              ? "Model context window not mapped — rail shows message-stack fallback."
              : "Loading context budget"
          }
        >
          window?
        </div>
      )}

      {hover && data && budget && (
        <HoverCard
          hover={hover.kind}
          topPx={hover.topPx}
          data={data}
          budget={budget}
          segments={segments}
          onMouseLeave={closeHover}
        />
      )}
    </div>
  );
}

function ThresholdLines({
  modelMaxTokens,
  softCompactAt,
  autoCompactAt,
  dangerAt,
  onHoverSoft,
  onHoverAuto,
  onHoverDanger,
}: {
  modelMaxTokens: number;
  softCompactAt: number | null;
  autoCompactAt: number | null;
  dangerAt: number | null;
  onHoverSoft: (target: HTMLElement) => void;
  onHoverAuto: (target: HTMLElement) => void;
  onHoverDanger: (target: HTMLElement) => void;
}) {
  return (
    <>
      {softCompactAt !== null && (
        <button
          type="button"
          tabIndex={0}
          className="pointer-events-auto absolute left-0 right-0 h-px bg-amber-400/40 outline-none focus:ring-1 focus:ring-amber-300/50"
          style={{ bottom: `${thresholdPercent(softCompactAt, modelMaxTokens)}%` }}
          onMouseEnter={(e) => onHoverSoft(e.currentTarget)}
          onFocus={(e) => onHoverSoft(e.currentTarget)}
          aria-label="soft compact hint"
        />
      )}
      {autoCompactAt !== null && (
        <button
          type="button"
          tabIndex={0}
          className="pointer-events-auto absolute left-0 right-0 h-px bg-orange-400/80 outline-none focus:ring-1 focus:ring-orange-300/60"
          style={{ bottom: `${thresholdPercent(autoCompactAt, modelMaxTokens)}%` }}
          onMouseEnter={(e) => onHoverAuto(e.currentTarget)}
          onFocus={(e) => onHoverAuto(e.currentTarget)}
          aria-label="auto compact threshold"
        />
      )}
      {dangerAt !== null && (
        <button
          type="button"
          tabIndex={0}
          className="pointer-events-auto absolute left-0 right-0 h-px bg-rose-400/80 outline-none focus:ring-1 focus:ring-rose-300/60"
          style={{ bottom: `${thresholdPercent(dangerAt, modelMaxTokens)}%` }}
          onMouseEnter={(e) => onHoverDanger(e.currentTarget)}
          onFocus={(e) => onHoverDanger(e.currentTarget)}
          aria-label="danger threshold"
        />
      )}
    </>
  );
}

function thresholdPercent(value: number, modelMaxTokens: number): number {
  if (modelMaxTokens <= 0) return 0;
  return Math.max(0, Math.min(100, (value / modelMaxTokens) * 100));
}

function hoverLabel(kind: HoverKind): string {
  switch (kind) {
    case "headroom": return "headroom";
    case "user": return "user dialog";
    case "assistant": return "assistant dialog";
    case "tool": return "tool / other dialog";
    case "system-overhead": return "system overhead";
    case "threshold-softCompact": return "soft compact hint";
    case "threshold-autoCompact": return "auto compact threshold";
    case "threshold-danger": return "danger threshold";
  }
}

function buildBudgetSegments(
  data: ContextInspectResult,
  budget: NonNullable<ContextInspectResult["contextBudget"]>,
): Segment[] {
  const max = budget.modelMaxTokens ?? 0;
  if (max <= 0) return [];
  const used = budget.usedTokens ?? 0;
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

  const segs: Segment[] = [];
  if (headroomTok > 0) {
    segs.push({
      key: "headroom",
      tone: "headroom",
      fraction: headroomTok / max,
      hoverKind: "headroom",
      segmentTokens: headroomTok,
      segmentMessages: 0,
    });
  }
  if (dialogAssistantTok > 0) {
    segs.push({
      key: "dialog-assistant",
      tone: "assistant",
      fraction: dialogAssistantTok / max,
      hoverKind: "assistant",
      segmentTokens: dialogAssistantTok,
      segmentMessages: assistantMsgs,
    });
  }
  if (dialogUserTok > 0) {
    segs.push({
      key: "dialog-user",
      tone: "user",
      fraction: dialogUserTok / max,
      hoverKind: "user",
      segmentTokens: dialogUserTok,
      segmentMessages: userMsgs,
    });
  }
  if (dialogToolTok > 0) {
    segs.push({
      key: "dialog-tool",
      tone: "tool",
      fraction: dialogToolTok / max,
      hoverKind: "tool",
      segmentTokens: dialogToolTok,
      segmentMessages: toolMsgs,
    });
  }
  if (scaledSysOH > 0) {
    segs.push({
      key: "system-overhead",
      tone: "system-overhead",
      fraction: scaledSysOH / max,
      hoverKind: "system-overhead",
      segmentTokens: scaledSysOH,
      segmentMessages: 0,
    });
  }
  return segs;
}

function buildFallbackSegments(data: ContextInspectResult): Segment[] {
  const total = Math.max(1, data.visibleMessages.length);
  return data.visibleMessages.map((m, idx) => {
    const hasTool = (m.parts ?? []).some((p) => p.type === "tool");
    const tone: SegmentTone =
      m.role === "user" ? "user" : hasTool ? "tool" : "assistant";
    const hoverKind: HoverKind =
      tone === "user" ? "user" : tone === "tool" ? "tool" : "assistant";
    return {
      key: `${m.id}-${idx}`,
      tone,
      fraction: 1 / total,
      hoverKind,
      segmentTokens: 0,
      segmentMessages: 1,
    };
  });
}

// ── Hover card ──────────────────────────────────────────────────────────

function HoverCard({
  hover,
  topPx,
  data,
  budget,
  segments,
  onMouseLeave,
}: {
  hover: HoverKind;
  topPx: number;
  data: ContextInspectResult;
  budget: NonNullable<ContextInspectResult["contextBudget"]>;
  segments: Segment[];
  onMouseLeave: () => void;
}) {
  // clamp top against the rail container's height so the
  // card stays within view near the rail's ends. We approximate the
  // rail height via the card's offsetParent (the rail container) on
  // first render. Card height is roughly 200-300px depending on body
  // type; we offset by half so the card opens centered on the
  // segment, then clamp to keep at least 4px from the top.
  const cardRef = useRef<HTMLDivElement>(null);
  const [clampedTop, setClampedTop] = useState<number>(Math.max(4, topPx));
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const railH = parent?.clientHeight ?? 0;
    const cardH = el.offsetHeight;
    // Center on segment, then clamp.
    let top = topPx - cardH / 2;
    if (top < 4) top = 4;
    if (railH > 0 && top + cardH > railH - 4) top = Math.max(4, railH - cardH - 4);
    setClampedTop(top);
  }, [topPx, hover]);
  return (
    <div
      ref={cardRef}
      role="tooltip"
      onMouseLeave={onMouseLeave}
      style={{ top: `${clampedTop}px` }}
      className="absolute left-5 z-30 w-64 rounded-md border border-slate-700 bg-slate-900/95 shadow-lg p-3 text-[11px] text-slate-200 space-y-2 pointer-events-auto"
    >
      {hover === "headroom" && <HeadroomBody data={data} budget={budget} />}
      {hover === "system-overhead" && <SystemOverheadBody budget={budget} />}
      {(hover === "user" || hover === "assistant" || hover === "tool") && (
        <DialogSegmentBody hover={hover} budget={budget} segments={segments} />
      )}
      {hover === "threshold-softCompact" && (
        <ThresholdBody kind="soft" tokens={budget.softCompactAt ?? null} modelMax={budget.modelMaxTokens} source={budget.source} />
      )}
      {hover === "threshold-autoCompact" && (
        <ThresholdBody kind="auto" tokens={budget.autoCompactAt} modelMax={budget.modelMaxTokens} source={budget.source} />
      )}
      {hover === "threshold-danger" && (
        <ThresholdBody kind="danger" tokens={budget.dangerAt} modelMax={budget.modelMaxTokens} source={budget.source} />
      )}
    </div>
  );
}

function HoverCardHeader({ title, source }: { title: string; source?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{title}</span>
      {source && (
        <span className="text-[9px] uppercase tracking-wide text-slate-500">{source}</span>
      )}
    </div>
  );
}

function KVRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={muted ? "text-slate-500" : "text-slate-400"}>{label}</span>
      <span className={`font-mono ${muted ? "text-slate-500" : "text-slate-100"}`}>{value}</span>
    </div>
  );
}

function HeadroomBody({
  data,
  budget,
}: {
  data: ContextInspectResult;
  budget: NonNullable<ContextInspectResult["contextBudget"]>;
}) {
  const max = budget.modelMaxTokens;
  const used = budget.usedTokens;
  const headroom = (max !== null && used !== null) ? Math.max(0, max - used) : null;
  const dialogTok = budget.visibleDialogTokens;
  // show inline percent for thresholds so the operator can read
  // "24K (18.75%)" instead of mentally computing why the danger line
  // looks low against a 128K fallback window.
  const fmtThreshold = (n: number | null): string => {
    if (n === null) return "—";
    if (max === null || max <= 0) return fmtTokens(n);
    const pct = (n / max) * 100;
    return `${fmtTokens(n)} (${pct.toFixed(2)}%)`;
  };
  return (
    <>
      <HoverCardHeader title="context budget" source={budget.source} />
      <div className="space-y-0.5">
        <KVRow label="model max" value={fmtTokens(max)} />
        <KVRow label="used" value={fmtTokens(used)} />
        <KVRow label="headroom" value={fmtTokens(headroom)} />
        <KVRow
          label="dialog"
          value={dialogTok === null ? "unavailable" : fmtTokens(dialogTok)}
          muted={dialogTok === null}
        />
        <KVRow label="soft compact" value={fmtThreshold(budget.softCompactAt ?? null)} muted />
        <KVRow label="auto compact" value={fmtThreshold(budget.autoCompactAt)} />
        <KVRow label="danger" value={fmtThreshold(budget.dangerAt)} />
        <KVRow label="msgs (visible)" value={`${data.visibleMessages.length} / ${data.totalMessageCount}`} muted />
      </div>
      <Legend />
      {budget.source !== "provider" && (
        <div className="text-[10px] text-slate-500 italic">
          {budget.source === "estimated"
            ? "Window is a conservative fallback estimate (provider hasn't reported yet)."
            : "Window unavailable."}
        </div>
      )}
      {dialogTok === null && (
        <div className="text-[10px] text-slate-500 italic">
          dialog tokens unavailable — system overhead alone is shown as used baseline.
        </div>
      )}
    </>
  );
}

function SystemOverheadBody({ budget }: { budget: NonNullable<ContextInspectResult["contextBudget"]> }) {
  const total = budget.systemOverheadTokens;
  const bd = budget.systemOverheadBreakdown ?? {};
  return (
    <>
      <HoverCardHeader title="system overhead" source={budget.source} />
      <div className="space-y-0.5">
        <KVRow label="total" value={fmtTokens(total)} />
        {bd.soul !== undefined && <KVRow label="SOUL" value={fmtTokens(bd.soul)} muted />}
        {bd.tools !== undefined && <KVRow label="tools" value={fmtTokens(bd.tools)} muted />}
        {bd.skills !== undefined && <KVRow label="skills" value={fmtTokens(bd.skills)} muted />}
        {bd.systemPrompt !== undefined && <KVRow label="system prompt" value={fmtTokens(bd.systemPrompt)} muted />}
        {bd.other !== undefined && <KVRow label="other" value={fmtTokens(bd.other)} muted />}
      </div>
      <div className="text-[10px] text-slate-500 italic">
        numbers only · no SOUL / system / tool schema text returned.
      </div>
    </>
  );
}

function DialogSegmentBody({
  hover,
  budget,
  segments,
}: {
  hover: "user" | "assistant" | "tool";
  budget: NonNullable<ContextInspectResult["contextBudget"]>;
  segments: Segment[];
}) {
  const seg = segments.find((s) => s.hoverKind === hover);
  const max = budget.modelMaxTokens ?? 0;
  const tokens = seg?.segmentTokens ?? 0;
  const messages = seg?.segmentMessages ?? 0;
  const pctOfWindow = max > 0 ? (tokens / max) * 100 : 0;
  const role = hover === "user" ? "user" : hover === "assistant" ? "assistant" : "tool / other";
  return (
    <>
      <HoverCardHeader title={`${role} dialog`} source={budget.source} />
      <div className="space-y-0.5">
        <KVRow label="tokens (est)" value={fmtTokens(Math.round(tokens))} />
        <KVRow label="messages" value={String(messages)} />
        <KVRow label="% of window" value={`${pctOfWindow.toFixed(2)}%`} muted />
      </div>
      <div className="text-[10px] text-slate-500 italic">
        estimated chars / 4 · no message text returned.
      </div>
    </>
  );
}

function ThresholdBody({
  kind,
  tokens,
  modelMax,
  source,
}: {
  kind: "soft" | "auto" | "danger";
  tokens: number | null;
  modelMax: number | null;
  source: "estimated" | "provider" | "unavailable";
}) {
  const pct = (tokens !== null && modelMax !== null && modelMax > 0)
    ? (tokens / modelMax) * 100
    : null;
  // three-layer threshold copy. Soft is hint-only; hard
  // is the hygiene loop's actual trigger; danger is the red line that
  // leaves headroom for tool traces / output / framework overhead.
  const title = kind === "soft"
    ? "soft compact hint"
    : kind === "auto"
      ? "auto compact threshold"
      : "danger threshold";
  const meaning = kind === "soft"
    ? "UI hint only — hygiene may prepare/advise but does not force compact at this line."
    : kind === "auto"
      ? "Main hygiene loop trigger — auto compact runs once total used tokens cross this line."
      : "Strong warning — keep buffer for tool traces, hidden framework overhead, and the model's own output above this line.";
  // explicit annotation about the percent-of-window
  // calculation. the operator questioned why the danger line sits low; the
  // answer is `24K / 128K = 18.75%` against the fallback window. The
  // tooltip now shows the fraction inline + says "(of fallback
  // window)" or "(of estimated window)" so the math is transparent
  // and the user can decide if they want to revisit thresholds.
  const windowLabel = source === "provider"
    ? "model window"
    : "fallback window (estimated)";
  return (
    <>
      <HoverCardHeader title={title} source={source} />
      <div className="space-y-0.5">
        <KVRow label="at" value={fmtTokens(tokens)} />
        <KVRow
          label={`% of ${windowLabel}`}
          value={pct === null ? "—" : `${pct.toFixed(2)}%`}
          muted
        />
        {tokens !== null && modelMax !== null && modelMax > 0 && (
          <KVRow
            label="fraction"
            value={`${tokens.toLocaleString()} / ${modelMax.toLocaleString()}`}
            muted
          />
        )}
      </div>
      <div className="text-[10px] text-slate-400">{meaning}</div>
      {source !== "provider" && (
        <div className="text-[10px] text-slate-500 italic">
          Window is a conservative estimate (no provider reading yet) — threshold position may look low against a 128K fallback.
        </div>
      )}
    </>
  );
}

function Legend() {
  return (
    <div className="pt-1 border-t border-slate-700/70 space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">legend</div>
      <LegendRow swatch="bg-slate-500/70" label="system overhead" />
      <LegendRow swatch="bg-sky-400/80" label="user" />
      <LegendRow swatch="bg-emerald-400/70" label="assistant" />
      <LegendRow swatch="bg-fuchsia-400/70" label="tool / other" />
      <LegendRow swatch="bg-transparent border border-slate-600" label="headroom" />
      <LegendRow swatch="bg-amber-400/40" label="soft compact line" thin />
      <LegendRow swatch="bg-orange-400/80" label="auto compact line" thin />
      <LegendRow swatch="bg-rose-400/80" label="danger line" thin />
    </div>
  );
}

function LegendRow({ swatch, label, thin }: { swatch: string; label: string; thin?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block ${thin ? "w-3 h-px" : "w-3 h-3 rounded-sm"} ${swatch}`} />
      <span className="text-slate-300">{label}</span>
    </div>
  );
}

function fmtTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}K`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(2)}K`;
  return n.toLocaleString();
}
