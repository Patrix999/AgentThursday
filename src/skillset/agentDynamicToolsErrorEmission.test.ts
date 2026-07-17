/**
 * manager dynamic tool error emission redaction tests.
 *
 * an earlier revision added safe `enrichManagerInputSummary` / `enrichManagerResultSummary`
 * for dispatch + result payloads but left the `onError` branch of
 * `buildDynamicSkillTools` at `message.slice(0, 200)` — handler exceptions
 * that quote `Bearer …` / `sk-…` / `ghp_…` / `approval_token=…` reached
 * raw `event_log` even though the mapper later re-redacted them.
 *
 * These tests build a minimal `LoaderState` exposing a fake
 * `manager.agent_message` tool, force its handler to throw a message
 * carrying secret-shaped tokens, and assert the raw `onError` payload
 * already has them redacted before any downstream consumer (inspect,
 * mapper) sees the row.
 *
 * Also asserts the non-manager error branch is unchanged (raw
 * `message.slice(0,200)`) so existing contract is preserved per spec
 * non-goal — only the manager-prefixed canonicals get the new
 * `previewText` boundary.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { z } from "zod";

import {
  buildDynamicSkillTools,
  type BuildDynamicSkillToolsArgs,
} from "./agentDynamicTools";
import type { ToolContract } from "./contractRegistry";
import type {
  CacheEntry,
  LoaderState,
  SkillDescriptor,
  SkillsetManifest,
} from "./types";

function fakeSkill(id: string, tools: string[]): SkillDescriptor {
  return {
    id,
    name: id,
    tier: 1,
    tools,
    capability_class: "callable_tool_ready",
  };
}

function fakeManifest(id: string, skills: SkillDescriptor[]): SkillsetManifest {
  return {
    id,
    name: id,
    description: "",
    version: "0.0.1",
    purpose: "",
    dependencies: [],
    tools: [],
    skills,
    workflow_patterns: [],
    reasoning_protocol: { principles: [] },
    evidence_protocol: {},
    safety_policy: { policy_version: "0.0.1" },
    observability: {},
    policy: { surface_modes: ["enable"], default_tier_cap: 3 },
  };
}

function fakeEntry(manifest: SkillsetManifest): CacheEntry {
  return {
    manifest,
    source_yaml: "",
    source_sha: "djb2:0",
    loaded_at: "2026-05-25T00:00:00.000Z",
    status: "loaded",
    validation_errors: [],
    soul_token_estimate: 0,
  };
}

function fakeState(entries: Record<string, CacheEntry>): LoaderState {
  return {
    schema_version: "0.1.0",
    loaded_at: "2026-05-25T00:00:00.000Z",
    total_soul_token_estimate: 0,
    total_soul_token_cap: 3000,
    per_skillset_token_cap: 1000,
    entries,
  };
}

function fakeContract(toolId: string): ToolContract {
  return {
    tool_id: toolId,
    description: "",
    dispatch_path: { surface: "fetch_path", identifier: "/_test" },
    input_schema: {},
    output_schema: {},
    side_effects: [],
    dry_run_supported: false,
    tier: 1,
    emit_events: [],
    required_evidence: [],
    implemented: true,
  };
}

interface CapturedError {
  canonical: string;
  payload: Record<string, unknown>;
}

function harness(toolId: string, thrown: Error): {
  args: BuildDynamicSkillToolsArgs;
  captured: CapturedError[];
} {
  const manifest = fakeManifest("ms-test", [fakeSkill("sk-test", [toolId])]);
  const captured: CapturedError[] = [];
  const args: BuildDynamicSkillToolsArgs = {
    state: fakeState({ "ms-test": fakeEntry(manifest) }),
    env: {},
    envLookup: () => "set",
    contractsByToolId: (id) => (id === toolId ? fakeContract(id) : undefined),
    handlersByToolId: (id) =>
      id === toolId
        ? {
            canonicalToolId: id,
            inputSchema: z.object({}).passthrough(),
            execute: async () => {
              throw thrown;
            },
          }
        : undefined,
    onError: (canonical, payload) => {
      captured.push({ canonical, payload });
    },
  };
  return { args, captured };
}

function sanitizedKey(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_]/g, "_");
}

describe("buildDynamicSkillTools — manager.* handler error redaction", () => {
  it("scrubs ghp_/Bearer/sk-/approval_token from raw onError payload", async () => {
    const toolId = "manager.agent_message";
    const dangerous = new Error(
      "dispatch failed for sk-ABCDEFGHIJKLMNOPQRSTUVWX " +
        "and ghp_1234567890abcdefghij; Bearer xyz.abc; approval_token=secrettok",
    );
    const { args, captured } = harness(toolId, dangerous);
    const tools = buildDynamicSkillTools(args);
    const tool = tools[sanitizedKey(toolId)];
    assert.ok(tool, "expected tool to be exposed");

    await assert.rejects(() => tool.execute({ agent_id: "a-1", text: "hello" }, undefined));

    assert.equal(captured.length, 1);
    const { canonical, payload } = captured[0];
    assert.equal(canonical, toolId);
    assert.equal(payload.tool, toolId);
    assert.equal(payload.reason, "handler_exception");
    const snippet = payload.message_snippet as string;
    assert.equal(typeof snippet, "string");
    assert.equal(snippet.includes("sk-ABCDEFGHIJ"), false, "sk- token leaked");
    assert.equal(snippet.includes("ghp_1234567890"), false, "ghp_ token leaked");
    assert.equal(snippet.includes("Bearer xyz"), false, "Bearer token leaked");
    assert.equal(snippet.includes("approval_token=secrettok"), false, "approval token leaked");
    assert.equal(snippet.includes("[REDACTED]"), true, "REDACTED marker missing");
  });

  it("caps long manager error messages at 200 and flags truncation", async () => {
    const toolId = "manager.agent_message";
    const long = "x".repeat(800);
    const { args, captured } = harness(toolId, new Error(long));
    const tools = buildDynamicSkillTools(args);
    const tool = tools[sanitizedKey(toolId)];
    await assert.rejects(() => tool.execute({ agent_id: "a-1" }, undefined));
    const snippet = captured[0].payload.message_snippet as string;
    assert.equal(snippet.length, 200);
    assert.equal(captured[0].payload.message_truncated, true);
  });

  it("short manager error messages pass through without truncation flag", async () => {
    const toolId = "manager.agent_message";
    const { args, captured } = harness(toolId, new Error("brief boom"));
    const tools = buildDynamicSkillTools(args);
    const tool = tools[sanitizedKey(toolId)];
    await assert.rejects(() => tool.execute({ agent_id: "a-1" }, undefined));
    assert.equal(captured[0].payload.message_snippet, "brief boom");
    assert.equal(captured[0].payload.message_truncated, undefined);
  });

  it("applies redaction to every manager.* family (agent_list / agent_create / agent_update)", async () => {
    for (const toolId of [
      "manager.agent_list",
      "manager.agent_create",
      "manager.agent_update",
    ]) {
      const { args, captured } = harness(
        toolId,
        new Error("dispatch failed; Bearer secret.token here"),
      );
      const tools = buildDynamicSkillTools(args);
      const tool = tools[sanitizedKey(toolId)];
      await assert.rejects(() => tool.execute({}, undefined));
      const snippet = captured[0].payload.message_snippet as string;
      assert.equal(snippet.includes("Bearer secret"), false, `Bearer leaked for ${toolId}`);
      assert.equal(snippet.includes("[REDACTED]"), true, `REDACTED missing for ${toolId}`);
    }
  });
});

describe("buildDynamicSkillTools — non-manager handler error path is unchanged", () => {
  it("non-manager tool keeps raw message.slice(0,200) contract", async () => {
    // A token-shaped string in a non-manager tool MUST still pass through
    // (contract-preserving). The narrower mapper-layer redaction continues
    // to handle this case downstream; the emission contract for
    // non-manager tools is preserved verbatim per spec.
    const toolId = "localdoc.convert_text";
    const { args, captured } = harness(
      toolId,
      new Error("oops Bearer raw.token leaked-by-design-in-test"),
    );
    const tools = buildDynamicSkillTools(args);
    const tool = tools[sanitizedKey(toolId)];
    await assert.rejects(() => tool.execute({}, undefined));
    const snippet = captured[0].payload.message_snippet as string;
    // Non-manager error path is intentionally the raw slice — verifies
    // we did not silently widen the redaction contract to all tools.
    assert.equal(snippet.includes("Bearer raw.token"), true);
    assert.equal(captured[0].payload.message_truncated, undefined);
  });

  it("non-manager long messages still slice at 200 without truncated flag", async () => {
    const toolId = "localdoc.convert_text";
    const long = "y".repeat(800);
    const { args, captured } = harness(toolId, new Error(long));
    const tools = buildDynamicSkillTools(args);
    const tool = tools[sanitizedKey(toolId)];
    await assert.rejects(() => tool.execute({}, undefined));
    assert.equal((captured[0].payload.message_snippet as string).length, 200);
    assert.equal(captured[0].payload.message_truncated, undefined);
  });
});
