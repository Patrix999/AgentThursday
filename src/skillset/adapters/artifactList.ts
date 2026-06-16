/**
 *  — adapter for `artifact.list` dynamic tool.
 *
 * Wraps the agent's DO callable `listArtifacts()` ().
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { AgentArtifactCtx, requireArtifactCtx } from "./artifactCommon";

const ARTIFACT_LIST_TOOL_ID = "artifact.list";

const inputSchema = z.object({
  cardId: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Output = Awaited<ReturnType<AgentArtifactCtx["listArtifacts"]>>;

registerDispatchHandler<Input, Output>({
  tool_id: ARTIFACT_LIST_TOOL_ID,
  inputSchema,
  execute: async (input, _env, ctx) => {
    const agent = requireArtifactCtx(ctx);
    return agent.listArtifacts(input);
  },
});
