import { useState } from "react";
import type {
  CompactPlanResult,
  CompactPlanApplyResult,
} from "../../shared/schema";
import { compactPlan, applyCompactPlan } from "../api/contextActions";
import { getDebugReadonlyNotice } from "../debugSurfaceMode";

/**
 * v2 Anchor-aware compact plan preview UI.
 *
 * Sits inside ContextPanel's "Future actions" alongside the legacy
 * CompactAction. Two-step flow: preview a plan, then explicit
 * apply. Renders only backend-supplied previews — never builds its own
 * snapshot of message content. Refreshes the inspect surface via the
 * same `agentthursday:context:compacted` event the legacy flow uses.
 */

type Stage =
  | { kind: "idle" }
  | { kind: "loading-plan" }
  | { kind: "plan-error"; message: string }
  | { kind: "plan-ready"; plan: CompactPlanResult }
  | { kind: "applying"; plan: CompactPlanResult }
  | { kind: "apply-error"; plan: CompactPlanResult; message: string }
  | { kind: "applied"; plan: CompactPlanResult; result: CompactPlanApplyResult };

const DEFAULT_STRATEGY = {
  lastN: 200,
  firstK: 4,
  keepRecent: 8,
  minRangeMessages: 3,
  pressureThreshold: 20,
};

export function SmartCompactPlan({ actionsEnabled = true }: { actionsEnabled?: boolean }) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  // opt-in semantic advisor scaffold. Default off so apply
  // behavior remains identical to unless the operator
  // explicitly toggles it. With no model client wired server-side
  // (current state) the apply path falls back to the deterministic
  // summary; the response carries `appliedRanges[i].semanticAdvisor`
  // audit metadata which we render below so the operator can see what
  // happened.
  const [useSemanticAdvisor, setUseSemanticAdvisor] = useState(false);

  async function preview() {
    if (!actionsEnabled) {
      setStage({ kind: "plan-error", message: getDebugReadonlyNotice() });
      return;
    }
    setStage({ kind: "loading-plan" });
    const res = await compactPlan(DEFAULT_STRATEGY);
    if (res.ok && res.data) {
      setStage({ kind: "plan-ready", plan: res.data });
      return;
    }
    const message = (res.data as unknown as { error?: string })?.error
      ?? res.error
      ?? `HTTP ${res.status}`;
    setStage({ kind: "plan-error", message });
  }

  async function apply(plan: CompactPlanResult) {
    if (!actionsEnabled) {
      setStage({ kind: "apply-error", plan, message: getDebugReadonlyNotice() });
      return;
    }
    setStage({ kind: "applying", plan });
    const res = await applyCompactPlan(
      plan,
      useSemanticAdvisor
        ? { semanticAdvisor: true, semanticAdvisorTrigger: "manual" }
        : undefined,
    );
    if (res.ok && res.data) {
      setStage({ kind: "applied", plan, result: res.data });
      window.dispatchEvent(new Event("agentthursday:context:compacted"));
      return;
    }
    const message = (res.data as unknown as { error?: string })?.error
      ?? res.error
      ?? `HTTP ${res.status}`;
    setStage({ kind: "apply-error", plan, message });
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] text-slate-300">
        <span className="font-semibold">Smart compact plan</span>
        <span className="text-[10px] text-sky-400/80 italic">
 v2 — anchor-aware, explicit apply
        </span>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Builds an anchor-aware plan via Cards 138–140: preserves first-K
        rules, explicit anchors, recent working set, and unresolved
        compaction hazards; proposes contiguous middle ranges as
        compaction candidates. The plan is read-only until you click
        Apply.
      </p>

      {stage.kind === "idle" && (
        <button
          type="button"
          onClick={preview}
          aria-disabled={!actionsEnabled || undefined}
          title={actionsEnabled ? "Preview smart compact plan" : getDebugReadonlyNotice()}
          className={`mt-2 rounded border px-2 py-1 text-[10px] ${actionsEnabled ? "border-sky-700/70 bg-sky-950/40 text-sky-200 hover:bg-sky-900/40" : "border-slate-700 bg-slate-900/80 text-slate-500 cursor-not-allowed"}`}
        >
          Preview smart compact plan
        </button>
      )}

      {stage.kind === "loading-plan" && (
        <Note tone="muted">Building plan…</Note>
      )}

      {stage.kind === "plan-error" && (
        <Note tone="error">
          <div className="font-semibold">Plan request failed</div>
          <div className="mt-0.5">{stage.message}</div>
          <DismissButton tone="error" onClick={() => setStage({ kind: "idle" })} />
        </Note>
      )}

      {(stage.kind === "plan-ready"
        || stage.kind === "applying"
        || stage.kind === "apply-error"
        || stage.kind === "applied") && (
        <PlanView
          plan={stage.plan}
          stage={stage}
          useSemanticAdvisor={useSemanticAdvisor}
          onToggleSemanticAdvisor={setUseSemanticAdvisor}
          onApply={() => apply(stage.plan)}
          onDismiss={() => setStage({ kind: "idle" })}
          actionsEnabled={actionsEnabled}
        />
      )}
    </div>
  );
}

function PlanView({
  plan,
  stage,
  useSemanticAdvisor,
  onToggleSemanticAdvisor,
  onApply,
  onDismiss,
  actionsEnabled,
}: {
  plan: CompactPlanResult;
  stage: Stage;
  useSemanticAdvisor: boolean;
  onToggleSemanticAdvisor: (next: boolean) => void;
  onApply: () => void;
  onDismiss: () => void;
  actionsEnabled: boolean;
}) {
  const hasRanges = plan.ranges.length > 0;
  const result = stage.kind === "applied" ? stage.result : null;

  return (
    <div className="mt-2 space-y-2 rounded border border-sky-800/70 bg-sky-950/20 p-3 text-[11px] text-sky-100">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Plan {planIdShort(plan.planId)}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-sky-300/80 hover:text-sky-100"
        >
          dismiss
        </button>
      </div>

      <PressureBlock plan={plan} />
      <PreservedBlock plan={plan} />
      <RangesBlock plan={plan} />
      <RejectedBlock plan={plan} />

      {!hasRanges && (
        <Note tone="muted">
          No compactable ranges — apply is disabled. See rejected reasons
          above for why no range met the planner's safety filters.
        </Note>
      )}

      {hasRanges && stage.kind === "plan-ready" && (
        <SemanticAdvisorToggle
          checked={useSemanticAdvisor}
          onChange={onToggleSemanticAdvisor}
        />
      )}

      {hasRanges && stage.kind === "plan-ready" && (
        <button
          type="button"
          onClick={onApply}
          aria-disabled={!actionsEnabled || undefined}
          title={actionsEnabled ? "Apply compact plan" : getDebugReadonlyNotice()}
          className={`rounded border px-2 py-1 text-[10px] ${actionsEnabled ? "border-amber-700/70 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40" : "border-slate-700 bg-slate-900/80 text-slate-500 cursor-not-allowed"}`}
        >
          Apply plan
        </button>
      )}

      {stage.kind === "applying" && (
        <Note tone="muted">
          Applying plan{useSemanticAdvisor ? " (semantic advisor requested)" : ""}…
        </Note>
      )}

      {stage.kind === "apply-error" && (
        <Note tone="error">
          <div className="font-semibold">Apply failed</div>
          <div className="mt-0.5">{stage.message}</div>
        </Note>
      )}

      {result && <ApplyResultView result={result} />}
    </div>
  );
}

function SemanticAdvisorToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[10px] text-slate-300 cursor-pointer hover:border-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-sky-500"
      />
      <span className="flex-1">
        <span className="font-semibold">Try semantic advisor (audit-only scaffold)</span>
        <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-500"></span>
        <div className="mt-0.5 text-[10px] text-slate-500">
          Sends <span className="font-mono">semanticAdvisor:true</span> with{" "}
          <span className="font-mono">trigger:"manual"</span>. No model client is
          configured server-side, so the advisor records a fallback audit row
          and the deterministic summary is used. Toggle off to keep
          default behavior unchanged.
        </div>
      </span>
    </label>
  );
}

function PressureBlock({ plan }: { plan: CompactPlanResult }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">
        Pressure
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[10px]">
        <Stat label="before" value={`${plan.pressure.beforeMessages} msgs`} />
        <Stat label="estimated after" value={`${plan.pressure.estimatedAfterMessages} msgs`} />
        <Stat
          label="reduction"
          value={`-${plan.pressure.estimatedReduction}`}
          tone={plan.pressure.estimatedReduction > 0 ? "good" : "muted"}
        />
      </div>
      <div className="mt-1 text-[10px] text-slate-500">
        strategy: lastN={plan.strategy.lastN} firstK={plan.strategy.firstK} keepRecent=
        {plan.strategy.keepRecent} minRange={plan.strategy.minRangeMessages} threshold=
        {plan.strategy.pressureThreshold}
      </div>
    </div>
  );
}

function PreservedBlock({ plan }: { plan: CompactPlanResult }) {
  if (plan.preserved.length === 0) {
    return (
      <Note tone="muted">No preserved messages in this snapshot window.</Note>
    );
  }
  const groups = groupPreservedByCategory(plan.preserved);
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        Preserved ({plan.preserved.length})
      </div>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[10px] text-slate-300">
            <span className="font-semibold">{g.label}</span>
            <span className="ml-1 text-slate-500">({g.items.length})</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {g.items.map((p) => (
              <li
                key={`${p.id}-${p.index}`}
                className="flex items-baseline gap-2 text-[10px] text-slate-400"
              >
                <span className="font-mono text-slate-500">#{p.index}</span>
                <span className="truncate">{p.preview || <em className="text-slate-600">(no text)</em>}</span>
                <span className="ml-auto truncate text-slate-500">
                  {p.reasons.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RangesBlock({ plan }: { plan: CompactPlanResult }) {
  if (plan.ranges.length === 0) return null;
  return (
    <div className="rounded border border-amber-900/60 bg-amber-950/20 p-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-amber-300/80">
        Candidate ranges ({plan.ranges.length})
      </div>
      {plan.ranges.map((r) => (
        <div
          key={r.rangeId}
          className="rounded border border-slate-800 bg-slate-900/60 p-2 text-[10px] text-slate-300"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-slate-400">
              [{r.fromIndex}..{r.toIndex}]
            </span>
            <span className="text-slate-500">{r.messageCount} msgs</span>
            <span className="ml-auto text-emerald-400/80">
              -{r.estimatedReduction}
            </span>
          </div>
          {r.previews.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {r.previews.map((p, idx) => (
                <li key={idx} className="truncate text-slate-400">
                  · {p || <em className="text-slate-600">(no text)</em>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function RejectedBlock({ plan }: { plan: CompactPlanResult }) {
  if (plan.rejected.length === 0) return null;
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        Rejected / no-op ({plan.rejected.length})
      </div>
      <ul className="space-y-0.5">
        {plan.rejected.map((r, idx) => (
          <li key={idx} className="flex gap-2 text-[10px] text-slate-400">
            <span className="font-mono text-slate-300">{r.reason}</span>
            <span className="truncate text-slate-500">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApplyResultView({ result }: { result: CompactPlanApplyResult }) {
  const tone = result.deadRecordDetected
    ? "warning"
    : result.ok
      ? "success"
      : "warning";
  return (
    <div
      className={`rounded border p-2 space-y-1.5 text-[10px] ${
        tone === "success"
          ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-100"
          : "border-amber-700/70 bg-amber-950/30 text-amber-100"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          Apply {result.ok ? "complete" : "partial"} ·{" "}
          {result.appliedRanges.length} applied · {result.rejectedRanges.length} rejected
        </span>
      </div>

      {result.deadRecordDetected && (
        <div className="rounded border border-rose-700/70 bg-rose-950/40 px-2 py-1 text-rose-200">
          ⚠ Dead-record detected — a compaction was stored but did not
          take effect (spike Case 5). The audit log records
          which range/compaction id triggered this.
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Stat label="before" value={`${result.beforeCount} msgs`} />
        <Stat label="after" value={`${result.afterCount} msgs`} />
        <Stat
          label="reduction"
          value={`-${Math.max(0, result.beforeCount - result.afterCount)}`}
          tone="good"
        />
        <Stat label="plan id" value={planIdShort(result.planId)} mono />
      </div>

      {result.appliedRanges.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Applied ranges
          </div>
          <ul className="space-y-0.5">
            {result.appliedRanges.map((r) => (
              <li key={r.rangeId} className="flex gap-2 truncate text-slate-300">
                <span className="font-mono text-slate-400">{r.rangeId.slice(0, 8)}…</span>
                <span className="text-slate-500">→</span>
                <span className="font-mono text-slate-400">{r.compactionId.slice(0, 8)}…</span>
                <span className="ml-auto text-slate-500">
                  {r.beforeCount}→{r.afterCount}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.appliedRanges.some((r) => r.semanticAdvisor !== undefined) && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Semantic advisor scaffold (/146)
          </div>
          {result.appliedRanges.map((r) => (
            r.semanticAdvisor === undefined ? null : (
              <SemanticAdvisorRow key={r.rangeId} rangeId={r.rangeId} advisor={r.semanticAdvisor} />
            )
          ))}
        </div>
      )}

      {result.rejectedRanges.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-rose-300/80">
            Rejected ranges
          </div>
          <ul className="space-y-0.5">
            {result.rejectedRanges.map((r) => (
              <li
                key={r.rangeId}
                className="flex gap-2 text-[10px] text-rose-200"
              >
                <span className="font-mono text-rose-300">{r.reason}</span>
                <span className="truncate text-rose-300/70">{r.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SemanticAdvisorRow({
  rangeId,
  advisor,
}: {
  rangeId: string;
  advisor: NonNullable<CompactPlanApplyResult["appliedRanges"][number]["semanticAdvisor"]>;
}) {
  const { ok, audit } = advisor;
  const headlineTone = ok ? "text-emerald-200" : "text-amber-200";
  const headlineLabel = ok
    ? "advisor produced enriched summary"
    : "advisor scaffold invoked; deterministic summary used";
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2 space-y-1 text-[10px] text-slate-300">
      <div className="flex items-center gap-2">
        <span className="font-mono text-slate-400">{rangeId.slice(0, 8)}…</span>
        <span className={`font-semibold ${headlineTone}`}>
          {ok ? "ok" : "fallback"}
        </span>
        <span className="truncate text-slate-400">{headlineLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Stat label="fallback reason" value={audit.fallbackReason ?? "—"} mono />
        <Stat
          label="model"
          value={audit.semanticModel ?? "(none)"}
          tone={audit.semanticModel ? undefined : "muted"}
          mono
        />
        <Stat label="prompt version" value={audit.semanticPromptVersion} mono />
        <Stat label="trigger" value={audit.trigger ?? "—"} mono />
        <Stat label="latency" value={audit.latencyMs !== null ? `${audit.latencyMs} ms` : "—"} />
        <Stat
          label="compaction id"
          value={audit.sourceCompactionId ? `${audit.sourceCompactionId.slice(0, 8)}…` : "—"}
          mono
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className="text-slate-500">flags:</span>
        {audit.qualityFlags.length === 0 ? (
          <span className="text-slate-500">(none)</span>
        ) : (
          audit.qualityFlags.map((f) => (
            <span
              key={f}
              className="rounded border border-amber-700/60 bg-amber-950/30 px-1.5 py-0.5 font-mono text-amber-200"
            >
              {f}
            </span>
          ))
        )}
      </div>
      <div className="text-[10px] text-slate-500">
        deterministic hash:{" "}
        <span className="font-mono text-slate-400">{audit.deterministicSummaryHash}</span>
      </div>
    </div>
  );
}

function groupPreservedByCategory(
  items: CompactPlanResult["preserved"],
): { label: string; items: CompactPlanResult["preserved"] }[] {
  const byKey = new Map<string, CompactPlanResult["preserved"]>();
  for (const it of items) {
    const key = preservedCategory(it.reasons);
    const arr = byKey.get(key) ?? [];
    arr.push(it);
    byKey.set(key, arr);
  }
  const order = ["Anchors", "Recent tail", "Synthetic", "System", "Hazards", "Other"];
  return order
    .filter((k) => byKey.has(k))
    .map((label) => ({ label, items: byKey.get(label)! }));
}

function preservedCategory(reasons: string[]): string {
  if (reasons.includes("synthetic-compaction")) return "Synthetic";
  if (reasons.includes("system-message")) return "System";
  if (reasons.includes("recent-tail")) return "Recent tail";
  if (reasons.some((r) => r.startsWith("hazard-"))) return "Hazards";
  if (reasons.some((r) => isAnchorReason(r))) return "Anchors";
  return "Other";
}

function isAnchorReason(r: string): boolean {
  return (
    r === "first-k"
    || r === "explicit-anchor"
    || r === "rule-or-constraint"
    || r === "long-user-briefing"
    || r === "memory-or-workflow-instruction"
    || r === "handoff-or-version-marker"
  );
}

function planIdShort(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function Stat({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: "good" | "muted";
  mono?: boolean;
}) {
  const valueClass = tone === "good"
    ? "text-emerald-300"
    : tone === "muted"
      ? "text-slate-500"
      : "text-slate-200";
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={`${mono ? "font-mono " : ""}truncate ${valueClass}`}>{value}</span>
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "muted" | "error";
  children: React.ReactNode;
}) {
  const cls = tone === "error"
    ? "border-rose-700 bg-rose-950/40 text-rose-300"
    : "border-slate-700 bg-slate-900/80 text-slate-400";
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 text-[10px] ${cls}`}>
      {children}
    </div>
  );
}

function DismissButton({
  tone,
  onClick,
}: {
  tone: "error";
  onClick: () => void;
}) {
  const cls = tone === "error"
    ? "text-rose-400 hover:text-rose-200"
    : "text-slate-400 hover:text-slate-200";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-1 text-[10px] ${cls}`}
    >
      dismiss
    </button>
  );
}
