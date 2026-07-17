import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { checkDispatchOwnership } from "./dispatchOwnership";
import { tryGetOwnAgentId } from "../skillset/adapters/managerCtx";
import type { RequestIdentity } from "./requestIdentity";

/**
 * agent-initiated dispatch inherits the dispatching agent's owner.
 * Two units:
 *   - `checkDispatchOwnership`: the ownership gate a scoped dispatcher passes
 *     through before any dispatch / ledger write.
 *   - `tryGetOwnAgentId`: resolves the dispatcher from its own DO id
 *     (`this.name`), ALWAYS available (no in-flight-manager-round dependency),
 *     so the security path never falls back to admin (fail-open).
 */

const ADMIN: RequestIdentity = { kind: "admin" };
const ALICE: RequestIdentity = { kind: "user", userId: "user-alice" };
const BOB: RequestIdentity = { kind: "user", userId: "user-bob" };

// Owner-scoped readAgentProfile (an earlier revision semantics): a scoped caller only
// sees agents it owns; a cross-tenant id reads as null (no existence leak).
function makeOwnerScopedRegistry(agents: Record<string, string>) {
  return {
    readAgentProfile: async (
      id: string,
      identity?: RequestIdentity,
    ): Promise<{ owner_user_id?: string } | null> => {
      const owner = agents[id];
      if (owner === undefined) return null;
      if (identity !== undefined && identity.kind === "user" && identity.userId !== owner) {
        return null;
      }
      return { owner_user_id: owner };
    },
  };
}

const AGENTS = {
  "agent-alice-1": "user-alice",
  "agent-bob-1": "user-bob",
  "agent-admin-1": "user-admin",
};

describe("checkDispatchOwnership — an earlier revision dispatch ownership gate", () => {
  it("scoped dispatcher CANNOT dispatch to another tenant's agent (target_not_found)", async () => {
    const reg = makeOwnerScopedRegistry(AGENTS);
    const block = await checkDispatchOwnership(reg, "agent-bob-1", ALICE);
    assert.ok(block !== null, "expected a block result");
    assert.equal(block!.ok, false);
    assert.equal(block!.status, "failed");
    assert.equal(block!.error?.code, "target_not_found");
  });

  it("scoped dispatcher CAN dispatch to its own agent (null = proceed)", async () => {
    const reg = makeOwnerScopedRegistry(AGENTS);
    assert.equal(await checkDispatchOwnership(reg, "agent-alice-1", ALICE), null);
  });

  it("a nonexistent target is indistinguishable from cross-tenant (no existence leak)", async () => {
    const reg = makeOwnerScopedRegistry(AGENTS);
    const ghost = await checkDispatchOwnership(reg, "agent-ghost", ALICE);
    const foreign = await checkDispatchOwnership(reg, "agent-bob-1", ALICE);
    assert.equal(ghost?.error?.code, "target_not_found");
    assert.equal(foreign?.error?.code, "target_not_found");
  });

  it("admin (and undefined identity) dispatch freely — no ownership check", async () => {
    const reg = makeOwnerScopedRegistry(AGENTS);
    assert.equal(await checkDispatchOwnership(reg, "agent-bob-1", ADMIN), null);
    assert.equal(await checkDispatchOwnership(reg, "agent-alice-1", undefined), null);
  });

  it("a different scoped tenant is also confined to its own agents", async () => {
    const reg = makeOwnerScopedRegistry(AGENTS);
    assert.equal((await checkDispatchOwnership(reg, "agent-alice-1", BOB))?.error?.code, "target_not_found");
    assert.equal(await checkDispatchOwnership(reg, "agent-bob-1", BOB), null);
  });
});

describe("tryGetOwnAgentId — an earlier revision dispatcher resolution (fail-closed)", () => {
  it("returns this.name from a ctx that exposes getOwnAgentId", () => {
    assert.equal(tryGetOwnAgentId({ getOwnAgentId: () => "agent-dispatcher" }), "agent-dispatcher");
  });

  it("is available WITHOUT an in-flight manager round (no getCurrentManagerContext needed)", () => {
    // The whole point: dispatcher id does not depend on a manager turn being
    // active, so a scoped agent calling manager.agent_message directly in its
    // loop still resolves an owner (→ no admin fallback).
    const ctxNoManagerRound = { getOwnAgentId: () => "agent-x" };
    assert.equal(tryGetOwnAgentId(ctxNoManagerRound), "agent-x");
  });

  it("returns null (→ caller fails closed) when ctx is absent / wrong shape / empty id", () => {
    assert.equal(tryGetOwnAgentId(null), null);
    assert.equal(tryGetOwnAgentId(undefined), null);
    assert.equal(tryGetOwnAgentId({}), null);
    assert.equal(tryGetOwnAgentId({ getOwnAgentId: () => "" }), null);
    assert.equal(tryGetOwnAgentId({ getOwnAgentId: () => 42 }), null);
  });
});
