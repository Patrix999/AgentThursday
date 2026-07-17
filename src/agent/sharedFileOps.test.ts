import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateShareFileInput,
  insertSharedFileRow,
  listSharedFileRows,
  readSharedFileRow,
  inferShareMime,
  SHARED_FILE_SIZE_CAP_BYTES,
  type SharedFileRow,
} from "./sharedFileOps";

// Minimal in-memory SQL host mimicking the tagged-template `sql` surface used
// by the ops. Only the three statements the ops issue are interpreted.
function makeHost(seed: SharedFileRow[] = []) {
  const rows = [...seed];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO shared_file")) {
      const [
        file_id, owner_user_id, source_agent_id, source_agent_name, filename,
        content, sha256, size_bytes, mime, note, created_at,
      ] = values as never[];
      rows.push({
        file_id, owner_user_id, source_agent_id, source_agent_name, filename,
        content, sha256, size_bytes, mime, note, created_at,
      } as SharedFileRow);
      return [];
    }
    if (q.includes("FROM shared_file WHERE file_id =")) {
      const fileId = values[0];
      return rows.filter((r) => r.file_id === fileId).slice(0, 1) as never[];
    }
    if (q.includes("FROM shared_file WHERE owner_user_id =")) {
      const owner = values[0];
      return rows
        .filter((r) => r.owner_user_id === owner)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) as never[];
    }
    if (q.includes("FROM shared_file ORDER BY")) {
      return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) as never[];
    }
    throw new Error("unexpected query: " + q);
  };
  return { sql } as never;
}

function row(over: Partial<SharedFileRow>): SharedFileRow {
  return {
    file_id: "sf-1",
    owner_user_id: "user-a",
    source_agent_id: "agent-1",
    source_agent_name: "A",
    filename: "f.md",
    content: "hi",
    sha256: "x",
    size_bytes: 2,
    mime: "text/markdown",
    note: null,
    created_at: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

describe("validateShareFileInput", () => {
  it("accepts a normal text file and infers mime", () => {
    const v = validateShareFileInput({ filename: "report.md", content: "# hi" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.mime, "text/markdown");
  });

  it("rejects content containing a secret pattern", () => {
    const v = validateShareFileInput({
      filename: "leak.txt",
      content: "key=AKIA" + "ABCDEFGHIJ123456",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.code, "secret_pattern");
  });

  it("rejects empty content", () => {
    const v = validateShareFileInput({ filename: "e.txt", content: "" });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.code, "empty_content");
  });

  it("rejects a traversal filename", () => {
    const v = validateShareFileInput({ filename: "../etc/passwd", content: "x" });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.code, "invalid_filename");
  });

  it("caps by UTF-8 byte length, not string length", () => {
    // 600 multi-byte chars = 1800 bytes; well under cap — but prove byte math by
    // building content just over the cap with multi-byte chars.
    const overBytes = "界".repeat(SHARED_FILE_SIZE_CAP_BYTES / 3 + 10); // each '界' = 3 bytes
    const v = validateShareFileInput({ filename: "big.txt", content: overBytes });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.code, "oversize");
  });

  it("inferShareMime defaults to text/plain", () => {
    assert.equal(inferShareMime("notes"), "text/plain");
    assert.equal(inferShareMime("a.json"), "application/json");
  });
});

describe("owner-scoped reads", () => {
  it("listSharedFileRows scoped to an owner sees only its rows", () => {
    const host = makeHost([
      row({ file_id: "sf-a", owner_user_id: "user-a" }),
      row({ file_id: "sf-b", owner_user_id: "user-b" }),
    ]);
    const a = listSharedFileRows(host, "user-a");
    assert.deepEqual(a.map((r) => r.file_id), ["sf-a"]);
  });

  it("listSharedFileRows admin (undefined scope) sees all", () => {
    const host = makeHost([
      row({ file_id: "sf-a", owner_user_id: "user-a" }),
      row({ file_id: "sf-b", owner_user_id: "user-b" }),
    ]);
    const all = listSharedFileRows(host, undefined);
    assert.equal(all.length, 2);
  });

  it("readSharedFileRow returns null for a cross-owner read (no leak)", () => {
    const host = makeHost([row({ file_id: "sf-a", owner_user_id: "user-a" })]);
    assert.equal(readSharedFileRow(host, "sf-a", "user-b"), null);
  });

  it("readSharedFileRow returns the row for the owning user", () => {
    const host = makeHost([row({ file_id: "sf-a", owner_user_id: "user-a" })]);
    const got = readSharedFileRow(host, "sf-a", "user-a");
    assert.equal(got?.file_id, "sf-a");
  });

  it("readSharedFileRow admin (undefined scope) reads any row", () => {
    const host = makeHost([row({ file_id: "sf-a", owner_user_id: "user-a" })]);
    assert.equal(readSharedFileRow(host, "sf-a", undefined)?.file_id, "sf-a");
  });

  it("insert then list round-trips for the owner", () => {
    const host = makeHost();
    insertSharedFileRow(host, row({ file_id: "sf-x", owner_user_id: "user-x" }));
    assert.deepEqual(listSharedFileRows(host, "user-x").map((r) => r.file_id), ["sf-x"]);
  });
});
