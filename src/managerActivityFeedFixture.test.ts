/**
 * Manager Activity Feed smoke fixture.
 *
 * Mirrors the take1.1 production manager-fanout shape:
 *   - one `manager.agent_list` dispatch/result pair (count=2)
 *   - two `manager.agent_message` dispatch/result pairs targeting
 *     two subagents (matching real task ids `task-mpknt2a6` /
 *     `task-mpknt26h` and envelope ids `env-mpknt2a6-di1` /
 *     `env-mpknt26h-di1`)
 *   - one `manager.agent_message` error result (handler exception)
 *
 * The fixture is exported as `MANAGER_FANOUT_FIXTURE_TAKE_1_1` so
 * future regression checks can reuse the same row sequence.
 *
 * Required assertions (an earlier revision §Required 2 / §Acceptance):
 *   - Every manager.* row becomes a `tool.lifecycle` intent (not
 *     `generic.tool_event`) — this is the REGRESSION GUARD. If the
 *     lifecycle mapper or its event_type allowlist regresses, the
 *     panel falls back to GenericToolEventCard and this test FAILS.
 *   - All intents render `ManagerLifecyclePanel`.
 *   - Target/subagent correlators (agent_id, task_id, envelope_id)
 *     surface on the relevant result rows.
 *   - Result status surfaces (`replied`).
 *   - Smuggled raw-prompt / token-shaped fields never reach the
 *     intent props (mapper-side defense; emission also redacts).
 *   - Agent list count surfaces on the list result.
 *   - Error phase carries handler_exception code + safe message
 *     preview.
 *
 * Pure-fixture test — no DO, no network, no env. Card spec §Non-
 * Goals: do not depend on any specific production trace being
 * retained forever; this synthetic fixture is the stable proof.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildActionUiIntents,
  type ActionUiIntent,
  type ActionUiIntentSourceRow,
} from "./actionUiIntents";

function row(
  event_type: string,
  payload: Record<string, unknown>,
  ts: number,
): ActionUiIntentSourceRow {
  return {
    event_type,
    payload: JSON.stringify(payload),
    created_at: ts,
    trace_id: null,
  };
}

/**
 * Take1.1 production manager fanout shape. Exported so future
 * fixtures / tests can extend without re-deriving the canonical
 * sequence. Times are monotonically increasing — `buildActionUiIntents`
 * preserves row order (per-row map, no coalescing).
 */
export const MANAGER_FANOUT_FIXTURE_TAKE_1_1: ActionUiIntentSourceRow[] = [
  row("tool.manager.agent_list.dispatch", {
    tool: "manager.agent_list",
    include_archived: false,
  }, 1_000),
  row("tool.manager.agent_list.result", {
    tool: "manager.agent_list",
    status: "ok",
    count: 2,
  }, 1_050),
  row("tool.manager.agent_message.dispatch", {
    tool: "manager.agent_message",
    agent_id: "agent-alpha",
    text_preview: "please summarise Q3 customer feedback",
    text_truncated: false,
    text_bytes: 39,
    source: "manager.http",
  }, 2_000),
  row("tool.manager.agent_message.result", {
    tool: "manager.agent_message",
    status: "replied",
    agent_id: "agent-alpha",
    task_id: "task-mpknt2a6",
    envelope_id: "env-mpknt2a6-di1",
    reply_preview: "summary attached",
    reply_truncated: false,
    reply_length: 16,
    loop_triggered: true,
  }, 2_500),
  row("tool.manager.agent_message.dispatch", {
    tool: "manager.agent_message",
    agent_id: "agent-beta",
    text_preview: "draft an outreach to the Q3 churn cohort",
    text_truncated: false,
    text_bytes: 41,
    source: "manager.http",
  }, 3_000),
  row("tool.manager.agent_message.result", {
    tool: "manager.agent_message",
    status: "replied",
    agent_id: "agent-beta",
    task_id: "task-mpknt26h",
    envelope_id: "env-mpknt26h-di1",
    reply_preview: "draft v1 ready",
    reply_truncated: false,
    reply_length: 14,
    loop_triggered: false,
  }, 3_500),
  row("tool.manager.agent_message.error", {
    tool: "manager.agent_message",
    reason: "handler_exception",
    agent_id: "agent-gamma",
    message_snippet: "ECONNRESET reaching inner subagent",
  }, 4_000),
];

function byEvent(
  intents: ActionUiIntent[],
  eventType: string,
): ActionUiIntent[] {
  return intents.filter((i) => i.sourceEventType === eventType);
}

describe("Manager Activity Feed fixture (take1.1 fanout)", () => {
  it("every manager.* row maps to tool.lifecycle, not generic.tool_event", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    // dispatch rows pair into their result/error rows, so
    // the feed shows one item per ACTION: list pair + msg pair ×2 +
    // unpaired error (agent-gamma had no dispatch in fixture) = 4.
    assert.equal(intents.length, 4);
    for (const intent of intents) {
      assert.equal(
        intent.type,
        "tool.lifecycle",
        `regression: ${intent.sourceEventType} fell through to ${intent.type}`,
      );
      assert.equal(
        intent.component.name,
        "ManagerLifecyclePanel",
        `regression: ${intent.sourceEventType} renders ${intent.component.name}`,
      );
    }
  });

  it("sequence matches expected (paired: list, msg×2, error)", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    const eventTypes = intents.map((i) => i.sourceEventType);
    // paired feed: each surviving row is the action's
    // terminal phase, annotated with lifecycle status/duration.
    assert.deepEqual(eventTypes, [
      "tool.manager.agent_list.result",
      "tool.manager.agent_message.result",
      "tool.manager.agent_message.result",
      "tool.manager.agent_message.error",
    ]);
    for (const intent of intents.slice(0, 3)) {
      const lc = (intent.component.props as { lifecycle?: { status?: string; durationMs?: number | null } }).lifecycle;
      assert.equal(lc?.status, "ok");
      assert.equal(typeof lc?.durationMs, "number");
    }
    const errLc = (intents[3].component.props as { lifecycle?: { status?: string } }).lifecycle;
    assert.equal(errLc?.status, "error");
  });

  it("list result surfaces agent count from `count` field", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    const [listResult] = byEvent(intents, "tool.manager.agent_list.result");
    const p = listResult.component.props as Record<string, unknown>;
    assert.equal(p.family, "agent_list");
    assert.equal(p.phase, "result");
    assert.equal(p.agentCount, 2);
    assert.equal(p.status, "ok");
    assert.ok(listResult.title.includes("2"));
  });

  it("each agent_message result carries agent_id + task_id + envelope_id + status", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    const results = byEvent(intents, "tool.manager.agent_message.result");
    assert.equal(results.length, 2);
    const expected = [
      { agentId: "agent-alpha", taskId: "task-mpknt2a6", envelopeId: "env-mpknt2a6-di1" },
      { agentId: "agent-beta", taskId: "task-mpknt26h", envelopeId: "env-mpknt26h-di1" },
    ];
    for (let i = 0; i < results.length; i++) {
      const p = results[i].component.props as Record<string, unknown>;
      assert.equal(p.agentId, expected[i].agentId);
      assert.equal(p.taskId, expected[i].taskId);
      assert.equal(p.envelopeId, expected[i].envelopeId);
      assert.equal(p.status, "replied");
      assert.equal(typeof p.replyPreview, "string");
      assert.ok((p.replyPreview as string).length > 0);
    }
  });

  it("error intent has primary priority + handler_exception code + safe message preview", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    const [errIntent] = byEvent(intents, "tool.manager.agent_message.error");
    const p = errIntent.component.props as Record<string, unknown>;
    assert.equal(errIntent.priority, "primary");
    assert.equal(p.family, "agent_message");
    assert.equal(p.phase, "error");
    assert.equal(p.agentId, "agent-gamma");
    assert.equal(p.errorCode, "handler_exception");
    assert.equal(
      p.errorMessagePreview,
      "ECONNRESET reaching inner subagent",
    );
  });

  it("intent props never carry raw prompt / token-shaped strings", () => {
    // Variant fixture: smuggle prompt-leak shapes into the dispatch
    // payload. Mapper-side whitelist + redactSecrets must scrub them
    // before they reach the intent props. Defense in depth — emission
    // also redacts (359b1 + 359b1a tests cover that).
    const leakRows: ActionUiIntentSourceRow[] = [
      row("tool.manager.agent_message.dispatch", {
        tool: "manager.agent_message",
        agent_id: "agent-x",
        text_preview: "Bearer abc123tokenrest sneaks through preview",
        text_bytes: 47,
        raw_text_full: "ghp_ABCDEFGHIJ1234567890abcd full prompt",
        provider_response: { headers: { authorization: "Bearer raw.token" } },
        prompt_raw: "<system>secret</system>",
      }, 5_000),
    ];
    const intents = buildActionUiIntents(leakRows);
    const propsStr = JSON.stringify(intents[0].component.props);
    assert.equal(propsStr.includes("Bearer abc"), false, "Bearer leak in props");
    assert.equal(propsStr.includes("ghp_ABCDEFG"), false, "ghp_ leak via raw_text_full");
    assert.equal(propsStr.includes("raw_text_full"), false, "smuggled key reached props");
    assert.equal(propsStr.includes("provider_response"), false, "provider_response reached props");
    assert.equal(propsStr.includes("prompt_raw"), false, "prompt_raw reached props");
    assert.equal(propsStr.includes("<system>"), false, "raw system tag reached props");
    assert.equal(propsStr.includes("[REDACTED]"), true, "redaction marker missing from text_preview");
  });

  it("fixture intents read meaningfully (titles + summaries non-empty)", () => {
    const intents = buildActionUiIntents(MANAGER_FANOUT_FIXTURE_TAKE_1_1);
    for (const intent of intents) {
      assert.equal(typeof intent.title, "string");
      assert.ok(intent.title.length > 0, `empty title for ${intent.sourceEventType}`);
      assert.ok(
        intent.title.toLowerCase().includes("manager"),
        `title for ${intent.sourceEventType} missing 'manager' prefix: ${intent.title}`,
      );
    }
    // Result rows additionally carry a summary line.
    for (const result of byEvent(intents, "tool.manager.agent_message.result")) {
      assert.ok(result.summary && result.summary.length > 0);
    }
    const [listResult] = byEvent(intents, "tool.manager.agent_list.result");
    assert.ok(listResult.summary && listResult.summary.includes("2 agents"));
  });
});
