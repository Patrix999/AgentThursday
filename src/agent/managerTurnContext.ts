//  — per-submit manager turn context propagated via
// AsyncLocalStorage instead of Durable-Object instance fields.
//
//  (now closed-FAIL) stored the in-flight outer
// `manager_task_id` (and friends) on three mutable DO fields:
// `_currentManagerTaskId / _currentManagerTaskSource /
// _currentManagerTaskConversationId`. `submitManagerTask()` set them,
// `await this.submitTask(...)` ran, and `finally` cleared them.
//
// Cloudflare Durable Objects are single-threaded but `async`/`await`
// allows multiple requests against the same DO instance to interleave
// while one is awaiting external I/O (LLM, tool, cross-DO RPC). With
// two async manager tasks targeting the same manager agent, Task B's
// `submitManagerTask()` could overwrite Task A's fields while Task A
// was awaiting the model loop; when A's tool turn later called
// `manager.agent_message`, the adapter would read B's outer id and
// route A's subagent dispatch under B's `parent_task_id`. Task A's
// `finally` could also clear B's still-live context.
//
// AsyncLocalStorage is the framework's own pattern: cf-agents itself
// uses it for `__DO_NOT_USE_WILL_BREAK__agentContext`. Each
// `als.run(store, async () => ...)` invocation gives the body an
// isolated store that propagates through native Promise chains and is
// re-entered explicitly across `ctx.waitUntil`-style detachments by
// cf-agents (see `agents/dist/index.js` line ~750). Two overlapping
// `als.run` calls cannot stomp each other.
//
// `submitManagerTask()` wraps its `await this.submitTask(...)` in
// `managerTurnContext.run({...}, ...)`. The
// `manager.agent_message` adapter still calls
// `agentCtx.getCurrentManagerContext()`, which now reads from the
// store; an absent store (text-only `submitTask`, or
// `manager.agent_message` invoked outside a manager turn) returns
// `null` — same shape as .

// `@types/node` is intentionally NOT in the main tsconfig types list
// (only `@cloudflare/workers-types`), so a direct `import { ... } from
// "node:async_hooks"` would fail typecheck even though the Workers
// runtime exposes the module at runtime when
// `compatibility_flags = ["nodejs_compat"]` (see `wrangler.toml`),
// which is already enabled — cf-agents itself uses it. Pull in just
// the AsyncLocalStorage shape via the Node type reference, scoped to
// this file so the rest of `src/` stays under the Workers-only type
// closure.
/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";

export interface ManagerTurnContext {
  /** Canonical outer `manager_task_id` — same id used by
   *  `/api/manager/tasks/:id`, registry `event_log.trace_id`, and the
   *  subagent's `task_context.parent_task_id` when autofilled. */
  managerTaskId: string;
  /** Manager agent's own `agent_id` (DO instance name). */
  agentId: string;
  /** Optional `source` tag from `submitManagerTask` opts. */
  source: string | null;
  /** Optional `conversation_id` from `submitManagerTask` opts. */
  conversationId: string | null;
}

const store = new AsyncLocalStorage<ManagerTurnContext>();

/**
 * Run `fn` with `ctx` as the active manager turn context. Two
 * `run()` calls executed concurrently (e.g. via `Promise.all`) each
 * see their own `ctx` even when their internal `await`s interleave.
 */
export function runWithManagerTurnContext<T>(
  ctx: ManagerTurnContext,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(ctx, fn);
}

/**
 * Read the active manager turn context, or `null` when called outside
 * any `runWithManagerTurnContext` scope (e.g. text-only `submitTask`,
 * direct `submitTask` callers, or a `manager.agent_message` adapter
 * invocation that somehow escapes the manager turn).
 */
export function getManagerTurnContext(): ManagerTurnContext | null {
  return store.getStore() ?? null;
}
