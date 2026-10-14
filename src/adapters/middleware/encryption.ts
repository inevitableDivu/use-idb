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
 * Optional WebCrypto AES-GCM field encryption middleware.
 * Encrypts/decrypts specified fields transparently.
 * Skips fields that don't exist in the record.
 * Passes through unchanged if crypto.subtle is unavailable.
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
