/**
 * propose-patch artifact policy module (v1).
 *
 * Pure module. No I/O. Mechanizes the path allowlist / denylist and
 * redaction rules from an earlier revision ADR §D4.3 + §D7. Used by ChannelHub's
 * `proposePatchArtifact` callable to fail-closed at creation time.
 *
 * Decisions baked in for v1 (revisit in 219+):
 *
 *   - `src/server.ts` is **denied** in v1. an earlier revision D4.3 lists it as
 *     "allowed (非生产路径)" but does not specify how to enforce that
 *     qualifier mechanically. an earlier revision spec §4 explicitly authorizes
 *     "降级为 deny" rather than guessing. Reason code:
 *     `server-ts-deny-in-v1`.
 *   - Redaction is a **literal substring** match, not regex with
 *     value-shape constraints. Verifier production smoke (an earlier revision
 *     §5.6) greps for literal substrings; this module must be at
 *     least as strict as that grep, otherwise a patch can pass
 *     creation and fail verifier smoke. The cost is rejecting patches
 *     that mention these identifiers in legitimate prose; v1
 *     conservatism is intentional.
 */
import { canonicalInputHash } from "./approvalToken";

export interface PatchPolicyInput {
  target_paths: ReadonlyArray<string>;
  patch_text: string;
  summary: string | null;
}

export interface PatchPolicyDenial {
  path: string;
  reason: string;
}

export interface PatchPolicyRedactionHit {
  category: string;
  count: number;
}

export interface PatchPolicyResult {
  passed: boolean;
  allowed_paths: string[];
  denied_paths: PatchPolicyDenial[];
  redaction_hits: PatchPolicyRedactionHit[];
  policy_version: string;
}

export const PATCH_POLICY_VERSION = "v1.0.0";

/**
 * Path allowlist roots. A target path must start with one of these
 * prefixes to be considered for allowance. Empty allowlist means deny.
 *
 * v1 deliberately omits `src/server.ts` (see denylist + module
 * preamble for rationale).
 */
export const PATCH_PATH_ALLOWLIST: ReadonlyArray<string> = [
  "docs/",
  "src/skillset/",
];

/**
 * Path denylist. Even if a path matches the allowlist, a denylist hit
 * vetoes it. an earlier revision D4.3 explicit denials + the v1 `src/server.ts`
 * downgrade.
 */
export const PATCH_PATH_DENYLIST: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /^src\/server\.ts$/, reason: "server-ts-deny-in-v1" },
  { pattern: /(^|\/)wrangler\.toml$/, reason: "wrangler-config" },
  { pattern: /(^|\/)package\.json$/, reason: "package-json" },
  { pattern: /(^|\/)package-lock\.json$/, reason: "package-lock" },
  { pattern: /(^|\/)yarn\.lock$/, reason: "yarn-lock" },
  { pattern: /(^|\/)pnpm-lock\.yaml$/, reason: "pnpm-lock" },
  { pattern: /(^|\/)worker-configuration\.d\.ts$/, reason: "worker-types" },
  { pattern: /(^|\/)\.dev\.vars$/i, reason: "dev-vars" },
  { pattern: /(^|\/)\.env(\..+)?$/i, reason: "env-file" },
  { pattern: /^\.github\//, reason: "github-config" },
  { pattern: /^docs\/runbooks\//, reason: "runbooks" },
  { pattern: /^docs\/adr\//, reason: "adr" },
  { pattern: /^docs\/kanban\/217-/, reason: "card-217-self" },
  { pattern: /^docs\/kanban\/218-/, reason: "card-218-self" },
];

/**
 * Redaction substrings. Any literal match (case-insensitive) in
 * `patch_text` or `summary` causes fail-closed.
 *
 * Sourced from an earlier revision ADR §D7 禁止 list and an earlier revision verifier
 * production smoke grep set. The category name is what surfaces in
 * the policy result; the matched substring itself is **never**
 * echoed back (it could be the raw secret).
 */
export const REDACTION_SUBSTRINGS: ReadonlyArray<{
  needle: string;
  category: string;
}> = [
  { needle: "Authorization", category: "authorization-header" },
  { needle: "Bearer", category: "bearer-scheme" },
  { needle: "X-AgentThursday-Secret", category: "agentthursday-secret-header" },
  { needle: "payload_json", category: "payload-json-field" },
  { needle: "raw_token", category: "raw-token-identifier" },
  { needle: "raw_signature", category: "raw-signature-identifier" },
  { needle: "token_b64", category: "token-b64-identifier" },
  { needle: "AGENT_THURSDAY_APPROVAL_HMAC_KEY", category: "approval-hmac-key" },
  { needle: "AGENT_THURSDAY_SHARED_SECRET", category: "shared-secret" },
];

const MAX_PATH_LENGTH = 512;
const PATH_RE = /^[A-Za-z0-9_./\-]{1,512}$/;

export const PATCH_TEXT_MAX_BYTES = 256 * 1024;
export const SUMMARY_MAX_BYTES = 4 * 1024;

export function evaluatePatchPolicy(input: PatchPolicyInput): PatchPolicyResult {
  const allowed_paths: string[] = [];
  const denied_paths: PatchPolicyDenial[] = [];

  for (const raw of input.target_paths) {
    if (typeof raw !== "string" || raw.length === 0) {
      denied_paths.push({ path: String(raw), reason: "path-empty-or-non-string" });
      continue;
    }
    if (raw.length > MAX_PATH_LENGTH) {
      denied_paths.push({ path: raw.slice(0, 64), reason: "path-too-long" });
      continue;
    }
    if (!PATH_RE.test(raw)) {
      denied_paths.push({ path: raw, reason: "path-charset-rejected" });
      continue;
    }
    if (raw.includes("..")) {
      denied_paths.push({ path: raw, reason: "path-traversal" });
      continue;
    }
    if (raw.startsWith("/")) {
      denied_paths.push({ path: raw, reason: "path-absolute" });
      continue;
    }

    const denyHit = PATCH_PATH_DENYLIST.find((d) => d.pattern.test(raw));
    if (denyHit !== undefined) {
      denied_paths.push({ path: raw, reason: denyHit.reason });
      continue;
    }

    const allowHit = PATCH_PATH_ALLOWLIST.some((root) => raw.startsWith(root));
    if (!allowHit) {
      denied_paths.push({ path: raw, reason: "not-in-allowlist" });
      continue;
    }

    allowed_paths.push(raw);
  }

  const redaction_hits = scanForRedactionHits(input.patch_text, input.summary);

  const passed =
    denied_paths.length === 0 &&
    allowed_paths.length > 0 &&
    redaction_hits.length === 0;

  return {
    passed,
    allowed_paths,
    denied_paths,
    redaction_hits,
    policy_version: PATCH_POLICY_VERSION,
  };
}

function scanForRedactionHits(
  patch_text: string,
  summary: string | null,
): PatchPolicyRedactionHit[] {
  const haystacks: string[] = [patch_text];
  if (summary !== null && summary.length > 0) haystacks.push(summary);
  const counts = new Map<string, number>();
  for (const haystack of haystacks) {
    const lower = haystack.toLowerCase();
    for (const r of REDACTION_SUBSTRINGS) {
      const needleLower = r.needle.toLowerCase();
      let from = 0;
      let hits = 0;
      while (true) {
        const idx = lower.indexOf(needleLower, from);
        if (idx === -1) break;
        hits += 1;
        from = idx + needleLower.length;
      }
      if (hits > 0) {
        counts.set(r.category, (counts.get(r.category) ?? 0) + hits);
      }
    }
  }
  const result: PatchPolicyRedactionHit[] = [];
  for (const [category, count] of counts.entries()) {
    result.push({ category, count });
  }
  result.sort((a, b) => a.category.localeCompare(b.category));
  return result;
}

/**
 * Canonical input hash for a propose-patch artifact. Binds tool_id,
 * sorted target paths, and the patch text. Future apply path (Card
 * 219+) must use this same canonicalization so an approval token
 * issued against the artifact's input_hash mechanically matches at
 * consume time.
 */
export async function computePatchInputHash(opts: {
  tool_id: string;
  target_paths: ReadonlyArray<string>;
  patch_text: string;
}): Promise<string> {
  const sortedPaths = [...opts.target_paths].sort();
  return canonicalInputHash({
    tool_id: opts.tool_id,
    target_paths: sortedPaths,
    patch_text: opts.patch_text,
  });
}

/**
 * Generate an artifact id with 64 bits of entropy. Stable public
 * identifier; safe to surface in inspect / outbox.
 */
export function generatePatchArtifactId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `art_${hex}`;
}

export const ARTIFACT_ID_RE = /^art_[a-f0-9]{16}$/i;

// git SHA1 (full 40-hex). Used by `proposePatchArtifact` to
// validate caller-supplied `base_sha` and by `applyPatchDryRun` for
// the case-insensitive mismatch comparison against the sandbox-resolved
// `head_sha`. Anchored to forbid leading/trailing whitespace; case is
// not enforced (git CLI prints lowercase but callers may upper-case).
export const BASE_SHA_RE = /^[a-f0-9]{40}$/i;

/**
 * apply tool id. Distinct from the artifact's `tool_id` so the
 * apply approval binds to a different conceptual capability (apply, not
 * propose). The canonical apply input is intentionally short:
 *
 *   { tool_id: APPLY_TOOL_ID, artifact_id, artifact_input_hash }
 *
 * The `artifact_input_hash` field is the artifact row's `input_hash`,
 * which itself binds (artifact tool_id, sorted target_paths, patch_text).
 * So an apply approval transitively covers the patch body without
 * re-hashing it — and the issuer must point at one specific artifact_id,
 * which is mechanically enforced at apply time by re-deriving the apply
 * input_hash and matching the approval row's stored value.
 *
 * Spec §B requires either reusing the artifact's tool_id or defining a
 * new one with explicit canonical input. an earlier revision chose the latter so
 * apply-vs-propose can be approved separately in M8.7+ without ambiguity.
 */
export const APPLY_TOOL_ID = "m8.6.apply_patch.v1";

/**
 * Canonical input hash for an apply approval. Pure function; takes the
 * artifact's id and its existing input_hash so the hash is mechanically
 * reproducible without loading the patch body.
 */
export async function computeApplyInputHash(opts: {
  artifact_id: string;
  artifact_input_hash: string;
}): Promise<string> {
  return canonicalInputHash({
    tool_id: APPLY_TOOL_ID,
    artifact_id: opts.artifact_id,
    artifact_input_hash: opts.artifact_input_hash,
  });
}

/**
 * Parse a unified-diff to extract declared target paths and hunk count.
 * Used by the apply skeleton  as a **preflight** structural
 * gate: every `+++ b/<path>` in the diff must already be in the
 * artifact's `target_paths` allowlist.
 *
 * an earlier revision tighten: this is a conservative parser, not a `git apply`
 * substitute. `git apply --check`  remains the authoritative
 * validator. The parser's job is to reject *obviously* malformed,
 * unsupported, or ambiguous structures before paying the sandbox
 * round-trip — and to surface a categorical `error` for tests / debug
 * without affecting the call site, which only consumes `ok`.
 *
 * Reject categories (ok=false; first error wins):
 *   - `no_target` — no `+++` target ever recognized
 *   - `no_hunk` — targets present but zero `@@` hunks
 *   - `hunk_before_target` — `@@` appears before any `+++` in its
 *     section, or a section has hunks but no `+++`
 *   - `delete_only_unsupported` — `--- a/<path>` paired with
 *     `+++ /dev/null` (v1 cannot truly apply, deletion is rejected
 *     at preflight rather than blowing up `git apply --check`)
 *   - `target_quoted` — `+++ "..."` quoted paths (v1 does not handle
 *     git's quoted-path escape rules)
 *   - `target_absolute` — `+++ /absolute`
 *   - `target_traversal` — `+++ ../x` or `+++ b/../x`
 *   - `target_charset` — non-`[A-Za-z0-9_./-]` byte
 *   - `target_too_long` — > 512 chars
 *   - `target_empty` — empty after prefix strip
 *
 * Path output: paths are de-duplicated, preserving first-occurrence
 * order, with the optional git `b/` prefix stripped. /dev/null
 * targets are not included in `paths`.
 *
 * Pure function, no I/O.
 */
export function parseUnifiedDiffTargets(patchText: string): {
  paths: string[];
  hunks: number;
  ok: boolean;
  error?: string;
} {
  const paths: string[] = [];
  const seenPaths = new Set<string>();
  let hunks = 0;
  let firstError: string | null = null;

  const setErr = (code: string): void => {
    if (firstError === null) firstError = code;
  };

  type SectionMark = null | "dev_null" | "path";
  type Section = { source: SectionMark; target: SectionMark; hasHunks: boolean };
  let section: Section | null = null;

  const ensureSection = (): Section => {
    if (section === null) section = { source: null, target: null, hasHunks: false };
    return section;
  };

  const finalize = (s: Section | null): void => {
    if (s === null) return;
    if (s.hasHunks && s.target === null) setErr("hunk_before_target");
    if (s.target === "dev_null" && s.source === "path") setErr("delete_only_unsupported");
  };

  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finalize(section);
      section = { source: null, target: null, hasHunks: false };
      continue;
    }
    if (line.startsWith("--- ")) {
      const s = ensureSection();
      const rest = line.slice(4).replace(/\t.*$/, "").trimEnd();
      s.source = rest === "/dev/null" ? "dev_null" : "path";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const s = ensureSection();
      const rest = line.slice(4).replace(/\t.*$/, "").trimEnd();
      if (rest === "/dev/null") {
        s.target = "dev_null";
        continue;
      }
      if (rest.length === 0) { setErr("target_empty"); continue; }
      if (rest.startsWith('"')) { setErr("target_quoted"); continue; }
      const path = rest.startsWith("b/") ? rest.slice(2) : rest;
      if (path.length === 0) { setErr("target_empty"); continue; }
      if (path.startsWith("/")) { setErr("target_absolute"); continue; }
      if (path.split("/").includes("..")) { setErr("target_traversal"); continue; }
      if (path.length > 512) { setErr("target_too_long"); continue; }
      if (!/^[A-Za-z0-9_./\-]+$/.test(path)) { setErr("target_charset"); continue; }
      s.target = "path";
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        paths.push(path);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      hunks += 1;
      if (section === null || section.target === null) {
        setErr("hunk_before_target");
      } else {
        section.hasHunks = true;
      }
      continue;
    }
  }
  finalize(section);

  if (firstError === null) {
    if (paths.length === 0) setErr("no_target");
    else if (hunks === 0) setErr("no_hunk");
  }

  return {
    paths,
    hunks,
    ok: firstError === null,
    error: firstError ?? undefined,
  };
}
