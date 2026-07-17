import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "./credentialCrypto";

// A fixed 32-byte master key (base64) for deterministic tests.
const MASTER = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)).toString("base64");
const MASTER2 = Buffer.from(new Uint8Array(32).map((_, i) => (i * 11 + 1) & 0xff)).toString("base64");

describe("credentialCrypto — AES-256-GCM envelope", () => {
  it("round-trips a secret", async () => {
    const pt = "sk-deepseek-abcdef0123456789";
    const env = await encryptSecret(pt, MASTER);
    assert.equal(isEncryptedSecret(env), true);
    assert.match(env, /^v1:[^:]+:.+$/);
    assert.equal(await decryptSecret(env, MASTER), pt);
  });

  it("ciphertext differs each time (random IV) but decrypts the same", async () => {
    const pt = "same-secret";
    const a = await encryptSecret(pt, MASTER);
    const b = await encryptSecret(pt, MASTER);
    assert.notEqual(a, b);
    assert.equal(await decryptSecret(a, MASTER), pt);
    assert.equal(await decryptSecret(b, MASTER), pt);
  });

  it("legacy plaintext (no v1: prefix) passes through unchanged", async () => {
    assert.equal(isEncryptedSecret("sk-plain-legacy"), false);
    assert.equal(await decryptSecret("sk-plain-legacy", MASTER), "sk-plain-legacy");
  });

  it("a wrong master key fails (GCM auth tag)", async () => {
    const env = await encryptSecret("top-secret", MASTER);
    await assert.rejects(() => decryptSecret(env, MASTER2));
  });

  it("tampered ciphertext fails to decrypt", async () => {
    const env = await encryptSecret("top-secret", MASTER);
    // flip the last char of the ciphertext segment
    const flipped = env.slice(0, -1) + (env.endsWith("A") ? "B" : "A");
    await assert.rejects(() => decryptSecret(flipped, MASTER));
  });

  it("rejects a master key that isn't 32 bytes", async () => {
    const short = Buffer.from(new Uint8Array(16)).toString("base64");
    await assert.rejects(() => encryptSecret("x", short));
  });

  it("handles unicode + empty secrets", async () => {
    for (const pt of ["", "ключ-密钥-🔑"]) {
      const env = await encryptSecret(pt, MASTER);
      assert.equal(await decryptSecret(env, MASTER), pt);
    }
  });
});
