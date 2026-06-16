import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveActiveAgent } from "./activeAgentResolver";

const A = { id: "agent-a" };
const B = { id: "agent-b" };
const C = { id: "agent-c" };

describe("resolveActiveAgent", () => {
  it("returns the pinned id when it exists in the list", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: "agent-b",
      storedAgentId: "agent-a",
      agents: [A, B, C],
    });
    assert.deepEqual(r, { agentId: "agent-b", source: "pinned", pinIsStale: false });
  });

  it("falls back to stored when pin is missing from the list", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: "agent-gone",
      storedAgentId: "agent-a",
      agents: [A, B],
    });
    assert.deepEqual(r, { agentId: "agent-a", source: "stored", pinIsStale: true });
  });

  it("falls back to first when neither pin nor stored matches", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: "agent-gone",
      storedAgentId: "also-gone",
      agents: [A, B],
    });
    assert.deepEqual(r, { agentId: "agent-a", source: "first", pinIsStale: true });
  });

  it("uses stored when no pin is set", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: null,
      storedAgentId: "agent-b",
      agents: [A, B, C],
    });
    assert.deepEqual(r, { agentId: "agent-b", source: "stored", pinIsStale: false });
  });

  it("uses first when no pin set and stored is empty", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: null,
      storedAgentId: "",
      agents: [A, B],
    });
    assert.deepEqual(r, { agentId: "agent-a", source: "first", pinIsStale: false });
  });

  it("uses first when no pin set and stored matches nothing", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: null,
      storedAgentId: "stale-cache-id",
      agents: [A, B],
    });
    assert.deepEqual(r, { agentId: "agent-a", source: "first", pinIsStale: false });
  });

  it("returns none when agents list is empty", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: "any",
      storedAgentId: "any",
      agents: [],
    });
    assert.deepEqual(r, { agentId: null, source: "none", pinIsStale: true });
  });

  it("treats empty-string pin as no pin", () => {
    const r = resolveActiveAgent({
      pinnedAgentId: "",
      storedAgentId: "agent-b",
      agents: [A, B],
    });
    assert.deepEqual(r, { agentId: "agent-b", source: "stored", pinIsStale: false });
  });
});
