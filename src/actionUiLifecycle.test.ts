/**
 *  — lifecycle pairing + workflow-era intent tests.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildActionUiIntents,
  annotateLifecycleRows,
  type ActionUiIntentSourceRow,
} from "./actionUiIntents";

const NOW = 1_781_200_000_000;

function row(
  event_type: string,
  at: number,
  payload: Record<string, unknown> = {},
  trace: string | null = "task-1",
): ActionUiIntentSourceRow {
  return { event_type, payload: JSON.stringify(payload), created_at: at, trace_id: trace };
}

describe("annotateLifecycleRows ()", () => {
  it("pairs dispatch+result into one action (dispatch skipped, result annotated)", () => {
    const rows = [
      row("tool.repo.read.result", NOW, { ok: true }),
      row("tool.repo.read.dispatch", NOW - 1500, { input: { path: "x" } }),
    ];
    const out = annotateLifecycleRows(rows);
    assert.equal(out[1].skip, true);
    assert.deepEqual(out[0].lifecycle, { status: "ok", durationMs: 1500 });
  });

  it("marks an unpaired dispatch as running", () => {
    const out = annotateLifecycleRows([row("tool.gate.build.dispatch", NOW)]);
    assert.deepEqual(out[0].lifecycle, { status: "running", durationMs: null });
    assert.notEqual(out[0].skip, true);
  });

  it("pairs error with its dispatch as status error", () => {
    const rows = [
      row("tool.repo.write.error", NOW, {}),
      row("tool.repo.write.dispatch", NOW - 300),
    ];
    const out = annotateLifecycleRows(rows);
    assert.equal(out[1].skip, true);
    assert.deepEqual(out[0].lifecycle, { status: "error", durationMs: 300 });
  });

  it("does not pair across different tools or traces", () => {
    const rows = [
      row("tool.repo.read.result", NOW, {}, "task-2"),
      row("tool.repo.grep.dispatch", NOW - 100, {}, "task-1"),
      row("tool.repo.read.dispatch", NOW - 200, {}, "task-1"),
    ];
    const out = annotateLifecycleRows(rows);
    // read.result(trace 2) must NOT consume read.dispatch(trace 1)
    assert.notEqual(out[2].skip, true);
    assert.equal(out[0].lifecycle?.durationMs, null);
    // grep.dispatch stays running
    assert.equal(out[1].lifecycle?.status, "running");
  });

  it("leaves non-suffixed tool rows untouched", () => {
    const out = annotateLifecycleRows([row("tool.execute", NOW)]);
    assert.equal(out[0].lifecycle, undefined);
    assert.notEqual(out[0].skip, true);
  });
});

describe("buildActionUiIntents workflow-era mapping ()", () => {
  it("maps workflow.run.started/terminal to workflow.run intents", () => {
    const intents = buildActionUiIntents(
      [
        row("workflow.run.terminal", NOW, { run_id: "wfr-exec-abc", status: "completed" }, "wfr-exec-abc"),
        row("workflow.run.started", NOW - 60_000, { run_id: "wfr-exec-abc", source_task_id: "ops-manual-v3" }, "wfr-exec-abc"),
      ],
      { now: NOW },
    );
    assert.equal(intents.length, 2);
    assert.equal(intents[0].type, "workflow.run");
    assert.match(intents[0].title, /completed/);
    assert.equal(intents[0].component.name, "WorkflowRunPanel");
    assert.match(intents[1].title, /ops-manual-v3/);
  });

  it("maps executor-dispatched subagent terminal (wfr- trace) but not plain manager tasks", () => {
    const intents = buildActionUiIntents(
      [
        row("manager.task.replied", NOW, { agent_id: "agent-654bee02-x" }, "wfr-exec-abc-p-p1-a-0-t"),
        row("manager.task.replied", NOW - 10, { agent_id: "agent-654bee02-x" }, "task-ordinary"),
      ],
      { now: NOW },
    );
    assert.equal(intents[0].type, "workflow.run");
    assert.match(intents[0].title, /Subagent replied/);
    const props = intents[0].component.props as { runId?: string };
    assert.equal(props.runId, "wfr-exec-abc");
    assert.notEqual(intents[1].type, "workflow.run");
  });

  it("skipped dispatch rows do not appear; result carries lifecycle in props", () => {
    const intents = buildActionUiIntents(
      [
        row("tool.repo.read.result", NOW, { input: { path: "a" } }),
        row("tool.repo.read.dispatch", NOW - 500, { input: { path: "a" } }),
      ],
      { now: NOW },
    );
    assert.equal(intents.length, 1);
    const props = intents[0].component.props as { lifecycle?: { status: string; durationMs: number } };
    assert.equal(props.lifecycle?.status, "ok");
    assert.equal(props.lifecycle?.durationMs, 500);
  });
});

describe("same-tool burst pairing ( feed observation)", () => {
  it("pairs by path so interleaved reads of different files don't cross-consume", () => {
    const rows = [
      row("tool.repo.read.result", NOW, { input: { path: "b.ts" } }),
      row("tool.repo.read.result", NOW - 100, { input: { path: "a.ts" } }),
      row("tool.repo.read.dispatch", NOW - 700, { input: { path: "b.ts" } }),
      row("tool.repo.read.dispatch", NOW - 800, { input: { path: "a.ts" } }),
    ];
    const out = annotateLifecycleRows(rows);
    assert.deepEqual(out[0].lifecycle, { status: "ok", durationMs: 700 });
    assert.deepEqual(out[1].lifecycle, { status: "ok", durationMs: 700 });
    assert.equal(out[2].skip, true);
    assert.equal(out[3].skip, true);
  });
});


describe("result previews ()", () => {
  it("file read surfaces a bounded content preview", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const intents = buildActionUiIntents(
      [row("tool.repo.read.result", NOW, { input: { path: "x.ts" }, output: { content } })],
      { now: NOW },
    );
    const props = intents[0].component.props as { resultPreview?: string };
    assert.equal(typeof props.resultPreview, "string");
    assert.ok(props.resultPreview!.includes("line 0"));
    // capped at 30 lines
    assert.ok(!props.resultPreview!.includes("line 40"));
  });

  it("grep surfaces match count + file:line preview", () => {
    const intents = buildActionUiIntents(
      [row("tool.repo.grep.result", NOW, {
        output: {
          pattern: "Foo",
          files_scanned: 12,
          matches: [
            { file: "a.ts", line: 3, text: "class Foo {" },
            { file: "b.ts", line: 9, text: "new Foo()" },
          ],
        },
      })],
      { now: NOW },
    );
    assert.equal(intents[0].type, "tool.search_results");
    assert.match(intents[0].summary ?? "", /2 matches/);
    const props = intents[0].component.props as { resultPreview?: string };
    assert.match(props.resultPreview ?? "", /a\.ts:3: class Foo/);
  });

  it("gate failure surfaces exit + bounded stdout", () => {
    const intents = buildActionUiIntents(
      [row("tool.gate.typecheck.result", NOW, {
        target: "typecheck", ok: false, exit_code: 2, duration_ms: 71582,
        stdout: "src/x.ts(1,1): error TS2307: Cannot find module 'zod'",
      })],
      { now: NOW },
    );
    assert.equal(intents[0].type, "tool.execution_result");
    assert.match(intents[0].title, /✗ gate\.typecheck/);
    const props = intents[0].component.props as { preview?: string };
    assert.match(props.preview ?? "", /TS2307/);
  });

  it("byte-caps a multibyte preview ( lesson)", () => {
    const content = "界".repeat(2000); // 6KB UTF-8
    const intents = buildActionUiIntents(
      [row("tool.repo.read.result", NOW, { input: { path: "x" }, output: { content } })],
      { now: NOW },
    );
    const props = intents[0].component.props as { resultPreview?: string };
    assert.ok(new TextEncoder().encode(props.resultPreview ?? "").length <= 1536 + 8);
  });
});

describe("file read path carried from dispatch ()", () => {
  it("a read.result with only output still maps to file_read using the paired dispatch path", () => {
    const intents = buildActionUiIntents(
      [
        // result row (newest) lacks input.path — only output.content
        row("tool.repo.read.result", NOW, { output: { content: "hello\nworld" } }),
        // dispatch row carries the path
        row("tool.repo.read.dispatch", NOW - 200, { input: { path: "src/x.ts" } }),
      ],
      { now: NOW },
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0].type, "tool.file_read");
    assert.match(intents[0].title, /src\/x\.ts/);
    const props = intents[0].component.props as { resultPreview?: string };
    assert.match(props.resultPreview ?? "", /hello/);
  });
});


describe("auto-dispatch marker ()", () => {
  it("marks a gate result whose task+target had an autodispatch.start", () => {
    const intents = buildActionUiIntents(
      [
        row("tool.gate.typecheck.result", NOW, { target: "typecheck", ok: true, exit_code: 0 }, "task-z"),
        row("tool.gate_intent.autodispatch.start", NOW - 1000, { taskId: "task-z", target: "typecheck" }, "task-z"),
      ],
      { now: NOW },
    );
    const gate = intents.find((i) => i.sourceEventType === "tool.gate.typecheck.result")!;
    assert.equal((gate.component.props as { autoDispatched?: boolean }).autoDispatched, true);
  });

  it("does NOT mark an agent-invoked gate (no autodispatch.start)", () => {
    const intents = buildActionUiIntents(
      [row("tool.gate.build.result", NOW, { target: "build", ok: true, exit_code: 0 }, "task-z")],
      { now: NOW },
    );
    const gate = intents.find((i) => i.sourceEventType === "tool.gate.build.result")!;
    assert.notEqual((gate.component.props as { autoDispatched?: boolean }).autoDispatched, true);
  });
});
