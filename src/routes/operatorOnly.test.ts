import { test } from "node:test";
import assert from "node:assert/strict";
import { isOperatorOnlyPath, isAgentsSdkPath, isScopedSdkRpcForbidden } from "./operatorOnly";

test("operator/debug per-agent surfaces are operator-only", () => {
  for (const p of [
    "/api/workspace",
    "/api/workspace/files",
    "/api/workspace/file",
    "/api/inspect",
    "/api/inspect/evidence",
    "/api/inspect/agents",
    "/api/inspect/skillset/agent-tools",
    "/api/memory",
    "/api/memory/anything",
    "/api/skillset/runtime",
    "/api/skillset/disable",
    "/api/skillset/enable",
    "/api/skillset/reload",
    "/api/artifact/card-1/file.txt",
    "/api/dev-shell/dispatch",
    "/api/dispatch/skillset/runtime_summary",
    "/api/diag/dispatch",
    // operator/debug surfaces with no internal identity check.
    "/api/sandbox/exec",
    "/api/admin/codemode-probe",
    "/api/discord-gateway/start",
    "/api/discord-gateway/stop",
    "/api/discord-gateway/status",
    "/cli/submit",
    "/cli/context/active",
  ]) {
    assert.equal(isOperatorOnlyPath(p), true, `expected operator-only: ${p}`);
  }
});

test("user-facing + public routes are NOT operator-only", () => {
  for (const p of [
    "/api/agent-profiles",
    "/api/agent-profiles/agent-1",
    "/api/manager/agents",
    "/api/manager/agents/agent-1/message",
    "/api/agent-runs",
    "/api/app-users/pending",
    "/api/models",
    "/api/models/credentials",
    "/api/channel/discord/bots",
    "/api/config",
    "/health",
    "/",
  ]) {
    assert.equal(isOperatorOnlyPath(p), false, `should not be operator-only: ${p}`);
  }
});

test("agents-SDK RPC routes (>=3 segments) are gated; SPA /agents paths are not", () => {
  // Gated (per-agent DO RPC):
  for (const p of [
    "/agents/AgentThursdayAgent/agentthursday-dev-fresh-108a-1",
    "/agents/ChannelHubAgent/x",
    "/agents/AgentThursdayAgent/abc/rpc",
    "/agents/anything/instance",
  ]) {
    assert.equal(isAgentsSdkPath(p), true, `expected SDK-gated: ${p}`);
  }
  // NOT gated (console SPA routes served from ASSETS):
  for (const p of ["/agents", "/agents/new", "/agents/agent-abc123", "/", "/api/agent-profiles"]) {
    assert.equal(isAgentsSdkPath(p), false, `SPA/other must not be SDK-gated: ${p}`);
  }
});

test("a SCOPED user is forbidden from the agents-SDK RPC path (admin/SPA allowed)", () => {
  // The exact @callable RPC paths the 426e adversarial pass raised: a scoped
  // user must be blocked (the optional identity can't ride the RPC → would
  // default to the admin/unscoped branch).
  for (const p of [
    "/agents/AgentThursdayAgent/agentthursday-registry-do-default/readAgentRun",
    "/agents/AgentThursdayAgent/agentthursday-registry-do-default/listAgentRuns",
    "/agents/AgentThursdayAgent/agentthursday-registry-do-default/createAgentRun",
    "/agents/AgentThursdayAgent/x/getDiscordBotsSecret",
    "/agents/AgentThursdayAgent/x/getProviderCredentialSecret",
  ]) {
    assert.equal(isScopedSdkRpcForbidden(true, p), true, `scoped must be blocked: ${p}`);
    // Admin (no X-AgentThursday-User-Id → not a scoped user) still reaches the SDK path.
    assert.equal(isScopedSdkRpcForbidden(false, p), false, `admin must be allowed: ${p}`);
  }
  // A scoped user is NOT blocked by THIS guard on /api/* or SPA paths
  // (those are handled by the route layer / isOperatorOnlyPath instead).
  for (const p of ["/api/agent-runs", "/api/agent-runs/run-1", "/agents", "/agents/agent-abc123"]) {
    assert.equal(isScopedSdkRpcForbidden(true, p), false, `not an SDK-RPC path: ${p}`);
  }
});

test("BYO GitHub — ContentHubAgent's content methods are SDK-gated too (chokepoint is class-agnostic)", () => {
  // The 2B owner/token gate trusts the `caller` arg is server-derived; the only
  // external way to invoke ContentHubAgent.read/list/search/getSources with a
  // FORGED caller is the agents-SDK RPC path. That path is keyed on SHAPE
  // (/agents/<class>/<instance>/<method>), so it covers ContentHubAgent exactly
  // like AgentThursdayAgent — secret-gated (426g) + scoped-403 (426e). This test locks
  // that against a future isAgentsSdkPath refactor (the gate would be theater if
  // ContentHubAgent's SDK path ever stopped matching).
  for (const p of [
    "/agents/ContentHubAgent/agentthursday-dev/read",
    "/agents/ContentHubAgent/agentthursday-dev/list",
    "/agents/ContentHubAgent/agentthursday-dev/search",
    "/agents/ContentHubAgent/agentthursday-dev/getSources",
  ]) {
    assert.equal(isAgentsSdkPath(p), true, `ContentHub SDK path must be gated: ${p}`);
    assert.equal(isScopedSdkRpcForbidden(true, p), true, `scoped must be blocked: ${p}`);
    assert.equal(isScopedSdkRpcForbidden(false, p), false, `admin (already full access) reaches it: ${p}`);
  }
});
