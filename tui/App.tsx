import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useCloudStatus, WORKER_URL, authHeaders, type CliStatusData } from "./hooks/useCloudStatus";

type TuiMode = "idle" | "submit" | "approve-human" | "approve-mutation" | "busy";

type PendingMutation = {
  id: number;
  card_ref: string;
  mutation_type: string;
  description: string;
  diff_hint: string;
  created_at: number;
};

type LogEntryType = "assistant" | "tool-call" | "tool-result" | "approval" | "intervention" | "error" | "system";
type LogEntry = { id: string; type: LogEntryType; text: string; at: number };

// 5-char fixed-width labels (single-byte chars only — avoids emoji double-width issues)
const LOG_LABEL: Record<LogEntryType, string> = {
  assistant:    "[AGT]",
  "tool-call":  "[TCL]",
  "tool-result":"[RST]",
  approval:     "[PAS]",
  intervention: "[INT]",
  error:        "[ERR]",
  system:       "[SYS]",
};

const LOG_COLOR: Record<LogEntryType, string> = {
  assistant:    "cyanBright",
  "tool-call":  "blueBright",
  "tool-result":"green",
  approval:     "yellow",
  intervention: "yellowBright",
  error:        "red",
  system:       "gray",
};

function stageColor(stage: string | undefined): string {
  switch (stage) {
    case "loop-ready": return "green";
    case "gate-open": return "magenta";
    case "task-active": return "blue";
    case "awaiting-deliverable": return "yellow";
    default: return "gray";
  }
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "--:--:--";
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

async function postJson(endpoint: string, body?: object): Promise<{ ok: boolean; data: unknown }> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${WORKER_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function fetchPendingMutations(): Promise<PendingMutation[]> {
  const res = await fetch(`${WORKER_URL}/demo/pending-mutations`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as { pending: PendingMutation[] };
  return data.pending ?? [];
}

function detectApproveKind(
  interventions: string[],
  pendingToolApproval: { toolCallId: string; toolName: string } | null | undefined
): "tool-approval" | "mutation-confirm" | "human-response" | null {
  if (pendingToolApproval) return "tool-approval";
  for (const iv of interventions) {
    if (iv.includes("mutation-confirm-required")) return "mutation-confirm";
  }
  for (const iv of interventions) {
    if (iv.includes("waiting-for-human")) return "human-response";
  }
  return null;
}

// Prefix width: "HH:MM:SS " (9) + "[LBL] " (6) = 15 chars
const INDENT = " ".repeat(15);

function isTableSeparator(line: string): boolean {
  return /^(\|\s*:?-+:?\s*)+\|?$/.test(line.trim());
}

function splitEntryLines(text: string): string[] {
  const segments = text.replace(/\n+$/, "").split("\n").filter(l => !isTableSeparator(l));
  // Collapse consecutive blank lines to at most one
  const result: string[] = [];
  let prevBlank = false;
  for (const line of segments) {
    const blank = line.trim().length === 0;
    if (blank && prevBlank) continue;
    result.push(line);
    prevBlank = blank;
  }
  return result.length > 0 ? result : [""];
}

const LogLine = React.memo(function LogLine({ entry }: { entry: LogEntry }) {
  const ts = fmtTime(entry.at);
  const label = LOG_LABEL[entry.type];
  const color = LOG_COLOR[entry.type] as React.ComponentProps<typeof Text>["color"];
  const dim = entry.type === "system";
  const lines = splitEntryLines(entry.text);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text dimColor>{i === 0 ? `${ts} ` : INDENT}</Text>
          {i === 0 && <Text color={color}>{label} </Text>}
          {dim
            ? <Text dimColor>{line}</Text>
            : <Text color={color}>{line}</Text>
          }
        </Box>
      ))}
    </Box>
  );
});

export default function App(): React.ReactElement {
  const { exit } = useApp();
  const status = useCloudStatus();
  const [mode, setMode] = useState<TuiMode>("idle");
  const [inputValue, setInputValue] = useState("");
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const prevStatusRef = useRef<CliStatusData | null>(null);
  const logIdRef = useRef(0);
  const seenToolEventsRef = useRef(new Set<string>());

  const addLog = useCallback((type: LogEntryType, text: string, at = Date.now()) => {
    const entry: LogEntry = { id: String(++logIdRef.current), type, text, at };
    setLogEntries(prev => [...prev, entry].slice(-300));
  }, []);

  // Convert status changes to log entries
  useEffect(() => {
    const cur = status.data;
    const prev = prevStatusRef.current;
    if (!cur) return;

    const newEntries: LogEntry[] = [];
    const nextId = () => String(++logIdRef.current);

    if (!prev) {
      newEntries.push({ id: nextId(), type: "system", text: `connected — stage: ${cur.session.loopStage} | trace: available model output + tool events (no raw CoT)`, at: Date.now() });
      if (cur.session.taskTitle) {
        newEntries.push({ id: nextId(), type: "system", text: `task: ${cur.session.taskTitle}`, at: Date.now() });
      }
    } else {
      // Stage change
      if (prev.session.loopStage !== cur.session.loopStage) {
        newEntries.push({ id: nextId(), type: "system", text: `stage → ${cur.session.loopStage}`, at: Date.now() });
      }
      // Task change
      if (prev.session.taskTitle !== cur.session.taskTitle && cur.session.taskTitle) {
        newEntries.push({ id: nextId(), type: "system", text: `task: ${cur.session.taskTitle}`, at: Date.now() });
      }
    }

    // Debug trace events
    const curTrace = cur.debugTrace;
    const prevTrace = prev?.debugTrace;
    if (curTrace) {
      // New tool events — dedup by "type:at"
      for (const e of [...curTrace.recentToolEvents].reverse()) {
        const key = `${e.type}:${e.at}`;
        if (!seenToolEventsRef.current.has(key)) {
          seenToolEventsRef.current.add(key);
          newEntries.push({ id: nextId(), type: "tool-call", text: e.summary, at: e.at });
        }
      }

      // New action result
      const prevLar = prevTrace?.lastActionResult;
      const curLar = curTrace.lastActionResult;
      if (curLar && (curLar.actionType !== prevLar?.actionType || curLar.summary !== prevLar?.summary)) {
        newEntries.push({ id: nextId(), type: "tool-result", text: `${curLar.actionType} → ${curLar.outcome}: ${curLar.summary}`, at: Date.now() });
      }

      // New assistant summary
      const prevSummary = prevTrace?.lastAssistantSummary ?? "";
      const curSummary = curTrace.lastAssistantSummary;
      if (curSummary && curSummary !== prevSummary) {
        newEntries.push({ id: nextId(), type: "assistant", text: curSummary, at: Date.now() });
      }

      // Approval reason change
      const prevPause = prevTrace?.pendingApprovalReason;
      const curPause = curTrace.pendingApprovalReason;
      if (curPause && curPause !== prevPause) {
        newEntries.push({ id: nextId(), type: "approval", text: `paused: ${curPause}`, at: Date.now() });
      }
      if (!curPause && prevPause && prev) {
        newEntries.push({ id: nextId(), type: "system", text: "approval resolved — continuing", at: Date.now() });
      }
    }

    // New interventions
    if (prev) {
      const prevIvSet = new Set(prev.activeInterventions);
      for (const iv of cur.activeInterventions) {
        if (!prevIvSet.has(iv)) {
          newEntries.push({ id: nextId(), type: "intervention", text: iv, at: Date.now() });
        }
      }
      const curIvSet = new Set(cur.activeInterventions);
      const clearedCount = prev.activeInterventions.filter(iv => !curIvSet.has(iv)).length;
      if (clearedCount > 0) {
        newEntries.push({ id: nextId(), type: "system", text: "intervention cleared", at: Date.now() });
      }
    }

    if (newEntries.length > 0) {
      setLogEntries(prev => [...prev, ...newEntries].slice(-300));
    }
    prevStatusRef.current = cur;
  }, [status.data]); // addLog is stable (useCallback [])

  const handleContinue = async () => {
    setMode("busy");
    try {
      const { ok, data } = await postJson("/cli/continue");
      const d = data as { ok?: boolean };
      addLog(ok ? "system" : "error", ok ? "continue executed" : `continue failed: ${JSON.stringify(d)}`);
    } catch (e) { addLog("error", String(e)); }
    setMode("idle");
  };

  const handleSubmit = async (task: string) => {
    if (!task.trim()) { setMode("idle"); return; }
    setMode("busy");
    try {
      const { ok, data } = await postJson("/cli/submit", { task });
      const d = data as { loopStageAfter?: string };
      addLog(ok ? "system" : "error", ok ? `submitted — stage: ${d.loopStageAfter ?? "?"}` : "submit failed");
    } catch (e) { addLog("error", String(e)); }
    setMode("idle");
  };

  const handleApproveHuman = async (content: string) => {
    if (!content.trim()) { setMode("idle"); return; }
    setMode("busy");
    try {
      const { ok, data } = await postJson("/cli/approve", { kind: "human-response", fromHuman: "tui-user", content });
      const d = data as { description?: string };
      addLog(ok ? "system" : "error", ok ? (d.description ?? "response sent") : "approve failed");
    } catch (e) { addLog("error", String(e)); }
    setMode("idle");
  };

  const handleApproveTool = async (toolCallId: string) => {
    setMode("busy");
    try {
      const { ok, data } = await postJson("/cli/tool-approval", { toolCallId, approved: true });
      const d = data as { ok?: boolean };
      addLog(ok ? "system" : "error", ok ? "tool approved — loop continuing" : `tool approval failed: ${JSON.stringify(d)}`);
    } catch (e) { addLog("error", String(e)); }
    setMode("idle");
  };

  const handleApproveMutation = async (evidence: string) => {
    if (!pendingMutation) { setMode("idle"); return; }
    setMode("busy");
    const eff = evidence.trim() || "confirmed via TUI";
    try {
      const { ok, data } = await postJson("/cli/approve", {
        kind: "mutation-confirm", mutationId: pendingMutation.id, mutationStatus: "applied", evidence: eff,
      });
      const d = data as { description?: string };
      addLog(ok ? "system" : "error", ok ? `mutation #${pendingMutation.id} applied — ${d.description ?? ""}` : "mutation confirm failed");
    } catch (e) { addLog("error", String(e)); }
    setPendingMutation(null);
    setMode("idle");
  };

  const handleApprovePressed = async () => {
    const interventions = status.data?.activeInterventions ?? [];
    const pendingToolApproval = status.data?.pendingToolApproval ?? null;
    const kind = detectApproveKind(interventions, pendingToolApproval);
    if (kind === "tool-approval" && pendingToolApproval) {
      void handleApproveTool(pendingToolApproval.toolCallId);
    } else if (kind === "mutation-confirm") {
      setMode("busy");
      const mutations = await fetchPendingMutations();
      const first = mutations[0] ?? null;
      if (!first) { addLog("error", "no pending mutations found"); setMode("idle"); return; }
      setPendingMutation(first);
      addLog("system", `confirm mutation #${first.id} (${first.card_ref}): ${first.description}`);
      setInputValue("");
      setMode("approve-mutation");
    } else if (kind === "human-response") {
      setInputValue("");
      setMode("approve-human");
    } else {
      addLog("system", "no active intervention requiring approval");
    }
  };

  useInput((input, key) => {
    if (mode === "busy") return;
    if (mode === "idle") {
      if (input === "q" || input === "Q") { exit(); return; }
      if (input === "s" || input === "S") { setMode("submit"); setInputValue(""); return; }
      if (input === "c" || input === "C") { void handleContinue(); return; }
      if (input === "a" || input === "A") { void handleApprovePressed(); return; }
      return;
    }
    if (key.escape) { setMode("idle"); setInputValue(""); setPendingMutation(null); return; }
    if (key.return) {
      const val = inputValue;
      setInputValue("");
      if (mode === "submit") void handleSubmit(val);
      else if (mode === "approve-human") void handleApproveHuman(val);
      else if (mode === "approve-mutation") void handleApproveMutation(val);
      return;
    }
    if (key.backspace || key.delete) { setInputValue(v => v.slice(0, -1)); return; }
    if (input && input >= " ") { setInputValue(v => v + input); }
  });

  const termRows = process.stdout.rows ?? 30;
  const termCols = process.stdout.columns ?? 80;
  const LOG_ROWS = Math.max(6, termRows - 10);
  const EFFECTIVE_COLS = Math.max(20, Math.floor((termCols - 20) / 2));

  const visibleLog: LogEntry[] = [];
  let rowBudget = LOG_ROWS;
  for (let i = logEntries.length - 1; i >= 0; i--) {
    const segs = splitEntryLines(logEntries[i].text);
    const rowCount = Math.max(1, segs.reduce(
      (sum, seg) => sum + Math.max(1, Math.ceil(seg.length / EFFECTIVE_COLS)), 0
    ));
    if (rowCount > rowBudget && visibleLog.length > 0) break;
    visibleLog.unshift(logEntries[i]);
    rowBudget -= rowCount;
  }

  const s = status.data?.session;
  const usage = status.data?.usageStats;
  const interventions = status.data?.activeInterventions ?? [];
  const pendingToolApproval = status.data?.pendingToolApproval ?? null;
  const hasInterventions = interventions.length > 0;
  const approveKind = detectApproveKind(interventions, pendingToolApproval);

  return (
    <Box flexDirection="column" height={termRows}>

      {/* HEADER */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        {/* : TUI demoted to debug surface — Web is the primary product surface. */}
        <Box>
          <Text bold color="yellow">[AGENT_THURSDAY DEBUG SURFACE]</Text>
          <Text dimColor>  Web (/) is the primary product surface; this TUI is debug/inspect only.</Text>
        </Box>
        {/* Row 1: identity + stage + model */}
        <Box>
          <Text bold color="cyanBright">AgentThursday</Text>
          <Text>  </Text>
          <Text bold color="yellow">[DEBUG]</Text>
          <Text>  </Text>
          <Text bold>{s?.instanceName ?? "—"}</Text>
          <Text>  stage: </Text>
          <Text bold color={stageColor(s?.loopStage)}>{s?.loopStage ?? "—"}</Text>
          {s?.readyForNextRound && <Text color="green">  +ready</Text>}
          {usage?.modelInfo
            ? <Text dimColor>  model: {usage.modelInfo.modelId.replace("@cf/", "")}</Text>
            : <Text dimColor>  model: {status.data ? usage?.modelProfile?.model?.replace("@cf/", "") ?? "kimi-k2.6" : "—"}</Text>
          }
          {usage?.modelProfile && <Text dimColor>  profile: {usage.modelProfile.provider}/{usage.modelProfile.model.replace("@cf/", "")}</Text>}
        </Box>
        {/* Row 2: execution ladder tier + task-scoped act + tokens + refresh time */}
        <Box>
          {status.data?.debugTrace?.lastLadderTier
            ? <Text color="magenta">ladder: T{status.data.debugTrace.lastLadderTier.tier} ({status.data.debugTrace.lastLadderTier.reason}){"  "}</Text>
            : <Text dimColor>ladder: —{"  "}</Text>
          }
          {usage && (
            <Text dimColor>
              task act: ckpts:{usage.taskCheckpoints} notes:{usage.taskNotes} muts:{usage.taskAppliedMutations}
              {"  "}ctx: {usage.msgCount}msg{usage.lastStepInputTokens !== null ? ` last-req:${fmtTok(usage.lastStepInputTokens)}` : ""}
            </Text>
          )}
          {usage?.tokenTask
            ? <Text dimColor>  tok task:{fmtTok(usage.tokenTask.in)}↑{fmtTok(usage.tokenTask.out)}↓</Text>
            : usage?.tokenSession
            ? <Text dimColor>  tok session:{fmtTok(usage.tokenSession.in)}↑{fmtTok(usage.tokenSession.out)}↓</Text>
            : <Text dimColor>  tok:n/a</Text>
          }
          <Text dimColor>  {fmtTime(status.lastRefreshedAt)}</Text>
        </Box>
      </Box>

      {/* TASK LINE */}
      <Box paddingX={2}>
        <Text dimColor>task: </Text>
        <Text bold color="yellow">{s?.taskTitle ?? "(none)"}</Text>
        {s?.suggestedNextCommand && <Text dimColor>  next: {s.suggestedNextCommand}</Text>}
        {status.error && <Text color="red">  ! {status.error}</Text>}
      </Box>

      {/* LOG AREA */}
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {status.loading && logEntries.length === 0 && (
          <Text dimColor>  Connecting to {WORKER_URL}…</Text>
        )}
        {!status.loading && logEntries.length === 0 && !status.error && (
          <Text dimColor>  no activity yet — press S to submit a task</Text>
        )}
        {visibleLog.map(entry => (
          <LogLine key={entry.id} entry={entry} />
        ))}
      </Box>

      {/* FOOTER */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        {/* Intervention alert line */}
        {hasInterventions && (
          <Box>
            <Text bold color="yellowBright">! INTERVENTION: </Text>
            <Text color="yellow">{interventions[0]}</Text>
            {interventions.length > 1 && <Text dimColor>  +{interventions.length - 1} more</Text>}
          </Box>
        )}
        {/* Mutation detail when confirming */}
        {mode === "approve-mutation" && pendingMutation && (
          <Box>
            <Text bold color="cyan">mutation #{pendingMutation.id} ({pendingMutation.card_ref}): </Text>
            <Text dimColor>{pendingMutation.description}</Text>
          </Box>
        )}
        {/* ACTIONS */}
        <Box>
          <Text bold>ACTIONS  </Text>
          {mode === "idle" && (
            <Text>
              [<Text bold color="green">S</Text>]ubmit{"  "}
              [<Text bold color={hasInterventions ? "redBright" : "yellow"}>A</Text>]pprove
              {approveKind === "tool-approval" && <Text color="magenta"> (tool +)</Text>}
              {approveKind === "mutation-confirm" && <Text color="cyan"> (mutation)</Text>}
              {approveKind === "human-response" && <Text color="yellow"> (respond)</Text>}
              {hasInterventions ? <Text color="redBright"> &lt;--</Text> : null}{"  "}
              [<Text bold color="red">Q</Text>]uit
              <Text dimColor>  [C] debug-continue</Text>
            </Text>
          )}
          {mode === "submit" && <Text color="green">typing task — Enter to submit, Esc to cancel</Text>}
          {mode === "approve-human" && <Text color="yellow">typing response — Enter to send, Esc to cancel</Text>}
          {mode === "approve-mutation" && <Text color="cyan">evidence — Enter to apply (blank = "confirmed via TUI"), Esc to cancel</Text>}
          {mode === "busy" && <Text color="cyan">working…</Text>}
        </Box>
        {/* INPUT */}
        <Box>
          <Text bold color={mode === "idle" ? "blue" : "green"}>INPUT  </Text>
          {mode === "idle" && <Text dimColor>&gt; press S/A to act, Q to quit</Text>}
          {mode === "submit" && <Text>task &gt; <Text color="green">{inputValue}_</Text></Text>}
          {mode === "approve-human" && <Text>response &gt; <Text color="yellow">{inputValue}_</Text></Text>}
          {mode === "approve-mutation" && <Text>evidence &gt; <Text color="cyan">{inputValue}_</Text></Text>}
          {mode === "busy" && <Text dimColor>working...</Text>}
        </Box>
      </Box>

    </Box>
  );
}
