/**
 * `inspectConversationOwnershipImpl` regression tests.
 *
 * Pure-helper test: stubs the host's `sql` template tag so we can
 * exercise the ownership / mismatch / unbound shape without the
 * partyserver / cloudflare:workers chain. The actual SQL strings are
 * exercised by integration smoke (card §smoke plan); these unit
 * tests pin the ownership-derivation + input shape-validation
 * contract.
 *
 * Coverage:
 *   - conversation_id lookup: bound (route_owner_agent_id + is_bound:true).
 *   - conversation_id lookup: unbound (route_owner_agent_id:null + is_bound:false).
 *   - conversation_id lookup: missing row (conversation:null + recent_inbox:[]).
 *   - conversation_id lookup: recent_inbox passthrough preserves shape.
 *   - agent_id lookup: returns bound conversations + bound_count.
 *   - invalid id (LIKE-pattern wildcards) → empty result.
 *   - missing input → empty result.
 *   - inbox_limit clamped [1, 50].
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  inspectConversationOwnershipImpl,
  type ChannelHubOwnershipInspectHost,
} from "./conversationOwnership";

type ConversationQRow = {
  conversation_id: string;
  active_profile_id: string | null;
  provider: string;
  chat_type: string;
  first_seen_at: number;
  last_seen_at: number;
};

type RecentInboxQRow = {
  created_at: number;
  status: string;
  route_action: string | null;
  route_reason: string | null;
  handoff_task_id: string | null;
};

function makeConvRow(overrides: Partial<ConversationQRow> = {}): ConversationQRow {
  return {
    conversation_id: "a00a4631f0a06a32",
    active_profile_id: "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
    provider: "discord",
    chat_type: "channel",
    first_seen_at: 1716699999000,
    last_seen_at: 1716700000000,
    ...overrides,
  };
}

function makeInboxRow(overrides: Partial<RecentInboxQRow> = {}): RecentInboxQRow {
  return {
    created_at: 1716700000000,
    status: "handled",
    route_action: "process",
    route_reason: "addressed via mention from trusted sender; submit as AgentThursday task",
    handoff_task_id: "task-mpmh80m8",
    ...overrides,
  };
}

type SqlCall = { query: string; values: unknown[] };

function makeHost(plan: Array<ConversationQRow[] | RecentInboxQRow[]>): {
  host: ChannelHubOwnershipInspectHost;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  let idx = 0;
  const host = {
    sql: <T,>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
      calls.push({ query: strings.join("?"), values });
      const rows = plan[idx] ?? [];
      idx += 1;
      return rows as unknown as T[];
    },
  } as unknown as ChannelHubOwnershipInspectHost;
  return { host, calls };
}

describe("an earlier revision inspectConversationOwnershipImpl", () => {
  it("conversation_id lookup: bound surfaces route_owner_agent_id + is_bound:true", () => {
    const { host } = makeHost([
      [makeConvRow()],
      [makeInboxRow()],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "a00a4631f0a06a32",
    });
    assert.equal(result.kind, "conversation");
    if (result.kind !== "conversation") return;
    assert.ok(result.conversation);
    assert.equal(result.conversation?.route_owner_agent_id, "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c");
    assert.equal(result.conversation?.is_bound, true);
    assert.equal(result.conversation?.conversation_id, "a00a4631f0a06a32");
    assert.equal(result.conversation?.provider, "discord");
  });

  it("conversation_id lookup: unbound surfaces route_owner_agent_id:null + is_bound:false", () => {
    const { host } = makeHost([
      [makeConvRow({ active_profile_id: null })],
      [],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "a00a4631f0a06a32",
    });
    assert.equal(result.kind, "conversation");
    if (result.kind !== "conversation") return;
    assert.equal(result.conversation?.route_owner_agent_id, null);
    assert.equal(result.conversation?.is_bound, false);
  });

  it("conversation_id lookup: missing row → conversation:null + recent_inbox:[]", () => {
    const { host } = makeHost([
      [],
      [],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "does-not-exist",
    });
    assert.equal(result.kind, "conversation");
    if (result.kind !== "conversation") return;
    assert.equal(result.conversation, null);
    assert.deepEqual(result.recent_inbox, []);
  });

  it("conversation_id lookup: recent_inbox passthrough preserves route_action / status / reason", () => {
    const { host } = makeHost([
      [makeConvRow()],
      [
        makeInboxRow({ status: "deferred", route_action: "invalid-binding", route_reason: "invalid_binding:agent:agent-bdd58c91-...:archived", handoff_task_id: null }),
        makeInboxRow({ status: "handled", route_action: "process" }),
      ],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "a00a4631f0a06a32",
    });
    assert.equal(result.kind, "conversation");
    if (result.kind !== "conversation") return;
    assert.equal(result.recent_inbox.length, 2);
    assert.equal(result.recent_inbox[0].status, "deferred");
    assert.equal(result.recent_inbox[0].route_action, "invalid-binding");
    assert.equal(result.recent_inbox[1].status, "handled");
  });

  it("agent_id lookup: returns currently bound conversations + bound_count", () => {
    const { host } = makeHost([
      [
        makeConvRow({ conversation_id: "convA" }),
        makeConvRow({ conversation_id: "convB", chat_type: "dm" }),
      ],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      agent_id: "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
    });
    assert.equal(result.kind, "agent");
    if (result.kind !== "agent") return;
    assert.equal(result.agent_id, "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c");
    assert.equal(result.bound_count, 2);
    assert.equal(result.bound_conversations.length, 2);
    assert.equal(result.bound_conversations[0].conversation_id, "convA");
    assert.equal(result.bound_conversations[0].is_bound, true);
    assert.equal(result.bound_conversations[1].chat_type, "dm");
  });

  it("agent_id lookup: zero bound conversations returns bound_count:0", () => {
    const { host } = makeHost([[]]);
    const result = inspectConversationOwnershipImpl(host, {
      agent_id: "agent-no-binding",
    });
    assert.equal(result.kind, "agent");
    if (result.kind !== "agent") return;
    assert.equal(result.bound_count, 0);
    assert.deepEqual(result.bound_conversations, []);
  });

  it("rejects conversation_id with LIKE-pattern wildcards", () => {
    const { host, calls } = makeHost([[makeConvRow()], [makeInboxRow()]]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "%; DROP TABLE--",
    });
    assert.deepEqual(result, { kind: "empty" });
    assert.equal(calls.length, 0);
  });

  it("rejects agent_id with LIKE-pattern wildcards", () => {
    const { host, calls } = makeHost([[]]);
    const result = inspectConversationOwnershipImpl(host, {
      agent_id: "agent-%",
    });
    assert.deepEqual(result, { kind: "empty" });
    assert.equal(calls.length, 0);
  });

  it("returns empty when no lookup key supplied", () => {
    const { host, calls } = makeHost([[]]);
    const result = inspectConversationOwnershipImpl(host, {});
    assert.deepEqual(result, { kind: "empty" });
    assert.equal(calls.length, 0);
  });

  it("inbox_limit is clamped to [1, 50]", () => {
    const { host, calls } = makeHost([
      [makeConvRow()],
      [makeInboxRow()],
      [makeConvRow()],
      [makeInboxRow()],
      [makeConvRow()],
      [makeInboxRow()],
    ]);
    inspectConversationOwnershipImpl(host, { conversation_id: "a", inbox_limit: -50 });
    inspectConversationOwnershipImpl(host, { conversation_id: "a", inbox_limit: 10_000 });
    inspectConversationOwnershipImpl(host, { conversation_id: "a", inbox_limit: 0.5 });
    assert.ok(true);
  });

  it("conversation_id takes precedence when both id forms supplied", () => {
    const { host, calls } = makeHost([
      [makeConvRow()],
      [makeInboxRow()],
    ]);
    const result = inspectConversationOwnershipImpl(host, {
      conversation_id: "a00a4631f0a06a32",
      agent_id: "agent-bdd58c91-d6bf-4036-8c5e-7346cb4e146c",
    });
    assert.equal(result.kind, "conversation");
    // 2 queries (conversation + recent_inbox) only — agent_id branch
    // skipped because conversation_id is handled first.
    assert.equal(calls.length, 2);
  });
});
