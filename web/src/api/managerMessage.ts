import { authHeaders } from "../auth/secret";

/**
 * an earlier revision (UX W4) — send a work message to a cloud agent from its
 * detail page. Wraps `POST /api/manager/agents/:id/message`, which
 * returns `{ ok, task_id, status }` (async accept semantics).
 */
export interface SendAgentMessageResult {
  ok: boolean;
  taskId: string | null;
  status: string | null;
  error: string | null;
}

export async function sendAgentMessage(
  agentId: string,
  text: string,
): Promise<SendAgentMessageResult> {
  try {
    const res = await fetch(
      `/api/manager/agents/${encodeURIComponent(agentId)}/message`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    const d = (await res.json()) as {
      ok?: boolean;
      task_id?: string;
      status?: string;
      message?: string;
      code?: string;
    };
    if (!res.ok || !d.ok) {
      return { ok: false, taskId: null, status: null, error: d.message ?? d.code ?? `HTTP ${res.status}` };
    }
    return { ok: true, taskId: d.task_id ?? null, status: d.status ?? null, error: null };
  } catch (e) {
    return { ok: false, taskId: null, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}
