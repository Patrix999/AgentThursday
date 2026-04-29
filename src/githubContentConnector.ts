/**
 * GitHub connector v1 (read + list).
 *
 * Pure module: no Workers DO imports. Imported by `ContentHubAgent` (DO),
 * by the  smoke (Node runtime), and by `server.ts` API routes.
 *
 * Strategy (ADR §6 revision-pinned):
 *   1. Resolve user ref (branch/tag/sha) → concrete commit SHA via
 *      GET /repos/{owner}/{repo}/commits/{ref}
 *   2. Fetch file content via raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}
 *      (raw URL avoids base64 decode and skips the 1MB Contents-API ceiling).
 *   3. List directory via GET /repos/{owner}/{repo}/contents/{path}?ref={sha}
 *
 * Cache is keyed by `(sourceId, path, JSON.stringify(revision))` where
 * revision is `{ kind: "git-sha", sha, ref }` — see schema.ts.
 *
 * Token handling (ADR §11): `env.GITHUB_TOKEN` is read directly by the
 * caller and passed in here; this module never logs it, never returns it
 * in any result, and only forwards it as an `Authorization: Bearer ...`
 * header to GitHub.
 */

import type {
  ContentSource,
  ContentRedaction,
  ContentFileEntry,
} from "./schema";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";

export const DEFAULT_READ_MAX_BYTES = 256 * 1024;
export const HARD_READ_MAX_BYTES = 1024 * 1024;

export class GithubContentError extends Error {
  constructor(
    public readonly code:
      | "ref-not-found"
      | "unauthorized"
      | "forbidden-or-rate-limited"
      | "ref-resolve-failed"
      | "not-found"
      | "fetch-failed"
      | "list-failed"
      | "not-a-directory"
      | "no-body"
      // search-specific failures.
      | "quota-exhausted"
      | "code-search-failed",
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GithubContentError";
  }
}

export type GithubRepo = {
  owner: string;
  repo: string;
  defaultRef: string;
};

//  hardcodes the source-id → repo mapping. + moves this to
// per-source metadata (`source.providerConfig`) once OAuth providers land.
const SOURCE_REPO_MAP: Readonly<Record<string, GithubRepo>> = {
  "agentthursday-github": { owner: "Patrix999", repo: "AgentThursday", defaultRef: "main" },
};

export function getRepoForSource(sourceId: string): GithubRepo | null {
  return SOURCE_REPO_MAP[sourceId] ?? null;
}

// ─── Path policy ─────────────────────────────────────────────────────────────
// Enforces deny-list (precedence) + allow-list before any network call. ADR
// §11 +  §scope: denied/unsafe paths must be rejected without
// touching the GitHub API, so the network is never used to enumerate
// secrets or hidden config.

export type PathPolicyOk = { ok: true; normalized: string };
export type PathPolicyDeny = {
  ok: false;
  code:
    | "path-traversal"
    | "absolute-path"
    | "backslash"
    | "null-byte"
    | "denied"
    | "not-allowed";
  reason: string;
};
export type PathPolicyResult = PathPolicyOk | PathPolicyDeny;

export function checkPath(source: ContentSource, rawPath: string): PathPolicyResult {
  if (rawPath.includes("\0")) return { ok: false, code: "null-byte", reason: "path contains null byte" };
  if (rawPath.includes("\\")) return { ok: false, code: "backslash", reason: "path contains backslash" };
  if (rawPath.startsWith("/")) return { ok: false, code: "absolute-path", reason: "absolute path not allowed" };
  if (rawPath.includes("..")) return { ok: false, code: "path-traversal", reason: "path traversal not allowed" };

  // Strip leading "./" but preserve everything else.
  const normalized = rawPath.replace(/^\.\//, "");

  const denied = source.deniedPaths ?? [];
  for (const d of denied) {
    if (normalized === d) return { ok: false, code: "denied", reason: `denied: ${d}` };
    if (normalized.startsWith(d + "/")) return { ok: false, code: "denied", reason: `denied subtree: ${d}` };
    // Also reject if the denied token appears as any path segment — catches
    // ".git/config" matching against ".git" denial regardless of nesting.
    const segs = normalized.split("/");
    if (segs.includes(d)) return { ok: false, code: "denied", reason: `denied segment: ${d}` };
  }

  const allowed = source.allowedPaths ?? [];
  for (const a of allowed) {
    if (a.endsWith("/")) {
      const stripped = a.slice(0, -1);
      if (normalized === stripped || normalized.startsWith(a)) return { ok: true, normalized };
    } else {
      if (normalized === a) return { ok: true, normalized };
    }
  }
  return { ok: false, code: "not-allowed", reason: "path not in allowed list" };
}

// ─── Secret redaction ───────────────────────────────────────────────────────
// ADR §11.6 +  §7: high-confidence patterns only. PEM private key
// blocks refuse the entire file content (kind="pem-block"). Other patterns
// replace inline and return offsets of the placeholder in the rebuilt text.

type SecretPattern = {
  kind: ContentRedaction["kind"];
  re: RegExp;
  refuseWholeFile?: boolean;
};

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // PEM private keys — refuse entire file (covers RSA/EC/DSA/OPENSSH variants)
  {
    kind: "pem-block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
    refuseWholeFile: true,
  },
  // GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_)
  { kind: "oauth-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // Slack tokens
  { kind: "oauth-token", re: /\bxox[pboas]-\d+-\d+-[A-Za-z0-9]+\b/g },
  // Generic OpenAI-style secret keys
  { kind: "api-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  // AWS access key IDs
  { kind: "api-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
];

export function redactSecrets(content: string): {
  content: string;
  redactions: ContentRedaction[];
  refusedWholeFile: boolean;
} {
  // PEM check first — short-circuit to whole-file refusal.
  for (const p of SECRET_PATTERNS) {
    if (!p.refuseWholeFile) continue;
    p.re.lastIndex = 0;
    if (p.re.test(content)) {
      return {
        content: "[REDACTED:pem-private-key — file refused per ADR §11]",
        redactions: [{ offset: 0, length: content.length, kind: "pem-block" }],
        refusedWholeFile: true,
      };
    }
  }

  // Inline replacements for the rest.
  let working = content;
  const redactions: ContentRedaction[] = [];

  for (const p of SECRET_PATTERNS) {
    if (p.refuseWholeFile) continue;
    p.re.lastIndex = 0;
    const matches: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(working)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length });
      if (m.index === p.re.lastIndex) p.re.lastIndex += 1;
    }
    if (matches.length === 0) continue;

    let next = "";
    let cursor = 0;
    const placeholder = `<REDACTED:${p.kind}>`;
    for (const { start, end } of matches) {
      next += working.slice(cursor, start);
      redactions.push({ offset: next.length, length: placeholder.length, kind: p.kind });
      next += placeholder;
      cursor = end;
    }
    next += working.slice(cursor);
    working = next;
  }

  return { content: working, redactions, refusedWholeFile: false };
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

type GhJsonOk<T> = { ok: true; data: T };
type GhJsonErr = { ok: false; status: number; bodySnippet: string };

async function ghJson<T>(url: string, token: string): Promise<GhJsonOk<T> | GhJsonErr> {
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AgentThursday-contenthub/1",
    },
  });
  if (!res.ok) {
    const bodySnippet = (await res.text()).slice(0, 300);
    return { ok: false, status: res.status, bodySnippet };
  }
  const data = (await res.json()) as T;
  return { ok: true, data };
}

/** Resolve a branch/tag/sha to a concrete commit SHA. */
export async function resolveRefToSha(repo: GithubRepo, ref: string, token: string): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`;
  const r = await ghJson<{ sha: string }>(url, token);
  if (!r.ok) {
    if (r.status === 404) throw new GithubContentError("ref-not-found", 404, `ref ${ref} not found`);
    if (r.status === 401) throw new GithubContentError("unauthorized", 401, "GitHub auth failed (check GITHUB_TOKEN)");
    if (r.status === 403) throw new GithubContentError("forbidden-or-rate-limited", 403, "GitHub forbidden / rate-limited");
    throw new GithubContentError("ref-resolve-failed", r.status, `ref resolve failed (${r.status})`);
  }
  return r.data.sha;
}

/** Fetch file content via raw URL, capped at maxBytes. */
export async function fetchRawFile(
  repo: GithubRepo,
  sha: string,
  path: string,
  token: string,
  maxBytes: number,
): Promise<{ content: string; size: number; truncated: boolean; truncatedBytes?: number }> {
  const url = `${GITHUB_RAW_BASE}/${repo.owner}/${repo.repo}/${sha}/${path}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent": "AgentThursday-contenthub/1",
    },
  });
  if (res.status === 404) throw new GithubContentError("not-found", 404, "file not found");
  if (res.status === 401) throw new GithubContentError("unauthorized", 401, "GitHub auth failed");
  if (res.status === 403) throw new GithubContentError("forbidden-or-rate-limited", 403, "GitHub forbidden / rate-limited");
  if (!res.ok) throw new GithubContentError("fetch-failed", res.status, `raw fetch failed (${res.status})`);

  const reader = res.body?.getReader();
  if (!reader) throw new GithubContentError("no-body", res.status, "no response body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }

  // Concatenate into a single Uint8Array sized at min(total, maxBytes).
  const target = Math.min(total, maxBytes);
  const merged = new Uint8Array(target);
  let cursor = 0;
  for (const c of chunks) {
    if (cursor >= target) break;
    const remaining = target - cursor;
    const take = Math.min(c.byteLength, remaining);
    merged.set(c.subarray(0, take), cursor);
    cursor += take;
  }
  // `fatal: false` so partial-utf8 (truncation cut a multi-byte char) yields
  // a replacement char rather than throwing. The agent already knows the
  // content was truncated via the `truncated` flag. Workers types require
  // both fields on the options bag.
  const content = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(merged);
  return {
    content,
    size: total,
    truncated,
    truncatedBytes: truncated ? merged.length : undefined,
  };
}

type GhContentEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
  sha: string;
};

/** List directory contents at the given commit SHA. */
export async function fetchContentsList(
  repo: GithubRepo,
  sha: string,
  path: string,
  token: string,
): Promise<ContentFileEntry[]> {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  const url = cleanPath === ""
    ? `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/contents?ref=${encodeURIComponent(sha)}`
    : `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/contents/${cleanPath}?ref=${encodeURIComponent(sha)}`;

  const r = await ghJson<GhContentEntry[] | GhContentEntry>(url, token);
  if (!r.ok) {
    if (r.status === 404) throw new GithubContentError("not-found", 404, `directory ${cleanPath} not found`);
    if (r.status === 401) throw new GithubContentError("unauthorized", 401, "GitHub auth failed");
    if (r.status === 403) throw new GithubContentError("forbidden-or-rate-limited", 403, "GitHub forbidden / rate-limited");
    throw new GithubContentError("list-failed", r.status, `list failed (${r.status})`);
  }
  // GitHub returns array for directories, object for single files. 
  // list is for directories only — fail loudly if a file path is passed.
  if (!Array.isArray(r.data)) {
    throw new GithubContentError("not-a-directory", null, `path ${cleanPath} is a file, not a directory`);
  }
  return r.data
    .map<ContentFileEntry>(e => ({
      name: e.name,
      pathOrId: e.path,
      type: e.type === "dir" ? "directory" : "file",
      size: e.type === "file" ? e.size : undefined,
    }))
    // Stable sort: directories first, then alphabetical by name.
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// ─── GitHub Code Search ─────────────────────────────────────────

type GhCodeSearchItem = {
  path: string;
  sha: string;
  score?: number;
  text_matches?: Array<{
    fragment: string;
    matches?: Array<{ text: string; indices: [number, number] }>;
  }>;
};

type GhCodeSearchResponse = {
  total_count: number;
  incomplete_results: boolean;
  items: GhCodeSearchItem[];
};

const PREVIEW_MAX = 200;

/**
 * Run GitHub Code Search REST `q=<query>+repo:owner/repo[+path:path]` and
 * return raw `{path, sha, fragment}` triples. Caller maps to ContentSearchHit
 * (the connector helper deliberately stays decoupled from ContentRef shape so
 * it can be reused outside ContentHubAgent later).
 *
 * Caveats per ADR §7.1 and the GitHub Code Search API:
 *   - 30 req/min rate limit, often hit before the generic 5000/hr.
 *   - Searches whatever branches GitHub has indexed (default branch only in
 *     practice). Caller MUST NOT promise that a non-default `ref` was searched.
 *   - 403 with rate-limit body → `quota-exhausted` (caller can offer the
 *     `bounded-local` fallback).
 */
export async function runGithubCodeSearch(
  repo: GithubRepo,
  query: string,
  pathFilter: string | undefined,
  token: string,
  maxResults: number,
): Promise<{ items: Array<{ path: string; sha: string; preview: string }>; incompleteResults: boolean; totalCount: number }> {
  const parts = [query, `repo:${repo.owner}/${repo.repo}`];
  if (pathFilter && pathFilter.length > 0) parts.push(`path:${pathFilter}`);
  const q = parts.join(" ");
  const url = `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(q)}&per_page=${Math.max(1, Math.min(100, maxResults))}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.text-match+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AgentThursday-contenthub/1",
    },
  });
  if (res.status === 401) throw new GithubContentError("unauthorized", 401, "GitHub auth failed (check GITHUB_TOKEN)");
  if (res.status === 403) {
    // 403 from GitHub Code Search is most often rate-limit. We'd ideally
    // sniff `X-RateLimit-Remaining: 0` but Workers AI also blocks 403 paths
    // wholesale, so pessimistically return quota-exhausted (the agent can
    // retry with `strategy: "bounded-local"`).
    throw new GithubContentError("quota-exhausted", 403, "GitHub Code Search quota exhausted or forbidden");
  }
  if (res.status === 422) throw new GithubContentError("code-search-failed", 422, "GitHub Code Search rejected the query");
  if (!res.ok) throw new GithubContentError("code-search-failed", res.status, `GitHub Code Search failed (${res.status})`);

  const data = (await res.json()) as GhCodeSearchResponse;
  const items = (data.items ?? []).map(it => {
    const firstFrag = it.text_matches?.[0]?.fragment ?? "";
    const preview = firstFrag.length > PREVIEW_MAX ? firstFrag.slice(0, PREVIEW_MAX) + "…" : firstFrag;
    return { path: it.path, sha: it.sha, preview };
  });
  return {
    items,
    incompleteResults: !!data.incomplete_results,
    totalCount: data.total_count ?? items.length,
  };
}

/**
 * Synthetic top-level entries derived from registry allowedPaths. Used when
 * the caller asks for `content_list("", ...)` so the agent can see what
 * subtrees / files it is allowed to read without us fetching the real repo
 * root (which would include denied paths like `.git`, `node_modules`).
 */
export function synthesizeTopLevelEntries(source: ContentSource): ContentFileEntry[] {
  const allowed = source.allowedPaths ?? [];
  return allowed
    .map<ContentFileEntry>(p => {
      const isDir = p.endsWith("/");
      const trimmed = isDir ? p.slice(0, -1) : p;
      return {
        name: trimmed,
        pathOrId: trimmed,
        type: isDir ? "directory" : "file",
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
