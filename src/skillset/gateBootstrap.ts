/**
 * gate-runner bootstrap / prewarm helpers extracted from
 * `gateRunner.ts`.
 *
 * This module owns the dependency-bootstrap path: probing for marker
 * files, picking an install strategy, prewarming `node_modules` from
 * the image-baked snapshot, and the full install + re-probe envelope.
 *
 * `runGate()` (in `gateRunner.ts`) is the only caller in production —
 * it invokes `prewarmNodeModules()` and `ensureNodeModules()` per
 * subdir before delegating to the phase runner. A focused smoke
 * (`scripts/card266b-bootstrap-smoke.ts`) drives `ensureNodeModules`
 * directly through a fake `SandboxExec`.
 *
 * an earlier revision invariant: every shell snippet, marker check, event
 * payload, timeout value, and result shape is byte-equivalent to the
 * pre-split definitions in `gateRunner.ts`. The orphan
 * `ensureNodeModules` doc-block (originally sitting between
 * `probeMissingMarkers` and `selectInstallStrategy` in
 * `gateRunner.ts`) is preserved in place to keep the move
 * minimum-diff.
 */

import type { SandboxExec } from "./devShell";
import type { InstallStrategy } from "./gateConstants";
import {
  PREWARM_DIRS_BY_SUBDIR,
  BOOTSTRAP_INSTALL_CMD_BY_STRATEGY,
  BOOTSTRAP_INSTALL_TIMEOUT_S,
} from "./gateConstants";
import type {
  PrewarmResult,
  BootstrapStatus,
  BootstrapStartedEvent,
} from "./gateTypes";

/**
 * 190a: check the gate's required executables/markers under
 * `<subdir>/node_modules/`. Returns the list of markers that are
 * missing — empty array means everything is in place and the
 * caller can short-circuit to `skipped`.
 *
 * Each marker path is relative to `<subdir>/node_modules/`. The
 * shell test uses `[ -e ... ]` (any file/symlink exists) rather
 * than `-x` because a few `.bin/<tool>` entries are symlinks whose
 * exec bit is on the link target, which `-x` can sometimes refuse.
 */
async function probeMissingMarkers(
  exec: SandboxExec,
  baseDir: string,
  subdir: string,
  markers: readonly string[],
): Promise<readonly string[]> {
  if (markers.length === 0) return [];
  const dir = subdir ? `${baseDir}/${subdir}` : baseDir;
  // One shell call per marker keeps the parsing trivial and the
  // command short. Markers are static — never user input.
  const missing: string[] = [];
  for (const m of markers) {
    const r = await exec(
      `[ -e ${dir}/node_modules/${m} ] && echo HAS || echo MISSING`,
    );
    if (!r.stdout.includes("HAS")) {
      missing.push(m);
    }
  }
  return missing;
}

/**
 * 190 + 190a + 190b: ensure node_modules exist AND the gate's
 * required markers are present, with a hard install timebox.
 *
 * Idempotent — every marker found returns `skipped` without
 * running install. Missing markers trigger the fixed install
 * command, wrapped in `timeout(1) <BOOTSTRAP_INSTALL_TIMEOUT_S>`
 * so a hung install can't dangle the HTTP request. Exit 124 from
 * the timeout builtin is detected and surfaced as
 * `failed timed_out=true`.
 *
 * After install we re-probe; a 0 exit but missing markers is also
 * reported as failed so the caller can give a precise reason
 * instead of the generic `tsc: not found` downstream.
 *
 * `onStarted` (190b) fires once per attempted install BEFORE the
 * shell command runs so a truly hung install still leaves a
 * `bootstrap_started` event in the trace.
 *
 * The install command is hard-coded (not derived from any model
 * input) so 186's allowlist invariant — model never injects shell
 * — extends to bootstrap too.
 */
/**
 * 190e: pick the bootstrap install strategy. Prefer `npm ci` when
 * the subdir has a `package-lock.json` (deterministic, faster cold
 * install, refuses lockfile mutation). Fall back to `npm install`
 * when no lockfile exists. The probe is a one-shell-call test for
 * the lockfile so we don't pay an extra round trip.
 */
async function selectInstallStrategy(
  exec: SandboxExec,
  baseDir: string,
  subdir: string,
): Promise<InstallStrategy> {
  const dir = subdir ? `${baseDir}/${subdir}` : baseDir;
  const r = await exec(`[ -f ${dir}/package-lock.json ] && echo HAS || echo MISSING`);
  return r.stdout.includes("HAS") ? "npm-ci" : "npm-install";
}

/**
 * 190g: try to symlink the image-baked prewarm `node_modules` into
 * `<baseDir>/<subdir>/node_modules`. The whole probe + link is one
 * shell call so we pay at most one round trip in the happy path.
 *
 * The shell snippet is fully static; only `baseDir` and `subdir`
 * (controlled by repoMaterialization + GATE_DEP_REQUIREMENTS, never
 * model input) and the static prewarm dir from the map are
 * interpolated. Output is parsed by exact-string match.
 */
export async function prewarmNodeModules(
  exec: SandboxExec,
  baseDir: string,
  subdir: string,
): Promise<PrewarmResult> {
  const startedAt = Date.now();
  const targetParent = subdir ? `${baseDir}/${subdir}` : baseDir;
  const targetNm = `${targetParent}/node_modules`;
  const prewarmRoot = PREWARM_DIRS_BY_SUBDIR[subdir];
  if (!prewarmRoot) {
    return {
      subdir,
      status: "missing_in_image",
      duration_ms: Date.now() - startedAt,
      prewarm_source: null,
      target_path: targetNm,
      stderr_snippet: `no prewarm map entry for subdir '${subdir || "(root)"}'`,
    };
  }
  const prewarmNm = `${prewarmRoot}/node_modules`;
  // One-shot: 1) target already exists -> already_present;
  //          2) prewarm dir absent     -> missing_in_image;
  //          3) ensure parent + symlink → LINKED / LINK_FAILED.
  const cmd =
    `if [ -e ${targetNm} ]; then echo TARGET_PRESENT; ` +
    `elif [ ! -d ${prewarmNm} ]; then echo PREWARM_MISSING; ` +
    `else mkdir -p ${targetParent} && ln -s ${prewarmNm} ${targetNm} && echo LINKED || echo LINK_FAILED; fi`;
  let r;
  try {
    r = await exec(cmd);
  } catch (e) {
    return {
      subdir,
      status: "failed",
      duration_ms: Date.now() - startedAt,
      prewarm_source: prewarmNm,
      target_path: targetNm,
      stderr_snippet: `prewarm exec error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const out = r.stdout || "";
  const dur = Date.now() - startedAt;
  if (out.includes("TARGET_PRESENT")) {
    return {
      subdir,
      status: "already_present",
      duration_ms: dur,
      prewarm_source: prewarmNm,
      target_path: targetNm,
    };
  }
  if (out.includes("PREWARM_MISSING")) {
    return {
      subdir,
      status: "missing_in_image",
      duration_ms: dur,
      prewarm_source: prewarmNm,
      target_path: targetNm,
      stderr_snippet: `prewarm dir ${prewarmNm} not found in image`,
    };
  }
  if (out.includes("LINKED")) {
    return {
      subdir,
      status: "linked",
      duration_ms: dur,
      prewarm_source: prewarmNm,
      target_path: targetNm,
    };
  }
  return {
    subdir,
    status: "failed",
    duration_ms: dur,
    prewarm_source: prewarmNm,
    target_path: targetNm,
    stderr_snippet: `prewarm shell unexpected output: '${out.slice(0, 200)}' stderr='${(r.stderr || "").slice(0, 200)}'`,
  };
}

export async function ensureNodeModules(
  exec: SandboxExec,
  baseDir: string,
  subdir: string,
  markers: readonly string[],
  onStarted?: (ev: BootstrapStartedEvent) => void,
): Promise<BootstrapStatus> {
  const missingPre = await probeMissingMarkers(exec, baseDir, subdir, markers);
  if (missingPre.length === 0) {
    return { status: "skipped", subdir, duration_ms: 0, markers_checked: markers };
  }
  const dir = subdir ? `${baseDir}/${subdir}` : baseDir;
  // 190e: pick install strategy based on lockfile presence.
  const strategy = await selectInstallStrategy(exec, baseDir, subdir);
  const installCmd = BOOTSTRAP_INSTALL_CMD_BY_STRATEGY[strategy];
  // 190b/190e: announce the install (with strategy + resolved
  // command) before kicking it off so a hung process still leaves
  // evidence. Caller decides whether to log as a tool event.
  if (onStarted) {
    onStarted({
      subdir,
      markers_checked: markers,
      markers_missing: missingPre,
      timeout_s: BOOTSTRAP_INSTALL_TIMEOUT_S,
      install_strategy: strategy,
      install_command: installCmd,
    });
  }
  const startedAt = Date.now();
  // Wrap with the GNU coreutils `timeout` builtin: `timeout S CMD`
  // exits 124 if S elapses before CMD finishes. This is portable
  // across busybox / coreutils / alpine. We pipe through 2>&1 so
  // both streams collapse into stdout for capping; the merge
  // matches the pre-190b behavior.
  const wrappedCmd = `cd ${dir} && timeout ${BOOTSTRAP_INSTALL_TIMEOUT_S} ${installCmd} 2>&1`;
  const r = await exec(wrappedCmd);
  const duration = Date.now() - startedAt;
  const merged = (r.stdout || "") + (r.stderr ? `\n${r.stderr}` : "");
  const timedOut = r.exit_code === 124;
  if (r.exit_code !== 0) {
    return {
      status: "failed",
      subdir,
      duration_ms: duration,
      exit_code: r.exit_code,
      stderr_snippet: timedOut
        ? `bootstrap install (${strategy}) timed out after ${BOOTSTRAP_INSTALL_TIMEOUT_S}s (exit 124)\n${merged.slice(-1500)}`
        : `bootstrap install (${strategy}) exit ${r.exit_code}\n${merged.slice(-2048)}`,
      markers_checked: markers,
      markers_missing_pre_install: missingPre,
      timeout_s: BOOTSTRAP_INSTALL_TIMEOUT_S,
      timed_out: timedOut,
      install_strategy: strategy,
    };
  }
  // Re-probe after install — a 0 exit can still leave markers
  // missing (wrong scripts, partial network failures glossed
  // over by npm). Surface as failed to avoid the misleading
  // `tsc: not found` downstream.
  const missingPost = await probeMissingMarkers(exec, baseDir, subdir, markers);
  if (missingPost.length > 0) {
    return {
      status: "failed",
      subdir,
      duration_ms: duration,
      exit_code: 0,
      stderr_snippet: `install (${strategy}) completed with exit 0 but markers still missing: ${missingPost.join(", ")}`,
      markers_checked: markers,
      markers_missing_pre_install: missingPre,
      markers_missing_post_install: missingPost,
      timeout_s: BOOTSTRAP_INSTALL_TIMEOUT_S,
      timed_out: false,
      install_strategy: strategy,
    };
  }
  return {
    status: "succeeded",
    subdir,
    duration_ms: duration,
    exit_code: 0,
    markers_checked: markers,
    markers_missing_pre_install: missingPre,
    timeout_s: BOOTSTRAP_INSTALL_TIMEOUT_S,
    install_strategy: strategy,
  };
}
