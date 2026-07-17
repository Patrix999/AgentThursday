// pure module-level constants + a SQL-row type moved from
// `src/server.ts` (pre-edit lines 183, 418-441, 456-457, 464-465,
// 480-481, 509, 512-518). Byte-equivalent: literal values preserved
// exactly; only the leading `const`/`type` keyword loses the `export`-less
// module-private status as it crosses module boundaries.
//
// Grouping rationale (vs the 9-file split the card suggested): these are
// all pure values referenced from `AgentThursdayAgent` and friends in `server.ts`.
// Keeping them in one focused module avoids fragmenting the import block
// at the top of `server.ts` into a stack of one-symbol imports while still
// removing ~50 LoC of literals from the entry module.
import type { CliSession } from "../types";

// fresh context id budget cap (chars/4 surrogate)
// used by `storedCompactionView` in `./contextHelpers`.
export const COMPACTION_SUMMARY_PREVIEW_BUDGET = 600;

// tool names the truthfulness gate watches for in assistant
// text. Must stay aligned with `getTools()` registration; if a new tool is
// added, add its name here so claims about it are validated. Workspace tools
// (read/write/list/edit) come from `createWorkspaceTools` and are addressed
// by their bare names below.
export const KNOWN_TOOL_NAMES: readonly string[] = [
  "review_project_status",
  "write_checkpoint",
  "review_note",
  "advance_kanban_card",
  "execute",
  "remember",
  "recall",
  "list_memories",
  "forget",
  "browse",
  "read",
  "write",
  "list",
  "edit",
  // ContentHub external source tools.
  "content_sources",
  "content_list",
  "content_read",
  // ContentHub literal search.
  "content_search",
  // agent-facing conversation archive search.
  "conversation_search",
  // 2026-06-19 — global workspace file share (replaces localdoc).
  "share_file",
  "list_shared_files",
  "read_shared_file",
  // self-scheduling (recurring prompts to oneself).
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
];

// fixed estimates for tool schema + framing overhead
// (chars/4 surrogate). Keeps inspect cheap; revisit if a real
// tokenizer lands or registry grows substantially.
export const ESTIMATED_TOOLS_OVERHEAD_TOKENS = 3_000;
export const ESTIMATED_OTHER_OVERHEAD_TOKENS = 500;

// source-read budget harness v1. Mirrored in
// `docs/skillsets/software-dev.0.1.0.yaml` `source_read_policy`; the
// smoke (`scripts/card247-source-read-budget-smoke.ts`) asserts both
// sides match so the YAML cannot silently drift. Warning-only: large or
// truncated reads emit `read_budget.warning` but the read is not blocked.
export const SOURCE_READ_DEFAULT_MAX_BYTES = 8192;
export const SOURCE_READ_LARGE_THRESHOLD_BYTES = 15360;

// an earlier revision §A — bounded chars/4 estimate of dialog tokens from persisted
// messages. Used as a fallback when runtime token usage is unavailable
// (DO cold start / post-deploy reset wipes `_sessionTok`/`_taskTok`).
// Bounded:
//   - last 60 messages only (matches the dialog-turn budget elsewhere);
//   - per-message text capped to 8000 chars before estimation, so a
//     single huge tool payload cannot dominate the estimate or push
//     the loop into a memory-hot read.
// Returns null when no usable text is available.
export const DIALOG_FALLBACK_MESSAGE_LIMIT = 60;
export const DIALOG_FALLBACK_PER_MSG_CHAR_CAP = 8_000;

// Row shape for `event_log` SELECTs used by inspect/dashboard plumbing
// in `server.ts`. Kept narrow to what the call sites bind. (Note: a
// duplicate local declaration also lives in `./workspaceSnapshot.ts`
// and could be deduped in a follow-up card — out of 266g scope.)
export type EventLogRow = {
  event_type: string;
  payload: string;
  created_at: number;
  trace_id: string | null;
};

export const CLI_COMMANDS: CliSession["availableCommands"] = [
  { name: "submit",   kind: "loop-advance", description: "提交新任务，启动 developer loop",                endpoint: "/cli/submit",   method: "POST" },
  { name: "status",   kind: "read",         description: "查看当前 CLI session / loop 状态",              endpoint: "/cli/status",   method: "GET"  },
  { name: "continue", kind: "loop-advance", description: "执行当前 committedAction，推进 loop",           endpoint: "/cli/continue", method: "POST" },
  { name: "approve",  kind: "write",        description: "处理人类确认：响应 escalation 或 confirm mutation", endpoint: "/cli/approve",  method: "POST" },
  { name: "result",   kind: "read",         description: "查看当前 deliverable 与 reviewer 结论",         endpoint: "/cli/result",   method: "GET"  },
];
