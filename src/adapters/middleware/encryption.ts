import type { IDBMiddleware } from "../../ports/middleware.port";

interface EncryptedField {
  __encrypted: true;
  iv: string; // base64
  ciphertext: string; // base64
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isEncryptedField(val: unknown): val is EncryptedField {
  return isRecord(val) && val["__encrypted"] === true;
}

/**
 * Creates an {@link IDBMiddleware} that transparently encrypts and decrypts specified fields
 * using authenticated AES-GCM (256-bit) via WebCrypto `crypto.subtle`.
 *
 * Each field encryption generates a fresh cryptographically random 12-byte IV.
 * Fields not present in a record are skipped without error.
 * If WebCrypto is unavailable (e.g. non-secure HTTP context), values pass through unmodified.
 *
 * @param key - AES-GCM `CryptoKey` generated via `crypto.subtle.generateKey` or imported with `importKey`.
 * @param fieldPaths - Array of property field names on records to encrypt.
 * @returns Configured {@link IDBMiddleware} instance.
 *
 * @example
 * ```typescript
 * import { createDatabase, createEncryptionMiddleware } from "use-idb";
 *
 * const key = await crypto.subtle.generateKey(
 *   { name: "AES-GCM", length: 256 },
 *   false,
 *   ["encrypt", "decrypt"]
 * );
 *
 * const db = createDatabase(schema, {
 *   middlewares: [
 *     createEncryptionMiddleware(key, ["ssn", "creditCardNumber"])
 *   ]
 * });
 * ```
 */
export function createEncryptionMiddleware(key: CryptoKey, fieldPaths: string[]): IDBMiddleware {
  const hasCrypto =
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined" &&
    typeof crypto.subtle.encrypt === "function";

  return {
    name: "encryption",

    async beforeWrite(ctx) {
      if (!hasCrypto || !isRecord(ctx.value)) return ctx.value;
      const record = { ...ctx.value } as Record<string, unknown>;

      for (const field of fieldPaths) {
        if (!(field in record)) continue;
        const plaintext = new TextEncoder().encode(JSON.stringify(record[field]));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
        record[field] = {
          __encrypted: true,
          iv: toBase64(iv.buffer),
          ciphertext: toBase64(ciphertext),
        } satisfies EncryptedField;
      }

      return record;
    },

    async afterRead(ctx) {
      if (!hasCrypto || !isRecord(ctx.value)) return ctx.value;
      const record = { ...ctx.value } as Record<string, unknown>;

      for (const field of fieldPaths) {
        const val = record[field];
        if (!isEncryptedField(val)) continue;
        const iv = fromBase64(val.iv);
        const ciphertext = fromBase64(val.ciphertext);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        record[field] = JSON.parse(new TextDecoder().decode(plaintext));
      }

      return record;
    },
  };
}
