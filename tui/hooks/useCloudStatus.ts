import { useState, useEffect } from "react";
import type { WorkspaceSnapshot } from "../../src/schema";

export type DebugTrace = {
  lastAssistantSummary: string;
  recentToolEvents: { type: string; summary: string; at: number }[];
  pendingApprovalReason: string | null;
  lastActionResult: { actionType: string; outcome: string; summary: string } | null;
  lastLadderTier: { tier: number; toolName: string; reason: string; at: number } | null;
};

export type UsageStats = {
  checkpoints: number;
  notes: number;
  appliedMutations: number;
  eventCount: number;
  taskCheckpoints: number;
  taskNotes: number;
  taskAppliedMutations: number;
  tokenSession: { in: number; out: number; total: number } | null;
  tokenTask: { in: number; out: number; total: number } | null;
  lastStepInputTokens: number | null;
  msgCount: number;
  modelInfo: { provider: string; modelId: string } | null;
  modelProfile: { provider: string; model: string };
};

export type CliStatusData = {
  session: {
    sessionId: string;
    instanceName: string;
    taskId: string | null;
    taskTitle: string | null;
    taskLifecycle: string | null;
    loopStage: string;
    readyForNextRound: boolean;
    autoContinue: boolean;
    suggestedNextCommand: string | null;
  };
  loopSummary: string;
  activeInterventions: string[];
  pendingToolApproval: { toolCallId: string; toolName: string } | null;
  debugTrace: DebugTrace | null;
  usageStats: UsageStats | null;
};

export type CliResultData = {
  taskId: string | null;
  taskTitle: string | null;
  taskLifecycle: string | null;
  loopStage: string;
  deliverableFormed: boolean;
  deliverableSummary: string | null;
  gatePassed: boolean;
  gateReason: string;
  readyForNextRound: boolean;
  activeInterventions: string[];
  suggestedNextCommand: string | null;
  loopSummary: string;
};

export const WORKER_URL = process.env["AGENT_THURSDAY_WORKER_URL"] ?? "http://localhost:8787";

// M7.1 Card 77 — single-user shared-secret auth.
// Read once at module load. The TUI does not support hot-reload of the secret;
// restart the process if you rotate it.
const WORKER_SECRET = process.env["AGENT_THURSDAY_SHARED_SECRET"] ?? "";

if (!WORKER_SECRET) {
  console.warn(
    "[agent-thursday-tui] AGENT_THURSDAY_SHARED_SECRET not set — requests may 401 unless the worker has AGENT_THURSDAY_ALLOW_INSECURE_DEV=true.",
  );
}

/**
 * Header bag for every TUI → worker request. Empty when the secret is unset
 * (TUI keeps booting; worker decides whether to accept).
 */
export function authHeaders(): Record<string, string> {
  return WORKER_SECRET ? { "X-AgentThursday-Secret": WORKER_SECRET } : {};
}

function makePollHook<T>(endpoint: string) {
  return function useCloudPoll(intervalMs = 3000): {
    data: T | null;
    loading: boolean;
    error: string | null;
    lastRefreshedAt: number | null;
  } {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

    useEffect(() => {
      let active = true;

      async function poll() {
        try {
          const res = await fetch(`${WORKER_URL}${endpoint}`, { headers: authHeaders() });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as T;
          if (active) {
            setData(json);
            setLoading(false);
            setError(null);
            setLastRefreshedAt(Date.now());
          }
        } catch (e) {
          if (active) {
            setError(String(e));
            setLoading(false);
          }
        }
      }

      poll();
      const timer = setInterval(poll, intervalMs);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [intervalMs]);

    return { data, loading, error, lastRefreshedAt };
  };
}

export const useCloudStatus = makePollHook<CliStatusData>("/cli/status");
export const useCloudResult = makePollHook<CliResultData>("/cli/result");

/**
 * M7.1 Card 76 — unified workspace snapshot poller.
 *
 * Sourced from `GET /api/workspace`; `WorkspaceSnapshot` is the contract Card 78+
 * is built against. App.tsx is intentionally not migrated in Card 76 — it keeps
 * using `useCloudStatus` until a follow-up card retires the legacy view. This
 * hook is exported so Card 81 (TUI demotion) can adopt it without re-plumbing.
 */
export const useWorkspaceSnapshot = makePollHook<WorkspaceSnapshot>("/api/workspace");
