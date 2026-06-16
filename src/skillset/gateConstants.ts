/**
 *  — gate-runner constants extracted from `gateRunner.ts`.
 *
 * This module holds every runtime value that drives the gate runner's
 * behavior: target allowlist + per-target command/timeout maps, phase
 * configuration arrays, watchdog grace, prewarm map, dependency-marker
 * requirements, and bootstrap install commands.
 *
 *  invariant: values are moved byte-equivalently from
 * `gateRunner.ts`. No numeric/string change. Several constants and
 * type aliases that were previously module-private had to widen to
 * `export` so `gateRunner.ts` (and the later 266b/266c modules) can
 * import them across the new boundary. Visibility-only change; no
 * runtime effect.
 *
 * Cross-references:
 *   - Type aliases consumed by structural types live in `gateTypes.ts`
 *     (e.g. `BootstrapStatus` imports `InstallStrategy` from here).
 *   - The runtime orchestrator (`runGate`), the phase runner
 *     (`runPhasedGate`), and the bootstrap helpers stay in
 *     `gateRunner.ts` until Cards 266b/266c move them.
 */

export const GATE_TARGETS = ["typecheck", "build", "test", "dry_run"] as const;
export type GateTarget = typeof GATE_TARGETS[number];

export const GATE_COMMAND_ALLOWLIST: Record<GateTarget, string> = {
  typecheck: "npm run typecheck",
  build: "npm run build:web",
  test: "npm test",
  dry_run: "npx wrangler deploy --dry-run",
};

/**
 *  — per-target hard timebox in seconds for the actual
 * gate command (the npm / wrangler invocation that runs after
 * dependency bootstrap). Hard-coded; never composed from model
 * input. Wrapped via the GNU coreutils `timeout` builtin so a
 * stuck `tsc` / `vite build` returns exit 124 deterministically
 * instead of hanging the HTTP client.
 *
 * The values are generous enough that a real cold typecheck on
 * the AgentThursday root + tui + scripts projects can finish, while
 * still bounded so a wedged build can't dangle a /api/dev-shell
 * /gate request beyond ~5 minutes.
 *
 * 190d: typecheck no longer goes through this monolithic timeout;
 * see TYPECHECK_PHASES below for per-phase timeboxes. The
 * typecheck entry here remains as a (now informational) overall
 * cap; runGate still uses it as a safety net wrapping the whole
 * phase chain, but in practice each phase finishes faster.
 *
 * 193c / 195 follow-up: when target=typecheck or target=build and a
 * sandbox checkout is available, runGate routes to runPhasedGate and
 * the per-phase budgets in TYPECHECK_PHASES / BUILD_PHASES are the
 * *real* wallclock caps. The `typecheck:300` and `build:300` entries
 * here only govern the monolithic fallback path (no checkout /
 * non-phased targets). The aggregate `result.timeout_s` reported by
 * runPhasedGate is set to this umbrella value for legacy compatibility
 * but does NOT bound the phase-chain wallclock — see cards 193c / 195
 * QA for context. Reviewers comparing direct gate evidence against
 * this number should consult `result.phases[*].timeout_s` for the
 * binding budgets.
 */
export const GATE_COMMAND_TIMEOUT_S: Record<GateTarget, number> = {
  typecheck: 300,
  build: 300,
  test: 240,
  dry_run: 180,
};

/**
 *  — per-phase evidence for typecheck.
 *
 * `npm run typecheck` runs three independent `tsc --noEmit`
 * invocations (root / tui / scripts). Production showed the
 * monolithic command timing out at 300s without a way to tell
 * which phase was slow. The phase runner replaces the
 * monolithic invocation for typecheck, gives each phase its
 * own static timebox, and records every phase's evidence so
 * verifiers can pinpoint regressions.
 *
 * `skipped_due_to_previous_failure` is set when an earlier
 * phase failed/timed out — fail-fast is intentional so the
 * sandbox doesn't burn timeboxes on later phases that won't
 * change the verdict.
 */
//  — `web` is the scoped typecheck phase: `cd web && tsc --noEmit`.
// The fixed `TYPECHECK_PHASES` chain (diag/root/tui/scripts) covers
// src/**/tui/**/scripts/** via the root + per-project tsconfigs; web/**
// has its OWN tsconfig and is only type-checked by gate.build's
// `web_tsc` phase today. The scoped fast path (selectTypecheckPhases)
// adds a `web` phase so a web-only mutation gets a fast, relevant
// gate.typecheck instead of the slow full-repo `root` phase.
export type GateTypecheckPhase = "diag" | "root" | "tui" | "scripts" | "web";
//  — build gate phase breakdown. `npm run build:web` is two
// distinct steps under the hood (`tsc --noEmit && vite build` inside
// web/); splitting them into named phases lets verifiers tell whether
// a build failure was the type checker or the bundler.
export type GateBuildPhase = "web_tsc" | "web_vite";
export type GatePhase = GateTypecheckPhase | GateBuildPhase;

/**
 *  — fixed phase breakdown for `gate.typecheck`. Each
 * entry corresponds to one of the three `tsc --noEmit` invocations
 * inside `npm run typecheck`. Commands are static — never composed
 * from model input — and use the local `node_modules/.bin/tsc`
 * directly so we don't pay the npx-resolution cost on every call.
 *
 * Per-phase timeouts add up to less than the typecheck umbrella
 * (see GATE_COMMAND_TIMEOUT_S) so a single slow phase still
 * surfaces as a phase-level timed_out rather than the umbrella
 * killing the whole run.
 */
export const TYPECHECK_PHASES: ReadonlyArray<{
  phase: GateTypecheckPhase;
  command: string;
  timeout_s: number;
}> = [
  //  — root phase timebox 180→300s. Local cold tsc with 45
  // src + 262 .d.ts (skipLibCheck) is ~2.5s; production Cloudflare
  // sandbox stuck at ≥180s wallclock with 190i watchdog firing at
  // 195s. 190j production confirmed root completes at ~231s in 300s.
  //
  //  — root phase timebox 300→450s. Production cold sandbox
  // tsc has been creeping up across deploys: 190l verifier 252s,
  // 192 acceptance 274s, 193b verifier 300s+ TIMEOUT (Version
  // 2a318fee), 193c probe 300,898ms TIMEOUT (Version 2a318fee, same
  // worker, replicated). 450s gave ~50% headroom over observed
  // cold-sandbox runs (252–305s).
  //
  //  — root phase timebox 450→600s. 193c production rerun
  // (Version e8bbe42a) showed root duration_ms=465000 / exit 124 —
  // hit the 450s budget + 15s watchdog ceiling exactly, fail-fast
  // skipped tui/scripts. 193d investigation (see
  // 20260508112436--193d-investigation-findings.md) confirmed
  // workload split is dead (server.ts is a 428KB hub, any phase
  // containing it ≈ full work) and incremental cache is fragile
  // (cwd/path-depth mismatch between bake and runtime invalidates
  // tsbuildinfo). Per operator's call: data-driven bounded bump rather
  // than async / cache rewrite. 600s is +33% over the 450s ceiling
  // we just hit — same headroom-per-step shape as 190j (180→300,
  // +67%) and 193c (300→450, +50%) — and stays inside a single
  // qualitative "low-minutes" budget, not crossing into multi-
  // minute territory that would warrant async-job evidence shape.
  // tui/scripts unchanged: their cold prod evidence (88-99s tui,
  // 90-93s scripts) is well inside 300s; bumping them would be
  // policy churn, not data-driven.
  //
  // Worst-case wallclock with 600s root + 15s watchdog grace:
  //   - root timeout path:  ≤ 615s (fail-fast skips tui/scripts)
  //   - happy path estimate: 305s root + 100s tui + 95s scripts ≈ 500s
  //   - all-phase-timeout:  615 + 315 + 315 ≈ 1245s (extreme; any
  //                         earlier-phase failure stops the chain)
  // Bounded; auditable; no top-level umbrella.
  //
  // Why bounded and not just keep raising: each bump pays once for
  // the underlying cold-sandbox amplification; if root crosses 600s
  // in a future rerun that is the genuine fundamental signal and
  // the next move is async gate / phase evidence streaming
  // (193d §4), not 193e=600→750. The bump is bounded by the
  // qualitative threshold of "request still feels like a gate
  // call, not a background job," which we set at 10 minutes.
  //  — `diag` phase. Runs `tsc --noEmit --listFilesOnly`: tsc
  // resolves the program graph (config + includes + module resolution)
  // and prints every file that would be type-checked, then exits
  // WITHOUT running the binder / checker. Local baseline on cold
  // node_modules: 0:00.49 wall / 1.14s user / 194MB RSS / 389 files.
  //
  // Purpose: surface diagnostic evidence on production typecheck
  // timeouts.  was opened after production root phase hit
  // exit 124 / 600s on  Step 5 aggregate validation while local
  // root tsc finishes in 2.91s — i.e. it is a sandbox-side
  // amplification, not a local type-graph regression. operator's
  // directive: do NOT continue bumping the 600s root budget; instead
  // instrument so the next aggregate run produces a structured signal
  // about WHERE in the pipeline tsc is stuck.
  //
  // Three possible diag outcomes and their downstream signals:
  //
  //   1. diag PASS in <120s  → sandbox can enumerate the program graph
  //      fine; root timeout is in binder/checker work, not in module
  //      resolution. Next remediation: workload split / project
  //      references / async gate streaming (193d §4), not budget bump.
  //
  //   2. diag PASS but slow (>60s)  → sandbox FS / module resolution
  //      is itself the slow path. Workload split won't help much.
  //      Next remediation: sandbox materialization cache / faster
  //      module-resolution mode (e.g. `--moduleResolution bundler` is
  //      already on; consider `--types []` allowlist or `paths` prune).
  //
  //   3. diag TIMEOUT at 120s  → strong "sandbox materialization /
  //      filesystem is broken" signal; tsc can't even list the file
  //      set in two minutes. Next remediation is sandbox-side
  //      infrastructure (checkout strategy, FS layer), not typecheck
  //      workload at all.
  //
  // 120s budget rationale: 2x the advisor's initial 60s suggestion to
  // tolerate moderate sandbox amplification of the I/O-bound file
  // enumeration phase. Local is sub-second; if sandbox amplifies
  // enumeration by ~50x (less than the ~200x root tsc amplification
  // we observe, because enumeration is I/O-bound and root is CPU-bound),
  // diag finishes in ~25s and the 120s cap is comfortable headroom.
  // If we DO hit 120s, that itself is the actionable signal from
  // outcome (3) above.
  //
  // Fail-fast: per gatePhaseRunner the chain stops on any non-zero
  // exit, so a diag failure DOES skip root/tui/scripts. This is
  // intentional — if tsc can't enumerate files, running the same tsc
  // with full type-checking will not somehow recover.
  { phase: "diag", command: "./node_modules/.bin/tsc --noEmit --listFilesOnly", timeout_s: 120 },
  { phase: "root", command: "./node_modules/.bin/tsc --noEmit", timeout_s: 600 },
  //  — tui phase timebox 90→300s. Local cold tsc with
  // tui/tsconfig.json scans 323 files (3 src + React + ink + Node
  // types) and runs ~0.95s warm; production timed out at 90s
  // (`duration_ms=91199`, raw exec exit 124, watchdog NOT fired —
  // SDK returned cleanly). The root phase showed ~90–100x sandbox
  // slowdown (2.5s → 231s); applying the same ratio to tui's
  // 0.95s baseline puts the realistic prod runtime at ~85–100s,
  // marginal against the 90s cap. 300s matches the root precedent
  // and keeps the policy uniform across phases. If tui still
  // timeouts at 300s in production, that's a strong "workload
  // optimization required" signal (open 190l/190m).
  { phase: "tui", command: "./node_modules/.bin/tsc --noEmit -p tui/tsconfig.json", timeout_s: 300 },
  //  — scripts phase timebox 90→300s. 190k production rerun
  // (trace `-prod-1778198009-gate1`, Version ID
  // `8e5ee0b9-605a-4a24-aa80-99cf80135fca`) advanced past root
  // (134221ms PASS) and tui (90401ms PASS) but scripts timed out at
  // 90s (`duration_ms=90694`, raw exec exit 124, watchdog NOT fired).
  // Same signature as 190j root and 190k tui — sandbox cold-tsc
  // amplification, not a config defect. Bumping to 300s mirrors the
  // existing root/tui precedent so the policy is uniform across all
  // three phases and the umbrella `GATE_COMMAND_TIMEOUT_S.typecheck`.
  // 190i watchdog grace stays 15s → worst-case scripts wallclock 315s.
  // If scripts still timeouts at 300s in production, that's a strong
  // ">300s fundamental" signal and the next step is workload
  // optimization (incremental tsc / project references / swc),
  // tracked as a separate sub-plan, not this card.
  { phase: "scripts", command: "./node_modules/.bin/tsc --noEmit -p scripts/tsconfig.json", timeout_s: 300 },
];

/**
 *  — the `web` typecheck phase. Same command + timebox as
 * gate.build's `web_tsc` phase (which already proves the prewarm /
 * bootstrap path for `web/node_modules`); the inner command must run
 * from inside web/ because web has its own tsconfig (see BUILD_PHASES
 * doc for the `bash -c 'cd web && …'` wrapping rationale). Only used
 * by the scoped fast path — never part of the default
 * `TYPECHECK_PHASES` chain, so a full / fallback run is byte-for-byte
 * the pre-380b behavior.
 */
export const TYPECHECK_WEB_PHASE: {
  phase: GateTypecheckPhase;
  command: string;
  timeout_s: number;
} = { phase: "web", command: "bash -c 'cd web && ./node_modules/.bin/tsc --noEmit'", timeout_s: 450 };

/**
 *  — coarse scope of a single changed path, used to pick which
 * typecheck phases are relevant after a repo mutation.
 *
 *   web     → web/**                      → `web` phase
 *   tui     → tui/**                      → `tui` phase
 *   scripts → scripts/**                  → `scripts` phase
 *   src     → src/** + worker-configuration.d.ts → `diag` + `root` phases
 *   shared  → anything else (root tsconfig*.json, package.json,
 *             lockfiles, top-level config, unrecognized paths)
 *             → conservative FULL run (no scoping)
 */
export type TypecheckScope = "web" | "tui" | "scripts" | "src" | "shared";

export function classifyTypecheckPath(path: string): TypecheckScope {
  const p = path.replace(/^\.\//, "").trim();
  if (p.startsWith("web/")) return "web";
  if (p.startsWith("tui/")) return "tui";
  if (p.startsWith("scripts/")) return "scripts";
  if (p.startsWith("src/") || p === "worker-configuration.d.ts") return "src";
  // tsconfig.json / tsconfig.test.json / package.json / *.lock / any
  // top-level or unrecognized path could affect multiple projects —
  // fall back to a full run rather than risk a misleading scoped PASS.
  return "shared";
}

export interface TypecheckPhaseSelection {
  /** Phases to actually run, in chain order. */
  phases: ReadonlyArray<{ phase: GateTypecheckPhase; command: string; timeout_s: number }>;
  /** Phases deliberately skipped by the scoped fast path. */
  skipped: ReadonlyArray<{ phase: GateTypecheckPhase; reason: string }>;
  /** Distinct scopes detected from the changed paths. */
  scopes: TypecheckScope[];
  /** false → full / fallback run (no scoping applied). */
  scoped: boolean;
  /** node_modules subdirs the selected phases need prewarmed ("" = root). */
  depSubdirs: string[];
}

/**
 *  — pure phase selection for `gate.typecheck`. Given the
 * worktree's changed paths (e.g. from `git status --porcelain` after
 * the agent's uncommitted repo.write/repo.patch), return the relevant
 * subset of phases plus an auditable record of what was skipped and
 * why. Falls back to the full `TYPECHECK_PHASES` chain (no `web`) when
 * a `shared`/unrecognized path is touched or no change is detected —
 * the scoped path must never masquerade as a full-repo PASS.
 *
 * Invariant: `diag` only enumerates the root (src) program graph, so it
 * is selected together with `root` and skipped together with it.
 */
export function selectTypecheckPhases(changedPaths: string[]): TypecheckPhaseSelection {
  const FULL = TYPECHECK_PHASES;
  const fallback = (scopes: TypecheckScope[]): TypecheckPhaseSelection => ({
    phases: FULL,
    skipped: [],
    scopes,
    scoped: false,
    // FULL = diag/root/tui/scripts → all root-bin/tsc; "" subdir only.
    depSubdirs: [""],
  });

  const paths = changedPaths.map(p => p.trim()).filter(p => p.length > 0);
  if (paths.length === 0) return fallback([]);

  const scopeSet = new Set<TypecheckScope>(paths.map(classifyTypecheckPath));
  if (scopeSet.has("shared")) return fallback([...scopeSet]);

  const byName = new Map(FULL.map(p => [p.phase, p] as const));
  const diag = byName.get("diag")!;
  const root = byName.get("root")!;
  const tui = byName.get("tui")!;
  const scripts = byName.get("scripts")!;

  const selected: Array<{ phase: GateTypecheckPhase; command: string; timeout_s: number }> = [];
  const depSubdirs = new Set<string>();
  if (scopeSet.has("src")) { selected.push(diag, root); depSubdirs.add(""); }
  if (scopeSet.has("tui")) { selected.push(tui); depSubdirs.add(""); }
  if (scopeSet.has("scripts")) { selected.push(scripts); depSubdirs.add(""); }
  //  — web/tsconfig compiles ../src/** whose imports (zod)
  // resolve from the ROOT node_modules; without the root prewarm the
  // scoped web run fails with a TS2307 'zod' cascade on a clean tree
  // (381 attempt #4, task-e20784d8).
  if (scopeSet.has("web")) { selected.push(TYPECHECK_WEB_PHASE); depSubdirs.add("web"); depSubdirs.add(""); }

  const selectedNames = new Set(selected.map(p => p.phase));
  const skipped = FULL
    .filter(p => !selectedNames.has(p.phase))
    .map(p => ({ phase: p.phase, reason: "scoped_fast_path" as const }));

  return {
    phases: selected,
    skipped,
    scopes: [...scopeSet],
    scoped: true,
    depSubdirs: [...depSubdirs],
  };
}

/**
 *  — fixed phase breakdown for `gate.build`.
 *  — data-driven bounded bump for web_tsc 300 → 450 after
 * the first production smoke showed an exact-budget timeout.
 *
 * `npm run build:web` resolves to `npm --prefix web run build`, which
 * runs `tsc --noEmit && vite build` from inside web/. 192 production
 * smoke saw the monolithic 300s umbrella expire at duration_ms=303299
 * with no phase evidence — a bounded fail, but indistinguishable
 * between "type check is the slow part" and "vite bundling is the slow
 * part". Splitting the script into two named phases gives verifiers
 * exactly that signal:
 *
 *   web_tsc  — the `tsc --noEmit` half. Cold sandbox web tsc has a
 *              smaller scope than root tsc (React + Tailwind + router
 *              + a handful of components vs the full server), but
 *              skipLibCheck still applies.
 *
 *              195 production smoke (Version 56055eb0) measured
 *              `web_tsc duration_ms=301608` at `timeout_s=300` —
 *              exact-budget kill, indistinguishable from "would have
 *              finished at 305s" vs "would have run another minute".
 *              No completed data point yet, so 195a applies the
 *              193c-shape +50% bounded bump to 450s. Headroom-per-step
 *              precedent: 190j +67% / 193c +50% / 193d +29%.
 *
 *              195a contract (operator 5-08, Discord 100000000000000008):
 *              if 450s still times out, do NOT bump web_tsc again —
 *              switch surface to web tsconfig / workload split (e.g.
 *              project references, exclude tests, narrower include).
 *              The next remediation is workload reduction, not budget.
 *
 *   web_vite — the `vite build` half. Local warm build is ~1.3-1.6s;
 *              cold sandbox amplification has not been measured for
 *              vite specifically. Even allowing for module-resolution
 *              scan + asset pipeline, 300s is generous. 195 production
 *              smoke could not measure vite — web_tsc fail-fast
 *              skipped it. 195a deliberately keeps `web_vite` at 300s
 *              until web_tsc PASSes; only then can a real vite data
 *              point distinguish "vite needs budget" from "vite is
 *              fine". If web_vite times out on a future rerun where
 *              web_tsc PASSed, that is strong "vite-specific" signal
 *              (bundler config / asset pipeline bottleneck), not a
 *              marginal-budget signal — different remediation surface,
 *              future .
 *
 * Each phase wraps the actual binary directly via the web subdir
 * `node_modules/.bin` (prewarmed via 190g GATE_DEP_REQUIREMENTS.build
 * since 190g already lists `web` with `.bin/tsc + .bin/vite` markers).
 * 190h SessionTerminated regex / 190i watchdog apply unchanged via
 * the shared phased runner.
 *
 * Worst-case wallclock (PHASE_AWAIT_GRACE_S = 15s):
 *   web_tsc + grace        ≤ 465s    (450 + 15;        was 315 pre-195a)
 *   web_vite + grace       ≤ 315s    (300 + 15;        unchanged 195a)
 *   chain (all timeout)    ≤ 780s    (~13min;          was 630 pre-195a)
 *   chain (happy path)      ~330-380s (web_tsc 280-330s + vite ~50s)
 *   chain (web_tsc TO)     ≤ 465s    (fail-fast skips web_vite)
 *
 * Bounded; still well under the typecheck-chain worst case of 1245s
 * and inside the "low-minutes" qualitative envelope. If 195a smoke
 * measures web_tsc completing well under 450s but vite still hidden,
 * a 195b card may follow to either tighten web_tsc back down or
 * tackle vite if its own production data point emerges.
 */
export const BUILD_PHASES: ReadonlyArray<{
  phase: GateBuildPhase;
  command: string;
  timeout_s: number;
}> = [
  // The phase commands are eventually wrapped as
  //   cd ${baseDir} && timeout ${S} ${command}
  // by runPhasedGate. We need the inner command to execute *inside*
  // web/ because tsc's tsconfig.json and vite's tailwind content-glob
  // resolution both rely on the cwd being web/. A `(cd web && …)`
  // group fails because `timeout S (...)` is not valid bash syntax —
  // verified locally: `bash: syntax error near unexpected token '('`.
  // `bash -c '...'` keeps the inner command as a simple positional
  // argument to timeout and gives us a real shell to run the cd+exec
  // chain in. The vite invocation must run from web/ — `vite build
  // web` from repo root succeeds with exit 0 but produces a 4.94 kB
  // CSS bundle vs the correct 29.55 kB; tailwind content globs in
  // web/tailwind.config don't resolve when vite is run from outside
  // web/.
  {
    phase: "web_tsc",
    command: "bash -c 'cd web && ./node_modules/.bin/tsc --noEmit'",
    // 195a: 300 → 450 after exact-budget timeout (301608ms). See
    // BUILD_PHASES doc above for headroom rationale and the
    // "no further bump" contract.
    timeout_s: 450,
  },
  {
    phase: "web_vite",
    command: "bash -c 'cd web && ./node_modules/.bin/vite build'",
    timeout_s: 300,
  },
];

/**
 *  — JS-side await watchdog grace.
 *
 * Each phase's `await exec(wrapped)` is raced against a setTimeout
 * fired at `cfg.timeout_s + PHASE_AWAIT_GRACE_S` so a non-returning
 * sandbox SDK call can still produce bounded phase timeout
 * evidence. The grace gives GNU `timeout` inside the sandbox first
 * crack at exiting cleanly (the desired path); the watchdog only
 * wins when the SDK itself fails to surface the shell's exit.
 *
 * 15s is large enough to absorb normal shell teardown jitter but
 * small enough to keep worst-case wallclock bounded:
 *   - per-phase cap = cfg.timeout_s + 15s
 *     (root 195s / tui 105s / scripts 105s)
 *   - fail-fast: any phase failure (including a watchdog fire)
 *     skips subsequent phases, so one stuck phase caps total at
 *     ~195s; an all-pass-but-last-stalls scenario would be the
 *     longest path (~375s), but that means earlier phases ran
 *     clean, so the wallclock reflects real work, not a stuck SDK.
 */
export const PHASE_AWAIT_GRACE_S = 15;

export const TOOL_ID_BY_TARGET: Record<GateTarget, string> = {
  typecheck: "gate.typecheck",
  build: "gate.build",
  test: "gate.test",
  dry_run: "gate.dry_run",
};

export const STDOUT_CAP = 32 * 1024;
export const STDERR_CAP = 16 * 1024;

/**
 *  — sandbox dependency prewarm. The Cloudflare sandbox
 * image bakes `/opt/agentthursday/prewarm-{root,web}/node_modules` from the
 * repo's static `package.json` files at image build time so a fresh
 * checkout doesn't have to pay the cold `npm install` cost on the
 * request critical path.
 *
 * The prewarm step runs once per dep-requirement subdir BEFORE the
 * marker probe / bootstrap install: it symlinks the prewarmed dir
 * into the checkout (`<baseDir>/<subdir>/node_modules` →
 * `/opt/agentthursday/prewarm-{stem}/node_modules`). The existing 190a marker
 * probe uses `[ -e ... ]` which follows symlinks, so when the link
 * lands the probe finds the binaries, bootstrap returns `skipped`,
 * and execution proceeds straight to the phase runner.
 *
 * Status semantics:
 *   - `linked`             — prewarm dir present in image and target
 *                             didn't exist before; symlink created.
 *   - `already_present`    — `<baseDir>/<subdir>/node_modules` already
 *                             exists (e.g. a previous gate run, or a
 *                             warm checkout). No-op.
 *   - `missing_in_image`   — prewarm dir not baked into image (e.g.
 *                             an older image, or local dev). Falls
 *                             through to 190f bounded install path.
 *   - `failed`             — shell error / unexpected output. Same
 *                             fallback as `missing_in_image`.
 *
 * Subdir → prewarm dir is a static map (no model input). New subdirs
 * (e.g. additional workspace packages) require an explicit
 * Dockerfile + map update.
 */
export const PREWARM_DIRS_BY_SUBDIR: Record<string, string> = {
  "": "/opt/agentthursday/prewarm-root",
  web: "/opt/agentthursday/prewarm-web",
};

/**
 * 190 / 190a: per-target dependency requirements. Each entry is a
 * subdir (relative to repoBaseDir; "" for repo root) plus a list of
 * marker paths (`node_modules/.bin/...`) that MUST exist for the
 * gate command to actually find what it needs. 190's first cut only
 * checked "is node_modules non-empty"; production showed that an
 * incomplete install can leave node_modules with some files but
 * missing `.bin/tsc`, and the gate would re-fail with
 * `tsc: not found` while the probe said `skipped`.
 *
 * Markers are relative paths under `<subdir>/node_modules/`. The
 * probe AND-checks all listed markers; any missing marker forces a
 * fresh install. New gate targets must list the executable they
 * actually invoke.
 *
 * Strict allowlist: there is no input from the model. Only the four
 * fixed gate targets have entries; non-allowlisted strings never
 * reach this map (the dispatcher rejects them upstream).
 */
export const GATE_DEP_REQUIREMENTS: Record<
  GateTarget,
  ReadonlyArray<{ subdir: string; markers: readonly string[] }>
> = {
  // typecheck runs `tsc --noEmit && tsc -p tui && tsc -p scripts`;
  // all three need root node_modules/.bin/tsc.
  typecheck: [{ subdir: "", markers: [".bin/tsc"] }],
  // build:web runs `npm --prefix web run build`, which under the
  // hood does `tsc --noEmit && vite build` from inside web/. Root
  // bin/tsc is also needed because the project's typecheck script
  // composes root + tui + scripts; we keep the root requirement
  // here so a partial-install caught by 190a re-installs root too.
  build: [
    { subdir: "", markers: [".bin/tsc"] },
    { subdir: "web", markers: [".bin/tsc", ".bin/vite"] },
  ],
  // npm test is allowlisted but no test runner ships yet — we still
  // want root node_modules so npm itself can resolve scripts; bin/
  // tsc is the strictest available marker today.
  test: [{ subdir: "", markers: [".bin/tsc"] }],
  // dry_run runs `npx wrangler deploy --dry-run`. wrangler ships in
  // root devDependencies so node_modules/.bin/wrangler is the right
  // canary.
  dry_run: [{ subdir: "", markers: [".bin/wrangler"] }],
};

/**
 *  / 190e / 190f — install commands tuned for the
 * non-interactive sandbox.
 *
 *   --include=dev      both ci and install: ensure devDependencies
 *                      land so .bin/tsc / vite / wrangler appear
 *                      (npm ci defaults to production-only; npm
 *                      install also respects NODE_ENV in some
 *                      sandbox profiles, so we set it explicitly).
 *   --no-audit         skip the audit network round-trip
 *   --no-fund          skip the funding banner
 *   --no-progress      quieter logs (less buffer pressure)
 *   --loglevel=error   keep stderr focused on real failures
 *
 * 190e: when the subdir has a `package-lock.json` we prefer
 * `npm ci`. It's deterministic and skips dependency resolution.
 *
 * 190f: when the subdir has NO tracked lockfile (the AgentThursday
 * repo's  manifest denylists `package-lock.json` so production
 * checkouts never have one), use `npm install` with
 * `--no-package-lock` so npm doesn't waste time generating /
 * writing a lockfile. This matches the clean-deploy workflow that
 * has already shown to be fast and means we never accidentally
 * bake a lockfile into the sandbox checkout either.
 */
export type InstallStrategy = "npm-ci" | "npm-install";

export const BOOTSTRAP_INSTALL_CMD_BY_STRATEGY: Record<InstallStrategy, string> = {
  "npm-ci": "npm ci --include=dev --no-audit --no-fund --no-progress --loglevel=error",
  "npm-install":
    "npm install --include=dev --no-package-lock --no-audit --no-fund --no-progress --loglevel=error",
};

/**
 *  / 190e — bootstrap install hard timebox in seconds.
 * Production showed `npm install` could spend the entire 240s
 * resolving dependencies; `npm ci` skips resolution but the cold
 * download alone can still cost ~3 minutes. We bump the cap a
 * notch to give a deterministic ci a real chance to finish while
 * still bounded so a wedged install returns a structured
 * `bootstrap_failed` event before the HTTP client gives up.
 *
 * Hard-coded — never composed from model input. Apply with the
 * `timeout` shell builtin so a non-zero exit code distinguishes
 * "timed out" (124) from "install failed" (anything else).
 */
export const BOOTSTRAP_INSTALL_TIMEOUT_S = 300;
