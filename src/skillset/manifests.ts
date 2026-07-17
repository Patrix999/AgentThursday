/**
 * Embedded skillset manifests — thin facade over the YAML codegen.
 *
 * an earlier revision `docs/skillsets/*.yaml` is the canonical source of
 * truth (ADR 2026-05-07 IM-1). The build-time codegen
 * (`scripts/generate-skillset-manifests.ts`) reads those YAMLs and
 * emits `src/skillset/generatedManifests.ts`, which this module
 * re-exports as `EMBEDDED_MANIFESTS`.
 *
 * This is **build / deploy reload**, not production hot reload. To
 * propagate a YAML edit, run `npm run skillset:generate` and redeploy
 * the Worker. `npm run skillset:check` fails the build if the
 * generated file drifts from the YAML inputs.
 */

import type { SkillsetManifest } from "./types";

export interface EmbeddedManifest {
  id: string;
  source_yaml: string;
  manifest: SkillsetManifest;
}

export { EMBEDDED_MANIFESTS } from "./generatedManifests";
