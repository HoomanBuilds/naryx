/** Thrown where the browser withholds Web Crypto because the page is not served from a secure context. */
export const INSECURE_CONTEXT_MESSAGE =
  "This browser withholds Web Crypto on a page that is not served over HTTPS or localhost, so packages cannot be hashed or signed here. Open the terminal over HTTPS.";

/** The browser's SubtleCrypto, or a clear error when the page is not a secure context. */
export function requireSubtleCrypto(): SubtleCrypto {
  const subtle = typeof globalThis.crypto === "object" ? globalThis.crypto.subtle : undefined;
  if (subtle === undefined || subtle === null) throw new Error(INSECURE_CONTEXT_MESSAGE);
  return subtle;
}

/**
 * A random RFC 4122 version 4 identifier. crypto.randomUUID exists only in secure contexts, while
 * crypto.getRandomValues is available everywhere, so idempotency keys work on any origin.
 */
export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function" && globalThis.isSecureContext !== false) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
