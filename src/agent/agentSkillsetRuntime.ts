//  —  AgentProfile.skillset runtime resolution.
//
// Pure helper that turns the per-profile `AgentProfile.skillset`
// selection into the effective set of skillset ids whose tools the
// agent's dynamic tool surface is allowed to expose for that
// session/run.
//
// Architectural notes (do not delete — these constraints are why this
// module is pure / strict / closed):
//
//   * Closed registry. The only inputs are: the selected skillset id,
//     the current `LoaderState`, the embedded manifest map (for
//     `dependencies`), and the operator-disabled set. No env reads,
//     no I/O, no logging — the caller owns event emission.
//
//   * Strict fallback. Unknown, rejected, or disabled selection
//     returns an empty `effectiveIds` plus a structured `reason`. We
//     deliberately do NOT silently broaden to "all loaded" the way
//      falls back from a missing model to Kimi: a model
//     fallback is still dispatchable, but a skillset fallback would
//     silently widen the callable tool surface — which is exactly
//     what §Acceptance of  forbids ("the selected skillset
//     **controls** the runtime dynamic tool palette").
//
//   * Operator-disable wins. If the selected skillset or any of its
//     dependencies is operator-disabled (`skillset_disabled` SQL row,
//     ), the resolver intersects only with `loaded`, never
//     with `loaded ∪ disabled`. This preserves the
//     invariant that operator disable hides tools regardless of any
//     per-profile selection.
//
//   * Unknown dependency ids are dropped silently. Embedded manifests
//     may declare dependencies that are not themselves shipped (e.g.
//     `software-dev` declares `observability` / `communication`,
//     neither of which is in `EMBEDDED_MANIFESTS` today). The loader
//     does not error on this (see `checkV4DependencyCycle` — unknown
//     ids end the DFS branch without erroring). We mirror that
//     behavior: a missing dep cannot contribute callable tools
//     anyway, so dropping it from the effective set is honest.
//
//   * No load-time side effects. This module is imported wherever
//     `composePersonaContext` (server.ts) and `GET /api/agent-profiles/:id`
//     (agentProfileRoutes.ts) live. Both must be safe to import in the
//     registry DO where no profile has been selected.

import type { LoaderState, SkillsetManifest } from "../skillset/types";

export type EffectiveSkillsetStatus =
  | "ok"
  | "unknown_skillset"
  | "rejected_skillset"
  | "disabled_skillset"
  | "empty_selection";

export interface EffectiveSkillsetResult {
  /** Result kind. `"ok"` only when `effectiveIds.length >= 1`. */
  status: EffectiveSkillsetStatus;
  /**
   * Closure of the selected skillset + its loaded, not-disabled
   * dependency ids. Empty when `status !== "ok"`. The list is sorted
   * so the event_log / UI evidence is stable across runs.
   */
  effectiveIds: string[];
  /**
   * One-line machine-readable reason matching `status`. Always
   * present so consumers (event payload, route response, UI row) can
   * branch on it without re-classifying.
   */
  reason: string | null;
}

export interface ResolveEffectiveSkillsetArgs {
  /** `AgentProfile.skillset` — the user-selected id (or null/undefined for fresh DO). */
  profileSkillset: string | null | undefined;
  /** Loader-accepted entries (status === "loaded" | "load_rejected"). */
  state: LoaderState;
  /**
   * Embedded manifest lookup. Built from `EMBEDDED_MANIFESTS` by the
   * caller — passed in (rather than imported here) so the resolver
   * stays test-isolatable without spinning up the loader pipeline.
   */
  manifestsById: ReadonlyMap<string, SkillsetManifest>;
  /**
   * Operator-disabled set, keyed by skillset id. The values matter
   * only to operator surfaces; the resolver consumes only `.has()`.
   */
  disabledMap: ReadonlyMap<string, unknown>;
}

/**
 * Compute the effective skillset closure for a per-profile selection.
 *
 * Returns:
 *   - `{ status: "empty_selection", effectiveIds: [], reason: "no_selection" }`
 *     when no skillset is selected (registry DO, fresh profile not yet
 *     wired).
 *   - `{ status: "unknown_skillset", effectiveIds: [], reason: "not_in_manifest_registry" }`
 *     when the selection is not in `manifestsById`.
 *   - `{ status: "rejected_skillset", effectiveIds: [], reason: "load_rejected" }`
 *     when the selection exists in the manifest map but its loader
 *     entry is `load_rejected`.
 *   - `{ status: "disabled_skillset", effectiveIds: [], reason: "operator_disabled" }`
 *     when the selection is in `disabledMap`. Operator disable wins
 *     over any selection.
 *   - `{ status: "ok", effectiveIds, reason: null }` otherwise.
 *     `effectiveIds` is the DFS closure of `profileSkillset` over
 *     `manifest.dependencies`, intersected with the currently
 *     `loaded ∧ ¬disabled` set, and sorted.
 *
 * Dependency closure rules:
 *   - Cycles are tolerated (DFS visited-set) — they cannot increase
 *     the effective set, only loop forever without one.
 *   - Unknown dep ids are dropped silently (see module header).
 *   - Operator-disabled deps are dropped silently — a dep being
 *     disabled does NOT make the whole selection a `disabled_skillset`
 *     result; only the directly selected skillset can do that. The
 *     consumer can still see which deps survived via `effectiveIds`.
 */
export function resolveEffectiveSkillset(
  args: ResolveEffectiveSkillsetArgs,
): EffectiveSkillsetResult {
  const { profileSkillset, state, manifestsById, disabledMap } = args;

  if (typeof profileSkillset !== "string" || profileSkillset.length === 0) {
    return { status: "empty_selection", effectiveIds: [], reason: "no_selection" };
  }
  if (!manifestsById.has(profileSkillset)) {
    return { status: "unknown_skillset", effectiveIds: [], reason: "not_in_manifest_registry" };
  }
  const selectedEntry = state.entries[profileSkillset];
  if (!selectedEntry || selectedEntry.status !== "loaded") {
    return { status: "rejected_skillset", effectiveIds: [], reason: "load_rejected" };
  }
  if (disabledMap.has(profileSkillset)) {
    return { status: "disabled_skillset", effectiveIds: [], reason: "operator_disabled" };
  }

  // DFS dependency closure. `visited` doubles as cycle guard and
  // dedup. We only add a node to `effective` when it is loaded and
  // not disabled — unknown / rejected / disabled deps are silently
  // dropped (see module header).
  const visited = new Set<string>();
  const effective = new Set<string>();
  const stack: string[] = [profileSkillset];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const entry = state.entries[id];
    const loaded = entry !== undefined && entry.status === "loaded";
    const disabled = disabledMap.has(id);
    if (loaded && !disabled) {
      effective.add(id);
    }
    const manifest = manifestsById.get(id);
    if (manifest && Array.isArray(manifest.dependencies)) {
      for (const dep of manifest.dependencies) {
        if (typeof dep === "string" && dep.length > 0 && !visited.has(dep)) {
          stack.push(dep);
        }
      }
    }
  }

  return {
    status: "ok",
    effectiveIds: [...effective].sort(),
    reason: null,
  };
}
