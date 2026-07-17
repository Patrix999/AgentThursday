/**
 * content-update fan-out tests.
 *
 * Tests target `managerSkillsetContentFanout.ts` rather than
 * `managerOps.ts` directly because `managerOps` imports
 * `getAgentByName from "agents"`, which under `node --import tsx
 * --test` pulls in `partyserver` → `cloudflare:workers` and fails
 * to resolve outside the workers runtime. The fan-out helper is
 * pure and re-imported by `managerUpdateSkillset` at call time.
 *
 * Covers:
 *   1. PATCH on a custom skillset fans out a refresh to every agent
 *      whose `profile.skillset === <updated_id>`; agents bound to a
 *      different skillset are not touched.
 *   2. Archived agents are excluded (helper passes
 *      `includeArchived: false`).
 *   3. Per-agent refresh failure is recorded as
 *      `manager.skillset.content.refresh_failed` but does NOT throw
 *      — other agents still complete.
 *   4. Enumerate failure (listAgentProfiles throws) is recorded
 *      fail-soft with `phase: "enumerate"` and skips per-agent
 *      attempts.
 *
 * Negative-path validation regressions (embedded id readonly,
 * unknown tool id, registry update returning not_found) belong on
 * the unchanged validation layer (`customSkillsetValidation.test.ts`
 * already covers them) and on the `updateCustomSkillset` ops layer.
 * They are not re-asserted here because the 357b helper executes
 * AFTER those gates have passed in `managerUpdateSkillset`.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  fanoutCustomSkillsetContentRefresh,
  SKILLSET_CONTENT_REFRESHED_EVENT,
  SKILLSET_CONTENT_REFRESH_FAILED_EVENT,
  type FanoutRegistryStubSurface,
  type FanoutPerAgentStubSurface,
} from "./managerSkillsetContentFanout";
import type { AgentProfile } from "../schema/agent";

// ───────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────

function agentProfile(
  id: string,
  skillset: string,
  status: AgentProfile["status"] = "ready",
): AgentProfile {
  return {
    id,
    name: id,
    model: "glm-4.7-flash",
    channel: "default",
    skillset,
    persona: "",
    status,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
  };
}

interface FakeRegistryOptions {
  agents: AgentProfile[];
  listThrows?: Error;
}

interface FakeRegistry extends FanoutRegistryStubSurface {
  events: Array<{ type: string; payload: unknown }>;
  listCalls: Array<{ includeArchived?: boolean }>;
}

function makeRegistry(opts: FakeRegistryOptions): FakeRegistry {
  const events: Array<{ type: string; payload: unknown }> = [];
  const listCalls: Array<{ includeArchived?: boolean }> = [];
  return {
    events,
    listCalls,
    async listAgentProfiles(o) {
      listCalls.push(o);
      if (opts.listThrows) throw opts.listThrows;
      const includeArchived = o.includeArchived === true;
      // mirror prod: default list excludes both `archived`
      // and `deleted_marker` (ADR §2.1 tombstone is UI-invisible).
      return opts.agents.filter(
        (a) =>
          includeArchived ||
          (a.status !== "archived" && a.status !== "deleted_marker"),
      );
    },
    recordManagerEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

function makePerAgent(opts: {
  effectiveIds?: string[];
  throws?: Error;
} = {}): FanoutPerAgentStubSurface {
  return {
    async refreshCustomSkillsetCache() {
      if (opts.throws) throw opts.throws;
      return {
        profile_id: "unused",
        custom_skillset_ids: ["card357b-content"],
        effective_skillset_ids: opts.effectiveIds ?? ["card357b-content"],
        fallback_reason: null,
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────

describe("357b fanoutCustomSkillsetContentRefresh", () => {
  it("fans out refresh to agents bound to the updated skillset; bypasses other agents", async () => {
    const SKILLSET = "card357b-content";
    const agentA = agentProfile("agent-A", SKILLSET);
    const agentB = agentProfile("agent-B", SKILLSET);
    const agentC = agentProfile("agent-C", "qa-reviewer-basic");
    const resolved: string[] = [];
    const reg = makeRegistry({ agents: [agentA, agentB, agentC] });
    const result = await fanoutCustomSkillsetContentRefresh({
      stub: reg,
      skillsetId: SKILLSET,
      updatedAt: "2026-05-25T01:00:00.000Z",
      resolvePerAgent: async (id) => {
        resolved.push(id);
        return makePerAgent({ effectiveIds: [SKILLSET] });
      },
    });
    assert.deepEqual(resolved.sort(), ["agent-A", "agent-B"]);
    assert.deepEqual(result.refreshed.sort(), ["agent-A", "agent-B"]);
    assert.deepEqual(result.failed, []);
    const refreshEvents = reg.events.filter(
      (e) => e.type === SKILLSET_CONTENT_REFRESHED_EVENT,
    );
    assert.equal(refreshEvents.length, 2);
    const ids = refreshEvents
      .map((e) => (e.payload as { agent_id: string }).agent_id)
      .sort();
    assert.deepEqual(ids, ["agent-A", "agent-B"]);
    for (const e of refreshEvents) {
      const p = e.payload as { skillset_id: string; updated_at: string };
      assert.equal(p.skillset_id, SKILLSET);
      assert.equal(p.updated_at, "2026-05-25T01:00:00.000Z");
    }
    assert.equal(
      reg.events.filter((e) => e.type === SKILLSET_CONTENT_REFRESH_FAILED_EVENT).length,
      0,
    );
  });

  it("excludes archived agents from fan-out", async () => {
    const SKILLSET = "card357b-content";
    const agentLive = agentProfile("agent-live", SKILLSET);
    const agentArchived = agentProfile("agent-archived", SKILLSET, "archived");
    const resolved: string[] = [];
    const reg = makeRegistry({ agents: [agentLive, agentArchived] });
    const result = await fanoutCustomSkillsetContentRefresh({
      stub: reg,
      skillsetId: SKILLSET,
      updatedAt: "2026-05-25T01:00:00.000Z",
      resolvePerAgent: async (id) => {
        resolved.push(id);
        return makePerAgent();
      },
    });
    assert.deepEqual(resolved, ["agent-live"]);
    assert.deepEqual(result.refreshed, ["agent-live"]);
    assert.equal(reg.listCalls.length, 1);
    assert.equal(reg.listCalls[0]?.includeArchived, false);
  });

  it("records per-agent refresh failure as refresh_failed and keeps other agents going", async () => {
    const SKILLSET = "card357b-content";
    const agentOk = agentProfile("agent-ok", SKILLSET);
    const agentBoom = agentProfile("agent-boom", SKILLSET);
    const reg = makeRegistry({ agents: [agentOk, agentBoom] });
    const result = await fanoutCustomSkillsetContentRefresh({
      stub: reg,
      skillsetId: SKILLSET,
      updatedAt: "2026-05-25T01:00:00.000Z",
      resolvePerAgent: async (id) => {
        if (id === "agent-boom") {
          return makePerAgent({ throws: new Error("boom RPC failure") });
        }
        return makePerAgent();
      },
    });
    assert.deepEqual(result.refreshed, ["agent-ok"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.agent_id, "agent-boom");
    assert.equal(result.failed[0]?.phase, "refresh");
    const okEvents = reg.events.filter(
      (e) => e.type === SKILLSET_CONTENT_REFRESHED_EVENT,
    );
    const failEvents = reg.events.filter(
      (e) => e.type === SKILLSET_CONTENT_REFRESH_FAILED_EVENT,
    );
    assert.equal(okEvents.length, 1);
    assert.equal((okEvents[0]?.payload as { agent_id: string }).agent_id, "agent-ok");
    assert.equal(failEvents.length, 1);
    const failPayload = failEvents[0]?.payload as {
      agent_id: string; phase: string; message: string; skillset_id: string;
    };
    assert.equal(failPayload.agent_id, "agent-boom");
    assert.equal(failPayload.phase, "refresh");
    assert.equal(failPayload.skillset_id, SKILLSET);
    assert.match(failPayload.message, /boom RPC failure/);
  });

  it("records enumerate failure with phase=enumerate and skips per-agent attempts", async () => {
    const SKILLSET = "card357b-content";
    const reg = makeRegistry({
      agents: [],
      listThrows: new Error("registry list crashed"),
    });
    let perAgentResolved = 0;
    const result = await fanoutCustomSkillsetContentRefresh({
      stub: reg,
      skillsetId: SKILLSET,
      updatedAt: "2026-05-25T01:00:00.000Z",
      resolvePerAgent: async () => {
        perAgentResolved += 1;
        return makePerAgent();
      },
    });
    assert.equal(perAgentResolved, 0);
    assert.deepEqual(result.refreshed, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.phase, "enumerate");
    const failEvents = reg.events.filter(
      (e) => e.type === SKILLSET_CONTENT_REFRESH_FAILED_EVENT,
    );
    assert.equal(failEvents.length, 1);
    const p = failEvents[0]?.payload as { phase: string; skillset_id: string; message: string };
    assert.equal(p.phase, "enumerate");
    assert.equal(p.skillset_id, SKILLSET);
    assert.match(p.message, /registry list crashed/);
  });

  it("no-op (no events) when no agents are bound to the updated skillset", async () => {
    const reg = makeRegistry({
      agents: [agentProfile("agent-A", "qa-reviewer-basic")],
    });
    const result = await fanoutCustomSkillsetContentRefresh({
      stub: reg,
      skillsetId: "card357b-content",
      updatedAt: "2026-05-25T01:00:00.000Z",
      resolvePerAgent: async () => makePerAgent(),
    });
    assert.deepEqual(result.refreshed, []);
    assert.deepEqual(result.failed, []);
    assert.equal(reg.events.length, 0);
    assert.equal(reg.listCalls.length, 1);
  });
});
