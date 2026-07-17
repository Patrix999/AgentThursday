import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  type AgentRunHost,
  type AgentRunSqlTag,
  type AgentRunOpsHost,
  createAgentRunRow,
  readAgentRunRow,
  listAgentRunRows,
  createAgentRun,
} from "./agentRunOps";
import type { RequestIdentity } from "./requestIdentity";

/**
 * two-table owner-aware fake (agent_run + agent_profile).
 *
 * Ownership of a run derives from its agent (agent_run.profile_id →
 * agent_profile.owner_user_id). The fake routes by canonical statement shape so
 * the admin (no-JOIN / LEFT-JOIN) and scoped (INNER-JOIN / owner-predicate)
 * forms both resolve, and asserts a scoped user can never read/list/affect
 * another tenant's runs.
 */
type ProfileRow = { id: string; owner_user_id: string; name: string };
type RunRow = {
  run_id: string;
  profile_id: string;
  workflow_instance_id: string;
  status: string;
  turn_id: string | null;
  envelope_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function makeFakeRunSql(profiles: ProfileRow[]): {
  sql: AgentRunSqlTag;
  runs: RunRow[];
} {
  const runs: RunRow[] = [];
  const ownerOf = (profileId: string): string | null =>
    profiles.find((p) => p.id === profileId)?.owner_user_id ?? null;
  const nameOf = (profileId: string): string | null =>
    profiles.find((p) => p.id === profileId)?.name ?? null;

  const sql: AgentRunSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const v = values as Array<string | number | null>;

    if (text.startsWith("INSERT INTO agent_run")) {
      const [run_id, profile_id, workflow_instance_id] = v as string[];
      runs.push({
        run_id, profile_id, workflow_instance_id,
        status: "started", turn_id: null, envelope_id: null, error: null,
        created_at: "t", updated_at: "t",
      });
      return [];
    }

    // read — scoped (INNER JOIN) vs admin (no JOIN)
    if (text.includes("INNER JOIN agent_profile")) {
      const [runId, owner] = v as string[];
      const hit = runs.find((r) => r.run_id === runId && ownerOf(r.profile_id) === owner);
      return hit ? [hit] : [];
    }
    if (text.startsWith("SELECT run_id, profile_id") && text.includes("FROM agent_run WHERE run_id")) {
      const [runId] = v as string[];
      const hit = runs.find((r) => r.run_id === runId);
      return hit ? [hit] : [];
    }

    // list — LEFT JOIN; scoped if owner predicate present
    if (text.includes("LEFT JOIN agent_profile")) {
      let i = 0;
      const profileFilter = text.includes("r.profile_id =") ? (v[i++] as string) : null;
      const owner = text.includes("p.owner_user_id =") ? (v[i++] as string) : null;
      const limit = v[i++] as number;
      let out = runs.slice();
      if (profileFilter !== null) out = out.filter((r) => r.profile_id === profileFilter);
      if (owner !== null) out = out.filter((r) => ownerOf(r.profile_id) === owner);
      return out.slice(0, limit).map((r) => ({ ...r, profile_name: nameOf(r.profile_id) }));
    }

    throw new Error(`unhandled sql in fake: ${text}`);
  }) as AgentRunSqlTag;

  return { sql, runs };
}

const ADMIN: RequestIdentity = { kind: "admin" };
const ALICE: RequestIdentity = { kind: "user", userId: "user-alice" };
const BOB: RequestIdentity = { kind: "user", userId: "user-bob" };

const PROFILES: ProfileRow[] = [
  { id: "agent-alice", owner_user_id: "user-alice", name: "Alice Agent" },
  { id: "agent-bob", owner_user_id: "user-bob", name: "Bob Agent" },
  { id: "agent-admin", owner_user_id: "user-admin", name: "Admin Agent" },
];

function seeded(): { host: AgentRunHost; runs: RunRow[] } {
  const fake = makeFakeRunSql(PROFILES);
  const host: AgentRunHost = { sql: fake.sql };
  createAgentRunRow(host, { run_id: "run-a", profile_id: "agent-alice", workflow_instance_id: "wf-a" });
  createAgentRunRow(host, { run_id: "run-b", profile_id: "agent-bob", workflow_instance_id: "wf-b" });
  createAgentRunRow(host, { run_id: "run-adm", profile_id: "agent-admin", workflow_instance_id: "wf-adm" });
  return { host, runs: fake.runs };
}

describe("agentRunOps — an earlier revision tenant isolation", () => {
  it("scoped read returns own run; cross-tenant run reads as null (no existence leak)", () => {
    const { host } = seeded();
    assert.equal(readAgentRunRow(host, "run-a", ALICE)?.run_id, "run-a");
    assert.equal(readAgentRunRow(host, "run-b", ALICE), null); // bob's run invisible to alice
    assert.equal(readAgentRunRow(host, "run-adm", ALICE), null); // admin's run invisible to alice
  });

  it("admin read sees any run (no-JOIN path, byte-identical)", () => {
    const { host } = seeded();
    assert.equal(readAgentRunRow(host, "run-a", ADMIN)?.run_id, "run-a");
    assert.equal(readAgentRunRow(host, "run-b", ADMIN)?.run_id, "run-b");
    assert.equal(readAgentRunRow(host, "run-adm")?.run_id, "run-adm"); // undefined == admin
  });

  it("scoped list shows ONLY the caller's own runs", () => {
    const { host } = seeded();
    assert.deepEqual(listAgentRunRows(host, {}, ALICE).map((r) => r.run_id), ["run-a"]);
    assert.deepEqual(listAgentRunRows(host, {}, BOB).map((r) => r.run_id), ["run-b"]);
  });

  it("admin list shows every tenant's runs", () => {
    const { host } = seeded();
    assert.deepEqual(
      listAgentRunRows(host, {}, ADMIN).map((r) => r.run_id).sort(),
      ["run-a", "run-adm", "run-b"],
    );
  });

  it("scoped ?profile_id= filter cannot reach another tenant's runs", () => {
    const { host } = seeded();
    // Alice asks for bob's agent runs → empty (owner predicate wins).
    assert.deepEqual(listAgentRunRows(host, { profile_id: "agent-bob" }, ALICE), []);
    // Alice asks for her own → her run.
    assert.deepEqual(listAgentRunRows(host, { profile_id: "agent-alice" }, ALICE).map((r) => r.run_id), ["run-a"]);
  });
});

// ── createAgentRun ownership precheck (fake registry stub + workflow) ──────

function makeOpsHost(): {
  host: AgentRunOpsHost;
  created: string[];
  workflowSpawned: string[];
} {
  const created: string[] = [];
  const workflowSpawned: string[] = [];
  const stub = {
    createAgentRun: async (input: { run_id: string; profile_id: string; workflow_instance_id: string }) => {
      created.push(input.run_id);
      return {
        run_id: input.run_id, profile_id: input.profile_id, workflow_instance_id: input.workflow_instance_id,
        status: "started" as const, turn_id: null, envelope_id: null, error: null, created_at: "t", updated_at: "t",
      };
    },
    readAgentRun: async () => null,
    listAgentRuns: async () => [],
    markAgentRunAwaitingEvent: async () => {},
    markAgentRunTimedOut: async () => {},
    // owner-filtered profile read (an earlier revision semantics): null unless ALICE owns it.
    readAgentProfile: async (id: string, identity?: RequestIdentity) => {
      const owner = PROFILES.find((p) => p.id === id)?.owner_user_id;
      if (identity !== undefined && identity.kind === "user") {
        return owner === identity.userId ? { id } : null;
      }
      return owner !== undefined ? { id } : null;
    },
  };
  const host: AgentRunOpsHost = {
    // minimal fake Workflow — only create() is used.
    workflow: {
      create: async (o: { id: string }) => {
        workflowSpawned.push(o.id);
        return { id: o.id };
      },
    } as unknown as AgentRunOpsHost["workflow"],
    getRegistryStub: async () => stub,
  };
  return { host, created, workflowSpawned };
}

describe("createAgentRun — an earlier revision ownership precheck", () => {
  it("scoped user can start a run on their OWN agent", async () => {
    const { host, created, workflowSpawned } = makeOpsHost();
    const r = await createAgentRun(host, { profile_id: "agent-alice", input: null }, ALICE);
    assert.equal(r.ok, true);
    assert.equal(created.length, 1);
    assert.equal(workflowSpawned.length, 1);
  });

  it("scoped user CANNOT start a run on another tenant's agent — and NO workflow is spawned", async () => {
    const { host, created, workflowSpawned } = makeOpsHost();
    const r = await createAgentRun(host, { profile_id: "agent-bob", input: null }, ALICE);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "not_found");
    assert.equal(r.message, "agent not found: agent-bob"); // same shape as nonexistent — no existence leak
    assert.equal(workflowSpawned.length, 0, "precheck runs BEFORE workflow.create");
    assert.equal(created.length, 0);
  });

  it("scoped not_found for a nonexistent agent is indistinguishable from cross-tenant", async () => {
    const { host } = makeOpsHost();
    const r = await createAgentRun(host, { profile_id: "agent-ghost", input: null }, ALICE);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.message, "agent not found: agent-ghost");
  });

  it("admin skips the precheck (byte-identical create path)", async () => {
    const { host, created, workflowSpawned } = makeOpsHost();
    const r = await createAgentRun(host, { profile_id: "agent-bob", input: null }, ADMIN);
    assert.equal(r.ok, true);
    assert.equal(workflowSpawned.length, 1);
    assert.equal(created.length, 1);
  });
});
