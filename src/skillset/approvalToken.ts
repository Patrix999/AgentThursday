/**
 * approval token helpers.
 *
 * Per `docs/adr/2026-05-09-m8.5-approval-replay-runtime-wire-up.md` and
 * approval tokens bind one approval decision to one tool dispatch:
 *
 *   binding = (agent_id, tool_id, input_hash, expires_at)
 *
 * The raw token is a high-entropy string returned to the reviewer once
 * (out of band). Persistent storage only keeps a hash; verifier replay
 * checks `hash(presented_token) == stored_hash`. The `token_id` is a
 * stable short prefix safe to surface in inspect / audit.
 *
 * Hard caps from the ADR: T4 ≤ 1800s, T5 ≤ 900s; manifests cannot widen.
 *
 * Helpers here are pure (no DO state, no I/O) so they can be unit tested
 * in isolation. The DO callable (channelHub.ts) wraps them for storage.
 */
import type { Tier } from "./types";

export type ApprovalStatus =
  | "pending"
  | "granted"
  | "denied"
  | "expired"
  | "consumed"
  | "replay_rejected";

export interface ApprovalRecord {
  token_id: string;
  token_hash: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  tier: Tier;
  status: ApprovalStatus;
  reviewer_id: string | null;
  reviewer_signature_hash: string | null;
  agent_reason: string | null;
  summary: string | null;
  expires_at: number;
  created_at: number;
  decided_at: number | null;
  consumed_at: number | null;
  // id of the HMAC key that produced `token_hash`. Persisted
  // so a future rotation can disambiguate which key to verify against.
  // Nullable for rows written before the column existed (an earlier revision legacy).
  key_id: string | null;
}

/**
 * Inspect-safe row shape. Mirrors `ApprovalRecord` but with `token_hash`
 * removed and bounded preview fields. Inspect surfaces MUST use this
 * shape — see an earlier revision ADR §D5: raw token / raw signature never cross
 * the inspect / outbox / reply / envelope boundary.
 */
export interface ApprovalInspectRow {
  token_id: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  tier: Tier;
  status: ApprovalStatus;
  reviewer_id: string | null;
  reviewer_signature_hash: string | null;
  agent_reason_preview: string | null;
  summary_preview: string | null;
  expires_at: number;
  created_at: number;
  decided_at: number | null;
  consumed_at: number | null;
  // only the key id is exposed to inspect; the secret material
  // it identifies never appears here. Null for legacy rows (pre-212c).
  key_id: string | null;
}

const PREVIEW_CAP = 200;

/**
 * Stable JSON stringify for canonical input hashing. Object keys are
 * sorted recursively so semantically equal inputs hash identically
 * regardless of property insertion order. Arrays preserve order.
 *
 * Excludes `undefined` values (matches `JSON.stringify` semantics).
 * `null` is preserved as a meaningful value distinct from missing.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalStringify: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "undefined" || typeof value === "function") {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return "null";
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Canonical hash of the tool input. The token binds to this hash so a
 * replay cannot mutate input between approval and consumption.
 */
export async function canonicalInputHash(input: unknown): Promise<string> {
  return sha256Hex(canonicalStringify(input));
}

const TOKEN_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Issue a new approval token. Returns:
 *  - `token` — the raw secret. Surfaced to the reviewer once, never
 *    persisted, never returned by inspect / outbox / envelope.
 *  - `token_id` — stable public id (token_hash prefix).
 *  - `token_hash` — what gets persisted; replay verifies against this.
 */
export async function issueApprovalToken(opts: {
  hmacKey: string;
  agent_id: string;
  tool_id: string;
  input_hash: string;
}): Promise<{ token: string; token_id: string; token_hash: string }> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = bytesToHex(raw);
  const token_hash = await hmacSign({
    key: opts.hmacKey,
    message: `${opts.agent_id}|${opts.tool_id}|${opts.input_hash}|${token}`,
  });
  // token_id is a short stable prefix of token_hash. Safe to surface
  // because the binding (agent_id|tool_id|input_hash|raw_token) cannot
  // be reconstructed from the prefix alone.
  const token_id = `tok_${token_hash.slice(0, 16)}`;
  return { token, token_id, token_hash };
}

/**
 * Verify a presented token against a stored record. Caller has already
 * loaded the `ApprovalRecord` row by `token_id`. Returns a discriminated
 * verdict so the dispatcher can decide whether to allow replay or
 * mark the record `replay_rejected`.
 */
export async function verifyApprovalToken(opts: {
  hmacKey: string;
  presented_token: string;
  record: ApprovalRecord;
  agent_id: string;
  tool_id: string;
  input_hash: string;
  now_ms: number;
}): Promise<
  | { ok: true }
  | { ok: false; reason: "agent_mismatch" | "tool_mismatch" | "input_hash_mismatch" | "expired" | "wrong_status" | "token_mismatch" }
> {
  if (opts.record.agent_id !== opts.agent_id) return { ok: false, reason: "agent_mismatch" };
  if (opts.record.tool_id !== opts.tool_id) return { ok: false, reason: "tool_mismatch" };
  if (opts.record.input_hash !== opts.input_hash) return { ok: false, reason: "input_hash_mismatch" };
  if (opts.record.status !== "granted") return { ok: false, reason: "wrong_status" };
  if (opts.record.expires_at <= opts.now_ms) return { ok: false, reason: "expired" };
  const expected = await hmacSign({
    key: opts.hmacKey,
    message: `${opts.agent_id}|${opts.tool_id}|${opts.input_hash}|${opts.presented_token}`,
  });
  if (!constantTimeEqual(expected, opts.record.token_hash)) {
    return { ok: false, reason: "token_mismatch" };
  }
  return { ok: true };
}

/**
 * HMAC-SHA256 with hex output. `key_id` is the caller's responsibility
 * (an earlier revision ADR OQ2: HMAC + key_id rotation). MVP path uses a single
 * binding env secret; key_id is recorded on the row so a future rotation
 * card can disambiguate.
 */
export async function hmacSign(opts: { key: string; message: string }): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(opts.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(opts.message));
  return bytesToHex(new Uint8Array(sig));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aa = hexToBytes(a);
  const bb = hexToBytes(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

/**
 * Hard-cap TTL by tier. ADR OQ3: T4 ≤ 1800s, T5 ≤ 900s. Manifests cannot
 * widen this — the cap is enforced runtime-side at issue time.
 */
export function clampTtlSecondsByTier(tier: Tier, requestedSec: number): number {
  // ADR OQ3: T4 ≤ 1800s, T5 ≤ 900s. Lower tiers don't need approval at
  // this layer, so the cap is ∞ — caller is responsible for not asking.
  const cap = tier === 5 ? 900 : tier === 4 ? 1800 : Number.POSITIVE_INFINITY;
  const requested = Number.isFinite(requestedSec) && requestedSec > 0 ? Math.floor(requestedSec) : 0;
  if (requested === 0) return cap === Number.POSITIVE_INFINITY ? 0 : cap;
  return Math.min(requested, cap);
}

function previewCap(s: string | null | undefined): string | null {
  if (typeof s !== "string" || s.length === 0) return null;
  return s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP)}…` : s;
}

/**
 * Strip raw token / raw signature, bound preview fields. The only path
 * inspect routes / DO callables should use to expose approval rows.
 */
export function redactApprovalRow(row: ApprovalRecord): ApprovalInspectRow {
  return {
    token_id: row.token_id,
    agent_id: row.agent_id,
    tool_id: row.tool_id,
    input_hash: row.input_hash,
    tier: row.tier,
    status: row.status,
    reviewer_id: row.reviewer_id,
    reviewer_signature_hash: row.reviewer_signature_hash,
    agent_reason_preview: previewCap(row.agent_reason),
    summary_preview: previewCap(row.summary),
    expires_at: row.expires_at,
    created_at: row.created_at,
    decided_at: row.decided_at,
    consumed_at: row.consumed_at,
    key_id: row.key_id,
  };
}

/**
 * hash a reviewer-supplied raw signature for storage.
 *
 * The raw signature value never crosses the inspect / outbox / envelope
 * boundary (an earlier revision ADR §D5); only this hash is persisted. SHA-256 hex
 * is the skeleton hash function — when 212e wires real cryptographic
 * signature verify, the hash here is what reviewers prove against.
 */
export async function hashReviewerSignature(rawSignature: string): Promise<string> {
  return sha256Hex(rawSignature);
}

/**
 * HMAC key sourcing with rotation handle.
 *
 * Prefers the dedicated `AGENT_THURSDAY_APPROVAL_HMAC_KEY`. Falls back to the
 * legacy `AGENT_THURSDAY_SHARED_SECRET` so rows issued before the dedicated key
 * was provisioned remain verifiable. The returned `key_id` is recorded
 * on the row so a future rotation card can disambiguate which key to
 * verify against; `legacy_shared` is the explicit marker that the
 * fallback path was used.
 *
 * Pure helper — caller passes raw env values; never logs / surfaces
 * the secret material.
 */
export function resolveApprovalHmacKey(opts: {
  approvalHmacKey?: string;
  sharedSecret?: string;
}): { hmacKey: string; key_id: string } | null {
  if (typeof opts.approvalHmacKey === "string" && opts.approvalHmacKey.length > 0) {
    return { hmacKey: opts.approvalHmacKey, key_id: "v1" };
  }
  if (typeof opts.sharedSecret === "string" && opts.sharedSecret.length > 0) {
    return { hmacKey: opts.sharedSecret, key_id: "legacy_shared" };
  }
  return null;
}
