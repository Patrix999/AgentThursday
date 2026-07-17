/**
 * adapter for `patch.validate` dynamic tool.
 *
 * Smallest agentD-accessible surface that runs the an earlier revision validate-only
 * loop (hunk audit → `git apply --check` → isolated apply → new-file
 * EOF/line-count → optional allowlisted gate) and returns a closed
 * `PatchValidationResult`. agentD can submit a patch either inline
 * (`patchText`) or by reference to an artifact previously written via
 * `artifact.write` (`cardId` + `filename`).
 *
 * Boundary contract:
 *   - No `git_commit`, no `git_push`, no `deploy`, no
 *     `cross_repo_write` surface is reachable from this adapter — the
 *     engine only runs `git init`/`git apply --check`/`git apply` in
 *     an ephemeral `/tmp/pv-<id>` sandbox tree it owns.
 *   - The optional `gate` field has a closed shape (`node_check`); the
 *     adapter rejects anything else before the engine runs.
 *   - Patch text is base64-transported to the sandbox so shell
 *     metachars in patch content never see shell evaluation.
 *
 * Mirrors `agentd_patch_sandbox_policy.evidence_payload_fields` so the
 * returned record matches the YAML-declared closed field set.
 */

import { z } from "zod";

import { registerDispatchHandler } from "../dispatchRegistry";
import { validatePatchArtifactAsync, type GateSpec } from "../sandbox/patchValidateEngine";
import type { PatchValidationResult } from "../patchAudit";
import { requirePatchValidateCtx } from "./patchValidateCommon";

const PATCH_VALIDATE_TOOL_ID = "patch.validate";

const SAFE_FILE_NAME = /^[A-Za-z0-9_./-]{1,400}$/;

const inputSchema = z
  .object({
    cardId: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    patchText: z.string().min(1).optional(),
    gate: z
      .object({
        kind: z.literal("node_check"),
        file: z.string().min(1),
      })
      .optional(),
  })
  .refine(
    v => (v.cardId && v.filename) || v.patchText,
    {
      message:
        "patch.validate requires either {cardId, filename} (artifact ref) or {patchText} (inline)",
    },
  );

type Input = z.infer<typeof inputSchema>;
type Output =
  | { ok: true; result: PatchValidationResult }
  | { ok: false; error: { code: string; message: string } };

registerDispatchHandler<Input, Output>({
  tool_id: PATCH_VALIDATE_TOOL_ID,
  inputSchema,
  execute: async (input, _env, ctx) => {
    const agent = requirePatchValidateCtx(ctx);

    let patchText: string;
    if (input.cardId && input.filename) {
      const read = await agent.readArtifact({
        cardId: input.cardId,
        filename: input.filename,
      });
      if (!read.ok) {
        return {
          ok: false,
          error: {
            code: read.error.code,
            message: `patch.validate: artifact read failed: ${read.error.message}`,
          },
        };
      }
      patchText = read.content;
    } else if (input.patchText) {
      patchText = input.patchText;
    } else {
      return {
        ok: false,
        error: {
          code: "missing_patch",
          message: "patch.validate: provide {cardId, filename} or {patchText}",
        },
      };
    }

    let gate: GateSpec | null = null;
    if (input.gate) {
      const f = input.gate.file;
      if (!SAFE_FILE_NAME.test(f) || f.split("/").some(seg => seg === "..")) {
        return {
          ok: false,
          error: {
            code: "unsafe_gate_file",
            message: `patch.validate: unsafe gate file: ${f}`,
          },
        };
      }
      gate = { kind: input.gate.kind, file: f };
    }

    const result = await validatePatchArtifactAsync({
      sandboxExec: agent.sandboxExec.bind(agent),
      patchText,
      gate,
    });
    return { ok: true, result };
  },
});
