/**
 * adapter for `artifact.read` dynamic tool.
 *
 * Wraps the agent's DO callable `readArtifact()` .
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { AgentArtifactCtx, requireArtifactCtx } from "./artifactCommon";

const ARTIFACT_READ_TOOL_ID = "artifact.read";

const inputSchema = z.object({
  cardId: z.string().min(1),
  filename: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Output = Awaited<ReturnType<AgentArtifactCtx["readArtifact"]>>;

registerDispatchHandler<Input, Output>({
  tool_id: ARTIFACT_READ_TOOL_ID,
  inputSchema,
  execute: async (input, _env, ctx) => {
    const agent = requireArtifactCtx(ctx);
    return agent.readArtifact(input);
  },
});
