import { postJson } from "./client";

/**
 * Card 81 RecoverActions endpoints. `clearStaleState` was Card 81 §B-7 explicit;
 * `forceContinue` reuses /cli/continue with a different label so the inspect UI
 * makes "advance the loop manually" discoverable from the debug surface.
 */

export function clearStaleState() {
  return postJson("/cli/clear-stale-state");
}

export function forceContinue() {
  return postJson("/cli/continue");
}
