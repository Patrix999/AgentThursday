/**
 *  — concurrency-isolation tests for the manager turn
 * context AsyncLocalStorage.
 *
 *  stored the in-flight outer `manager_task_id` on DO
 * instance fields and verifier FAILed because async manager tasks
 * can interleave inside the same DO during `await` of LLM/tool/RPC
 * work. Task B's `submitManagerTask` overwrote Task A's fields; when
 * Task A's `manager.agent_message` adapter then read
 * `getCurrentManagerContext()`, it got B's outer id, and the
 * `try/finally` in `submitManagerTask` could clear B's still-live
 * context. This file pins the post-fix invariant: each
 * `runWithManagerTurnContext` call gets a store that survives await
 * yields and does not bleed into other concurrent calls.
 *
 * The Promise.all + explicit `setTimeout(0)` yield is load-bearing.
 * Sequential awaits would not catch the original bug — interleaving
 * only manifests when one branch's await yields the event loop to
 * another branch's body.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  runWithManagerTurnContext,
  getManagerTurnContext,
  type ManagerTurnContext,
} from "./managerTurnContext";

const CTX_A: ManagerTurnContext = {
  managerTaskId: "task-outer-A",
  agentId: "agent-manager-A",
  source: "discord",
  conversationId: "conv-A",
};

const CTX_B: ManagerTurnContext = {
  managerTaskId: "task-outer-B",
  agentId: "agent-manager-A", // same DO instance
  source: "discord",
  conversationId: "conv-B",
};

const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("managerTurnContext — AsyncLocalStorage isolation", () => {
  it("returns null outside any run() scope", () => {
    assert.equal(getManagerTurnContext(), null);
  });

  it("returns the active context inside a run() scope", async () => {
    const observed = await runWithManagerTurnContext(CTX_A, async () => {
      return getManagerTurnContext();
    });
    assert.deepEqual(observed, CTX_A);
  });

  it("nested run() shadows then restores the outer store", async () => {
    await runWithManagerTurnContext(CTX_A, async () => {
      assert.deepEqual(getManagerTurnContext(), CTX_A);
      await runWithManagerTurnContext(CTX_B, async () => {
        assert.deepEqual(getManagerTurnContext(), CTX_B);
      });
      assert.deepEqual(
        getManagerTurnContext(),
        CTX_A,
        "outer scope must restore after inner run() returns",
      );
    });
    assert.equal(getManagerTurnContext(), null);
  });

  it(
    "two overlapping runs do not stomp each other across await yields",
    async () => {
      // Force the event loop to interleave: Task A yields a tick,
      // Task B advances to completion in between, then Task A resumes
      // and re-reads its store. With the  instance-field
      // implementation, A's re-read would return B's context (or
      // null, if B's finally already cleared it). With ALS, A's chain
      // keeps its own store.
      const aReadAfterYield = runWithManagerTurnContext(CTX_A, async () => {
        const before = getManagerTurnContext();
        await yieldTick();
        const after = getManagerTurnContext();
        return { before, after };
      });

      const bRead = runWithManagerTurnContext(CTX_B, async () => {
        // No yield: this branch runs to completion before A resumes.
        return getManagerTurnContext();
      });

      const [a, b] = await Promise.all([aReadAfterYield, bRead]);
      assert.deepEqual(a.before, CTX_A, "A's pre-yield store must be CTX_A");
      assert.deepEqual(
        a.after,
        CTX_A,
        "A's post-yield store must still be CTX_A even though B ran in between",
      );
      assert.deepEqual(b, CTX_B, "B's store must be CTX_B");
    },
  );

  it(
    "two interleaving runs both yielding mid-flight stay isolated",
    async () => {
      // Symmetric case: both branches yield, so the event loop
      // alternates body-by-body. Same invariant must hold.
      const reads = await Promise.all([
        runWithManagerTurnContext(CTX_A, async () => {
          await yieldTick();
          const mid = getManagerTurnContext();
          await yieldTick();
          const end = getManagerTurnContext();
          return { mid, end };
        }),
        runWithManagerTurnContext(CTX_B, async () => {
          await yieldTick();
          const mid = getManagerTurnContext();
          await yieldTick();
          const end = getManagerTurnContext();
          return { mid, end };
        }),
      ]);
      assert.deepEqual(reads[0].mid, CTX_A);
      assert.deepEqual(reads[0].end, CTX_A);
      assert.deepEqual(reads[1].mid, CTX_B);
      assert.deepEqual(reads[1].end, CTX_B);
    },
  );

  it(
    "one branch ending (analog of `submitManagerTask` finally) does not clear the still-running branch",
    async () => {
      //  bug second mode: Task A's `finally` cleared the
      // instance fields while Task B was still mid-await. ALS scope
      // termination is per-promise-chain; A returning cannot affect
      // B's store. Encode that as: A completes first, then B reads.
      let bReadAfterAReturned: ManagerTurnContext | null | "unset" = "unset";
      const bDone = runWithManagerTurnContext(CTX_B, async () => {
        await yieldTick();
        await yieldTick();
        bReadAfterAReturned = getManagerTurnContext();
      });
      const aDone = runWithManagerTurnContext(CTX_A, async () => {
        return getManagerTurnContext();
      });
      const aResult = await aDone;
      assert.deepEqual(aResult, CTX_A, "A read its own context");
      await bDone;
      assert.deepEqual(
        bReadAfterAReturned,
        CTX_B,
        "B's context survived A's scope ending",
      );
    },
  );
});
