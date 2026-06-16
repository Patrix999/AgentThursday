/**
 * phase-runner extraction from gateRunner.ts.
 *
 * Holds the per-phase execution loop (`runPhasedGate`) and the
 * stdout/stderr `truncate` helper. `runGate` remains the orchestrator
 * in `./gateRunner` and calls `runPhasedGate` for `gate.typecheck` and
 * `gate.build`.
 *
 * Byte-equivalent move of lines 76–314 of `gateRunner.ts` prior to
 * 266c. Required invariants preserved:
 *   - 190h SessionTerminated 124 reclassification regex literal:
 *     `\b(?:exit[\s_]?code|exited)[\s:=]*124\b` (case-insensitive)
 *   - 190i JS-side watchdog: `Promise.race([exec(wrapped),
 *     watchdogPromise])` with `setTimeout(watchdogTotalS * 1000)`,
 *     `watchdogTotalS = cfg.timeout_s + PHASE_AWAIT_GRACE_S`, and
 *     `finally clearTimeout(watchdogTimer)`.
 *   - Wrapped command shape: `cd ${baseDir} && timeout
 *     ${cfg.timeout_s} ${cfg.command}`
 *   - Fail-fast skip phase shape: `skipped_due_to_previous_failure:
 *     true, exit_code: -1, duration_ms: 0`
 *   - Aggregate stdout phase separator: `=== phase: <name> ===`
 *   - Aggregate `failed_reason: "gate_timeout"` only when any phase
 *     timed out.
 *
 * Module boundary: depends only on `./gateConstants` (values + types)
 * and `./gateTypes` (types). No import of `./gateRunner` — one-way:
 * `gateRunner → gatePhaseRunner`. The sandbox `exec` arrives through
 * `GateRunContext.sandboxExec`, already typed by `gateTypes`.
 */

import {
  PHASE_AWAIT_GRACE_S,
  STDOUT_CAP,
  STDERR_CAP,
} from "./gateConstants";
import type { GatePhase, GateTarget } from "./gateConstants";
import type {
  PrewarmResult,
  BootstrapStatus,
  PhaseResult,
  GateResult,
  GateRunContext,
} from "./gateTypes";

export function truncate(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  // keep head and tail to preserve last error lines
  const head = s.slice(0, Math.floor(cap * 0.7));
  const tail = s.slice(s.length - Math.floor(cap * 0.3));
  return {
    text: `${head}\n... [truncated ${s.length - cap} bytes] ...\n${tail}`,
    truncated: true,
  };
}

/**
 * 190d / 195: phase-by-phase runner for sandbox-backed gates.
 *
 * Runs the supplied `phases` in order. Each phase is wrapped in
 * `cd ${baseDir} && timeout ${S} ${cmd}` and emits `phase_started`
 * and `phase_finished` events so the trace shows exactly which phase
 * landed where. Fail-fast: the first non-zero exit aborts subsequent
 * phases, which appear in the result with
 * `skipped_due_to_previous_failure=true` and zero duration.
 *
 * 190d originated this for `gate.typecheck` (TYPECHECK_PHASES).
 * 195 reuses it for `gate.build` (BUILD_PHASES) — the loop body is
 * phase-shape agnostic; only the input array differs. 190h
 * SessionTerminated 124 classification and 190i watchdog grace apply
 * uniformly regardless of which target is calling.
 *
 * Aggregate `GateResult`:
 *   ok        — true iff every phase exited 0 (no skipped, no
 *                timed_out)
 *   exit_code — first non-zero phase exit, else 0
 *   timed_out — any phase saw exit 124
 *   stdout/stderr — concatenated phase outputs prefixed with
 *                   `=== phase: <name> ===`
 *   duration_ms — wallclock since startedAt (gate dispatch enter)
 *   failed_reason — `gate_timeout` if any phase timed out
 *
 * `command` reflects the umbrella shape so existing inspect UIs
 * still see `npm run typecheck` / `npm run build:web`; phase-level
 * commands appear in `phases[]` and in the per-phase events.
 */
export async function runPhasedGate(args: {
  ctx: GateRunContext;
  toolId: string;
  target: GateTarget;
  command: string;
  bootstrap: BootstrapStatus[];
  prewarm: PrewarmResult[];
  startedAt: number;
  umbrellaTimeoutS: number;
  phases: ReadonlyArray<{ phase: GatePhase; command: string; timeout_s: number }>;
  //  — scoped typecheck evidence. When present, surfaced in the
  // result so the gate output is auditable: which scopes drove the
  // selection, and which phases were skipped (and why) by the fast path.
  typecheckScope?: {
    scoped: boolean;
    scopes: string[];
    skipped: ReadonlyArray<{ phase: string; reason: string }>;
  };
}): Promise<GateResult> {
  const { ctx, toolId, target, command, bootstrap, prewarm, startedAt, umbrellaTimeoutS, phases: phaseConfigs, typecheckScope } = args;
  // ctx.sandboxExec is required to reach this path — runGate already
  // routed away from sandbox-less stub mode before us.
  const exec = ctx.sandboxExec!;
  const baseDir = ctx.repoBaseDir!;

  const phases: PhaseResult[] = [];
  let firstFailure: PhaseResult | null = null;

  for (const cfg of phaseConfigs) {
    if (firstFailure) {
      const skipped: PhaseResult = {
        phase: cfg.phase,
        command: cfg.command,
        timeout_s: cfg.timeout_s,
        exit_code: -1,
        duration_ms: 0,
        stdout: "",
        stderr: `phase '${cfg.phase}' skipped: previous phase '${firstFailure.phase}' exited ${firstFailure.exit_code}${firstFailure.timed_out ? " (timeout)" : ""}`,
        truncated: { stdout: false, stderr: false },
        timed_out: false,
        skipped_due_to_previous_failure: true,
      };
      ctx.emit({
        type: `tool.${toolId}.phase_skipped`,
        payload: {
          phase: skipped.phase,
          command: skipped.command,
          reason: `previous_phase_${firstFailure.phase}_failed`,
          timeout_s: skipped.timeout_s,
          traceId: ctx.traceId ?? null,
        },
      });
      phases.push(skipped);
      continue;
    }

    ctx.emit({
      type: `tool.${toolId}.phase_started`,
      payload: {
        phase: cfg.phase,
        command: cfg.command,
        timeout_s: cfg.timeout_s,
        base_dir: baseDir,
        traceId: ctx.traceId ?? null,
      },
    });

    const phaseStartedAt = Date.now();
    const wrapped = `cd ${baseDir} && timeout ${cfg.timeout_s} ${cfg.command}`;
    let raw: { stdout: string; stderr: string; exit_code: number };
    // 190i: JS-side await watchdog. Even with GNU `timeout` inside
    // the sandbox shell and 190h's catch-side classification of
    // SessionTerminatedError 124, production showed `await
    // exec(wrapped)` itself can fail to return AND fail to throw,
    // leaving the gate request stuck after `phase_started`. Race
    // the exec promise against a timer set to `cfg.timeout_s +
    // PHASE_AWAIT_GRACE_S` — the in-shell `timeout` should normally
    // win first, so this is a strict safety net; if it does fire,
    // synthesize a phase-timeout raw so existing classification
    // (`raw.exit_code === 124`) lights up downstream.
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdogTotalS = cfg.timeout_s + PHASE_AWAIT_GRACE_S;
    const watchdogPromise = new Promise<{ stdout: string; stderr: string; exit_code: number }>(
      (resolve) => {
        watchdogTimer = setTimeout(() => {
          resolve({
            stdout: "",
            stderr: `phase '${cfg.phase}' sandbox exec await timed out after ${watchdogTotalS}s (watchdog)`,
            exit_code: 124,
          });
        }, watchdogTotalS * 1000);
      },
    );
    try {
      raw = await Promise.race([exec(wrapped), watchdogPromise]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // 190h: when GNU `timeout 180 tsc` actually fires inside the
      // sandbox shell, the @cloudflare/sandbox SDK surfaces the
      // killed shell as `SessionTerminatedError` whose message
      // carries `exit code: 124`. Without this re-classification
      // the catch path returned `exit_code=-1`, which masked the
      // timeout downstream (`phaseTimedOut` stayed false, top-level
      // `failed_reason` stayed null). Detect the 124 signal in the
      // exception message and surface it as a real timeout exit so
      // existing classification (`raw.exit_code === 124`) lights up.
      // Match `exit code: 124` / `exit_code=124` / `exit code 124`
      // with common separator variations; fall back to -1 for any
      // other opaque sandbox exec failure (preserves prior behavior
      // for non-timeout errors).
      const isTimeoutSignal = /\b(?:exit[\s_]?code|exited)[\s:=]*124\b/i.test(detail);
      raw = {
        stdout: "",
        stderr: `phase '${cfg.phase}' sandbox exec failed: ${detail}`,
        exit_code: isTimeoutSignal ? 124 : -1,
      };
    } finally {
      // 190i: clear watchdog timer whether exec resolved, rejected,
      // or the watchdog itself fired (idempotent — a timer already
      // fired is a harmless clearTimeout).
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    }
    const phaseDuration = Date.now() - phaseStartedAt;
    const phaseTimedOut = raw.exit_code === 124;
    const stdoutT = truncate(raw.stdout, STDOUT_CAP);
    const baseStderr = phaseTimedOut
      ? `phase '${cfg.phase}' timed out after ${cfg.timeout_s}s (exit 124)\n${raw.stderr || ""}`
      : raw.stderr;
    const stderrT = truncate(baseStderr, STDERR_CAP);
    const phaseResult: PhaseResult = {
      phase: cfg.phase,
      command: cfg.command,
      timeout_s: cfg.timeout_s,
      exit_code: raw.exit_code,
      duration_ms: phaseDuration,
      stdout: stdoutT.text,
      stderr: stderrT.text,
      truncated: { stdout: stdoutT.truncated, stderr: stderrT.truncated },
      timed_out: phaseTimedOut,
    };
    phases.push(phaseResult);
    ctx.emit({
      type: `tool.${toolId}.phase_finished`,
      payload: {
        phase: cfg.phase,
        command: cfg.command,
        exit_code: phaseResult.exit_code,
        duration_ms: phaseResult.duration_ms,
        timed_out: phaseResult.timed_out,
        timeout_s: phaseResult.timeout_s,
        truncated: phaseResult.truncated,
        traceId: ctx.traceId ?? null,
      },
    });
    if (phaseResult.exit_code !== 0) {
      firstFailure = phaseResult;
    }
  }

  // Aggregate.
  const ok = phases.every(p => p.exit_code === 0 && !p.skipped_due_to_previous_failure);
  const aggregateDuration =
    phases.reduce((acc, p) => acc + (p.skipped_due_to_previous_failure ? 0 : p.duration_ms), 0);
  const anyTimedOut = phases.some(p => p.timed_out);
  const firstNonZero = phases.find(p => p.exit_code !== 0 && !p.skipped_due_to_previous_failure);
  const aggregateExit = firstNonZero ? firstNonZero.exit_code : 0;
  const aggregateStdoutParts = phases.map(p =>
    p.skipped_due_to_previous_failure
      ? `=== phase: ${p.phase} === (skipped)\n${p.stderr}\n`
      : `=== phase: ${p.phase} === (exit ${p.exit_code}, ${p.duration_ms}ms${p.timed_out ? ", timed out" : ""})\n${p.stdout}\n`,
  );
  const aggregateStdout = aggregateStdoutParts.join("\n");
  const aggregateStderrParts = phases
    .filter(p => p.stderr.length > 0)
    .map(p => `=== phase: ${p.phase} stderr ===\n${p.stderr}`);
  const aggregateStderrRaw = aggregateStderrParts.join("\n\n");
  const aggregateStdoutT = truncate(aggregateStdout, STDOUT_CAP);
  const aggregateStderrT = truncate(aggregateStderrRaw, STDERR_CAP);

  const result: GateResult = {
    ok,
    target,
    tool_id: toolId,
    command,
    exit_code: aggregateExit,
    stdout: aggregateStdoutT.text,
    stderr: aggregateStderrT.text,
    duration_ms: Date.now() - startedAt,
    truncated: { stdout: aggregateStdoutT.truncated, stderr: aggregateStderrT.truncated },
    backend: "real",
    bootstrap: bootstrap.length > 0 ? bootstrap : undefined,
    prewarm: prewarm.length > 0 ? prewarm : undefined,
    phases,
    timeout_s: umbrellaTimeoutS,
    timed_out: anyTimedOut,
    ...(anyTimedOut ? { failed_reason: "gate_timeout" as const } : {}),
    ...(typecheckScope ? { typecheck_scope: typecheckScope } : {}),
  };
  ctx.emit({
    type: `tool.${toolId}.result`,
    payload: { ...result, traceId: ctx.traceId ?? null },
  });
  // Aggregate duration is informational; the real per-phase
  // breakdown lives in `phases`.
  void aggregateDuration;
  return result;
}
