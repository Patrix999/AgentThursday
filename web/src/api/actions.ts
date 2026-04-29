import { postJson } from "./client";

/**
 * Mutating action wrappers. Bodies mirror tui/App.tsx contracts verbatim
 * (Card 79 review constraint: don't invent shapes). The web identifies
 * itself as `web-user` instead of TUI's `tui-user`; otherwise the worker
 * cannot tell which surface a human-response came from.
 */

export const WEB_USER = "web-user";

export function submitTask(task: string) {
  return postJson("/cli/submit", { task });
}

export function sendHumanResponse(content: string) {
  return postJson("/cli/approve", {
    kind: "human-response",
    fromHuman: WEB_USER,
    content,
  });
}

export function approveTool(toolCallId: string) {
  return postJson("/cli/tool-approval", { toolCallId, approved: true });
}

export function rejectTool(toolCallId: string) {
  return postJson("/cli/tool-approval", { toolCallId, approved: false });
}

export function approveMutation(mutationId: number, evidence = "approved via web") {
  return postJson("/cli/approve", {
    kind: "mutation-confirm",
    mutationId,
    mutationStatus: "applied",
    evidence,
  });
}

export function rejectMutation(mutationId: number, evidence = "rejected via web") {
  return postJson("/cli/approve", {
    kind: "mutation-confirm",
    mutationId,
    mutationStatus: "rejected",
    evidence,
  });
}
