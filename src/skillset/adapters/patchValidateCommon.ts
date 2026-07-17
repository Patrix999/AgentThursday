/**
 * narrow agent context surface for `patch.validate`.
 *
 * The dynamic-tool dispatch path passes `agentCtx` as the third arg to
 * `DispatchHandler.execute`. `patch.validate` needs two capabilities
 * from the agent DO: `readArtifact()` (to resolve a patch-artifact
 * reference produced via `artifact.write`) and `sandboxExec()` (to
 * run the validation commands inside the Cloudflare Sandbox
 * container). Typing the ctx as the smallest interface keeps the
 * adapter free of `as AgentThursdayAgent` casts and lets reviewers see at a
 * glance which DO methods are reachable from this surface.
 *
 * Boundaries enforced here are minimal; the engine
 * (`patchValidateEngine.ts`) enforces the rest (ephemeral tree,
 * allowlisted gate, no write to the live checkout).
 */

import type { SandboxExec } from "../devShell";
import type { AgentArtifactCtx } from "./artifactCommon";

export interface PatchValidateCtx {
  readArtifact: AgentArtifactCtx["readArtifact"];
  sandboxExec: SandboxExec;
}

export function requirePatchValidateCtx(ctx: unknown): PatchValidateCtx {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { readArtifact?: unknown }).readArtifact !== "function" ||
    typeof (ctx as { sandboxExec?: unknown }).sandboxExec !== "function"
  ) {
    throw new Error(
      "patch.validate adapter requires agentCtx with readArtifact + sandboxExec",
    );
  }
  return ctx as PatchValidateCtx;
}
