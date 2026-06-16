import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveChannelAgentRoute } from "./resolveChannelAgentRoute";

const FALLBACK = "agentthursday-dev-fresh-108a-1";

describe("resolveChannelAgentRoute", () => {
  it("returns active_context_fallback when conversationBinding is null (unbound)", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: null,
      agentValidation: null,
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "active_context_fallback");
    assert.equal(r.targetName, FALLBACK);
    assert.equal(r.agentId, null);
    assert.equal(r.reason, null);
  });

  it("returns active_context_fallback when activeAgentId is empty string", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "" },
      agentValidation: null,
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "active_context_fallback");
    assert.equal(r.targetName, FALLBACK);
    assert.equal(r.agentId, null);
  });

  it("returns active_context_fallback when activeAgentId is whitespace", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "   " },
      agentValidation: null,
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "active_context_fallback");
  });

  it("routes to agent DO by agent_id when agent exists and status=initialized", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "agent-abc" },
      agentValidation: { exists: true, status: "initialized" },
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "agent_binding");
    assert.equal(r.targetName, "agent-abc");
    assert.equal(r.agentId, "agent-abc");
    assert.equal(r.reason, null);
  });

  it("returns invalid_binding with structured reason for deleted_marker agent", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "agent-tomb" },
      agentValidation: { exists: true, status: "deleted_marker" },
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "invalid_binding");
    assert.equal(r.agentId, "agent-tomb");
    assert.equal(r.reason, "invalid_binding:agent:agent-tomb:deleted_marker");
  });

  it("returns invalid_binding with structured reason for non-existent agent", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "agent-gone" },
      agentValidation: { exists: false, status: null },
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "invalid_binding");
    assert.equal(r.targetName, null);
    assert.equal(r.agentId, "agent-gone");
    assert.equal(r.reason, "invalid_binding:agent:agent-gone:missing");
  });

  it("returns invalid_binding with structured reason for archived agent", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "agent-old" },
      agentValidation: { exists: true, status: "archived" },
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "invalid_binding");
    assert.equal(r.agentId, "agent-old");
    assert.equal(r.reason, "invalid_binding:agent:agent-old:archived");
  });

  it("returns invalid_binding with structured reason when validation is null but binding present", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "agent-xyz" },
      agentValidation: null,
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "invalid_binding");
    assert.equal(r.agentId, "agent-xyz");
    assert.equal(r.reason, "invalid_binding:agent:agent-xyz:validation_unavailable");
  });

  it("trims surrounding whitespace from activeAgentId before routing", () => {
    const r = resolveChannelAgentRoute({
      conversationBinding: { activeAgentId: "  agent-abc  " },
      agentValidation: { exists: true, status: "initialized" },
      activeContextId: FALLBACK,
    });
    assert.equal(r.kind, "agent_binding");
    assert.equal(r.targetName, "agent-abc");
    assert.equal(r.agentId, "agent-abc");
  });
});
