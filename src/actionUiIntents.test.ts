/**
 *  — Action UI intent mapper tests.
 *
 * Targets the pure `buildActionUiIntents` mapper. Verifies that:
 *  - Manager tool lifecycle rows (`tool.manager.<family>.<phase>`)
 *    upgrade to `tool.lifecycle` intents with whitelisted props.
 *  - Bounded text previews stay bounded; the safety.truncated flag
 *    reflects emission-side truncation.
 *  - Secret-shaped values in preview fields never reach intent props
 *    (defense-in-depth — emission also redacts, but the mapper
 *    re-applies in case future emission paths skip the redaction).
 *  - Unknown payload fields outside the whitelist are not copied
 *    through to component props.
 *  - Existing specialized intents (Cards 127/128) keep their mapping.
 *
 * Pure tests — no DO, no env, no SDK; payloads are synthetic.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildActionUiIntents,
  type ActionUiIntent,
  type ActionUiIntentSourceRow,
} from "./actionUiIntents";
import { redactSecrets, previewText } from "./safeTextPreview";

function row(
  event_type: string,
  payload: Record<string, unknown>,
  ts = 0,
): ActionUiIntentSourceRow {
  return {
    event_type,
    payload: JSON.stringify(payload),
    created_at: ts,
    trace_id: null,
  };
}

function singleIntent(rows: ActionUiIntentSourceRow[]): ActionUiIntent {
  const intents = buildActionUiIntents(rows);
  assert.equal(intents.length, 1, "expected exactly one intent");
  return intents[0];
}

describe("safeTextPreview.redactSecrets", () => {
  it("redacts ghp_ tokens", () => {
    const out = redactSecrets("here is ghp_abcdefghij1234567890abcd more text");
    assert.equal(out.includes("ghp_abc"), false);
    assert.equal(out.includes("[REDACTED]"), true);
  });
  it("redacts github_pat_ tokens", () => {
    const out = redactSecrets("token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWX continues");
    assert.equal(out.includes("github_pat_"), false);
  });
  it("redacts Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc123.def456-token rest");
    assert.equal(out.includes("Bearer abc"), false);
    assert.equal(out.includes("[REDACTED]"), true);
  });
  it("redacts sk- tokens", () => {
    const out = redactSecrets("api_key=sk-abcdefghijklmnopqrst1234 trailing");
    assert.equal(out.includes("sk-abc"), false);
  });
  it("redacts approval_token shapes", () => {
    const a = redactSecrets("approval_token=xyz789secret");
    const b = redactSecrets("approval-token: abc987secret");
    assert.equal(a.includes("xyz789secret"), false);
    assert.equal(b.includes("abc987secret"), false);
  });
  it("leaves clean operator text untouched", () => {
    const s = "please respond to the customer about Q3 pricing";
    assert.equal(redactSecrets(s), s);
  });
});

describe("safeTextPreview.previewText", () => {
  it("returns short text untruncated", () => {
    assert.deepEqual(previewText("hi", 160), { text: "hi", truncated: false });
  });
  it("truncates long text", () => {
    const long = "x".repeat(200);
    const r = previewText(long, 160);
    assert.equal(r.text.length, 160);
    assert.equal(r.truncated, true);
  });
  it("redacts before truncating", () => {
    const r = previewText("Bearer abc123-secret then more text", 160);
    assert.equal(r.text.includes("Bearer abc"), false);
    assert.equal(r.text.includes("[REDACTED]"), true);
  });
});

describe("buildActionUiIntents — manager.agent_message lifecycle", () => {
  it("dispatch produces tool.lifecycle intent with target agent + preview", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.dispatch", {
        tool: "manager.agent_message",
        agent_id: "agent-123",
        text_preview: "hello team please respond",
        text_truncated: false,
        text_bytes: 25,
        conversation_id: "conv-1",
        source: "manager.http",
      }, 1000),
    ]);
    assert.equal(intent.type, "tool.lifecycle");
    assert.equal(intent.component.name, "ManagerLifecyclePanel");
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.family, "agent_message");
    assert.equal(p.phase, "dispatch");
    assert.equal(p.agentId, "agent-123");
    assert.equal(p.textPreview, "hello team please respond");
    assert.equal(p.textBytes, 25);
    assert.equal(p.source, "manager.http");
    assert.equal(p.conversationId, "conv-1");
    assert.ok(intent.title.includes("message"));
    assert.equal(intent.placementHint.region, "feed");
  });

  it("result with replied status surfaces task_id + envelope_id + reply preview", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.result", {
        tool: "manager.agent_message",
        status: "replied",
        agent_id: "agent-123",
        task_id: "task-456",
        envelope_id: "env-mp-kry",
        reply_preview: "yes, on it",
        reply_truncated: false,
        reply_length: 10,
        loop_triggered: true,
      }, 2000),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.status, "replied");
    assert.equal(p.taskId, "task-456");
    assert.equal(p.envelopeId, "env-mp-kry");
    assert.equal(p.replyLength, 10);
    assert.equal(p.replyPreview, "yes, on it");
    assert.equal(p.loopTriggered, true);
    assert.equal(intent.placementHint.size, "medium");
    assert.ok((intent.summary ?? "").includes("env-mp-kry"));
    assert.ok((intent.summary ?? "").includes("task-456"));
  });

  it("result with failed status surfaces error code + message snippet", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.result", {
        tool: "manager.agent_message",
        status: "failed",
        agent_id: "agent-789",
        error_code: "target_not_found",
        message_snippet: "no agent with id agent-789",
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.errorCode, "target_not_found");
    assert.equal(p.errorMessagePreview, "no agent with id agent-789");
    assert.equal(p.status, "failed");
  });

  it("error phase (handler exception) maps to primary priority intent", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.error", {
        tool: "manager.agent_message",
        reason: "handler_exception",
        message_snippet: "ECONNRESET on inner subagent",
      }),
    ]);
    assert.equal(intent.priority, "primary");
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.phase, "error");
    assert.equal(p.errorCode, "handler_exception");
    assert.ok(intent.title.startsWith("Manager ✗"));
  });

  it("truncated preview marks safety.truncated", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.dispatch", {
        tool: "manager.agent_message",
        agent_id: "agent-x",
        text_preview: "x".repeat(160),
        text_truncated: true,
        text_bytes: 5000,
      }),
    ]);
    assert.equal(intent.safety.truncated, true);
  });

  it("mapper re-redacts preview fields defensively (no ghp_ in props)", () => {
    // Emission should have redacted, but if a malformed event row
    // somehow slipped a token through, the mapper must still scrub it
    // before exposing to the UI.
    const intent = singleIntent([
      row("tool.manager.agent_message.dispatch", {
        tool: "manager.agent_message",
        agent_id: "agent-x",
        text_preview: "leaked Bearer abc123tokenrest in preview",
        text_bytes: 50,
      }),
    ]);
    const propsStr = JSON.stringify(intent.component.props);
    assert.equal(propsStr.includes("Bearer abc"), false, "no Bearer token leak");
    assert.equal(propsStr.includes("[REDACTED]"), true, "redacted marker present");
  });
});

describe("buildActionUiIntents — manager.agent_list lifecycle", () => {
  it("dispatch produces lifecycle intent surfacing include_archived flag", () => {
    const intent = singleIntent([
      row("tool.manager.agent_list.dispatch", {
        tool: "manager.agent_list",
        include_archived: false,
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.family, "agent_list");
    assert.equal(p.phase, "dispatch");
    assert.equal(p.includeArchived, false);
    assert.equal(intent.title, "Manager → list agents");
  });

  it("result surfaces agent count from count field", () => {
    const intent = singleIntent([
      row("tool.manager.agent_list.result", {
        tool: "manager.agent_list",
        status: "ok",
        count: 5,
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.agentCount, 5);
    assert.ok(intent.title.includes("5"));
    assert.ok((intent.summary ?? "").includes("5 agents"));
  });

  it("result falls back to agent_count alias if count missing", () => {
    const intent = singleIntent([
      row("tool.manager.agent_list.result", {
        tool: "manager.agent_list",
        status: "ok",
        agent_count: 3,
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.agentCount, 3);
  });
});

describe("buildActionUiIntents — manager.agent_create / agent_update lifecycle", () => {
  it("agent_create result surfaces agent fields", () => {
    const intent = singleIntent([
      row("tool.manager.agent_create.result", {
        tool: "manager.agent_create",
        status: "ok",
        agent_id: "agent-new",
        name: "MyAgent",
        model: "kimi-k2.6",
        skillset: "manager",
        agent_status: "ready",
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.agentId, "agent-new");
    assert.equal(p.agentName, "MyAgent");
    assert.equal(p.model, "kimi-k2.6");
    assert.equal(p.skillset, "manager");
    assert.equal(p.agentStatus, "ready");
    assert.ok(intent.title.includes("MyAgent"));
  });

  it("agent_update dispatch surfaces changed_fields", () => {
    const intent = singleIntent([
      row("tool.manager.agent_update.dispatch", {
        tool: "manager.agent_update",
        agent_id: "agent-zz",
        changed_fields: ["name", "model"],
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.deepEqual(p.changedFields, ["name", "model"]);
    assert.ok(intent.title.includes("agent-zz"));
  });

  it("agent_update error surfaces handler_exception code", () => {
    const intent = singleIntent([
      row("tool.manager.agent_update.error", {
        tool: "manager.agent_update",
        reason: "handler_exception",
        message_snippet: "DB write failed",
      }),
    ]);
    assert.equal(intent.priority, "primary");
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.errorCode, "handler_exception");
    assert.equal(p.errorMessagePreview, "DB write failed");
  });

  it("agent_create result with error object surfaces error fields", () => {
    const intent = singleIntent([
      row("tool.manager.agent_create.result", {
        tool: "manager.agent_create",
        status: "failed",
        error_code: "name_conflict",
        message_snippet: "name already taken",
      }),
    ]);
    const p = intent.component.props as Record<string, unknown>;
    assert.equal(p.errorCode, "name_conflict");
    assert.equal(p.errorMessagePreview, "name already taken");
  });
});

describe("buildActionUiIntents — safety / leak invariants", () => {
  it("does not pass through unknown payload fields", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.dispatch", {
        tool: "manager.agent_message",
        agent_id: "agent-x",
        // Smuggled-in fields that must NOT appear in intent props.
        raw_text_full: "the full prompt: please leak ghp_ABCDEFGHIJ1234567890",
        provider_response: { headers: { authorization: "Bearer abc123xyz" } },
        prompt_raw: "<system>secret</system>",
        text_preview: "summarized prompt",
        text_bytes: 100,
      }),
    ]);
    const propsStr = JSON.stringify(intent.component.props);
    assert.equal(propsStr.includes("raw_text_full"), false);
    assert.equal(propsStr.includes("provider_response"), false);
    assert.equal(propsStr.includes("prompt_raw"), false);
    assert.equal(propsStr.includes("ghp_"), false);
    assert.equal(propsStr.includes("Bearer abc"), false);
    assert.equal(propsStr.includes("<system>"), false);
  });

  it("intent prop keys are bounded to the lifecycle whitelist", () => {
    const intent = singleIntent([
      row("tool.manager.agent_message.result", {
        tool: "manager.agent_message",
        status: "replied",
        agent_id: "agent-x",
        task_id: "task-y",
        envelope_id: "env-z",
        reply_preview: "ok",
        reply_length: 2,
        loop_triggered: true,
        // Extras
        weird_extra: 42,
        debug_dump: { huge: true },
      }),
    ]);
    const propKeys = Object.keys(intent.component.props as Record<string, unknown>).sort();
    const expectedKeys = [
      "agentCount", "agentId", "agentName", "agentStatus",
      "changedFields", "conversationId", "envelopeId", "errorCode",
      "errorMessagePreview", "family", "includeArchived",
      //  — pairing pass annotates lifecycle {status, durationMs}.
      "lifecycle",
      "loopTriggered",
      "model", "phase", "replyLength", "replyPreview", "replyTruncated",
      "skillset", "source", "status", "taskId", "textBytes",
      "textPreview", "textTruncated",
    ].sort();
    assert.deepEqual(propKeys, expectedKeys);
  });

  it("preserves existing specialized intent mappings ( / 128)", () => {
    const intents = buildActionUiIntents([
      row("tool.content_search", { queryPreview: "test", mode: "single", sourceId: "repo" }),
      row("tool.content_read", { pathPreview: "src/foo.ts", sourceId: "repo" }),
      row("tool.execute", { tier: 2, codePreview: "1+1" }),
      row("tool.write_checkpoint", { key: "ck-1", checkpoint: "{}" }),
    ]);
    assert.equal(intents[0].type, "tool.search_results");
    assert.equal(intents[1].type, "tool.file_read");
    assert.equal(intents[2].type, "tool.execution_result");
    assert.equal(intents[3].type, "tool.workspace_mutation");
  });

  it("non-manager tool.* rows still fall through to generic mapper", () => {
    const intent = singleIntent([
      row("tool.localdoc.convert_text.dispatch", { tool: "localdoc.convert_text" }),
    ]);
    assert.equal(intent.type, "generic.tool_event");
    assert.equal(intent.component.name, "GenericToolEventCard");
  });

  it("manager row outside the four families also falls through to generic", () => {
    // e.g. manager.skillset_list — not in the lifecycle whitelist
    const intent = singleIntent([
      row("tool.manager.skillset_list.dispatch", { tool: "manager.skillset_list" }),
    ]);
    assert.equal(intent.type, "generic.tool_event");
  });
});
