import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  validateAgentProfileInput,
  type SkillsetRegistryStub,
} from "./agentProfileValidation";
import { listAgentRuntimeModelOptions } from "./agentModelRuntime";
import { EMBEDDED_MANIFESTS } from "../skillset/manifests";

/**
 *  — shared agent-profile validation unit tests.
 *
 * `validateAgentProfileInput` is what both `/api/agent-profiles`
 * (create) and `/api/manager/*` (create + update) go through. If this
 * drifts, the manager surface and the legacy UI surface stop agreeing
 * on what counts as a runnable model or known skillset.
 */

const emptyStub: SkillsetRegistryStub = {
  async listCustomSkillsets() {
    return [];
  },
};

const runnableModelId = (() => {
  const m = listAgentRuntimeModelOptions().find((opt) => opt.runtimeStatus === "available");
  return m ? m.id : null;
})();
const unsupportedModelId = (() => {
  const m = listAgentRuntimeModelOptions().find((opt) => opt.runtimeStatus !== "available");
  return m ? m.id : null;
})();
const embeddedSkillsetId = EMBEDDED_MANIFESTS[0]?.id ?? "manager";

describe("validateAgentProfileInput — model gate", () => {
  it("rejects an unknown model", async () => {
    const r = await validateAgentProfileInput(
      { model: "definitely.not.real", skillset: embeddedSkillsetId },
      emptyStub,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "unknown_model");
  });

  it("rejects an unrunnable known model", { skip: unsupportedModelId === null }, async () => {
    assert.ok(unsupportedModelId !== null);
    const r = await validateAgentProfileInput(
      { model: unsupportedModelId, skillset: embeddedSkillsetId },
      emptyStub,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "unsupported_model");
  });

  it("accepts a runnable model + embedded skillset", { skip: runnableModelId === null }, async () => {
    assert.ok(runnableModelId !== null);
    const r = await validateAgentProfileInput(
      { model: runnableModelId, skillset: embeddedSkillsetId },
      emptyStub,
    );
    assert.equal(r.ok, true);
  });
});

describe("validateAgentProfileInput — skillset gate", () => {
  it("rejects a skillset id outside embedded ∪ custom", { skip: runnableModelId === null }, async () => {
    assert.ok(runnableModelId !== null);
    const r = await validateAgentProfileInput(
      { model: runnableModelId, skillset: "no.such.skillset" },
      emptyStub,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "unknown_skillset");
  });

  it("accepts a custom skillset id present on the stub", { skip: runnableModelId === null }, async () => {
    assert.ok(runnableModelId !== null);
    const stub: SkillsetRegistryStub = {
      async listCustomSkillsets() {
        return [
          {
            id: "custom.test",
            name: "Custom",
            description: "",
            version: "0.1.0",
            source_yaml: "",
            manifest_json: JSON.stringify({
              id: "custom.test",
              name: "Custom",
              description: "",
              version: "0.1.0",
              purpose: "",
              tools: [],
              skills: [],
              workflow_patterns: [],
              reasoning_protocol: { principles: [] },
              evidence_protocol: {},
              safety_policy: { policy_version: "0.0.0" },
              observability: {},
              policy: { surface_modes: ["enable"], default_tier_cap: 3 },
            }),
            created_at: "2026-05-24T00:00:00Z",
            updated_at: "2026-05-24T00:00:00Z",
          },
        ];
      },
    };
    const r = await validateAgentProfileInput(
      { model: runnableModelId, skillset: "custom.test" },
      stub,
    );
    assert.equal(r.ok, true);
  });

  it("falls back to embedded-only when listCustomSkillsets throws", { skip: runnableModelId === null }, async () => {
    assert.ok(runnableModelId !== null);
    const stub: SkillsetRegistryStub = {
      async listCustomSkillsets() {
        throw new Error("RPC binding offline");
      },
    };
    const r = await validateAgentProfileInput(
      { model: runnableModelId, skillset: embeddedSkillsetId },
      stub,
    );
    assert.equal(r.ok, true);
  });
});
