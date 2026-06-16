/**
 *  — Worker-side validate-only patch engine.
 *
 * Runs the same 248 closed loop the Node-local validator runs, but
 * routed through `SandboxExec` so the agent (Worker / DO) can invoke
 * it without forking processes locally. The 243-class hunk-count
 * audit runs in-Worker before any sandbox call so a corrupt patch
 * short-circuits without touching the container.
 *
 * Steps (each in its own `sandboxExec` round trip):
 *   1. In-Worker: hunk-count audit. Short-circuit on `ok=false`.
 *   2. Sandbox: provision ephemeral repo (`mkdir`/`git init`/seed
 *      commit) + write patch text via base64 transport.
 *   3. Sandbox: `git apply --check`.
 *   4. Sandbox (if check ok): isolated `git apply`.
 *   5. Sandbox (if apply ok): per-new-file `cat` → count lines in
 *      TS (matches local validator semantics exactly).
 *   6. Sandbox (if EOF ok and gate supplied): allowlisted gate.
 *   7. Sandbox: `rm -rf` ephemeral repo (always; finally block).
 *
 * Hard boundaries:
 *   - Sandbox tree is an ephemeral `/tmp/<id>` directory — NEVER the
 *     agent's live checkout. No write to `repoBaseDir` is ever made.
 *   - Gate command shape is a closed allowlist (`node_check`).
 *   - No `git_commit` / `git_push` / `deploy` / `cross_repo_write`
 *     surface is reachable from this engine.
 */

import type { SandboxExec } from "../devShell";
import {
  auditHunkCounts,
  extractChangedPaths,
  extractNewFilePaths,
  type PatchValidationResult,
} from "../patchAudit";

export type GateSpec = { kind: "node_check"; file: string };

export interface ValidatePatchArtifactAsyncOpts {
  sandboxExec: SandboxExec;
  patchText: string;
  gate?: GateSpec | null;
  /** Optional id suffix for trace logging; default uses Date.now()+rand. */
  workspaceIdHint?: string;
}

const SAFE_FILE = /^[A-Za-z0-9_./-]{1,400}$/;

function emptyResult(failureReason: PatchValidationResult["failureReason"], partial: Partial<PatchValidationResult> = {}): PatchValidationResult {
  return {
    ok: false,
    baseRevision: partial.baseRevision ?? "(none)",
    changedPaths: partial.changedPaths ?? [],
    hunkAudit: partial.hunkAudit ?? [],
    gitApplyCheckOk: false,
    gitApplyCheckStderr: partial.gitApplyCheckStderr ?? "",
    newFileEofOk: partial.newFileEofOk ?? false,
    newFileEofDetails: partial.newFileEofDetails ?? [],
    gateCommand: partial.gateCommand ?? null,
    gateExitCode: partial.gateExitCode ?? null,
    gateStderr: partial.gateStderr ?? "",
    failureReason,
  };
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  // btoa is available in Cloudflare Workers; convert bytes to a
  // binary string first.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildSetupScript(tmpRepo: string, patchPath: string, patchB64: string): string {
  // Multiple statements joined with `&&` so any step failing stops the
  // chain. Single-quoted strings prevent shell expansion of patch
  // content (base64 only — no quotes to escape).
  return [
    `mkdir -p ${tmpRepo}`,
    `cd ${tmpRepo}`,
    `git init -q -b main`,
    `git -c user.email=pv@local -c user.name=pv commit --allow-empty -q -m seed`,
    `printf '%s' '${patchB64}' | base64 -d > ${patchPath}`,
    `git rev-parse HEAD`,
  ].join(" && ");
}

function buildGateCommand(gate: GateSpec): string {
  // Closed shape — only `node --check <file>` is supported, and
  // `file` must already have passed SAFE_FILE / changedPaths
  // validation at the adapter boundary. The engine re-validates
  // defensively so this stays a pure function of its input.
  if (gate.kind !== "node_check") {
    throw new Error(`patchValidateEngine: unsupported gate kind: ${(gate as { kind: string }).kind}`);
  }
  if (!SAFE_FILE.test(gate.file)) {
    throw new Error(`patchValidateEngine: unsafe gate file: ${gate.file}`);
  }
  if (gate.file.includes("..")) {
    throw new Error(`patchValidateEngine: traversal in gate file: ${gate.file}`);
  }
  return `node --check ${gate.file}`;
}

export async function validatePatchArtifactAsync(
  opts: ValidatePatchArtifactAsyncOpts,
): Promise<PatchValidationResult> {
  const { sandboxExec, patchText, gate } = opts;
  const changedPaths = extractChangedPaths(patchText);
  const hunkAudit = auditHunkCounts(patchText);
  const hunkOk = hunkAudit.length > 0 && hunkAudit.every(f => f.ok);

  // Step 1 — in-Worker 243-class catch. Short-circuit so a corrupt
  // patch never reaches the sandbox.
  if (!hunkOk) {
    return emptyResult("hunk_count_mismatch", {
      changedPaths,
      hunkAudit,
      gitApplyCheckStderr: "skipped: hunk audit failed",
      newFileEofDetails: [],
    });
  }

  const idHint = opts.workspaceIdHint
    ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpRepo = `/tmp/pv-${idHint}`;
  const patchPath = `${tmpRepo}/.candidate.patch`;
  const patchB64 = base64Encode(patchText);

  let baseRevision = "(none)";
  let gitApplyCheckOk = false;
  let gitApplyCheckStderr = "";
  let newFileEofOk = true;
  const newFileEofDetails: string[] = [];
  let gateCommandStr: string | null = null;
  let gateExitCode: number | null = null;
  let gateStderr = "";

  try {
    // Step 2 — provision + write patch.
    const setup = await sandboxExec(buildSetupScript(tmpRepo, patchPath, patchB64));
    if (setup.exit_code !== 0) {
      // Provisioning failed — surface as git_apply_check_failed with
      // the setup stderr so the failure is unambiguous in evidence.
      gitApplyCheckStderr = `setup failed: ${(setup.stderr ?? setup.stdout ?? "").trim().slice(-500)}`;
      return emptyResult("git_apply_check_failed", {
        baseRevision,
        changedPaths,
        hunkAudit,
        gitApplyCheckStderr,
      });
    }
    baseRevision = setup.stdout.trim().split(/\s+/).pop() ?? "(none)";

    // Step 3 — git apply --check.
    const check = await sandboxExec(`cd ${tmpRepo} && git apply --check ${patchPath} 2>&1`);
    gitApplyCheckOk = check.exit_code === 0;
    if (!gitApplyCheckOk) {
      gitApplyCheckStderr = (check.stdout || check.stderr || "").trim().slice(-1000);
      return emptyResult("git_apply_check_failed", {
        baseRevision,
        changedPaths,
        hunkAudit,
        gitApplyCheckOk,
        gitApplyCheckStderr,
      });
    }

    // Step 4 — isolated apply.
    const apply = await sandboxExec(`cd ${tmpRepo} && git apply ${patchPath} 2>&1`);
    if (apply.exit_code !== 0) {
      newFileEofOk = false;
      newFileEofDetails.push(`git apply failed: ${(apply.stdout || apply.stderr || "").trim().slice(-500)}`);
      return emptyResult("new_file_truncated", {
        baseRevision,
        changedPaths,
        hunkAudit,
        gitApplyCheckOk,
        gitApplyCheckStderr,
        newFileEofOk,
        newFileEofDetails,
      });
    }

    // Step 5 — per-new-file line-count audit. Mirror the local
    // validator's calculation: lines = split("\n").length minus 1
    // when the file ends with "\n".
    for (const p of extractNewFilePaths(patchText)) {
      if (!SAFE_FILE.test(p) || p.includes("..")) {
        newFileEofOk = false;
        newFileEofDetails.push(`unsafe new-file path: ${p}`);
        continue;
      }
      const cat = await sandboxExec(`cat ${tmpRepo}/${p}`);
      if (cat.exit_code !== 0) {
        newFileEofOk = false;
        newFileEofDetails.push(`new file declared but absent after apply: ${p}`);
        continue;
      }
      const body = cat.stdout;
      const lineCount =
        body.length === 0 ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
      const declared = hunkAudit.find(h => h.filePath === p)?.declaredNewCount ?? null;
      if (declared !== null && lineCount !== declared) {
        newFileEofOk = false;
        newFileEofDetails.push(
          `new file ${p}: declared ${declared} lines, on-disk has ${lineCount}`,
        );
      }
    }
    if (!newFileEofOk) {
      return emptyResult("new_file_truncated", {
        baseRevision,
        changedPaths,
        hunkAudit,
        gitApplyCheckOk,
        gitApplyCheckStderr,
        newFileEofOk,
        newFileEofDetails,
      });
    }

    // Step 6 — optional allowlisted gate.
    if (gate) {
      const gateCmd = buildGateCommand(gate);
      gateCommandStr = gateCmd;
      const gateProc = await sandboxExec(`cd ${tmpRepo} && ${gateCmd} 2>&1`);
      gateExitCode = gateProc.exit_code;
      gateStderr = (gateProc.stdout || gateProc.stderr || "").trim().slice(-1000);
      if (gateExitCode !== 0) {
        return {
          ok: false,
          baseRevision,
          changedPaths,
          hunkAudit,
          gitApplyCheckOk,
          gitApplyCheckStderr,
          newFileEofOk,
          newFileEofDetails,
          gateCommand: gateCommandStr,
          gateExitCode,
          gateStderr,
          failureReason: "gate_failed",
        };
      }
    }

    return {
      ok: true,
      baseRevision,
      changedPaths,
      hunkAudit,
      gitApplyCheckOk: true,
      gitApplyCheckStderr,
      newFileEofOk: true,
      newFileEofDetails,
      gateCommand: gateCommandStr,
      gateExitCode,
      gateStderr,
      failureReason: null,
    };
  } finally {
    // Step 7 — best-effort cleanup. Never let cleanup failure mask the
    // validation verdict.
    try {
      await sandboxExec(`rm -rf ${tmpRepo}`);
    } catch {
      // ignore
    }
  }
}
