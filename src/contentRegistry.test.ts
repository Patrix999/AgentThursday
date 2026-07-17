import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HARDCODED_REGISTRY,
  isOperatorInternalSource,
  listSources,
} from "./contentRegistry";

// the operator-internal gate. The private AgentThursday repo source must
// be classified operator-internal (so a scoped user-owned agent is refused),
// while the harmless local fixture stays open to every tenant.

test("agentthursday-github (private repo) is operator-internal", () => {
  const ghub = HARDCODED_REGISTRY.find(s => s.id === "agentthursday-github") ?? null;
  assert.ok(ghub, "agentthursday-github source must exist in the registry");
  assert.equal(ghub!.scope, "project");
  assert.equal(isOperatorInternalSource(ghub), true);
});

test("agentthursday-local-fixture is NOT operator-internal (open to all tenants)", () => {
  const fixture = HARDCODED_REGISTRY.find(s => s.id === "agentthursday-local-fixture") ?? null;
  assert.ok(fixture, "agentthursday-local-fixture source must exist in the registry");
  assert.notEqual(fixture!.scope, "project");
  assert.equal(isOperatorInternalSource(fixture), false);
});

test("isOperatorInternalSource is leak-safe for missing sources", () => {
  // A null/undefined source (unknown sourceId → findSource returned null) must
  // NOT be treated as operator-internal; the downstream source-not-found path
  // handles it. The gate only fires on a real `scope:"project"` source.
  assert.equal(isOperatorInternalSource(null), false);
  assert.equal(isOperatorInternalSource(undefined), false);
});

test("every registry source carries an explicit scope (no accidental open repo)", () => {
  // Defense against a future source being added without a scope: an absent
  // scope would make isOperatorInternalSource return false (open), so the
  // contract is that operator-internal repos MUST set scope:"project".
  for (const s of HARDCODED_REGISTRY) {
    assert.equal(typeof s.scope, "string", `${s.id} must declare a scope`);
  }
});

test("listSources still surfaces both registry sources (gate is caller-side, not registry-side)", () => {
  // The registry itself is unfiltered; ContentHub.getSources applies the
  // per-caller operator gate. Keeps the registry a pure data source.
  const ids = listSources({ includeHealth: false }).sources.map(s => s.source.id).sort();
  assert.deepEqual(ids, ["agentthursday-github", "agentthursday-local-fixture"]);
});
