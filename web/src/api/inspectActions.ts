import { postJson } from "./client";

/**
 * an earlier revision RecoverActions endpoints. `clearStaleState` was an earlier revision §B-7 explicit;
 * `forceContinue` reuses /cli/continue with a different label so the inspect UI
 * makes "advance the loop manually" discoverable from the debug surface.
 */

export function clearStaleState() {
  return postJson("/cli/clear-stale-state");
}

export function forceContinue() {
  return postJson("/cli/continue");
}
