//  — pure context-lifecycle helpers moved from `src/server.ts`
// (pre-edit lines 177-181, 185-204, 211-234, 482-507). Each helper is
// module-level, side-effect-free, and does not touch `AgentThursdayAgent` state
// or DO storage; relocation cannot change runtime behavior.
//
// Token-budget constants used by these helpers
// (`COMPACTION_SUMMARY_PREVIEW_BUDGET`, `DIALOG_FALLBACK_MESSAGE_LIMIT`,
// `DIALOG_FALLBACK_PER_MSG_CHAR_CAP`) live in `./agentConstants` so they
// can be shared with other call sites without duplication.
import type { StoredCompactionView } from "../schema";
import {
  isSummaryPreserveAnchor,
  type ContextSnapshotViewModel,
  type ContextAnchorClassification,
  type CompactSummaryPreservedPoint,
} from "../contextLifecycle";
import {
  COMPACTION_SUMMARY_PREVIEW_BUDGET,
  DIALOG_FALLBACK_MESSAGE_LIMIT,
  DIALOG_FALLBACK_PER_MSG_CHAR_CAP,
} from "./agentConstants";

//   — fresh context id. Crypto-random when available
// (Cloudflare Workers expose `crypto.randomUUID`); falls back to a
// time + random base-36 hash for the unlikely no-crypto path so the id
// remains unique for audit purposes.
export function newContextId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `ctx_${g.crypto.randomUUID()}`;
  return `ctx_${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function storedCompactionView(stored: {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
}): StoredCompactionView {
  const len = stored.summary.length;
  const summaryPreview = len > COMPACTION_SUMMARY_PREVIEW_BUDGET
    ? `${stored.summary.slice(0, COMPACTION_SUMMARY_PREVIEW_BUDGET)}…`
    : stored.summary;
  return {
    id: stored.id,
    summaryPreview,
    summaryLength: len,
    fromMessageId: stored.fromMessageId,
    toMessageId: stored.toMessageId,
    createdAt: stored.createdAt,
  };
}

//  — recompute medium-tier "preserved important points" from a
// FRESH snapshot/anchors taken immediately before each apply step.
// Using the original plan's `summaryPreservedAnchors` would risk
// drifting into a stale view of which messages still classify as
// medium anchors; recomputing keeps the summary honest.
export function collectFreshPreservedPoints(
  snapshot: ContextSnapshotViewModel,
  anchors: readonly ContextAnchorClassification[],
  fromMessageId: string,
  toMessageId: string,
): CompactSummaryPreservedPoint[] {
  const fromIdx = snapshot.messages.findIndex((m) => m.id === fromMessageId);
  const toIdx = snapshot.messages.findIndex((m) => m.id === toMessageId);
  if (fromIdx < 0 || toIdx < 0 || toIdx < fromIdx) return [];
  const anchorById = new Map<string, ContextAnchorClassification>();
  for (const a of anchors) anchorById.set(a.id, a);
  const out: CompactSummaryPreservedPoint[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const m = snapshot.messages[i];
    const a = anchorById.get(m.id);
    if (!a || !isSummaryPreserveAnchor(a)) continue;
    let text = "";
    for (const p of m.parts) {
      if (p.type === "text") text += (text.length > 0 ? "\n" : "") + p.text;
    }
    out.push({ index: m.index, reasons: a.reasons, preview: text });
  }
  return out;
}

export function estimateDialogTokensFromMessages(messages: ReadonlyArray<unknown>): number | null {
  if (!messages || messages.length === 0) return null;
  const start = Math.max(0, messages.length - DIALOG_FALLBACK_MESSAGE_LIMIT);
  let totalChars = 0;
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i] as { parts?: unknown; content?: unknown } | null | undefined;
    if (!msg || typeof msg !== "object") continue;
    let msgChars = 0;
    const parts = (msg as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") msgChars += t.length;
      }
    } else if (typeof (msg as { content?: unknown }).content === "string") {
      msgChars += ((msg as { content: string }).content).length;
    }
    if (msgChars > DIALOG_FALLBACK_PER_MSG_CHAR_CAP) {
      msgChars = DIALOG_FALLBACK_PER_MSG_CHAR_CAP;
    }
    totalChars += msgChars;
  }
  if (totalChars === 0) return null;
  return Math.ceil(totalChars / 4);
}
