/**
 *   + 184a — Developer Shell read + git inspect dispatcher.
 *
 * Read-only surface only:
 *   - repo.read / repo.glob / repo.grep    (workspace SDK backend)
 *   - git.status / git.diff / git.log / git.show (sandbox.exec backend)
 *
 * Every dispatch:
 *   1. validates path against the global path denylist
 *   2. emits `tool.<id>.dispatch` via the supplied event sink
 *   3. runs the tool implementation (real backend if provided, stub otherwise)
 *   4. emits `tool.<id>.result` (or `tool.<id>.error`)
 *
 * 184a wires real backends:
 *   - Workspace SDK (`@cloudflare/shell` Workspace) for repo.*
 *   - `getSandbox(env.Sandbox).exec("git ...")` for git.* with an
 *     allowlisted command shape (no arbitrary shell).
 *
 * The dispatcher remains pure: backends are passed in via the
 * DispatchContext so the module is unit-testable and stub-friendly.
 */

import { TOOL_CONTRACTS, type ToolContract } from "./contractRegistry";

export const READ_TOOL_IDS = [
  "repo.read",
  "repo.glob",
  "repo.grep",
  "repo.prepare",
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
] as const;

export type ReadToolId = typeof READ_TOOL_IDS[number];

export const PATH_DENYLIST: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.dev\.vars$/i,
  /(^|\/)secrets\//i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
];

export class DenylistError extends Error {
  constructor(public reason: string, public path: string) {
    super(`devshell:denylist:${reason}:${path}`);
  }
}

export function assertPathAllowed(path: string | undefined): void {
  if (!path) return;
  for (const re of PATH_DENYLIST) {
    if (re.test(path)) throw new DenylistError(re.source, path);
  }
}

export interface DispatchEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface DispatchContext {
  emit(event: DispatchEvent): void;
  traceId?: string | null;
  /**
   * Optional workspace backend. When omitted, repo.* tools fall back
   * to the  v1 stub return shape (used in unit tests).
   */
  workspace?: WorkspaceReadBackend;
  /**
   * Optional sandbox backend for controlled `git ...` invocation.
   * When omitted, git.* tools fall back to stubs.
   */
  sandboxExec?: SandboxExec;
  /**
   * 189: when set, repo.* reads run via sandboxExec against this
   * checkout dir (e.g. `/workspace/AgentThursday`). Takes priority over
   * `workspace` for repo.* if both are set. git.* commands also
   * `cd $repoBaseDir` before running so they see the real repo.
   */
  repoBaseDir?: string;
}

export interface WorkspaceReadBackend {
  readFile(path: string): Promise<string | null>;
  glob(pattern: string): Promise<string[]>;
}

export type SandboxExec = (command: string) => Promise<{
  stdout: string;
  stderr: string;
  exit_code: number;
}>;

export interface DispatchResult {
  ok: boolean;
  tool_id: ReadToolId;
  output?: unknown;
  error?: { reason: string; details?: string };
  duration_ms: number;
  contract: { tier: number; emit_events: string[]; required_evidence: string[] };
  /**
   *  B — `sandbox` means the read ran against the prepared
   * sandbox worktree (ctx.repoBaseDir + ctx.sandboxExec). `source_read`
   * means a workspace fallback to the GitHub-source backend
   * (ctx.workspace) — file content reflects the external source, not
   * the in-flight worktree. `stub` is the test-only default when no
   * backend is wired.
   */
  backend: "sandbox" | "source_read" | "stub";
  /**
   *  B — worktree path the dispatch ran against (when
   * `backend === "sandbox"`), or null when the dispatcher fell back
   * to source_read / stub.
   */
  worktree_path: string | null;
}

const READ_FILE_BYTES_CAP = 256 * 1024;
const GLOB_DEFAULT_LIMIT = 500;
const GREP_FILE_LIMIT = 200;
const GREP_LINE_CAP = 500;
const GIT_LOG_DEFAULT_MAX = 20;

const SAFE_REF = /^[A-Za-z0-9_./-]{1,200}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_./-]{1,400}$/;

//  — path / glob hardening for sandbox-backed reads.
//
// SAFE_RELATIVE_PATH allows dots and slashes, which is fine for
// individual character validation but does NOT prevent `..` segments
// or absolute paths from sneaking in. The sandbox dispatchers
// interpolate paths into shell commands like `${baseDir}/${path}`,
// so a `../../etc/passwd` would escape the checkout. These helpers
// reject those structurally.

const PATH_SHELL_METACHAR = /[;|&$`<>"'\\(){}\[\]\s]/;
const GLOB_SHELL_METACHAR = /[;|&$`<>"'\\(){}\s]/; // glob keeps * ? [ ] expressivity but bans shell control chars

export class UnsafePathError extends Error {
  constructor(public reason: string, public input: string) {
    super(`devshell:unsafe_path:${reason}:${input}`);
  }
}

/**
 * Reject any relative path that:
 *   - is empty
 *   - is absolute (starts with `/`)
 *   - contains a `..` segment (path traversal)
 *   - contains shell metacharacters (semicolon, pipe, backtick, etc.)
 *   - contains characters outside `[A-Za-z0-9_./-]`
 *   - is longer than 400 chars
 *
 * Throws `UnsafePathError` with a precise reason. Caller propagates
 * the error to the dispatcher's catch block so it surfaces as
 * `tool.<id>.error reason=internal_error details=unsafe_path:<reason>`.
 */
export function assertSafeRepoPath(path: string): void {
  if (!path || path.length === 0) throw new UnsafePathError("empty", path);
  if (path.length > 400) throw new UnsafePathError("too_long", path);
  if (path.startsWith("/")) throw new UnsafePathError("absolute", path);
  if (PATH_SHELL_METACHAR.test(path)) throw new UnsafePathError("shell_metachar", path);
  if (!SAFE_RELATIVE_PATH.test(path)) throw new UnsafePathError("invalid_chars", path);
  // Reject any `..` path segment. Splits on `/` so `..foo` (a name
  // beginning with two dots, e.g. a real filename) is allowed; only
  // segments equal to `..` are blocked.
  for (const seg of path.split("/")) {
    if (seg === "..") throw new UnsafePathError("traversal", path);
  }
}

/**
 * Validate a glob pattern (used by repo.glob and repo.grep
 * include_glob). Stricter than path: still rejects `..` segments and
 * absolute paths, but ALLOWS the glob meta characters `*` `?` `[` `]`
 * because they are the whole point of glob.
 */
export function assertSafeGlob(pattern: string): void {
  if (!pattern || pattern.length === 0) throw new UnsafePathError("empty_glob", pattern);
  if (pattern.length > 400) throw new UnsafePathError("glob_too_long", pattern);
  if (pattern.startsWith("/")) throw new UnsafePathError("absolute_glob", pattern);
  if (GLOB_SHELL_METACHAR.test(pattern)) throw new UnsafePathError("glob_shell_metachar", pattern);
  // The set of allowed characters for globs: alnum + . _ - / + glob meta * ? [ ]
  if (!/^[A-Za-z0-9_./*?\[\]-]{1,400}$/.test(pattern)) throw new UnsafePathError("glob_invalid_chars", pattern);
  for (const seg of pattern.split("/")) {
    if (seg === "..") throw new UnsafePathError("glob_traversal", pattern);
  }
}

function getContractMeta(toolId: ReadToolId): {
  tier: number;
  emit_events: string[];
  required_evidence: string[];
} {
  const c = TOOL_CONTRACTS.get(toolId) as ToolContract | undefined;
  return {
    tier: c?.tier ?? 2,
    emit_events: (c?.emit_events ?? []).map(e => e.name),
    required_evidence: (c?.required_evidence ?? []).map(r => r.field),
  };
}

// ── Sandbox-backed repo read implementations (189) ──────────────────
//
// When `ctx.repoBaseDir` is set we read repo files via sandbox shell
// (cat / find / grep) rather than the workspace SDK. Path is still
// denylist-checked at the dispatcher entry; the sandbox `cd` keeps
// arbitrary path traversal bounded to repo dir.

function shellQuotePath(relPath: string): string {
  // Restrict to safe characters so we can interpolate without quoting.
  // SAFE_RELATIVE_PATH already enforces ^[A-Za-z0-9_./-]{1,400}$.
  return relPath;
}

async function realRepoReadSandbox(
  exec: SandboxExec,
  baseDir: string,
  path: string,
): Promise<{ content: string; size_bytes: number; truncated: boolean }> {
  const safe = shellQuotePath(path);
  // size + content in one shell trip; capture exit so missing file is honest.
  const sizeR = await exec(`wc -c < ${baseDir}/${safe} 2>/dev/null`);
  if (sizeR.exit_code !== 0) {
    throw new Error(`repo.read: file not found at ${path}`);
  }
  const size = parseInt(sizeR.stdout.trim(), 10) || 0;
  const r = await exec(`head -c ${READ_FILE_BYTES_CAP} ${baseDir}/${safe}`);
  if (r.exit_code !== 0) {
    throw new Error(`repo.read: ${r.stderr.slice(0, 200)}`);
  }
  return {
    content: r.stdout,
    size_bytes: size,
    truncated: size > READ_FILE_BYTES_CAP,
  };
}

async function realRepoGlobSandbox(
  exec: SandboxExec,
  baseDir: string,
  pattern: string,
): Promise<{ paths: string[]; pattern: string; truncated: boolean }> {
  // Use find with -path; fall back to "**/*" semantic.
  const findArgs = pattern === "**/*" || pattern === "**" || !pattern
    ? "-type f"
    : `-type f -path "./${pattern.replace(/^\.\//, "")}"`;
  const cmd = `cd ${baseDir} && find . ${findArgs} -not -path './.git/*' -not -path './node_modules/*' 2>/dev/null | head -${GLOB_DEFAULT_LIMIT}`;
  const r = await exec(cmd);
  const allPaths = r.stdout.split(/\r?\n/).filter(p => p.length > 0).map(p => p.replace(/^\.\//, ""));
  const filtered: string[] = [];
  for (const p of allPaths) {
    let denied = false;
    for (const re of PATH_DENYLIST) {
      if (re.test(p)) { denied = true; break; }
    }
    if (!denied) filtered.push(p);
  }
  return { paths: filtered, pattern, truncated: filtered.length >= GLOB_DEFAULT_LIMIT };
}

//  — grep `--include` glob portability. The sandbox container's
// grep (busybox/musl fnmatch, pathname semantics) does not let `*` cross
// `/`, so `--include='**/*.tsx'` matches nothing in subdirectories even
// though GNU grep on a dev box accepts it. Models naturally write
// `**/*.ext`; strip the leading `**/` segments down to a basename-level
// glob, which both implementations handle. `**/*` (or empty) means "no
// include filter". Globs that still contain `/` after stripping are
// passed through unchanged (cross-implementation behavior is undefined;
// basename-level globs are the reliable contract).
export function normalizeGrepIncludeGlob(glob: string): string {
  let g = (glob ?? "").replace(/^\.\//, "");
  while (g.startsWith("**/")) g = g.slice(3);
  if (g === "" || g === "*" || g === "**" || g === "**/*") return "";
  return g;
}

async function realRepoGrepSandbox(
  exec: SandboxExec,
  baseDir: string,
  pattern: string,
  includeGlob: string,
): Promise<{
  matches: Array<{ file: string; line: number; text: string }>;
  pattern: string;
  files_scanned: number;
  truncated: boolean;
}> {
  // grep -rnE for regex with line numbers; restrict by --include and prune .git/node_modules.
  // Use POSIX regex (grep -E); pattern allowed chars are limited at the dispatcher boundary
  // but here we still pass through carefully.
  if (!/^[A-Za-z0-9_.\\/^$|()[\]{}*+?:\- ]{1,200}$/.test(pattern)) {
    throw new Error(`repo.grep: pattern contains unsafe characters`);
  }
  const normalizedInclude = normalizeGrepIncludeGlob(includeGlob);
  const incArg = normalizedInclude ? `--include='${normalizedInclude.replace(/'/g, "")}'` : "";
  const cmd = `cd ${baseDir} && grep -rnE ${incArg} --exclude-dir=.git --exclude-dir=node_modules ${JSON.stringify(pattern)} . 2>/dev/null | head -${GREP_LINE_CAP}`;
  const r = await exec(cmd);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    // Format: ./path:lineno:text
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const file = m[1].replace(/^\.\//, "");
    let denied = false;
    for (const re of PATH_DENYLIST) {
      if (re.test(file)) { denied = true; break; }
    }
    if (denied) continue;
    matches.push({ file, line: parseInt(m[2], 10), text: m[3].slice(0, 400) });
    if (matches.length >= GREP_LINE_CAP) break;
  }
  // files_scanned approximation: distinct files in matches; not exact but cheap.
  const filesScanned = new Set(matches.map(m => m.file)).size;
  return { matches, pattern, files_scanned: filesScanned, truncated: matches.length >= GREP_LINE_CAP };
}

// ── Workspace backed implementations (184a) ─────────────────────────

async function realRepoRead(
  ws: WorkspaceReadBackend,
  path: string,
): Promise<{ content: string; size_bytes: number; truncated: boolean }> {
  const raw = await ws.readFile(path);
  if (raw === null) {
    throw new Error(`repo.read: file not found at ${path}`);
  }
  const truncated = raw.length > READ_FILE_BYTES_CAP;
  const content = truncated ? raw.slice(0, READ_FILE_BYTES_CAP) : raw;
  return { content, size_bytes: raw.length, truncated };
}

async function realRepoGlob(
  ws: WorkspaceReadBackend,
  pattern: string,
): Promise<{ paths: string[]; pattern: string; truncated: boolean }> {
  const all = await ws.glob(pattern);
  const filtered: string[] = [];
  for (const p of all) {
    let denied = false;
    for (const re of PATH_DENYLIST) {
      if (re.test(p)) { denied = true; break; }
    }
    if (!denied) filtered.push(p);
    if (filtered.length >= GLOB_DEFAULT_LIMIT) break;
  }
  return {
    paths: filtered,
    pattern,
    truncated: filtered.length >= GLOB_DEFAULT_LIMIT,
  };
}

async function realRepoGrep(
  ws: WorkspaceReadBackend,
  pattern: string,
  basePathGlob: string,
): Promise<{
  matches: Array<{ file: string; line: number; text: string }>;
  pattern: string;
  files_scanned: number;
  truncated: boolean;
}> {
  let needle: RegExp;
  try {
    needle = new RegExp(pattern, "m");
  } catch {
    throw new Error(`repo.grep: invalid regex: ${pattern}`);
  }
  const candidatePaths = await ws.glob(basePathGlob);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let scanned = 0;
  for (const p of candidatePaths) {
    if (scanned >= GREP_FILE_LIMIT) break;
    let denied = false;
    for (const re of PATH_DENYLIST) {
      if (re.test(p)) { denied = true; break; }
    }
    if (denied) continue;
    scanned += 1;
    const text = await ws.readFile(p).catch(() => null);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (needle.test(lines[i])) {
        matches.push({ file: p, line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= GREP_LINE_CAP) break;
      }
    }
    if (matches.length >= GREP_LINE_CAP) break;
  }
  return {
    matches,
    pattern,
    files_scanned: scanned,
    truncated: matches.length >= GREP_LINE_CAP,
  };
}

// ── Sandbox-backed git inspect (184a) ───────────────────────────────

function gitPrefix(baseDir: string | undefined): string {
  // 189: when a checkout dir is provided, run git inside it.
  return baseDir ? `cd ${baseDir} && ` : "";
}

async function realGitStatus(exec: SandboxExec, baseDir?: string) {
  const r = await exec(`${gitPrefix(baseDir)}git status --porcelain=v1 -b`);
  return { porcelain: r.stdout, exit_code: r.exit_code, stderr: r.stderr };
}

async function realGitDiff(
  exec: SandboxExec,
  staged: boolean,
  baseRef: string | null,
  baseDir?: string,
) {
  const parts = ["git", "diff"];
  if (staged) parts.push("--staged");
  if (baseRef) {
    if (!SAFE_REF.test(baseRef)) {
      throw new Error(`git.diff: invalid base_ref: ${baseRef}`);
    }
    parts.push(baseRef);
  }
  const r = await exec(`${gitPrefix(baseDir)}${parts.join(" ")}`);
  return { unified_diff: r.stdout, exit_code: r.exit_code, stderr: r.stderr };
}

async function realGitLog(exec: SandboxExec, maxCount: number, baseDir?: string) {
  const cap = Math.min(Math.max(1, Math.floor(maxCount)), 200);
  const fmt = "%H%x09%ct%x09%s";
  const r = await exec(`${gitPrefix(baseDir)}git log --max-count=${cap} --pretty=format:'${fmt}'`);
  const commits = r.stdout
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => {
      const [sha, ts, ...rest] = line.split("\t");
      return { sha, ts, summary: rest.join("\t") };
    });
  return { commits, exit_code: r.exit_code, stderr: r.stderr };
}

async function realGitShow(exec: SandboxExec, ref: string, baseDir?: string) {
  if (!SAFE_REF.test(ref)) {
    throw new Error(`git.show: invalid ref: ${ref}`);
  }
  const r = await exec(`${gitPrefix(baseDir)}git show ${ref} --no-color --pretty=fuller --stat`);
  return { content: r.stdout, exit_code: r.exit_code, stderr: r.stderr };
}

//  A — repo.prepare. Resolves the prepared worktree path via
// `ctx.ensureRepoBaseDir` (which threads through AgentThursdayAgent's
// singleton-promise checkout) and runs three git commands inside it
// to report head_sha, branch, and porcelain status. No clone / no
// fetch is invoked here — `ensureRepoBaseDir` is the only entry-point
// for the checkout side effect, so this tool inherits its allowlist
// and token-policy guarantees.
async function realRepoPrepare(
  exec: SandboxExec,
  baseDir: string,
): Promise<{
  head_sha: string;
  branch: string;
  worktree_path: string;
  git_status: string;
}> {
  const head = await exec(`${gitPrefix(baseDir)}git rev-parse HEAD`);
  if (head.exit_code !== 0) {
    throw new Error(`repo.prepare: git rev-parse HEAD failed: ${head.stderr.slice(0, 200)}`);
  }
  const branchR = await exec(`${gitPrefix(baseDir)}git rev-parse --abbrev-ref HEAD`);
  const statusR = await exec(`${gitPrefix(baseDir)}git status --porcelain=v1 -b`);
  return {
    head_sha: head.stdout.trim(),
    branch: branchR.stdout.trim() || "HEAD",
    worktree_path: baseDir,
    git_status: statusR.stdout,
  };
}

// ── Stub fallbacks ( v0; preserved for unit tests) ──────────────

function stubReadFile(path: string) {
  return { content: `# stub for ${path}`, size_bytes: 0, truncated: false };
}
function stubGlob(pattern: string) {
  return { paths: [] as string[], pattern, truncated: false };
}
function stubGrep(pattern: string) {
  return { matches: [] as Array<{ file: string; line: number; text: string }>, pattern, files_scanned: 0, truncated: false };
}
function stubGitStatus() { return { porcelain: "", exit_code: 0, stderr: "" }; }
function stubGitDiff() { return { unified_diff: "", exit_code: 0, stderr: "" }; }
function stubGitLog() { return { commits: [], exit_code: 0, stderr: "" }; }
function stubGitShow(ref: string) { return { content: `# stub git show ${ref}`, exit_code: 0, stderr: "" }; }

// ── Dispatcher ──────────────────────────────────────────────────────

export async function dispatchReadTool(
  toolId: string,
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const startedAt = Date.now();
  const knownToolId = (READ_TOOL_IDS as readonly string[]).includes(toolId)
    ? (toolId as ReadToolId)
    : null;

  if (!knownToolId) {
    ctx.emit({
      type: `tool.${toolId}.error`,
      payload: { reason: "unsupported_read_tool", input, traceId: ctx.traceId ?? null },
    });
    return {
      ok: false,
      tool_id: "repo.read",
      error: { reason: "unsupported_read_tool", details: toolId },
      duration_ms: Date.now() - startedAt,
      contract: { tier: 2, emit_events: [], required_evidence: [] },
      backend: "stub",
      worktree_path: null,
    };
  }

  const contract = getContractMeta(knownToolId);
  const worktreePath: string | null = ctx.repoBaseDir ?? null;

  ctx.emit({
    type: `tool.${knownToolId}.dispatch`,
    payload: {
      input,
      traceId: ctx.traceId ?? null,
      tier: contract.tier,
      worktree_path: worktreePath,
    },
  });

  let backend: "sandbox" | "source_read" | "stub" = "stub";

  try {
    const path = typeof input.path === "string" ? input.path : undefined;
    assertPathAllowed(path);
    // 189a — uniform structural validator. Throws UnsafePathError for
    // absolute / traversal / shell metachar / invalid-char inputs so
    // the catch block surfaces reason='unsafe_path' rather than the
    // generic 'internal_error'.
    if (path) assertSafeRepoPath(path);

    let output: unknown;
    switch (knownToolId) {
      case "repo.read": {
        if (!path) throw new Error("repo.read: missing path");
        // 189a — structural path safety
        assertSafeRepoPath(path);
        if (ctx.repoBaseDir && ctx.sandboxExec) {
          backend = "sandbox";
          output = await realRepoReadSandbox(ctx.sandboxExec, ctx.repoBaseDir, path);
        } else if (ctx.workspace) {
          backend = "source_read";
          output = await realRepoRead(ctx.workspace, path);
        } else {
          output = stubReadFile(path);
        }
        break;
      }
      case "repo.glob": {
        const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
        // 189a — structural glob safety
        assertSafeGlob(pattern);
        if (ctx.repoBaseDir && ctx.sandboxExec) {
          backend = "sandbox";
          output = await realRepoGlobSandbox(ctx.sandboxExec, ctx.repoBaseDir, pattern);
        } else if (ctx.workspace) {
          backend = "source_read";
          output = await realRepoGlob(ctx.workspace, pattern);
        } else {
          output = stubGlob(pattern);
        }
        break;
      }
      case "repo.grep": {
        const pattern = typeof input.pattern === "string" ? input.pattern : "";
        if (!pattern) throw new Error("repo.grep: missing pattern");
        const includeGlob = typeof input.include_glob === "string" ? input.include_glob : "**/*";
        // 189a — validate include glob (the regex pattern itself is
        // separately constrained downstream by the existing grep-pattern
        // safety check; include_glob lands in the shell command line so
        // it must pass the glob safety gate too).
        assertSafeGlob(includeGlob);
        if (ctx.repoBaseDir && ctx.sandboxExec) {
          backend = "sandbox";
          output = await realRepoGrepSandbox(ctx.sandboxExec, ctx.repoBaseDir, pattern, includeGlob);
        } else if (ctx.workspace) {
          backend = "source_read";
          output = await realRepoGrep(ctx.workspace, pattern, includeGlob);
        } else {
          output = stubGrep(pattern);
        }
        break;
      }
      case "git.status": {
        if (ctx.sandboxExec) {
          backend = "sandbox";
          output = await realGitStatus(ctx.sandboxExec, ctx.repoBaseDir);
        } else {
          output = stubGitStatus();
        }
        break;
      }
      case "git.diff": {
        const staged = input.staged === true;
        const baseRef = typeof input.base_ref === "string" ? input.base_ref : null;
        if (ctx.sandboxExec) {
          backend = "sandbox";
          output = await realGitDiff(ctx.sandboxExec, staged, baseRef, ctx.repoBaseDir);
        } else {
          output = stubGitDiff();
        }
        break;
      }
      case "git.log": {
        const maxCount =
          typeof input.max_count === "number" && Number.isFinite(input.max_count)
            ? input.max_count
            : GIT_LOG_DEFAULT_MAX;
        if (ctx.sandboxExec) {
          backend = "sandbox";
          output = await realGitLog(ctx.sandboxExec, maxCount, ctx.repoBaseDir);
        } else {
          output = stubGitLog();
        }
        break;
      }
      case "git.show": {
        const ref = typeof input.ref === "string" ? input.ref : "HEAD";
        if (ctx.sandboxExec) {
          backend = "sandbox";
          output = await realGitShow(ctx.sandboxExec, ref, ctx.repoBaseDir);
        } else {
          output = stubGitShow(ref);
        }
        break;
      }
      case "repo.prepare": {
        //  A — requires both a resolved sandbox checkout dir
        // and the sandboxExec to run git inside it. ensureRepoBaseDir
        // is expected to have been called by the binding layer; if the
        // checkout failed we surface no_prepared_worktree so the agent
        // sees an honest error instead of a stub success.
        if (!ctx.repoBaseDir || !ctx.sandboxExec) {
          throw new Error("repo.prepare: no prepared worktree (repo materialization failed; check repo.materialization.error events)");
        }
        backend = "sandbox";
        output = await realRepoPrepare(ctx.sandboxExec, ctx.repoBaseDir);
        break;
      }
    }

    const duration = Date.now() - startedAt;
    ctx.emit({
      type: `tool.${knownToolId}.result`,
      payload: {
        output,
        duration_ms: duration,
        backend,
        worktree_path: worktreePath,
        traceId: ctx.traceId ?? null,
      },
    });
    return {
      ok: true,
      tool_id: knownToolId,
      output,
      duration_ms: duration,
      contract,
      backend,
      worktree_path: worktreePath,
    };
  } catch (e) {
    const duration = Date.now() - startedAt;
    let reason = "internal_error";
    let details: string;
    if (e instanceof DenylistError) {
      reason = "denylist";
      details = `path '${e.path}' matches denylist pattern '${e.reason}'`;
    } else if (e instanceof UnsafePathError) {
      reason = "unsafe_path";
      details = `input '${e.input}' rejected by ${e.reason}`;
    } else {
      details = e instanceof Error ? e.message : String(e);
    }
    ctx.emit({
      type: `tool.${knownToolId}.error`,
      payload: {
        reason,
        details,
        input,
        backend,
        worktree_path: worktreePath,
        traceId: ctx.traceId ?? null,
      },
    });
    return {
      ok: false,
      tool_id: knownToolId,
      error: { reason, details },
      duration_ms: duration,
      contract,
      backend,
      worktree_path: worktreePath,
    };
  }
}
