/**
 * gate-runner structural types extracted from
 * `gateRunner.ts`.
 *
 * This module holds the interface / discriminated-union shapes that
 * describe a gate run's evidence: prewarm + bootstrap status records,
 * the per-phase + aggregate result envelopes, and the dispatcher-side
 * `GateRunContext`. All literal-union "label" types live with their
 * companion constants in `gateConstants.ts` to avoid a circular import
 * (this module imports from gateConstants; gateConstants imports
 * nothing from here).
 *
 * an earlier revision invariant: every shape is byte-equivalent to the
 * pre-split definitions in `gateRunner.ts`. Field names, optionality,
 * doc-comments, and discriminant arms are preserved.
 *
 * The runtime helpers that produce these shapes (`prewarmNodeModules`,
 * `ensureNodeModules`, `runPhasedGate`, `runGate`) stay in
 * `gateRunner.ts` until an earlier revision move them.
 */

import type { DispatchEvent, SandboxExec } from "./devShell";
import type { GateTarget, GatePhase, InstallStrategy } from "./gateConstants";

export type PrewarmStatus =
  | "linked"
  | "already_present"
  | "missing_in_image"
  | "failed";

export interface PrewarmResult {
  subdir: string;
  status: PrewarmStatus;
  duration_ms: number;
  /** Resolved prewarm `node_modules` path; null when no map entry. */
  prewarm_source: string | null;
  /** Target `node_modules` path under the checkout. */
  target_path: string;
  /** Short failure / informational message, when relevant. */
  stderr_snippet?: string;
}

export type BootstrapStatus =
  | { status: "skipped"; subdir: string; duration_ms: 0; markers_checked: readonly string[] }
  | {
      status: "succeeded";
      subdir: string;
      duration_ms: number;
      exit_code: 0;
      markers_checked: readonly string[];
      markers_missing_pre_install: readonly string[];
      timeout_s: number;
      /** 190e: which install strategy actually ran. */
      install_strategy: InstallStrategy;
    }
  | {
      status: "failed";
      subdir: string;
      duration_ms: number;
      exit_code: number;
      stderr_snippet: string;
      markers_checked: readonly string[];
      markers_missing_pre_install: readonly string[];
      markers_missing_post_install?: readonly string[];
      timeout_s: number;
      /** 190b: true when the bootstrap install was killed by the shell timeout (exit 124). */
      timed_out: boolean;
      /** 190e: which install strategy ran (or was about to run when it timed out). */
      install_strategy: InstallStrategy;
    };

export interface BootstrapStartedEvent {
  subdir: string;
  markers_checked: readonly string[];
  markers_missing: readonly string[];
  timeout_s: number;
  /** 190e: which install command will run. */
  install_strategy: InstallStrategy;
  install_command: string;
}

export interface PhaseResult {
  phase: GatePhase;
  command: string;
  timeout_s: number;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timed_out: boolean;
  skipped_due_to_previous_failure?: boolean;
}

export interface GateResult {
  ok: boolean;
  target: GateTarget;
  tool_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: { stdout: boolean; stderr: boolean };
  backend: "real" | "stub";
  /**
   * 190: dependency bootstrap evidence per checkout subdir. Empty
   * when no bootstrap was needed (e.g. stub mode, or no repoBaseDir).
   */
  bootstrap?: BootstrapStatus[];
  /**
   * 190g: dependency prewarm evidence per checkout subdir. Populated
   * whenever a real backend ran (regardless of whether prewarm
   * actually linked or fell through). `undefined` only in stub mode
   * or when no `repoBaseDir` was set.
   */
  prewarm?: PrewarmResult[];
  /**
   * 190d: per-phase evidence for the typecheck target. Other
   * targets (build / test / dry_run) keep the monolithic 190c flow
   * and leave this undefined.
   */
  phases?: PhaseResult[];
  /**
   * 190 / 190c: explanation when the gate didn't produce real
   * evidence. `bootstrap_failed` covers the 190 case where
   * dependency install failed; `gate_timeout` covers the 190c case
   * where the gate command itself ran past its allotted timebox.
   */
  failed_reason?: "bootstrap_failed" | "gate_timeout" | "no_repo_checkout";
  /**
   * 190c: hard timebox (seconds) applied to this gate command.
   * Always populated when `backend === "real"` so verifiers can
   * compare wall-clock duration against the bound.
   */
  timeout_s?: number;
  /** 190c: true when the gate command was killed by the shell timeout (exit 124). */
  timed_out?: boolean;
  /**
   * an earlier revision: scoped typecheck evidence. Present only for
   * `gate.typecheck` runs that went through `selectTypecheckPhases`.
   * `scoped: false` means a full / fallback run (no skipping). When
   * `scoped: true`, `skipped` lists the phases the fast path deliberately
   * skipped (`reason: scoped_fast_path`) so a scoped result can never be
   * mistaken for a full-repo PASS.
   */
  typecheck_scope?: {
    scoped: boolean;
    scopes: string[];
    skipped: ReadonlyArray<{ phase: string; reason: string }>;
  };
}

export interface GateRunContext {
  emit(event: DispatchEvent): void;
  sandboxExec?: SandboxExec;
  traceId?: string | null;
  /**
   * 189: when set, gate commands run inside this checkout dir
   * (e.g. `/workspace/AgentThursday`) so npm / wrangler see the real
   * package.json + repo state instead of the empty sandbox cwd.
   */
  repoBaseDir?: string;
}
