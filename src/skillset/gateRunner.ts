/**
 * Gate runner.
 *
 * The gate runner is the only path through which the agent can
 * trigger build/test/typecheck. It NEVER runs an arbitrary shell;
 * the only commands it executes come from `GATE_COMMAND_ALLOWLIST`.
 * Every run produces a structured `GateResult` (stdout/stderr/
 * exit_code/duration) that downstream code can fold into an evidence
 * envelope.
 *
 * Backend wiring (`SandboxExec`) is identical to devShell.ts so the
 * same Cloudflare Sandbox container handles both git inspect and
 * gate runs.
 *
 * Contract:
 *   target ∈ {typecheck, build, test, dry_run}
 *   typecheck → npm run typecheck
 *   build     → npm run build:web
 *   test      → npm test  (allowed but no test script ships yet —
 *                          will exit non-zero, which is correct
 *                          evidence)
 *   dry_run   → npx wrangler deploy --dry-run
 */

import { TOOL_CONTRACTS, type ToolContract } from "./contractRegistry";
import {
  GATE_TARGETS,
  GATE_COMMAND_ALLOWLIST,
  GATE_COMMAND_TIMEOUT_S,
  BUILD_PHASES,
  TOOL_ID_BY_TARGET,
  STDOUT_CAP,
  STDERR_CAP,
  PREWARM_DIRS_BY_SUBDIR,
  GATE_DEP_REQUIREMENTS,
  selectTypecheckPhases,
} from "./gateConstants";
import type { GateTarget, TypecheckPhaseSelection } from "./gateConstants";
import type {
  PrewarmResult,
  BootstrapStatus,
  GateResult,
  GateRunContext,
} from "./gateTypes";
import { prewarmNodeModules, ensureNodeModules } from "./gateBootstrap";
import { runPhasedGate, truncate } from "./gatePhaseRunner";

//  — backward-compat re-exports. Public importers
// (e.g. `src/server.ts` and `scripts/-...`) continue to
// resolve these symbols from `./skillset/gateRunner` without an
// atomic update. New code should import directly from
// `./gateConstants` / `./gateTypes` instead.
export { GATE_TARGETS, GATE_COMMAND_ALLOWLIST } from "./gateConstants";
export type {
  GateTarget,
  GateTypecheckPhase,
  GateBuildPhase,
  GatePhase,
} from "./gateConstants";
export type {
  PrewarmStatus,
  PrewarmResult,
  BootstrapStatus,
  BootstrapStartedEvent,
  PhaseResult,
  GateResult,
  GateRunContext,
} from "./gateTypes";

function getContract(toolId: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(toolId);
}

/**
 *  — list the worktree's changed paths so the typecheck fast
 * path can scope phases to what actually changed. The agent's
 * `repo.write` / `repo.patch` are UNCOMMITTED in the checkout
 * (`devShellWrite.ts`: "No commit / push paths exist in this module"),
 * so `git status --porcelain` reports them. Returns `[]` on any failure
 * — callers treat an empty result as "scope unknown" and fall back to
 * the full phase chain, so a git glitch can never narrow the gate.
 */
async function detectChangedPaths(
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>,
  baseDir: string,
): Promise<string[]> {
  try {
    const r = await exec(`cd ${baseDir} && git status --porcelain`);
    if (r.exit_code !== 0) return [];
    return r.stdout
      .split("\n")
      // porcelain v1 line = "XY PATH" (XY is exactly 2 status chars);
      // renames are "R  old -> new". Slice the 2-char status, trim, and
      // take the post-arrow path for renames. Do NOT trim the raw line
      // first — the leading status space is significant.
      .filter(line => line.length >= 3)
      .map(line => {
        const rest = line.slice(2).replace(/\r$/, "").trim();
        const arrow = rest.indexOf(" -> ");
        return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
      })
      .filter(p => p.length > 0);
  } catch {
    return [];
  }
}

export async function runGate(
  rawTarget: string,
  ctx: GateRunContext,
): Promise<GateResult> {
  const startedAt = Date.now();
  const knownTarget = (GATE_TARGETS as readonly string[]).includes(rawTarget)
    ? (rawTarget as GateTarget)
    : null;

  if (!knownTarget) {
    const fallbackToolId = "gate.typecheck";
    ctx.emit({
      type: `tool.${fallbackToolId}.error`,
      payload: {
        reason: "unsupported_gate_target",
        details: rawTarget,
        traceId: ctx.traceId ?? null,
      },
    });
    return {
      ok: false,
      target: "typecheck",
      tool_id: fallbackToolId,
      command: "",
      exit_code: -1,
      stdout: "",
      stderr: `unsupported gate target: ${rawTarget}`,
      duration_ms: Date.now() - startedAt,
      truncated: { stdout: false, stderr: false },
      backend: "stub",
    };
  }

  const target = knownTarget;
  const command = GATE_COMMAND_ALLOWLIST[target];
  const toolId = TOOL_ID_BY_TARGET[target];
  const contract = getContract(toolId);

  ctx.emit({
    type: `tool.${toolId}.dispatch`,
    payload: {
      input: { target },
      command,
      traceId: ctx.traceId ?? null,
      tier: contract?.tier ?? 3,
    },
  });

  if (!ctx.sandboxExec) {
    // No backend → stub: emit "would have run" result so dispatcher
    // contract is observable in unit tests.
    const r: GateResult = {
      ok: true,
      target,
      tool_id: toolId,
      command,
      exit_code: 0,
      stdout: `# stub: ${command}`,
      stderr: "",
      duration_ms: Date.now() - startedAt,
      truncated: { stdout: false, stderr: false },
      backend: "stub",
    };
    ctx.emit({
      type: `tool.${toolId}.result`,
      payload: { ...r, traceId: ctx.traceId ?? null },
    });
    return r;
  }

  //  — when typecheck / build fire without a repo checkout
  // resolved (e.g. lazy materialization race lost), the monolithic
  // fallthrough runs `npm run typecheck` / `npm run build:web` in the
  // sandbox cwd which has no node_modules and produces the misleading
  // `sh: 1: tsc: not found` exit 127 with `phases=[]`. Surface a
  // structured failure so callers (and the verdict computation) can
  // distinguish "no checkout available" from "real toolchain failure".
  if ((target === "typecheck" || target === "build") && !ctx.repoBaseDir) {
    const r: GateResult = {
      ok: false,
      target,
      tool_id: toolId,
      command,
      exit_code: -1,
      stdout: "",
      stderr: "no repo checkout available",
      duration_ms: Date.now() - startedAt,
      truncated: { stdout: false, stderr: false },
      backend: "real",
      phases: [],
      failed_reason: "no_repo_checkout",
    };
    ctx.emit({
      type: `tool.${toolId}.result`,
      payload: { ...r, traceId: ctx.traceId ?? null },
    });
    return r;
  }

  //  — scoped typecheck phase selection. Detect the worktree's
  // changed paths and run only the relevant phases, skipping the slow
  // full-repo `root` phase for web-/tui-/scripts-only mutations. Computed
  // BEFORE prewarm so dependency warming follows the selected scope
  // (e.g. a web-only run warms web/node_modules, not just root).
  let typecheckSelection: TypecheckPhaseSelection | null = null;
  if (target === "typecheck" && ctx.repoBaseDir && ctx.sandboxExec) {
    const changedPaths = await detectChangedPaths(ctx.sandboxExec, ctx.repoBaseDir);
    typecheckSelection = selectTypecheckPhases(changedPaths);
    ctx.emit({
      type: `tool.${toolId}.scope_selected`,
      payload: {
        scoped: typecheckSelection.scoped,
        scopes: typecheckSelection.scopes,
        phases: typecheckSelection.phases.map(p => p.phase),
        skipped: typecheckSelection.skipped,
        changed_path_count: changedPaths.length,
        traceId: ctx.traceId ?? null,
      },
    });
  }

  //  — dependency requirements follow the scoped selection for
  // typecheck (root-bin for diag/root/tui/scripts; web-bin for the `web`
  // phase); other targets keep the static per-target map.
  const effectiveRequirements: ReadonlyArray<{ subdir: string; markers: readonly string[] }> =
    typecheckSelection
      ? typecheckSelection.depSubdirs.map(sd => ({ subdir: sd, markers: [".bin/tsc"] as const }))
      : (GATE_DEP_REQUIREMENTS[target] ?? []);

  // 190g: dependency prewarm. Try to symlink image-baked node_modules
  // into the checkout BEFORE the marker probe so the bootstrap install
  // (which can't fit into 300s on a cold sandbox) is avoided. Falls
  // through to the 190f bounded install path when the prewarm dir is
  // absent / link fails.
  const prewarm: PrewarmResult[] = [];
  if (ctx.repoBaseDir) {
    const requirements = effectiveRequirements;
    for (const req of requirements) {
      const prewarmSource = PREWARM_DIRS_BY_SUBDIR[req.subdir];
      const targetNm = req.subdir
        ? `${ctx.repoBaseDir}/${req.subdir}/node_modules`
        : `${ctx.repoBaseDir}/node_modules`;
      ctx.emit({
        type: `tool.${toolId}.prewarm_started`,
        payload: {
          subdir: req.subdir || "(root)",
          prewarm_source: prewarmSource ?? null,
          target_path: targetNm,
          traceId: ctx.traceId ?? null,
        },
      });
      const pr = await prewarmNodeModules(ctx.sandboxExec, ctx.repoBaseDir, req.subdir);
      prewarm.push(pr);
      ctx.emit({
        type: `tool.${toolId}.prewarm_finished`,
        payload: {
          subdir: pr.subdir || "(root)",
          status: pr.status,
          duration_ms: pr.duration_ms,
          prewarm_source: pr.prewarm_source,
          target_path: pr.target_path,
          stderr_snippet: pr.stderr_snippet ?? null,
          traceId: ctx.traceId ?? null,
        },
      });
    }
  }

  // 190: bootstrap dependencies before running the gate command.
  // Only when repoBaseDir is set; without a checkout dir we keep the
  // pre-190 behavior so the existing `tsc: not found` evidence still
  // surfaces in test environments that intentionally lack a repo.
  const bootstrap: BootstrapStatus[] = [];
  if (ctx.repoBaseDir) {
    const requirements = effectiveRequirements;
    for (const req of requirements) {
      const status = await ensureNodeModules(
        ctx.sandboxExec,
        ctx.repoBaseDir,
        req.subdir,
        req.markers,
        // 190b/190e: emit `bootstrap_started` BEFORE the install
        // runs so a hung install still leaves evidence in the
        // trace. Payload now includes install_strategy +
        // install_command so a verifier can see which command was
        // about to run (npm ci vs npm install).
        (started) => {
          ctx.emit({
            type: `tool.${toolId}.bootstrap_started`,
            payload: {
              subdir: started.subdir || "(root)",
              markers_checked: started.markers_checked,
              markers_missing: started.markers_missing,
              timeout_s: started.timeout_s,
              install_strategy: started.install_strategy,
              install_command: started.install_command,
              traceId: ctx.traceId ?? null,
            },
          });
        },
      );
      bootstrap.push(status);
      ctx.emit({
        type:
          status.status === "failed"
            ? `tool.${toolId}.bootstrap_failed`
            : status.status === "succeeded"
            ? `tool.${toolId}.bootstrap_succeeded`
            : `tool.${toolId}.bootstrap_skipped`,
        payload: {
          subdir: status.subdir || "(root)",
          duration_ms: status.duration_ms,
          exit_code: "exit_code" in status ? status.exit_code : null,
          stderr_snippet: "stderr_snippet" in status ? status.stderr_snippet.slice(-512) : null,
          markers_checked: status.markers_checked,
          markers_missing_pre_install:
            "markers_missing_pre_install" in status ? status.markers_missing_pre_install : null,
          markers_missing_post_install:
            "markers_missing_post_install" in status && status.markers_missing_post_install
              ? status.markers_missing_post_install
              : null,
          timeout_s: "timeout_s" in status ? status.timeout_s : null,
          timed_out: "timed_out" in status ? status.timed_out : null,
          // 190e: which install strategy ran. `skipped` has no
          // install attempt and therefore no strategy.
          install_strategy: "install_strategy" in status ? status.install_strategy : null,
          traceId: ctx.traceId ?? null,
        },
      });
      if (status.status === "failed") {
        // Don't run the gate command when bootstrap fails — it would
        // fail anyway and obscure the real reason. Surface the
        // failure straight to the caller as a structured GateResult.
        const failResult: GateResult = {
          ok: false,
          target,
          tool_id: toolId,
          command,
          exit_code: -1,
          stdout: "",
          stderr: `bootstrap failed in ${status.subdir || "(root)"}: exit ${status.exit_code}\n${status.stderr_snippet.slice(-1500)}`,
          duration_ms: Date.now() - startedAt,
          truncated: { stdout: false, stderr: false },
          backend: "real",
          bootstrap,
          prewarm: prewarm.length > 0 ? prewarm : undefined,
          failed_reason: "bootstrap_failed",
        };
        ctx.emit({
          type: `tool.${toolId}.result`,
          payload: { ...failResult, traceId: ctx.traceId ?? null },
        });
        return failResult;
      }
    }
  }

  // 190c: per-target timebox + execution_started event so a stuck
  // gate command can return bounded evidence instead of dangling
  // the HTTP client.
  const timeoutSeconds = GATE_COMMAND_TIMEOUT_S[target];
  ctx.emit({
    type: `tool.${toolId}.execution_started`,
    payload: {
      command,
      target,
      timeout_s: timeoutSeconds,
      base_dir: ctx.repoBaseDir ?? null,
      traceId: ctx.traceId ?? null,
    },
  });

  // 190d: typecheck splits into three named phases so a slow one
  // can be pinpointed. 195: build splits into web_tsc/web_vite for
  // the same reason — production gate.build was hitting the 300s
  // umbrella timeout with no breakdown of which sub-step (tsc vs
  // vite) was slow. Other targets keep the 190c monolithic flow.
  if (target === "typecheck" && ctx.repoBaseDir) {
    //  — run the scoped phase subset (computed above). Falls
    // back to the full chain when no selection was produced (e.g.
    // sandboxExec absent on this path, which shouldn't happen here).
    const sel = typecheckSelection ?? selectTypecheckPhases([]);
    return await runPhasedGate({
      ctx,
      toolId,
      target,
      command,
      bootstrap,
      prewarm,
      startedAt,
      umbrellaTimeoutS: timeoutSeconds,
      phases: sel.phases,
      typecheckScope: { scoped: sel.scoped, scopes: sel.scopes, skipped: sel.skipped },
    });
  }
  if (target === "build" && ctx.repoBaseDir) {
    return await runPhasedGate({
      ctx,
      toolId,
      target,
      command,
      bootstrap,
      prewarm,
      startedAt,
      umbrellaTimeoutS: timeoutSeconds,
      phases: BUILD_PHASES,
    });
  }

  try {
    // 189: cd into repo checkout dir if provided so npm finds package.json
    // and wrangler finds wrangler.toml. Falls back to bare command when
    // no checkout dir is set (unit tests / pre-189 setups).
    //
    // 190c: wrap the actual command in `timeout S CMD` so a stuck
    // npm / vite / wrangler returns exit 124 deterministically and
    // we can surface a structured `gate_timeout` failure instead of
    // hanging the HTTP client.
    const cdPrefix = ctx.repoBaseDir ? `cd ${ctx.repoBaseDir} && ` : "";
    const fullCommand = `${cdPrefix}timeout ${timeoutSeconds} ${command}`;
    const raw = await ctx.sandboxExec(fullCommand);
    const timedOut = raw.exit_code === 124;
    const stdoutT = truncate(raw.stdout, STDOUT_CAP);
    const baseStderr = timedOut
      ? `gate command timed out after ${timeoutSeconds}s (exit 124)\n${raw.stderr || ""}`
      : raw.stderr;
    const stderrT = truncate(baseStderr, STDERR_CAP);
    const result: GateResult = {
      ok: raw.exit_code === 0,
      target,
      tool_id: toolId,
      command,
      exit_code: raw.exit_code,
      stdout: stdoutT.text,
      stderr: stderrT.text,
      duration_ms: Date.now() - startedAt,
      truncated: { stdout: stdoutT.truncated, stderr: stderrT.truncated },
      backend: "real",
      bootstrap: bootstrap.length > 0 ? bootstrap : undefined,
      prewarm: prewarm.length > 0 ? prewarm : undefined,
      timeout_s: timeoutSeconds,
      timed_out: timedOut,
      ...(timedOut ? { failed_reason: "gate_timeout" as const } : {}),
    };
    ctx.emit({
      type: `tool.${toolId}.result`,
      payload: { ...result, traceId: ctx.traceId ?? null },
    });
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    ctx.emit({
      type: `tool.${toolId}.error`,
      payload: {
        reason: "sandbox_exec_failed",
        details: detail,
        traceId: ctx.traceId ?? null,
      },
    });
    return {
      ok: false,
      target,
      tool_id: toolId,
      command,
      exit_code: -1,
      stdout: "",
      stderr: detail,
      duration_ms: Date.now() - startedAt,
      truncated: { stdout: false, stderr: false },
      backend: "real",
      bootstrap: bootstrap.length > 0 ? bootstrap : undefined,
      prewarm: prewarm.length > 0 ? prewarm : undefined,
      timeout_s: timeoutSeconds,
      timed_out: false,
    };
  }
}
