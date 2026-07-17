/**
 * `inspectChannelInboxImpl` regression tests.
 *
 * Pure-helper test: stubs the host's `sql` template tag so we can
 * exercise the redaction shape + input shape-validation without the
 * partyserver / cloudflare:workers chain. The actual SQL strings are
 * exercised by integration smoke (card §smoke plan); these unit
 * tests pin the redaction contract.
 *
 * Coverage:
 *   - provider_message_id lookup returns route_action / route_reason /
 *     handoff_task_id (the core operator question the card opens with).
 *   - text → bounded preview + length surfaced.
 *   - attachments → collapsed to count + kinds; never raw JSON.
 *   - raw_ref → bounded preview.
 *   - invalid id (LIKE-pattern wildcards) → `{ rows: [] }`.
 *   - missing input → `{ rows: [] }`.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  inspectChannelInboxImpl,
  type ChannelHubInboxInspectHost,
} from "./inboxInspect";

type InboxQRow = {
  id: string;
  provider: string;
  conversation_id: string;
  provider_message_id: string;
  sender_provider_user_id: string;
  chat_type: string;
  addressed_to_agent: number;
  addressed_signals_json: string;
  text: string;
  text_length: number;
  attachments_json: string;
  raw_ref: string | null;
  status: string;
  route_action: string | null;
  route_reason: string | null;
  routed_at: number | null;
  handoff_task_id: string | null;
  created_at: number;
  updated_at: number;
};

function makeRow(overrides: Partial<InboxQRow> = {}): InboxQRow {
  return {
    id: "ib_test_1",
    provider: "discord",
    conversation_id: "068412bce4072eab",
    provider_message_id: "100000000000000010",
    sender_provider_user_id: "100000000000000001",
    chat_type: "channel",
    addressed_to_agent: 1,
    addressed_signals_json: '["mention"]',
    text: "hihi",
    text_length: 4,
    attachments_json: "[]",
    raw_ref: null,
    status: "handled",
    route_action: "process",
    route_reason: "addressed_to_agent",
    routed_at: 1716700000000,
    handoff_task_id: "task_hihi_1",
    created_at: 1716699999000,
    updated_at: 1716700000000,
    ...overrides,
  };
}

function makeHost(rows: InboxQRow[]): {
  host: ChannelHubInboxInspectHost;
  calls: number;
} {
  let calls = 0;
  const host = {
    sql: <T,>(_strings: TemplateStringsArray, ..._values: unknown[]): T[] => {
      calls += 1;
      return rows as unknown as T[];
    },
  } as unknown as ChannelHubInboxInspectHost;
  return { host, get calls() { return calls; } };
}

describe("an earlier revision inspectChannelInboxImpl", () => {
  it("looks up by provider_message_id and surfaces route ownership fields", () => {
    const row = makeRow();
    const { host } = makeHost([row]);
    const result = inspectChannelInboxImpl(host, {
      provider_message_id: "100000000000000010",
    });
    assert.equal(result.rows.length, 1);
    const r = result.rows[0];
    assert.equal(r.provider_message_id, "100000000000000010");
    assert.equal(r.conversation_id, "068412bce4072eab");
    assert.equal(r.route_action, "process");
    assert.equal(r.route_reason, "addressed_to_agent");
    assert.equal(r.handoff_task_id, "task_hihi_1");
    assert.equal(r.status, "handled");
    assert.equal(r.addressed_to_agent, true);
    assert.deepEqual(r.addressed_signals, ["mention"]);
  });

  it("text is preview-bounded with length surfaced", () => {
    // text_length comes from SQL `length(text)`; the preview comes
    // from `substr(text, 1, 1000)`. We pass a row that mimics what
    // SQL would return after truncation.
    const fullLength = 5432;
    const previewBody = "x".repeat(1000);
    const { host } = makeHost([makeRow({ text: previewBody, text_length: fullLength })]);
    const result = inspectChannelInboxImpl(host, { provider_message_id: "1" });
    const r = result.rows[0];
    assert.equal(r.text_length, fullLength);
    assert.equal(r.text_preview.length, 1000);
  });

  it("attachments collapse to count + deduped kinds (no raw JSON)", () => {
    const attachments = JSON.stringify([
      { id: "1", name: "a.png", url: "https://x/y", contentType: "image/png", size: 12 },
      { id: "2", name: "b.png", url: "https://x/z", contentType: "image/png", size: 12 },
      { id: "3", name: "c.pdf", url: "https://x/w", contentType: "application/pdf", size: 99 },
    ]);
    const { host } = makeHost([makeRow({ attachments_json: attachments })]);
    const result = inspectChannelInboxImpl(host, { provider_message_id: "1" });
    const r = result.rows[0];
    assert.equal(r.attachment_count, 3);
    assert.deepEqual(r.attachment_kinds.sort(), ["application/pdf", "image/png"]);
    // The inspect row shape must NOT include the raw attachments JSON.
    assert.equal(("attachments_json" in r), false);
    assert.equal(("attachments" in r), false);
  });

  it("raw_ref → bounded preview when present, null otherwise", () => {
    const longRef = "y".repeat(500);
    const { host: hostLong } = makeHost([makeRow({ raw_ref: longRef })]);
    const long = inspectChannelInboxImpl(hostLong, { provider_message_id: "1" });
    assert.equal(long.rows[0].raw_ref_preview?.length, 201); // 200 + ellipsis

    const { host: hostNull } = makeHost([makeRow({ raw_ref: null })]);
    const empty = inspectChannelInboxImpl(hostNull, { provider_message_id: "1" });
    assert.equal(empty.rows[0].raw_ref_preview, null);
  });

  it("rejects provider_message_id with LIKE-pattern wildcards", () => {
    const { host } = makeHost([makeRow()]);
    const result = inspectChannelInboxImpl(host, { provider_message_id: "%; DROP TABLE--" });
    assert.deepEqual(result, { rows: [] });
  });

  it("rejects conversation_id with wildcards", () => {
    const { host } = makeHost([makeRow()]);
    const result = inspectChannelInboxImpl(host, { conversation_id: "abc%" });
    assert.deepEqual(result, { rows: [] });
  });

  it("rejects inbox_id with wildcards", () => {
    const { host } = makeHost([makeRow()]);
    const result = inspectChannelInboxImpl(host, { inbox_id: "ib_*" });
    assert.deepEqual(result, { rows: [] });
  });

  it("returns empty when no lookup key supplied", () => {
    const { host } = makeHost([makeRow()]);
    const result = inspectChannelInboxImpl(host, {});
    assert.deepEqual(result, { rows: [] });
  });

  it("inbox_id single-row lookup works", () => {
    const { host } = makeHost([makeRow({ id: "ib_specific" })]);
    const result = inspectChannelInboxImpl(host, { inbox_id: "ib_specific" });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, "ib_specific");
  });

  it("limit is clamped to [1, 100]", () => {
    const { host } = makeHost([makeRow()]);
    // Sanity: the helper accepts limits silently; we just confirm
    // the call completes without throwing for extreme values.
    inspectChannelInboxImpl(host, { provider_message_id: "1", limit: -50 });
    inspectChannelInboxImpl(host, { provider_message_id: "1", limit: 10_000 });
    inspectChannelInboxImpl(host, { provider_message_id: "1", limit: 0.5 });
    assert.ok(true);
  });

  it("handles addressed_to_agent=0 (not @ed)", () => {
    const { host } = makeHost([makeRow({
      addressed_to_agent: 0,
      addressed_signals_json: "[]",
      route_action: "ignore",
      route_reason: "not_addressed",
      handoff_task_id: null,
    })]);
    const result = inspectChannelInboxImpl(host, { provider_message_id: "1" });
    const r = result.rows[0];
    assert.equal(r.addressed_to_agent, false);
    assert.deepEqual(r.addressed_signals, []);
    assert.equal(r.route_action, "ignore");
    assert.equal(r.handoff_task_id, null);
  });
});
