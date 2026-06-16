/**
 *  — pure-helper unit tests for current-manager-task fallback.
 *
 * Mirrors the 4 acceptance cases on the card:
 *   1. missing `parent_task_id` → filled with current manager_task_id
 *   2. missing `source_agent_id` → filled with current manager agent_id
 *   3. explicit `parent_task_id` → preserved
 *   4. text-only call (no `task_context`) → input returned unchanged
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import type { ManagerAgentMessageInput } from "./managerOps";
import {
  applyManagerTaskContextFallback,
  resolveDispatchTaskContext,
  type CurrentManagerContext,
} from "./managerTaskContextFallback";

const CURRENT: CurrentManagerContext = {
  manager_task_id: "task-outer-manager-1",
  agent_id: "agent-manager-A",
};

function baseTaskContext() {
  return {
    id: "task-sub-1",
    title: "subagent task",
    objective: "do the thing",
    source_agent_id: CURRENT.agent_id,
  };
}

describe("applyManagerTaskContextFallback", () => {
  it("fills missing parent_task_id with current manager_task_id", () => {
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "go",
      task_context: { ...baseTaskContext() },
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);

    assert.equal(out.task_context?.parent_task_id, CURRENT.manager_task_id);
    assert.equal(out.task_context?.source_agent_id, CURRENT.agent_id);
    // returns a new object — input is not mutated
    assert.notEqual(out, input);
    assert.notEqual(out.task_context, input.task_context);
    assert.equal(input.task_context?.parent_task_id, undefined);
  });

  it("fills missing source_agent_id with current manager agent_id", () => {
    // Manager LLM may omit source_agent_id entirely; relaxed adapter
    // schema lets it through so this helper can recover it.
    const tc = baseTaskContext() as Partial<ReturnType<typeof baseTaskContext>>;
    delete tc.source_agent_id;
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "go",
      // cast: the relaxed adapter schema allows source_agent_id to be
      // absent; the TS type is wide enough because optional fields are
      // narrowed by zod, not by this in-memory shape.
      task_context: tc as ManagerAgentMessageInput["task_context"],
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);

    assert.equal(out.task_context?.source_agent_id, CURRENT.agent_id);
    assert.equal(out.task_context?.parent_task_id, CURRENT.manager_task_id);
  });

  it("preserves an explicit parent_task_id", () => {
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "go",
      task_context: {
        ...baseTaskContext(),
        parent_task_id: "task-explicit-cross-chain",
        source_agent_id: "agent-some-other-manager",
      },
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);

    assert.equal(out.task_context?.parent_task_id, "task-explicit-cross-chain");
    assert.equal(out.task_context?.source_agent_id, "agent-some-other-manager");
    // nothing missing → input passes through reference-equal
    assert.equal(out, input);
  });

  it("returns input unchanged for text-only calls (no task_context)", () => {
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "just a chat ping",
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);

    assert.equal(out, input);
    assert.equal(out.task_context, undefined);
  });

  it("treats empty-string source_agent_id as missing", () => {
    // Defensive: zod min(1) would normally reject this, but the helper
    // is pure and should still recover gracefully if a relaxed schema
    // ever lets an empty string through.
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "go",
      task_context: {
        ...baseTaskContext(),
        source_agent_id: "",
      },
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);
    assert.equal(out.task_context?.source_agent_id, CURRENT.agent_id);
  });

  it("treats null parent_task_id as missing", () => {
    const input: ManagerAgentMessageInput = {
      agent_id: "agent-sub",
      text: "go",
      task_context: {
        ...baseTaskContext(),
        parent_task_id: null,
      },
    };

    const out = applyManagerTaskContextFallback(input, CURRENT);
    assert.equal(out.task_context?.parent_task_id, CURRENT.manager_task_id);
  });
});

describe("resolveDispatchTaskContext ()", () => {
  it("returns ok+undefined for text-only calls (no task_context)", () => {
    const r = resolveDispatchTaskContext(undefined, CURRENT);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.taskContext, undefined);
  });

  it("fills missing parent_task_id from current manager context", () => {
    const r = resolveDispatchTaskContext(
      { ...baseTaskContext() },
      CURRENT,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.taskContext?.parent_task_id, CURRENT.manager_task_id);
      assert.equal(r.taskContext?.source_agent_id, CURRENT.agent_id);
    }
  });

  it("fills missing source_agent_id from current manager context", () => {
    const tc = baseTaskContext() as Partial<ReturnType<typeof baseTaskContext>>;
    delete tc.source_agent_id;
    const r = resolveDispatchTaskContext(tc, CURRENT);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.taskContext?.source_agent_id, CURRENT.agent_id);
      assert.equal(r.taskContext?.parent_task_id, CURRENT.manager_task_id);
    }
  });

  it("preserves explicit non-empty parent_task_id even inside manager turn", () => {
    const r = resolveDispatchTaskContext(
      {
        ...baseTaskContext(),
        parent_task_id: "task-explicit-cross-chain",
        source_agent_id: "agent-some-other-manager",
      },
      CURRENT,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.taskContext?.parent_task_id, "task-explicit-cross-chain");
      assert.equal(r.taskContext?.source_agent_id, "agent-some-other-manager");
    }
  });

  it("rejects missing parent_task_id outside manager turn (current=null)", () => {
    const r = resolveDispatchTaskContext(
      { ...baseTaskContext() },
      null,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "invalid_input");
      assert.match(
        r.error.message,
        /task_context\.parent_task_id is required outside manager turn context/,
      );
    }
  });

  it("rejects null parent_task_id outside manager turn", () => {
    const r = resolveDispatchTaskContext(
      { ...baseTaskContext(), parent_task_id: null },
      null,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(
        r.error.message,
        /parent_task_id is required outside manager turn context/,
      );
    }
  });

  it("rejects empty-string parent_task_id outside manager turn", () => {
    const r = resolveDispatchTaskContext(
      { ...baseTaskContext(), parent_task_id: "" },
      null,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(
        r.error.message,
        /parent_task_id is required outside manager turn context/,
      );
    }
  });

  it("rejects schema-invalid task_context (missing required field) with invalid_input", () => {
    // Title missing → TaskContextSchema rejects.
    const tc = baseTaskContext() as Partial<ReturnType<typeof baseTaskContext>>;
    delete tc.title;
    const r = resolveDispatchTaskContext(tc, CURRENT);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "invalid_input");
      assert.match(r.error.message, /task_context invalid/);
    }
  });

  it("preserves explicit parent outside manager turn (no fill needed)", () => {
    const r = resolveDispatchTaskContext(
      {
        ...baseTaskContext(),
        parent_task_id: "task-caller-supplied",
      },
      null,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.taskContext?.parent_task_id, "task-caller-supplied");
    }
  });
});
