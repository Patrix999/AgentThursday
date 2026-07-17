/**
 * Developer Shell repo patch/write/delete dispatcher.
 *
 * Mirrors the read dispatcher in devShell.ts (eventing, denylist
 * shape, DispatchResult contract) but the write side adds two extra
 * gates:
 *
 *   1. **Global denylist** (PATH_DENYLIST from devShell): same six
 *      regex (.env*, .dev.vars, secrets/, .git/, .ssh/, .gnupg/).
 *   2. **Manifest path policy** (passed in via context): the
 *      software-dev v0 manifest's `path_denylist` adds e.g.
 *      `wrangler.toml`, `package.json`, `*.lock`; its `path_allowlist`
 *      restricts where writes may land (src/**, docs/**, tests/**, ...).
 *
 * Each successful write emits a unified-diff artifact in the result
 * payload; failed denylist / allowlist hits emit
 * `tool.<id>.error reason=denylist|outside_allowlist|...`.
 *
 * No commit / push / deploy paths exist in this module — the
 * dispatcher is repo-write-only. Worker-side approval / commit /
 * push wiring is a separate card.
 */

import { TOOL_CONTRACTS, type ToolContract } from "./contractRegistry";
import {
  PATH_DENYLIST,
  DenylistError,
  assertSafeRepoPath,
  UnsafePathError,
  type DispatchEvent,
} from "./devShell";
import { canonicalInputHash } from "./approvalToken";

// `dev.echo.t4` is an internal T4 test tool that flows
// through the same approval guard as any future real T4/T5 write tool.
// It executes a pure no-op (returns the input back) so the verifier can
// smoke the consume-then-execute path without external side effects.
// Spec §D explicitly permits this: "如当前 dispatcher 结构不足以安全
// 接线，允许先接一个 internal high-tier test tool path，但必须文档说
// 明它与真实 dispatcher 共用同一 approval middleware/guard."
export const WRITE_TOOL_IDS = [
  "repo.write",
  "repo.patch",
  "repo.delete",
  "dev.echo.t4",
] as const;
export type WriteToolId = typeof WRITE_TOOL_IDS[number];

export interface ManifestPathPolicy {
  allowlist: string[];
  denylist: string[];
}

export interface WorkspaceWriteBackend {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile?(path: string): Promise<void>;
}

/**
 * minimal sandbox filesystem client surface used by the
 * sandbox-backed `WorkspaceWriteBackend`. Mirrors the subset of the
 * `@cloudflare/sandbox` SDK we depend on so this module stays pure
 * (no SDK import) and is straightforward to fake in tests.
 */
export interface SandboxFsClient {
  readFile(path: string): Promise<{ success: boolean; content?: string; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<{ success: boolean; exitCode?: number }>;
  deleteFile(path: string): Promise<{ success: boolean; exitCode?: number }>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean }>;
  exists?(path: string): Promise<{ success: boolean; exists?: boolean }>;
}

/**
 * robust detection of "file not found" thrown by the
 * production `@cloudflare/sandbox` SDK. 193a's `e instanceof Error &&
 * e.name === "FileNotFoundError"` check did not fire in production,
 * so the missing-file value reaches the adapter in at least one of
 * these shapes (verifier QA `2026-05-08-card193a-production-rerun.md`):
 *
 *   1. cross-realm `Error` whose constructor lives in a different
 *      JS realm — `instanceof Error` is `false` even though `.name`
 *      and `.constructor.name` are both `"FileNotFoundError"`;
 *   2. a plain object with `{ name: "FileNotFoundError", message: "..." }`;
 *   3. a `String`-coercible value whose stringified form starts with
 *      `"FileNotFoundError:"` and contains `"File not found:"`.
 *
 * The helper checks all three independently, in order from most
 * specific (typed name) to least specific (message substring). It
 * deliberately keeps the message-substring branch narrow ("File not
 * found:") so generic IO errors that happen to mention "not found"
 * elsewhere are still propagated — see card 193b §非目标.
 *
 * Exported for direct test coverage (193b sanity).
 */
export function isSandboxFileNotFound(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  // Match named Errors (real Errors AND plain objects with `.name`).
  const name = (e as { name?: unknown }).name;
  if (typeof name === "string" && name === "FileNotFoundError") return true;
  // Match cross-realm Errors where instanceof Error fails but the
  // constructor's name field is intact.
  const ctor = (e as { constructor?: { name?: unknown } }).constructor;
  if (ctor && typeof ctor.name === "string" && ctor.name === "FileNotFoundError") return true;
  // Match message-only / String(e) shapes. `message` typically only
  // contains "File not found: <path>"; the prefix check covers the
  // rare `String(error)` form which prepends "FileNotFoundError:".
  const messageRaw = (e as { message?: unknown }).message;
  const msg = String(typeof messageRaw === "string" ? messageRaw : e ?? "");
  if (msg.startsWith("FileNotFoundError:")) return true;
  if (msg.includes("File not found:")) return true;
  return false;
}

/**
 * adapt a sandbox FS client into the `WorkspaceWriteBackend`
 * shape used by `dispatchWriteTool`. All paths are resolved relative to
 * `baseDir`; the input `path` is the manifest-validated relative path
 * (already passed through `assertSafeRepoPath` so it is safe to join).
 *
 * Why this exists: pre-193, `repo.write` / `repo.patch` / `repo.delete`
 * wrote to the AgentThursdayAgent DO scratch workspace, while `repo.read` /
 * `gate.*` operate on the production sandbox checkout (`/workspace/AgentThursday`,
 * see card 189). This split made agent-proposed patches invisible to
 * `repo.read` and `gate.*` (an earlier revision finding F1). Writing through this
 * backend lands the patch in the same checkout the gate runs against,
 * so the self-dev loop closes:
 *   `repo.patch → repo.read sees it → gate.* validates it → diff evidence`.
 *
 * Returned errors fall through `dispatchWriteTool`'s catch path; they
 * surface as `tool.<id>.error reason=internal_error details=…`.
 */
export function makeSandboxWriteBackend(
  client: SandboxFsClient,
  baseDir: string,
): WorkspaceWriteBackend {
  if (!baseDir || baseDir === "/" || baseDir.includes("..")) {
    throw new Error(`makeSandboxWriteBackend: refusing unsafe baseDir '${baseDir}'`);
  }
  const join = (relPath: string) => `${baseDir}/${relPath}`;
  return {
    async readFile(relPath) {
      // production `@cloudflare/sandbox` SDK signals
      // missing files by *throwing* `FileNotFoundError`, not by
      // returning `{success:false}`. 193a's `instanceof Error &&
      // .name === "FileNotFoundError"` did not fire on the production
      // thrown value (cross-realm / non-Error / message-prefix shape;
      // see card 193b §背景). 193b switches to `isSandboxFileNotFound`
      // which checks `name`, `constructor.name`, and the canonical
      // message phrasing independently. Real I/O / permission /
      // generic errors keep propagating to the dispatcher catch.
      try {
        const r = await client.readFile(join(relPath));
        if (!r.success) return null;
        return r.content ?? "";
      } catch (e) {
        if (isSandboxFileNotFound(e)) return null;
        throw e;
      }
    },
    async writeFile(relPath, content) {
      // Ensure parent directory exists; the SDK's writeFile does not
      // implicitly create intermediate dirs. mkdir.recursive=true is a
      // no-op when the dir already exists.
      const lastSlash = relPath.lastIndexOf("/");
      if (lastSlash > 0 && client.mkdir) {
        const parentRel = relPath.slice(0, lastSlash);
        await client.mkdir(join(parentRel), { recursive: true });
      }
      const r = await client.writeFile(join(relPath), content);
      if (!r.success) {
        throw new Error(`sandbox writeFile failed at ${relPath} (exit ${r.exitCode ?? "?"})`);
      }
    },
    async deleteFile(relPath) {
      const r = await client.deleteFile(join(relPath));
      if (!r.success) {
        throw new Error(`sandbox deleteFile failed at ${relPath} (exit ${r.exitCode ?? "?"})`);
      }
    },
  };
}

/**
 * strip caller-supplied approval material from any `input`
 * that crosses into a dispatcher event payload (`tool.<id>.dispatch`,
 * `tool.<id>.error`). Reserved keys at the top level of the input are
 * replaced with the literal string `"[redacted]"` so the verifier can
 * still see the *shape* of the misuse without exposing the secret.
 *
 * Why redact the event copy and not the in-flight input itself: the
 * canonical hash + consume verify need to see the unredacted input so
 * deliberate-misuse cases (`ctx.approval` correct + caller stuffs token
 * into `input.approval`) still produce a hash mismatch and fail closed
 * — that's the binding control. Redaction here only protects the
 * event_log / trace / `/api/inspect` egress surfaces.
 *
 * Reserved set is the literal approval material a caller might present:
 * `approval` (the {token_id, token} struct), bare `token` / `token_id`
 * / `token_hash`. Top-level only — deeper nesting is not a known
 * legitimate caller pattern, so we don't speculate (an earlier revision spec:
 * "Keep it surgical").
 */
const APPROVAL_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "approval",
  "token",
  "token_id",
  "token_hash",
]);

function redactInputForEvent(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = APPROVAL_RESERVED_KEYS.has(k) ? "[redacted]" : v;
  }
  return out;
}

/**
 * approval consumption result the dispatcher receives back
 * from the cross-DO callback. Mirrors the shape of
 * `ChannelHubAgent.consumeApprovalToken` so the dispatcher can surface
 * the verify reason verbatim without re-importing the DO type.
 */
export type ApprovalConsumeResult =
  | { ok: true }
  | { ok: false; error: string; detail?: string };

/**
 * payload presented by the caller alongside a T4/T5 tool
 * dispatch. Raw `token` is in-memory only: never logged, never persisted,
 * never echoed in the dispatch event payload (which is why this rides
 * on `ctx`, not on `input` — see an earlier revision §C).
 */
export interface ApprovalPresentation {
  token_id: string;
  token: string;
}

export interface WriteDispatchContext {
  emit(event: DispatchEvent): void;
  traceId?: string | null;
  workspace?: WorkspaceWriteBackend;
  manifestPolicy?: ManifestPathPolicy;
  // present for any tier-≥4 dispatch. Caller is responsible
  // for refusing to populate these for tier-<4 calls.
  approval?: ApprovalPresentation;
  agentId?: string;
  consumeApproval?: (req: {
    token_id: string;
    token: string;
    agent_id: string;
    tool_id: string;
    input_hash: string;
  }) => Promise<ApprovalConsumeResult>;
  // an earlier revision B — post-checkout sandbox baseDir when writes land in the
  // prepared worktree; null when the dispatcher falls back to the DO
  // scratch workspace. Surfaced verbatim in dispatch / result / error
  // event payloads so trace consumers can correlate writes with the
  // matching `repo.prepare`.
  worktreePath?: string | null;
}

export interface WriteDispatchResult {
  ok: boolean;
  tool_id: WriteToolId;
  output?: unknown;
  error?: { reason: string; details?: string };
  duration_ms: number;
  contract: { tier: number; emit_events: string[]; required_evidence: string[] };
  backend: "real" | "stub";
  diff?: string;
  // an earlier revision B — sandbox baseDir when the write hit the prepared
  // worktree; null on DO scratch fallback. Mirrors the read-side
  // `DispatchResult.worktree_path` so callers can pin the write to a
  // specific `repo.prepare` outcome.
  worktree_path?: string | null;
}

const MAX_WRITE_BYTES = 256 * 1024;

// ── Glob → Regex helper ─────────────────────────────────────────────
//
// Minimal ant-glob style:
//   *  matches any sequence of characters except `/`
//   ** matches any sequence of characters including `/`
//   ?  matches a single character (not `/`)
//   plain text matches literally
// Anchored at start AND end (no partial matches).

function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** — match any chars including /
        re += ".*";
        i += 2;
        // optional trailing slash collapse: '**/' matches zero or more dirs
        if (glob[i] === "/") {
          // already covered by .*
          i += 1;
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") { re += "[^/]"; i += 1; continue; }
    if (".+()|^$\\{}[]/".includes(ch)) { re += "\\" + ch; i += 1; continue; }
    re += ch; i += 1;
  }
  re += "$";
  return new RegExp(re);
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(path)) return true;
  }
  return false;
}

// ── Allow / deny gates ─────────────────────────────────────────────

function assertGlobalAllowed(path: string): void {
  for (const re of PATH_DENYLIST) {
    if (re.test(path)) throw new DenylistError(re.source, path);
  }
}

export class ManifestDenyError extends Error {
  constructor(public path: string, public matchedPattern: string) {
    super(`devshell:manifest_deny:${matchedPattern}:${path}`);
  }
}

export class OutsideAllowlistError extends Error {
  constructor(public path: string) {
    super(`devshell:outside_allowlist:${path}`);
  }
}

function assertWriteAllowed(path: string, policy: ManifestPathPolicy | undefined): void {
  // 1. global denylist (always applies)
  assertGlobalAllowed(path);
  if (!policy) {
    // no manifest policy → reject (writes must declare a manifest scope)
    throw new OutsideAllowlistError(path);
  }
  // 2. manifest denylist (after global; deny wins over allow)
  for (const pattern of policy.denylist) {
    if (globToRegex(pattern).test(path)) {
      throw new ManifestDenyError(path, pattern);
    }
  }
  // 3. manifest allowlist (path must match at least one)
  if (policy.allowlist.length === 0) {
    throw new OutsideAllowlistError(path);
  }
  if (!matchesAnyGlob(path, policy.allowlist)) {
    throw new OutsideAllowlistError(path);
  }
}

// ── Unified diff helper ─────────────────────────────────────────────
//
// Produces a minimal unified-diff string. Not optimal hunking; uses a
// single `@@` hunk that spans the changed region. Sufficient for
// evidence/inspect: human-readable, machine-parseable, deterministic
// from (pre, post). Avoid pulling a heavy diff lib into the worker.

export function unifiedDiff(
  prePath: string,
  postPath: string,
  pre: string,
  post: string,
): string {
  if (pre === post) {
    return `--- ${prePath}\n+++ ${postPath}\n@@ -0,0 +0,0 @@\n`;
  }
  const preLines = pre.split(/\r?\n/);
  const postLines = post.split(/\r?\n/);
  // find first differing line index
  let start = 0;
  const minLen = Math.min(preLines.length, postLines.length);
  while (start < minLen && preLines[start] === postLines[start]) start += 1;
  // find last differing line index (from end)
  let preEnd = preLines.length;
  let postEnd = postLines.length;
  while (preEnd > start && postEnd > start && preLines[preEnd - 1] === postLines[postEnd - 1]) {
    preEnd -= 1;
    postEnd -= 1;
  }
  const preCount = preEnd - start;
  const postCount = postEnd - start;
  const preStart = preLines.length === 0 ? 0 : start + 1;
  const postStart = postLines.length === 0 ? 0 : start + 1;
  const lines: string[] = [];
  lines.push(`--- ${prePath}`);
  lines.push(`+++ ${postPath}`);
  lines.push(`@@ -${preStart},${preCount} +${postStart},${postCount} @@`);
  for (let i = start; i < preEnd; i += 1) lines.push("-" + preLines[i]);
  for (let i = start; i < postEnd; i += 1) lines.push("+" + postLines[i]);
  return lines.join("\n") + "\n";
}

// ── Tool implementations ────────────────────────────────────────────

function getContractMeta(toolId: WriteToolId): {
  tier: number;
  emit_events: string[];
  required_evidence: string[];
} {
  const c = TOOL_CONTRACTS.get(toolId) as ToolContract | undefined;
  return {
    tier: c?.tier ?? 3,
    emit_events: (c?.emit_events ?? []).map(e => e.name),
    required_evidence: (c?.required_evidence ?? []).map(r => r.field),
  };
}

async function realRepoWrite(
  ws: WorkspaceWriteBackend,
  path: string,
  content: string,
  expectedHash: string | null,
): Promise<{ output: { applied: boolean; bytes_written: number }; diff: string }> {
  if (content.length > MAX_WRITE_BYTES) {
    throw new Error(`repo.write: content exceeds ${MAX_WRITE_BYTES}-byte cap`);
  }
  const pre = (await ws.readFile(path)) ?? "";
  if (expectedHash && expectedHash !== await sha256Hex(pre)) {
    throw new Error("repo.write: expected_existing_hash mismatch (concurrent modification?)");
  }
  await ws.writeFile(path, content);
  const diff = unifiedDiff(`a/${path}`, `b/${path}`, pre, content);
  return {
    output: { applied: true, bytes_written: new TextEncoder().encode(content).length },
    diff,
  };
}

async function realRepoPatch(
  ws: WorkspaceWriteBackend,
  path: string,
  oldString: string,
  newString: string,
): Promise<{ output: { applied: boolean }; diff: string }> {
  const pre = (await ws.readFile(path)) ?? "";
  const idx = pre.indexOf(oldString);
  if (idx === -1) {
    throw new Error("repo.patch: old_string not found in file");
  }
  if (pre.indexOf(oldString, idx + 1) !== -1) {
    throw new Error("repo.patch: old_string is ambiguous (multiple matches)");
  }
  const post = pre.slice(0, idx) + newString + pre.slice(idx + oldString.length);
  if (post.length > MAX_WRITE_BYTES) {
    throw new Error(`repo.patch: result exceeds ${MAX_WRITE_BYTES}-byte cap`);
  }
  await ws.writeFile(path, post);
  const diff = unifiedDiff(`a/${path}`, `b/${path}`, pre, post);
  return { output: { applied: true }, diff };
}

async function realRepoDelete(
  ws: WorkspaceWriteBackend,
  path: string,
): Promise<{ output: { deleted: boolean }; diff: string }> {
  if (!ws.deleteFile) {
    throw new Error("repo.delete: workspace backend lacks deleteFile");
  }
  const pre = (await ws.readFile(path)) ?? "";
  await ws.deleteFile(path);
  const diff = unifiedDiff(`a/${path}`, `/dev/null`, pre, "");
  return { output: { deleted: true }, diff };
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ── Stubs (used when no workspace backend supplied; unit tests) ─────

function stubResult(diff: string) {
  return { output: { applied: true, stub: true }, diff };
}

// ── Dispatcher ──────────────────────────────────────────────────────

export async function dispatchWriteTool(
  toolId: string,
  input: Record<string, unknown>,
  ctx: WriteDispatchContext,
): Promise<WriteDispatchResult> {
  const startedAt = Date.now();
  const knownToolId = (WRITE_TOOL_IDS as readonly string[]).includes(toolId)
    ? (toolId as WriteToolId)
    : null;
  const worktreePath: string | null = ctx.worktreePath ?? null;

  if (!knownToolId) {
    ctx.emit({
      type: `tool.${toolId}.error`,
      payload: { reason: "unsupported_write_tool", input: redactInputForEvent(input), traceId: ctx.traceId ?? null, worktree_path: worktreePath },
    });
    return {
      ok: false,
      tool_id: "repo.write",
      error: { reason: "unsupported_write_tool", details: toolId },
      duration_ms: Date.now() - startedAt,
      contract: { tier: 3, emit_events: [], required_evidence: [] },
      backend: "stub",
      worktree_path: worktreePath,
    };
  }

  const contract = getContractMeta(knownToolId);

  // dispatch event MUST NOT carry the raw approval token.
  // `ctx.approval` rides on the context, not on `input`, so the input
  // hash is approval-free. defence-in-depth: redact any
  // caller-supplied approval-shaped keys from the *event copy* of the
  // input as well, so a buggy/malicious caller that stuffed approval
  // material into `input.approval` cannot leak it into event_log /
  // trace / `/api/inspect`. The dispatcher's canonical hash and the
  // consume call still see the unredacted input — that's the binding
  // control that catches the misuse with `input_hash_mismatch`.
  ctx.emit({
    type: `tool.${knownToolId}.dispatch`,
    payload: { input: redactInputForEvent(input), traceId: ctx.traceId ?? null, tier: contract.tier, worktree_path: worktreePath },
  });

  // approval enforcement for T4/T5. Must happen before any
  // tool-side execution so a missing / bad approval cannot cause a side
  // effect. Failure paths return `ok: false` and never enter the switch.
  if (contract.tier >= 4) {
    if (!ctx.approval || !ctx.consumeApproval || !ctx.agentId) {
      const duration = Date.now() - startedAt;
      ctx.emit({
        type: `tool.${knownToolId}.error`,
        payload: { reason: "approval_required", input: redactInputForEvent(input), traceId: ctx.traceId ?? null, worktree_path: worktreePath },
      });
      return {
        ok: false,
        tool_id: knownToolId,
        error: { reason: "approval_required" },
        duration_ms: duration,
        contract,
        backend: "stub",
        worktree_path: worktreePath,
      };
    }
    let inputHash: string;
    try {
      inputHash = await canonicalInputHash(input);
    } catch (e) {
      const duration = Date.now() - startedAt;
      const details = e instanceof Error ? e.message : String(e);
      ctx.emit({
        type: `tool.${knownToolId}.error`,
        payload: { reason: "input_canonicalize_failed", details, traceId: ctx.traceId ?? null, worktree_path: worktreePath },
      });
      return {
        ok: false,
        tool_id: knownToolId,
        error: { reason: "input_canonicalize_failed", details },
        duration_ms: duration,
        contract,
        backend: "stub",
        worktree_path: worktreePath,
      };
    }
    const verdict = await ctx.consumeApproval({
      token_id: ctx.approval.token_id,
      token: ctx.approval.token,
      agent_id: ctx.agentId,
      tool_id: knownToolId,
      input_hash: inputHash,
    });
    if (!verdict.ok) {
      const duration = Date.now() - startedAt;
      // Pass through the consume reason verbatim. token_mismatch /
      // input_hash_mismatch / wrong_status / expired / agent_mismatch /
      // tool_mismatch / approval_not_found all surface here without
      // remapping — the caller can distinguish "no approval was
      // presented" (approval_required, above) from "presented one
      // failed verify" (these reasons).
      ctx.emit({
        type: `tool.${knownToolId}.error`,
        payload: {
          reason: verdict.error,
          ...(verdict.detail ? { detail: verdict.detail } : {}),
          traceId: ctx.traceId ?? null,
          worktree_path: worktreePath,
        },
      });
      return {
        ok: false,
        tool_id: knownToolId,
        error: { reason: verdict.error, ...(verdict.detail ? { details: verdict.detail } : {}) },
        duration_ms: duration,
        contract,
        backend: "stub",
        worktree_path: worktreePath,
      };
    }
    ctx.emit({
      type: `tool.${knownToolId}.approval_consumed`,
      payload: { token_id: ctx.approval.token_id, traceId: ctx.traceId ?? null, worktree_path: worktreePath },
    });
  }

  let backend: "real" | "stub" = "stub";
  try {
    let output: unknown;
    let diff: string | undefined;

    switch (knownToolId) {
      case "repo.write": {
        // write paths are joined into the sandbox checkout;
        // `assertSafeRepoPath` rejects absolute paths, `..` segments,
        // and shell metacharacters. an earlier revision moved this check into the
        // repo.* cases so the new tier-4 `dev.echo.t4` (no path field)
        // flows through the dispatcher cleanly.
        const path = typeof input.path === "string" ? input.path : undefined;
        if (!path) throw new Error(`${knownToolId}: missing path`);
        assertSafeRepoPath(path);
        assertWriteAllowed(path, ctx.manifestPolicy);
        const content = typeof input.content === "string" ? input.content : undefined;
        if (content === undefined) throw new Error("repo.write: missing content");
        const expectedHash = typeof input.expected_existing_hash === "string"
          ? input.expected_existing_hash : null;
        if (ctx.workspace) {
          backend = "real";
          const r = await realRepoWrite(ctx.workspace, path, content, expectedHash);
          output = r.output;
          diff = r.diff;
        } else {
          diff = unifiedDiff(`a/${path}`, `b/${path}`, "", content);
          ({ output } = stubResult(diff));
        }
        break;
      }
      case "repo.patch": {
        const path = typeof input.path === "string" ? input.path : undefined;
        if (!path) throw new Error(`${knownToolId}: missing path`);
        assertSafeRepoPath(path);
        assertWriteAllowed(path, ctx.manifestPolicy);
        const oldString = typeof input.old_string === "string" ? input.old_string : undefined;
        const newString = typeof input.new_string === "string" ? input.new_string : undefined;
        if (oldString === undefined || newString === undefined) {
          throw new Error("repo.patch: missing old_string / new_string");
        }
        if (ctx.workspace) {
          backend = "real";
          const r = await realRepoPatch(ctx.workspace, path, oldString, newString);
          output = r.output;
          diff = r.diff;
        } else {
          diff = unifiedDiff(`a/${path}`, `b/${path}`, oldString, newString);
          ({ output } = stubResult(diff));
        }
        break;
      }
      case "repo.delete": {
        const path = typeof input.path === "string" ? input.path : undefined;
        if (!path) throw new Error(`${knownToolId}: missing path`);
        assertSafeRepoPath(path);
        assertWriteAllowed(path, ctx.manifestPolicy);
        if (ctx.workspace) {
          backend = "real";
          const r = await realRepoDelete(ctx.workspace, path);
          output = r.output;
          diff = r.diff;
        } else {
          diff = unifiedDiff(`a/${path}`, `/dev/null`, "", "");
          ({ output } = stubResult(diff));
        }
        break;
      }
      case "dev.echo.t4": {
        // internal T4 test tool. Pure no-op: returns the
        // canonical input hash so the verifier can prove the value the
        // dispatcher actually executed against (i.e. the value bound
        // to the consumed approval). No filesystem / VCS / network.
        output = { echoed: true, input_hash: await canonicalInputHash(input) };
        diff = undefined;
        break;
      }
    }

    const duration = Date.now() - startedAt;
    ctx.emit({
      type: `tool.${knownToolId}.result`,
      payload: { output, diff, duration_ms: duration, backend, traceId: ctx.traceId ?? null, worktree_path: worktreePath },
    });
    return { ok: true, tool_id: knownToolId, output, duration_ms: duration, contract, backend, diff, worktree_path: worktreePath };
  } catch (e) {
    const duration = Date.now() - startedAt;
    let reason = "internal_error";
    let details = e instanceof Error ? e.message : String(e);
    if (e instanceof DenylistError) {
      reason = "denylist";
      details = `path '${e.path}' matches global denylist '${e.reason}'`;
    } else if (e instanceof ManifestDenyError) {
      reason = "manifest_deny";
      details = `path '${e.path}' matches software-dev manifest deny '${e.matchedPattern}'`;
    } else if (e instanceof OutsideAllowlistError) {
      reason = "outside_allowlist";
      details = `path '${e.path}' is not inside the manifest path_allowlist`;
    } else if (e instanceof UnsafePathError) {
      reason = "unsafe_path";
      details = `path '${e.input}' rejected: ${e.reason}`;
    }
    ctx.emit({
      type: `tool.${knownToolId}.error`,
      payload: { reason, details, input: redactInputForEvent(input), backend, traceId: ctx.traceId ?? null, worktree_path: worktreePath },
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
