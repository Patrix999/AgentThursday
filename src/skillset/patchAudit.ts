/**
 *  — Worker-portable patch audit primitives.
 *
 * Pure JavaScript (no `node:` imports) so the `patch.validate`
 * adapter can run the 243-class hunk-count audit inside the
 * Cloudflare Worker / DO before reaching the sandbox. The Node-only
 * engine in `scripts/sandbox/devPatchSandbox.ts` re-uses the same
 * parsers / regexes / types.
 *
 * Shared with the Worker-side sandbox-routed engine
 * (`src/skillset/sandbox/patchValidateEngine.ts`) so both code paths
 * report `PatchValidationResult` with identical field semantics. The
 * field set matches `dev_patch_sandbox_policy.evidence_payload_fields`
 * in `docs/skillsets/software-dev.0.1.0.yaml` — adding a field there
 * means adding it here.
 */

export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export const FILE_TARGET_RE = /^\+\+\+ (?:b\/)?(.+?)(?:\s|$)/;
export const NEW_FILE_RE = /^new file mode /;

export type FailureReason =
  | "hunk_count_mismatch"
  | "git_apply_check_failed"
  | "new_file_truncated"
  | "gate_failed";

export interface HunkAuditFinding {
  hunkIndex: number;
  filePath: string;
  declaredOldCount: number;
  declaredNewCount: number;
  actualOldCount: number;
  actualNewCount: number;
  ok: boolean;
}

export interface PatchValidationResult {
  ok: boolean;
  baseRevision: string;
  changedPaths: string[];
  hunkAudit: HunkAuditFinding[];
  gitApplyCheckOk: boolean;
  gitApplyCheckStderr: string;
  newFileEofOk: boolean;
  newFileEofDetails: string[];
  gateCommand: string | null;
  gateExitCode: number | null;
  gateStderr: string;
  failureReason: FailureReason | null;
}

export function auditHunkCounts(patchText: string): HunkAuditFinding[] {
  const lines = patchText.split("\n");
  const findings: HunkAuditFinding[] = [];
  let currentFile = "";
  let hunkIndex = -1;
  let inHunk = false;
  let declaredOld = 0;
  let declaredNew = 0;
  let actualOld = 0;
  let actualNew = 0;

  const flush = (): void => {
    if (!inHunk) return;
    findings.push({
      hunkIndex,
      filePath: currentFile,
      declaredOldCount: declaredOld,
      declaredNewCount: declaredNew,
      actualOldCount: actualOld,
      actualNewCount: actualNew,
      ok: declaredOld === actualOld && declaredNew === actualNew,
    });
    inHunk = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentFile = "";
      continue;
    }
    const tgt = FILE_TARGET_RE.exec(line);
    if (tgt) {
      flush();
      currentFile = tgt[1] === "/dev/null" ? currentFile : tgt[1];
      continue;
    }
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      flush();
      hunkIndex += 1;
      declaredOld = m[2] != null ? Number(m[2]) : 1;
      declaredNew = m[4] != null ? Number(m[4]) : 1;
      actualOld = 0;
      actualNew = 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const c = line.charAt(0);
    if (c === " ") {
      actualOld += 1;
      actualNew += 1;
    } else if (c === "-") {
      actualOld += 1;
    } else if (c === "+") {
      actualNew += 1;
    } else {
      flush();
    }
  }
  flush();
  return findings;
}

export function extractChangedPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split("\n")) {
    const m = FILE_TARGET_RE.exec(line);
    if (m && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths].sort();
}

export function extractNewFilePaths(patchText: string): string[] {
  const paths: string[] = [];
  let pendingNewFile = false;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      pendingNewFile = false;
      continue;
    }
    if (NEW_FILE_RE.test(line)) {
      pendingNewFile = true;
      continue;
    }
    if (pendingNewFile) {
      const tgt = FILE_TARGET_RE.exec(line);
      if (tgt && tgt[1] !== "/dev/null") {
        paths.push(tgt[1]);
        pendingNewFile = false;
      }
    }
  }
  return paths;
}
