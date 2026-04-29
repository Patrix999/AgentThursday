/**
 * M7.4 v2 Card 112 — Local-fs / static docs ContentSource connector.
 *
 * Card 111 design (`docs/design/2026-04-28-m7.4-v2-provider-selection.md`)
 * picked Local-fs as the v2 first additional provider. Implementation form:
 * a hardcoded fixture map shipped with the worker. The connector exists to
 * validate `ContentSourceConnector` abstraction (different I/O / auth /
 * revision model than GitHub) and to give future dogfoods a known, stable,
 * non-network ContentSource.
 *
 * Acknowledged abstraction-pressure weakness: no network, no auth, no rate
 * limit (per design doc §二). v2 後續 connector must supply the missing
 * dimensions. This file does NOT pretend to validate those.
 *
 * Out of scope (per Card 112 §Out-of-scope and §Constraints):
 *   - no write
 *   - no search (Card 113 will not include local-fs in fan-out by capability)
 *   - no OAuth / vault / refresh token
 *   - no Tier 0 workspace bridging (workspace remains agent-private; this
 *     connector serves a fixed in-process fixture, NOT the agent workspace)
 */

import type {
  ContentSource,
  ContentRevision,
  ContentRef,
  ContentReadResult,
  ContentListResult,
  ContentFileEntry,
} from "./schema";

export const LOCAL_FS_SOURCE_ID = "agent-thursday-local-fixture";

/**
 * Hardcoded fixture map for the Local-fs connector. Keys are fixture paths
 * (slash-separated, no leading slash). Values are file content as strings.
 * Directories are inferred by walking the keys.
 *
 * Deliberately small. The fixtures exist for connector-abstraction validation
 * and as a stable target for future dogfoods, not as a content corpus.
 */
const LOCAL_FS_FIXTURES: Readonly<Record<string, string>> = {
  "README.md": [
    "# AgentThursday Local Fixture (v2 abstraction validator)",
    "",
    "This is the M7.4 v2 Card 112 Local-fs connector fixture corpus.",
    "It exists to prove ContentSource abstraction works for a non-GitHub",
    "provider (no network, no token, no rate limit, content-hash revision).",
    "",
    "It is **not** the agent's Tier 0 workspace. It is a fixed dev fixture",
    "shipped inside the worker at deploy time.",
    "",
    "See `docs/design/2026-04-28-m7.4-v2-provider-selection.md` for design.",
    "",
  ].join("\n"),
  "samples/hello.txt": "Hello from the AgentThursday local fixture.\nLine 2.\nLine 3.\n",
  "samples/config.json": JSON.stringify({
    name: "agent-thursday-local-fixture",
    purpose: "M7.4 v2 abstraction validator",
    revisionStrategy: "content-hash",
  }, null, 2) + "\n",
  "docs/local-fs-test.md": [
    "# Local-fs Test Doc",
    "",
    "If you can read this via `content_read({sourceId:\"" + LOCAL_FS_SOURCE_ID + "\", path:\"docs/local-fs-test.md\"})`,",
    "the Card 112 Local-fs connector skeleton is working end-to-end.",
    "",
  ].join("\n"),
};

/**
 * Stable error class with the same shape as `GithubContentError` so the
 * `ContentHubAgent.ghErrorToContentError` mapping path can adopt it without
 * needing a third error type. Keeps the audit / error-code surface uniform.
 */
export class LocalFsContentError extends Error {
  constructor(
    public readonly code:
      | "not-found"
      | "not-a-directory"
      | "denied"
      | "internal",
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "LocalFsContentError";
  }
}

/** Normalize a request path: strip leading slash, drop empty segments, reject `..`. */
function normalizePath(rawPath: string): string {
  if (rawPath === "" || rawPath === "/") return "";
  // Reject backslash, null bytes, traversal — same posture as Card 108 path policy.
  if (rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new LocalFsContentError("denied", null, `unsafe path: ${rawPath}`);
  }
  const segments = rawPath.split("/").filter(s => s.length > 0);
  if (segments.some(s => s === "..")) {
    throw new LocalFsContentError("denied", null, `path traversal: ${rawPath}`);
  }
  return segments.join("/");
}

/**
 * Synthesize a content-hash revision (Card 111 design §二/§三). Uses a
 * lightweight FNV-1a 64-bit hash so we don't need WebCrypto; we don't need
 * cryptographic strength here, just stable per-content identity. Output is
 * 16 hex chars used both as `snapshotId` and as the short `revisionLabel`
 * suffix (mirroring `main@<7-of-sha>` shape from GitHub).
 *
 * If the fixture content changes at deploy time, the hash changes and the
 * revision-pinned cache key naturally invalidates (per ADR §6).
 */
export function contentHashRevision(content: string): { revision: ContentRevision; revisionLabel: string } {
  // FNV-1a 64-bit (BigInt). Stable, fast, no crypto dependency.
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < content.length; i++) {
    hash ^= BigInt(content.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  const hex = hash.toString(16).padStart(16, "0");
  return {
    revision: { kind: "snapshot", snapshotId: hex },
    revisionLabel: `local@${hex.slice(0, 7)}`,
  };
}

function buildLocalFsRef(
  source: ContentSource,
  path: string,
  revision: ContentRevision,
  revisionLabel: string,
  cacheStatus: ContentRef["cacheStatus"],
): ContentRef {
  return {
    sourceId: source.id,
    provider: "local-fs",
    pathOrId: path,
    revision,
    revisionLabel,
    fetchedAt: Date.now(),
    permissionScope: "read",
    cacheStatus,
  };
}

/** Read a fixture file. Throws `LocalFsContentError("not-found", ...)` if missing. */
export function localFsRead(source: ContentSource, rawPath: string): ContentReadResult {
  const normalized = normalizePath(rawPath);
  if (normalized === "") {
    throw new LocalFsContentError("not-found", null, "empty path is not a file");
  }
  const content = LOCAL_FS_FIXTURES[normalized];
  if (content === undefined) {
    // Distinguish "directory exists but path is a directory not a file"
    if (Object.keys(LOCAL_FS_FIXTURES).some(k => k.startsWith(normalized + "/"))) {
      throw new LocalFsContentError("not-a-directory", null, `path ${normalized} is a directory, not a file`);
    }
    throw new LocalFsContentError("not-found", null, `file not found: ${normalized}`);
  }
  const { revision, revisionLabel } = contentHashRevision(content);
  return {
    ref: buildLocalFsRef(source, normalized, revision, revisionLabel, "miss"),
    content,
    contentType: "text/plain; charset=utf-8",
    size: content.length,
  };
}

/**
 * List fixture entries at the given prefix. Empty path returns top-level.
 * Directories synthesized from key prefixes.
 */
export function localFsList(source: ContentSource, rawPath: string): ContentListResult {
  const normalized = normalizePath(rawPath);
  const prefix = normalized === "" ? "" : normalized + "/";
  const keys = Object.keys(LOCAL_FS_FIXTURES);

  // Reject if normalized is itself a file (not a directory).
  if (normalized !== "" && LOCAL_FS_FIXTURES[normalized] !== undefined) {
    throw new LocalFsContentError("not-a-directory", null, `path ${normalized} is a file, not a directory`);
  }

  const directChildren = new Map<string, "file" | "directory">();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const remainder = key.slice(prefix.length);
    if (remainder.length === 0) continue;
    const slashIdx = remainder.indexOf("/");
    if (slashIdx === -1) {
      directChildren.set(remainder, "file");
    } else {
      const dirName = remainder.slice(0, slashIdx);
      if (!directChildren.has(dirName)) directChildren.set(dirName, "directory");
    }
  }

  if (normalized !== "" && directChildren.size === 0) {
    throw new LocalFsContentError("not-found", null, `directory not found: ${normalized}`);
  }

  const entries: ContentFileEntry[] = [...directChildren.entries()]
    .map(([name, type]) => ({
      name,
      pathOrId: prefix + name,
      type,
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // Synthesize a revision for the listing itself: hash of all entry paths.
  // Stable across reads if fixture map doesn't change at deploy.
  const listSignature = entries.map(e => `${e.type}:${e.pathOrId}`).join("\n");
  const { revision, revisionLabel } = contentHashRevision(listSignature);

  return {
    ref: buildLocalFsRef(source, normalized, revision, revisionLabel, "fresh"),
    entries,
  };
}

/** Cheap health probe — fixture map is in-process and always available. */
export function localFsHealth(): { ok: true; entryCount: number } {
  return { ok: true, entryCount: Object.keys(LOCAL_FS_FIXTURES).length };
}
