/**
 *  — adapter for `artifact.write` dynamic tool.
 *
 * Stateful adapter: routes the call through the agent's DO callable
 * `writeArtifact()` (defined in `src/server.ts` per ) so the
 * 245d validation / size cap / secret scan stays the single source of
 * truth — we do NOT duplicate any of those rules here.
 *
 * Context surface (`AgentArtifactCtx`) is intentionally narrow so the
 * adapter only sees the three @callable methods it needs; the rest of
 * the agent stays encapsulated.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { ARTIFACT_TYPES } from "../../artifactShare";
import { AgentArtifactCtx, requireArtifactCtx } from "./artifactCommon";

const ARTIFACT_WRITE_TOOL_ID = "artifact.write";

const inputSchema = z.object({
  cardId: z.string().min(1),
  filename: z.string().min(1),
  type: z.enum(ARTIFACT_TYPES),
  sourceAgent: z.enum(["", "", "", "verifier"] as const),
  producerUserId: z.string().min(1).optional(),
  mime: z.string().min(1).optional(),
  notes: z.string().max(200).optional(),
  content: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Output = Awaited<ReturnType<AgentArtifactCtx["writeArtifact"]>>;

registerDispatchHandler<Input, Output>({
  tool_id: ARTIFACT_WRITE_TOOL_ID,
  inputSchema,
  execute: async (input, _env, ctx) => {
    const agent = requireArtifactCtx(ctx);
    return agent.writeArtifact(input);
  },
});
