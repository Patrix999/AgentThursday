/**
 *  — LocalDoc adapter, migrated out of `dispatchRegistry.ts`.
 *
 * The handler self-registers via `registerDispatchHandler()` at
 * import time. The provider-specific transport / secret-handling /
 * error-mapping code stays in `src/localdocAdapter.ts` (untouched by
 * this card); this file is the thin registration shim that lets the
 * adapter-registry path own the canonical wiring.
 *
 * Side effects: outbound `fetch` to LocalDoc (`LOCALDOC_DEFAULT_ENDPOINT`)
 * when `env.LOCALDOC_API_KEY` is set; without the secret the underlying
 * adapter returns `{ status: "blocked", reason: "missing_secret" }`
 * without touching the network.
 *
 * Registration: top-level `registerDispatchHandler({...})` call. The
 * `tool_id` literal is intentionally absent from `dispatchRegistry.ts`
 * ( / 241 central-proof invariant) — it lives here so adding
 * or migrating a new tool requires zero edits to the registry module
 * itself.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import {
  dispatchLocalDocConvertText,
  LOCALDOC_TOOL_ID,
  type LocalDocConvertTextInput,
  type LocalDocEvidence,
} from "../../localdocAdapter";

const inputSchema = z.object({
  title: z.string().optional(),
  content: z.string().min(1),
});

registerDispatchHandler<LocalDocConvertTextInput, LocalDocEvidence>({
  tool_id: LOCALDOC_TOOL_ID,
  inputSchema,
  execute: async (input, env) =>
    dispatchLocalDocConvertText(input, env as { LOCALDOC_API_KEY?: string }),
});
