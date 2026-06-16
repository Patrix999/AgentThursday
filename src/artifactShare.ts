/**
 *  — workspace artifact share API v1 pure helpers.
 *
 * Pure validators / scanners used by both the route handlers in
 * `src/server.ts` and the DO-side write/read methods on AgentThursdayAgent.
 *
 * Follows the 245c contract at
 * ``
 * (§4 artifact types, §8 envelope v1, §9.1–9.3 path / secret / size).
 *
 * Scope constraints (245d card body):
 *   - no github.pr.create / branch / push;
 *   - no envelope signing;
 *   - no directory bundle extraction;
 *   - read is artifact-scoped (tmp/artifact/<card_id>/), not arbitrary repo.
 */

export const ARTIFACT_ENVELOPE_VERSION = "1" as const;

export const ARTIFACT_TYPES = [
  "patch",
  "test_doc",
  "smoke_json",
  "completion_report",
  "directory_bundle",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const DEFAULT_MIME: Record<ArtifactType, string> = {
  patch: "text/x-diff",
  test_doc: "text/markdown",
  smoke_json: "application/json",
  completion_report: "text/markdown",
  directory_bundle: "application/gzip",
};

// 245c §4 + §8 default MIMEs, plus the small set of explicitly
// permitted alternates. Anything outside this allowlist is rejected
// in `writeArtifact` so callers can't push arbitrary content-types
// through the envelope (and so reviewer UIs have a closed set).
export const ALLOWED_MIMES: ReadonlySet<string> = new Set([
  "text/x-diff",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/x-ndjson",
  "application/gzip",
  "application/zip",
]);

// v1 scope (245c §11 "245d 非目标"): binary directory bundles are
// NOT implemented — the API only stores UTF-8 string content.
// Declared here so the validator and the route handler agree.
export const TYPES_REJECTED_IN_V1: ReadonlySet<ArtifactType> = new Set([
  "directory_bundle",
]);

// 245c §8 — `notes` is a reviewer hint, not part of the signed
// payload; cap at 200 chars to match the contract's "< 200 chars" note.
export const NOTES_MAX_LENGTH = 200;

// 245c §9.2 single-file caps. v1 enforces single-file only; the
// per-card aggregate cap is left to a follow-up.
export const SIZE_CAP_BYTES: Record<ArtifactType, number> = {
  patch: 256 * 1024,
  test_doc: 512 * 1024,
  smoke_json: 1 * 1024 * 1024,
  completion_report: 64 * 1024,
  directory_bundle: 4 * 1024 * 1024,
};

// 245c §9.3 secret patterns. Match → reject with HTTP 422 in v1
// (no redact-and-store, per verifier decision recorded in 245d
// card body Background).
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "aws_temp_key", re: /ASIA[0-9A-Z]{16}/ },
  { name: "github_token_short", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]{82}/ },
  { name: "openai_anthropic_style_secret", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "slack_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "bearer_header", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  {
    name: "private_key_block",
    re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

export type ValidationError =
  | { code: "invalid_card_id"; message: string }
  | { code: "invalid_filename"; message: string }
  | { code: "invalid_type"; message: string }
  | { code: "invalid_source_agent"; message: string }
  | { code: "content_required"; message: string }
  | { code: "denied_path"; message: string }
  | { code: "oversize"; message: string; cap: number; size: number }
  | { code: "secret_pattern"; message: string; pattern: string };

const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FILENAME_RE = /^[A-Za-z0-9._-]+$/;
const FILENAME_MAX = 128;
const SOURCE_AGENT_ALLOWED = new Set(["", "", "", "verifier"]);

// 245c §9.1 denylist — names that must never appear as a card id
// or filename segment, even if they pass the character allowlist.
const DENYLIST_SEGMENTS = [
  ".git",
  "node_modules",
  "secrets",
];

const DENYLIST_PREFIXES = [".env"];

export function validateCardId(input: unknown): ValidationError | { ok: true; cardId: string } {
  if (typeof input !== "string" || input.length === 0) {
    return { code: "invalid_card_id", message: "card_id is required and must be a string" };
  }
  if (!CARD_ID_RE.test(input)) {
    return {
      code: "invalid_card_id",
      message: "card_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}",
    };
  }
  if (DENYLIST_SEGMENTS.includes(input)) {
    return { code: "denied_path", message: `card_id is on denylist: ${input}` };
  }
  if (DENYLIST_PREFIXES.some(p => input.startsWith(p))) {
    return { code: "denied_path", message: `card_id starts with denylisted prefix` };
  }
  return { ok: true, cardId: input };
}

export function validateFilename(input: unknown): ValidationError | { ok: true; filename: string } {
  if (typeof input !== "string" || input.length === 0) {
    return { code: "invalid_filename", message: "filename is required and must be a string" };
  }
  if (input.length > FILENAME_MAX) {
    return {
      code: "invalid_filename",
      message: `filename length ${input.length} exceeds ${FILENAME_MAX}`,
    };
  }
  if (!FILENAME_RE.test(input)) {
    return {
      code: "invalid_filename",
      message: "filename must match [A-Za-z0-9._-]+",
    };
  }
  // Reserved-name / traversal cases that pass the regex.
  if (input === "." || input === ".." || input.startsWith("..")) {
    return { code: "invalid_filename", message: "filename contains traversal segment" };
  }
  if (DENYLIST_SEGMENTS.includes(input)) {
    return { code: "denied_path", message: `filename is on denylist: ${input}` };
  }
  if (DENYLIST_PREFIXES.some(p => input.startsWith(p))) {
    return { code: "denied_path", message: `filename starts with denylisted prefix` };
  }
  // The envelope suffix is server-reserved.
  if (input.endsWith(".envelope.json")) {
    return {
      code: "invalid_filename",
      message: ".envelope.json suffix is reserved for server-generated envelopes",
    };
  }
  return { ok: true, filename: input };
}

export function validateType(input: unknown): ValidationError | { ok: true; type: ArtifactType } {
  if (typeof input !== "string") {
    return { code: "invalid_type", message: "type is required" };
  }
  if (!(ARTIFACT_TYPES as readonly string[]).includes(input)) {
    return {
      code: "invalid_type",
      message: `type must be one of ${ARTIFACT_TYPES.join(", ")}`,
    };
  }
  return { ok: true, type: input as ArtifactType };
}

export function validateSourceAgent(input: unknown): ValidationError | { ok: true; sourceAgent: string } {
  if (typeof input !== "string" || input.length === 0) {
    return { code: "invalid_source_agent", message: "source_agent is required" };
  }
  if (!SOURCE_AGENT_ALLOWED.has(input)) {
    return {
      code: "invalid_source_agent",
      message: `source_agent must be one of ${Array.from(SOURCE_AGENT_ALLOWED).join(", ")}`,
    };
  }
  return { ok: true, sourceAgent: input };
}

export function checkSize(
  type: ArtifactType,
  sizeBytes: number,
): { code: "oversize"; message: string; cap: number; size: number } | { ok: true } {
  const cap = SIZE_CAP_BYTES[type];
  if (sizeBytes > cap) {
    return {
      code: "oversize",
      message: `artifact size ${sizeBytes} bytes exceeds cap ${cap} for type ${type}`,
      cap,
      size: sizeBytes,
    };
  }
  return { ok: true };
}

export function scanSecrets(
  content: string,
): { code: "secret_pattern"; message: string; pattern: string } | { ok: true } {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      return {
        code: "secret_pattern",
        message: `content matches reject pattern: ${name}`,
        pattern: name,
      };
    }
  }
  return { ok: true };
}

/**
 * Hex sha256 of a UTF-8 string. Uses the Web Crypto API which is
 * available in Cloudflare Workers and modern Node.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const view = new Uint8Array(digest);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export interface ArtifactEnvelope {
  envelope_version: typeof ARTIFACT_ENVELOPE_VERSION;
  card_id: string;
  type: ArtifactType;
  filename: string;
  mime: string;
  source_agent: string;
  producer_user_id?: string;
  created_at: string;
  sha256: string;
  size_bytes: number;
  transport: "workspace_share";
  transport_uri: string;
  notes?: string;
}

export interface BuildEnvelopeInput {
  cardId: string;
  filename: string;
  type: ArtifactType;
  mime?: string;
  sourceAgent: string;
  producerUserId?: string;
  sha256: string;
  sizeBytes: number;
  notes?: string;
  createdAt?: string;
}

export function buildEnvelope(input: BuildEnvelopeInput): ArtifactEnvelope {
  const env: ArtifactEnvelope = {
    envelope_version: ARTIFACT_ENVELOPE_VERSION,
    card_id: input.cardId,
    type: input.type,
    filename: input.filename,
    mime: input.mime ?? DEFAULT_MIME[input.type],
    source_agent: input.sourceAgent,
    created_at: input.createdAt ?? new Date().toISOString(),
    sha256: input.sha256,
    size_bytes: input.sizeBytes,
    transport: "workspace_share",
    transport_uri: `/api/artifact/${input.cardId}/${input.filename}`,
  };
  if (input.producerUserId) env.producer_user_id = input.producerUserId;
  if (input.notes) env.notes = input.notes;
  return env;
}

export function envelopePath(cardId: string, filename: string): string {
  return `tmp/artifact/${cardId}/${filename}.envelope.json`;
}

export function bodyPath(cardId: string, filename: string): string {
  return `tmp/artifact/${cardId}/${filename}`;
}

export function cardDir(cardId: string): string {
  return `tmp/artifact/${cardId}`;
}
