/**
 * agent dispatch registry.
 *
 * Provider-neutral table that maps a canonical tool_id (with dots) to:
 *   - the zod input schema the AI SDK should advertise,
 *   - the execute function that performs the dispatch against an Env
 *     binding and returns non-sensitive evidence.
 *
 * The generic mapper (`src/skillset/agentDynamicTools.ts`) reads this
 * table. Provider-specific code (adapter, secret binding) lives in
 * the module that registers the handler — the registry entry itself
 * has no provider-specific descriptions; the mapper composes the
 * agent-facing description from `skill.prompt_segment` plus the
 * canonical `ToolContract.description` so manifest authorship stays
 * the boundary for agent-visible language.
 *
 * adapter registration entry point. Handlers added in
 * `src/skillset/adapters/*` register themselves via
 * `registerDispatchHandler()` at import time. The bootstrap module
 * (`src/skillset/adapters/index.ts`) is side-effect-imported by the
 * agent / smoke entry points; this file deliberately contains no
 * literal reference to any adapter-registered tool_id, so adding a
 * new tool requires zero edits here.
 *
 * the REGISTRY starts empty at module load and is
 * populated entirely by `registerDispatchHandler()` calls from
 * `src/skillset/adapters/*`. No adapter-registered tool_id is named
 * by literal in this file.
 */

import { z } from "zod";

export interface DispatchHandler<TInput = unknown, TOutput = unknown> {
  tool_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodSchema<TInput, any, any>;
  // optional `ctx` exposes a narrow per-handler interface
  // for stateful tools (e.g. artifact.write needs DO callable access).
  // Stateless adapters (localdoc/runtime_summary) ignore the third arg.
  execute: (input: TInput, env: unknown, ctx?: unknown) => Promise<TOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, DispatchHandler<any, any>>();

/**
 * adapter registration hook. Adapter modules call this at
 * import time; duplicate `tool_id` is a hard error so two adapters
 * never silently fight over the same canonical id.
 */
export function registerDispatchHandler<TInput, TOutput>(
  handler: DispatchHandler<TInput, TOutput>,
): void {
  if (REGISTRY.has(handler.tool_id)) {
    throw new Error(`duplicate dispatch handler for tool_id: ${handler.tool_id}`);
  }
  REGISTRY.set(handler.tool_id, handler);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_DISPATCH_HANDLERS: ReadonlyMap<string, DispatchHandler<any, any>> = REGISTRY;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDispatchHandler(toolId: string): DispatchHandler<any, any> | undefined {
  return REGISTRY.get(toolId);
}
