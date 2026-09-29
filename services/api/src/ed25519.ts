import { createPublicKey, verify } from "node:crypto";

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32-byte raw key follows it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verifies a raw 64-byte Ed25519 signature with a raw 32-byte public key. Never throws on bad input. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  if (!(message instanceof Uint8Array)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
