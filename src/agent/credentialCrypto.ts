/**
 * 2026-06-22 — application-level envelope encryption for stored provider API
 * keys. AES-256-GCM via WebCrypto; the master key is a base64 wrangler secret
 * (`CRED_ENC_KEY`, 32 raw bytes). A DB dump alone yields ciphertext — decrypting
 * also requires the master key, which lives only in the worker env.
 *
 * Stored envelope format (one string, fits the existing `api_key` TEXT column):
 *   `v1:<base64(iv)>:<base64(ciphertext+gcmTag)>`
 *
 * Backward compatible: a stored value WITHOUT the `v1:` prefix is treated as a
 * legacy plaintext key and returned as-is by `decryptSecret` (so pre-encryption
 * rows keep working; the caller lazily re-encrypts them on read).
 *
 * Pure module: no env reads, no I/O beyond WebCrypto — unit-testable.
 */

const ENVELOPE_PREFIX = "v1:";
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(masterKeyB64.trim());
  if (raw.length !== MASTER_KEY_BYTES) {
    throw new Error(`CRED_ENC_KEY must be base64 of ${MASTER_KEY_BYTES} bytes (AES-256); got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** True when the stored value is an encrypted envelope (not legacy plaintext). */
export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt a plaintext secret into the `v1:iv:ct` envelope. */
export async function encryptSecret(plaintext: string, masterKeyB64: string): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext) as unknown as ArrayBuffer,
  );
  return ENVELOPE_PREFIX + b64encode(iv) + ":" + b64encode(new Uint8Array(ctBuf));
}

/**
 * Decrypt a stored value. A non-`v1:` value is a legacy plaintext key and is
 * returned unchanged. Throws on a malformed envelope or auth-tag failure
 * (tampered ciphertext / wrong master key) — callers fail closed.
 */
export async function decryptSecret(stored: string, masterKeyB64: string): Promise<string> {
  if (!isEncryptedSecret(stored)) return stored; // legacy plaintext
  const rest = stored.slice(ENVELOPE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) throw new Error("malformed encrypted secret: missing iv/ciphertext separator");
  const iv = b64decode(rest.slice(0, sep));
  const ct = b64decode(rest.slice(sep + 1));
  const key = await importMasterKey(masterKeyB64);
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
    key,
    ct as unknown as ArrayBuffer,
  );
  return new TextDecoder().decode(ptBuf);
}
