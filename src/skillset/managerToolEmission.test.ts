/**
 * manager tool emission enrichment tests.
 *
 * Targets `enrichManagerInputSummary` / `enrichManagerResultSummary`.
 * These run inside `agentDynamicTools.ts` `execute` and widen the
 * `{tool, status}` baseline payload with safe whitelisted fields
 * before `onDispatch` / `onResult` is called.
 *
 * Verifies:
 *  - Whitelist coverage per family (agent_list / agent_message /
 *    agent_create / agent_update).
 *  - User-supplied text / reply fields land as bounded previews,
 *    never as raw content; long inputs flip text_truncated.
 *  - Secret-shaped tokens are redacted before reaching the payload
 *    (defense at the emission boundary so even raw inspect trace
 *    can't leak them).
 *  - Unknown / off-spec input fields don't leak into the summary.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  enrichManagerInputSummary,
  enrichManagerResultSummary,
} from "./managerToolEmission";

function emit(): Record<string, unknown> {
  return { tool: "marker" };
}

describe("enrichManagerInputSummary — manager.agent_message", () => {
  it("forwards agent_id / conversation_id / source verbatim", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_message", {
      agent_id: "agent-1",
      text: "hello",
      conversation_id: "conv-1",
      source: "manager.http",
    }, t);
    assert.equal(t.agent_id, "agent-1");
    assert.equal(t.conversation_id, "conv-1");
    assert.equal(t.source, "manager.http");
  });

  it("caps text at 160 chars and reports text_bytes", () => {
    const t = emit();
    const long = "a".repeat(500);
    enrichManagerInputSummary("manager.agent_message", {
      agent_id: "agent-1",
      text: long,
    }, t);
    assert.equal(typeof t.text_preview, "string");
    assert.equal((t.text_preview as string).length, 160);
    assert.equal(t.text_truncated, true);
    assert.equal(t.text_bytes, 500);
  });

  it("does NOT truncate short text", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_message", {
      agent_id: "agent-1",
      text: "short message",
    }, t);
    assert.equal(t.text_preview, "short message");
    assert.equal(t.text_truncated, false);
    assert.equal(t.text_bytes, 13);
  });

  it("redacts ghp_ / Bearer / sk- tokens in text before emit", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_message", {
      agent_id: "agent-1",
      text: "please use ghp_ABCDEFGHIJ1234567890XYZ and Bearer xyz123.abc",
    }, t);
    const preview = t.text_preview as string;
    assert.equal(preview.includes("ghp_"), false);
    assert.equal(preview.includes("Bearer xyz"), false);
    assert.equal(preview.includes("[REDACTED]"), true);
  });

  it("skips text fields when input has no text", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_message", {
      agent_id: "agent-1",
    }, t);
    assert.equal(t.text_preview, undefined);
    assert.equal(t.text_bytes, undefined);
  });
});

describe("enrichManagerResultSummary — manager.agent_message", () => {
  it("surfaces agent_id / task_id / envelope_id / loop_triggered", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_message", {
      ok: true,
      status: "replied",
      agent_id: "agent-1",
      task_id: "task-1",
      envelope_id: "env-1",
      conversation_id: "conv-1",
      loop_triggered: true,
    }, t);
    assert.equal(t.agent_id, "agent-1");
    assert.equal(t.task_id, "task-1");
    assert.equal(t.envelope_id, "env-1");
    assert.equal(t.conversation_id, "conv-1");
    assert.equal(t.loop_triggered, true);
  });

  it("caps reply at 160 chars and reports reply_length", () => {
    const t = emit();
    const long = "b".repeat(500);
    enrichManagerResultSummary("manager.agent_message", {
      ok: true,
      status: "replied",
      reply: long,
    }, t);
    assert.equal((t.reply_preview as string).length, 160);
    assert.equal(t.reply_truncated, true);
    assert.equal(t.reply_length, 500);
  });

  it("redacts secrets inside reply text", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_message", {
      ok: true,
      status: "replied",
      reply: "fetched secret sk-ABCDEFGHIJKLMNOPQRST1234 from store",
    }, t);
    const preview = t.reply_preview as string;
    assert.equal(preview.includes("sk-ABC"), false);
    assert.equal(preview.includes("[REDACTED]"), true);
  });

  it("surfaces error.code + error.message as error_code + message_snippet", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_message", {
      ok: false,
      status: "failed",
      agent_id: "agent-x",
      error: { code: "target_not_found", message: "no agent" },
    }, t);
    assert.equal(t.error_code, "target_not_found");
    assert.equal(t.message_snippet, "no agent");
  });

  it("ignores non-object error fields", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_message", {
      ok: false, status: "failed", error: "some string",
    }, t);
    assert.equal(t.error_code, undefined);
  });
});

describe("enrichManagerInputSummary — other families", () => {
  it("manager.agent_list forwards include_archived only", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_list", {
      include_archived: true,
      // off-spec extras must NOT leak
      secret_filter: "ghp_abcdef",
    }, t);
    assert.equal(t.include_archived, true);
    assert.equal(t.secret_filter, undefined);
  });

  it("manager.agent_create forwards name/model/skillset/status", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_create", {
      name: "MyAgent",
      model: "kimi-k2.6",
      skillset: "manager",
      status: "ready",
      persona: "very long persona text",
      // off-spec
      raw_dump: { token: "Bearer abc123" },
    }, t);
    assert.equal(t.name, "MyAgent");
    assert.equal(t.model, "kimi-k2.6");
    assert.equal(t.skillset, "manager");
    assert.equal(t.agent_status, "ready");
    assert.equal(t.raw_dump, undefined);
    assert.equal(t.persona, undefined);
  });

  it("manager.agent_update collects changed_fields from string-typed inputs", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_update", {
      agent_id: "agent-zz",
      name: "NewName",
      skillset: "manager-v2",
      // non-string ignored
      status: 42 as unknown as string,
    }, t);
    assert.equal(t.agent_id, "agent-zz");
    assert.deepEqual(t.changed_fields, ["name", "skillset"]);
  });

  it("manager.agent_update omits changed_fields when nothing string-typed changed", () => {
    const t = emit();
    enrichManagerInputSummary("manager.agent_update", {
      agent_id: "agent-zz",
    }, t);
    assert.equal(t.changed_fields, undefined);
  });
});

describe("enrichManagerResultSummary — other families", () => {
  it("manager.agent_list surfaces count + agents.length as agent_count", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_list", {
      agents: [{ agent_id: "a" }, { agent_id: "b" }, { agent_id: "c" }],
      count: 3,
    }, t);
    assert.equal(t.count, 3);
    assert.equal(t.agent_count, 3);
  });

  it("manager.agent_create surfaces agent.* fields", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_create", {
      ok: true,
      agent: {
        agent_id: "agent-new",
        name: "MyAgent",
        model: "kimi-k2.6",
        skillset: "manager",
        status: "ready",
        // off-spec fields must not leak
        persona: "secret-y persona text Bearer abc123",
        created_at: "2026-05-25T00:00:00Z",
      },
    }, t);
    assert.equal(t.agent_id, "agent-new");
    assert.equal(t.name, "MyAgent");
    assert.equal(t.model, "kimi-k2.6");
    assert.equal(t.skillset, "manager");
    assert.equal(t.agent_status, "ready");
    assert.equal(t.persona, undefined);
    assert.equal(t.created_at, undefined);
  });

  it("manager.agent_update with error object surfaces error fields", () => {
    const t = emit();
    enrichManagerResultSummary("manager.agent_update", {
      ok: false,
      error: { code: "not_found", message: "no such agent" },
    }, t);
    assert.equal(t.error_code, "not_found");
    assert.equal(t.message_snippet, "no such agent");
  });
});

describe("enrichManager* — unknown tool ids", () => {
  it("does nothing for non-manager canonical ids", () => {
    const t = emit();
    enrichManagerInputSummary("localdoc.convert_text", { content: "x" }, t);
    enrichManagerResultSummary("localdoc.convert_text", { status: "ok" }, t);
    // only the seeded marker survives
    assert.deepEqual(Object.keys(t).sort(), ["tool"]);
  });

  it("does nothing for unknown manager.* canonical ids", () => {
    const t = emit();
    enrichManagerInputSummary("manager.skillset_list", { foo: "bar" }, t);
    assert.deepEqual(Object.keys(t).sort(), ["tool"]);
  });
});
