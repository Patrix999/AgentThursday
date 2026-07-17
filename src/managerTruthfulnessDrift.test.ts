/**
 * Manager truthfulness drift fail-soft tests.
 *
 * Two layers:
 *   1. Pure helper (`computeManagerTruthfulnessDrift`) — assert drift
 *      detection, no-drift positive, extra-observed symmetry, and that
 *      a claim of a non-watched tool stays out of scope.
 *   2. Adapter-coverage guard — globs `src/skillset/adapters/manager*.ts`,
 *      extracts every registered `tool_id`, and asserts each is in
 *      `MANAGER_TIER_WATCHED_TOOL_NAMES`. This is the per-spec failure
 *      hook: anyone adding a manager.* adapter without extending the
 *      watched list trips this test.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  MANAGER_TIER_WATCHED_TOOL_NAMES,
  computeManagerTruthfulnessDrift,
} from "./toolTruthfulness";

describe("computeManagerTruthfulnessDrift — manager-tier drift detection", () => {
  it("flags claimed-but-not-observed as missing_claims (drift)", () => {
    const reply =
      "I called `manager.skillset_create` to spin up the new skillset and " +
      "the manager.agent_list result showed two agents.";
    const observed = new Set(["manager.agent_list"]);
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      observed,
    );
    assert.equal(out.has_drift, true);
    assert.deepEqual(out.missing_claims, ["manager.skillset_create"]);
    assert.deepEqual(out.claimed_tool_ids, [
      "manager.agent_list",
      "manager.skillset_create",
    ]);
    assert.deepEqual(out.observed_tool_ids, ["manager.agent_list"]);
    assert.deepEqual(out.extra_observed, []);
  });

  it("no drift when every claim has a matching dispatch", () => {
    const reply =
      "I called manager.agent_list and then dispatched manager.agent_message " +
      "to agent-alpha.";
    const observed = new Set([
      "manager.agent_list",
      "manager.agent_message",
    ]);
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      observed,
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.missing_claims, []);
    assert.deepEqual(out.claimed_tool_ids, [
      "manager.agent_list",
      "manager.agent_message",
    ]);
    assert.deepEqual(out.observed_tool_ids, [
      "manager.agent_list",
      "manager.agent_message",
    ]);
    assert.deepEqual(out.extra_observed, []);
  });

  it("dispatched-but-not-claimed surfaces as extra_observed (not drift)", () => {
    const reply = "I called manager.agent_list to enumerate the team.";
    const observed = new Set([
      "manager.agent_list",
      "manager.agent_message",
    ]);
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      observed,
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.extra_observed, ["manager.agent_message"]);
  });

  it("ignores observed tools outside the watched list", () => {
    // `recall` is in an earlier revision's KNOWN_TOOL_NAMES but not in the manager
    // watched list. It must not appear in observed_tool_ids and must
    // not affect drift detection.
    const reply = "I called manager.agent_list.";
    const observed = new Set(["manager.agent_list", "recall"]);
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      observed,
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.observed_tool_ids, ["manager.agent_list"]);
  });

  it("claims of non-watched tools do not register", () => {
    // `recall` is not in the watched list — a claim of it must not
    // produce a drift entry. an earlier revision still handles `recall` via its
    // separate gate.
    const reply = "I called `recall` and saw nothing relevant.";
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      new Set(),
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.claimed_tool_ids, []);
    assert.deepEqual(out.missing_claims, []);
  });

  it("workspace write/edit claims count as watched", () => {
    const reply =
      "I called `write` to create the new file, but later I called " +
      "`edit` to tweak it.";
    const observed = new Set(["write"]);
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      observed,
    );
    assert.equal(out.has_drift, true);
    assert.deepEqual(out.missing_claims, ["edit"]);
    assert.deepEqual(out.observed_tool_ids, ["write"]);
  });

  it("negation in the same sentence is not a claim (an earlier revision parity)", () => {
    const reply =
      "I did not call manager.skillset_create — there was nothing to make.";
    const out = computeManagerTruthfulnessDrift(
      reply,
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      new Set(),
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.claimed_tool_ids, []);
  });

  it("empty / whitespace reply is no-drift", () => {
    const out = computeManagerTruthfulnessDrift(
      "",
      MANAGER_TIER_WATCHED_TOOL_NAMES,
      new Set(["manager.agent_list"]),
    );
    assert.equal(out.has_drift, false);
    assert.deepEqual(out.claimed_tool_ids, []);
    // `observed_tool_ids` still reports for symmetry / inspect parity.
    assert.deepEqual(out.observed_tool_ids, ["manager.agent_list"]);
  });
});

describe("MANAGER_TIER_WATCHED_TOOL_NAMES — adapter coverage guard", () => {
  it("covers every registered manager.* adapter tool_id", () => {
    const adaptersDir = join(process.cwd(), "src", "skillset", "adapters");
    const files = readdirSync(adaptersDir).filter(
      (f) => /^manager.*\.ts$/.test(f) && !f.endsWith(".test.ts"),
    );
    assert.ok(files.length > 0, "expected at least one manager adapter file");

    const declared = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(adaptersDir, f), "utf8");
      const re = /tool_id:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        declared.add(m[1]);
      }
    }

    const watchedSet = new Set(MANAGER_TIER_WATCHED_TOOL_NAMES);
    const uncovered: string[] = [];
    for (const id of declared) {
      if (!id.startsWith("manager.")) continue;
      if (!watchedSet.has(id)) uncovered.push(id);
    }
    assert.deepEqual(
      uncovered,
      [],
      `manager.* adapters missing from MANAGER_TIER_WATCHED_TOOL_NAMES: ${uncovered.join(", ")}. ` +
        `Add each missing id to the watched list in src/toolTruthfulness.ts.`,
    );
  });
});
