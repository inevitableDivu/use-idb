import type { IDBMiddleware } from "../../ports/middleware.port";
import { defaultSerializer, type SerializationHook } from "./serializer";

export class CryptographicContextUnavailableError extends Error {
  constructor(message = "WebCrypto API (crypto.subtle) is not available in the current execution environment.") {
    super(message);
    this.name = "CryptographicContextUnavailableError";
  }
}

export class KeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`Encryption key with ID "${keyId}" not found in KeyRing.`);
    this.name = "KeyNotFoundError";
  }
}

/**
 * Keyring mapping key IDs to WebCrypto AES-GCM keys for rotation.
 */
export interface KeyRing {
  /**
   * The active key ID used for all new encrypt operations.
   */
  primaryKeyId: string;
  /**
   * Map of known key IDs to CryptoKey instances for decryption.
   */
  keys: Record<string, CryptoKey>;
}

/**
 * Persisted envelope for an encrypted field.
 */
export interface EncryptedFieldEnvelope {
  __encrypted: true;
  v: 1;
  keyId: string;
  iv: string; // base64
  ciphertext: string; // base64
  /**
   * Whether the primary key was available and bound into AAD at write time.
   * Optional for backwards compatibility with envelopes created before this field existed.
   */
  keyBound?: boolean;
  /**
   * Key/AAD encoding version. Older v1 envelopes omit this and use legacy key encoding.
   */
  aadVersion?: 2;
}

/**
 * Options for configuring encryption middleware.
 */
export interface EncryptionOptions {
  /**
   * Custom binary serialization hook. Defaults to rich serializer supporting Date, BigInt, Uint8Array, Map, Set.
   */
  serializer?: SerializationHook;
  /**
   * KeyRing configuration for key rotation. If supplied, overrides the primary key argument.
   */
  keyRing?: KeyRing;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
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

function toArrayBufferSource(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(u8.byteLength);
  const res = new Uint8Array(buffer);
  res.set(u8);
  return res;
}

function isEncryptedEnvelope(val: unknown): val is EncryptedFieldEnvelope {
  return isRecord(val) && val["__encrypted"] === true && typeof val["ciphertext"] === "string";
}

/**
 * Safely resolves nested property paths (e.g. "profile.ssn"), preventing prototype pollution.
 */
function getDeepProperty(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (part === "__proto__" || part === "prototype" || part === "constructor") {
      return undefined;
    }
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Safely sets nested property paths, creating intermediate objects if necessary, preventing prototype pollution.
 */
function setDeepProperty(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (part === "__proto__" || part === "prototype" || part === "constructor") {
      return;
    }
    if (!isRecord(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (last !== "__proto__" && last !== "prototype" && last !== "constructor") {
    current[last] = value;
  }
}

function hasDeepProperty(obj: Record<string, unknown>, path: string): boolean {
  return getDeepProperty(obj, path) !== undefined;
}

const NIST_ENCRYPTION_WARNING_THRESHOLD = 1_073_741_824; // 2^30 operations

/**
 * Creates an {@link IDBMiddleware} that transparently encrypts and decrypts specified fields
 * using authenticated AES-GCM (256-bit) via WebCrypto `crypto.subtle`.
 *
 * Adheres strictly to NIST SP 800-38D:
 * - Fails closed if WebCrypto is unavailable (never leaks plaintext).
 * - Cryptographically binds ciphertext to storage context (storeName:key:fieldPath) via Authenticated Additional Data (AAD).
 * - Preserves rich types (Date, BigInt, Uint8Array, Map, Set) via pluggable or default serializer.
 * - Supports key rotation and KeyRing versioning.
 *
 * @param keyOrKeyRing - Primary AES-GCM `CryptoKey` or a {@link KeyRing} configuration.
 * @param fieldPaths - Array of property field names or dotted nested paths (e.g. `"profile.ssn"`) to encrypt.
 * @param options - Additional options for custom serializer and key rotation.
 * @returns Configured {@link IDBMiddleware} instance.
 */
export function createEncryptionMiddleware(
  keyOrKeyRing: CryptoKey | KeyRing,
  fieldPaths: string[],
  options?: EncryptionOptions,
): IDBMiddleware {
  const hasCrypto =
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined" &&
    typeof crypto.subtle.encrypt === "function" &&
    typeof crypto.subtle.decrypt === "function";

  if (!hasCrypto) {
    throw new CryptographicContextUnavailableError();
  }

  const keyRing: KeyRing =
    "primaryKeyId" in keyOrKeyRing
      ? keyOrKeyRing
      : options?.keyRing ?? {
          primaryKeyId: "default",
          keys: { default: keyOrKeyRing },
        };

  const serializer = options?.serializer ?? defaultSerializer;
  const encryptionCounters = new Map<string, number>();

  function getEncryptionKey(keyId: string): CryptoKey {
    const key = keyRing.keys[keyId];
    if (!key) throw new KeyNotFoundError(keyId);
    return key;
  }

  function trackCounter(keyId: string): void {
    const count = (encryptionCounters.get(keyId) ?? 0) + 1;
    encryptionCounters.set(keyId, count);
    if (count === NIST_ENCRYPTION_WARNING_THRESHOLD) {
      console.warn(
        `[use-idb Security Warning] NIST SP 800-38D threshold reached: Key "${keyId}" has performed over 2^30 encryptions. Key rotation is strongly recommended.`,
      );
    }
  }

  /**
 * Canonical, type-tagged representation of an IndexedDB key for AAD.
 * JSON-encoding the tagged tree avoids collisions between e.g. number 1 and
 * string "1", or compound keys whose string elements contain delimiters.
 * Binary views encode only their visible byte range, not the backing buffer.
 */
function serializeAadKey(key: IDBValidKey): string {
  const encode = (value: IDBValidKey): unknown => {
    if (typeof value === "string") return ["string", value];
    if (typeof value === "number") return ["number", Object.is(value, -0) ? 0 : value];
    if (value instanceof Date) return ["date", value.getTime()];
    if (Array.isArray(value)) return ["array", value.map((part) => encode(part))];
    if (value instanceof ArrayBuffer) {
      return ["binary", Array.from(new Uint8Array(value))];
    }
    if (ArrayBuffer.isView(value)) {
      return [
        "binary",
        Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      ];
    }
    throw new TypeError("Unsupported IndexedDB key in encryption context.");
  };
  return JSON.stringify(encode(key));
}

function computeAad(storeName: string, key: IDBValidKey | undefined, fieldPath: string): Uint8Array<ArrayBuffer> {
    const keyRepr = key !== undefined ? serializeAadKey(key) : "*";
    const aadStr = `v1:${storeName}:${keyRepr}:${fieldPath}`;
    const encoded = new TextEncoder().encode(aadStr);
    const buffer = new ArrayBuffer(encoded.byteLength);
    const aad = new Uint8Array(buffer);
    aad.set(encoded);
    return aad;
  }

  // Compatibility for envelopes created before canonical AAD key encoding was introduced.
  function computeLegacyAad(
    storeName: string,
    key: IDBValidKey | undefined,
    fieldPath: string,
  ): Uint8Array<ArrayBuffer> {
    // oxlint-disable-next-line no-base-to-string -- Preserve the exact legacy AAD encoding for existing ciphertexts.
    const keyRepr = key !== undefined ? String(key) : "*";
    const encoded = new TextEncoder().encode(`v1:${storeName}:${keyRepr}:${fieldPath}`);
    const buffer = new ArrayBuffer(encoded.byteLength);
    const aad = new Uint8Array(buffer);
    aad.set(encoded);
    return aad;
  }

  return {
    name: "encryption",

    async beforeWrite(ctx) {
      if (!hasCrypto) {
        throw new CryptographicContextUnavailableError();
      }
      if (!isRecord(ctx.value)) return ctx.value;
      const record = structuredClone(ctx.value) as Record<string, unknown>;

      const primaryKeyId = keyRing.primaryKeyId;
      const activeKey = getEncryptionKey(primaryKeyId);

      for (const field of fieldPaths) {
        if (!hasDeepProperty(record, field)) continue;
        const rawValue = getDeepProperty(record, field);

        // Do not double-encrypt already encrypted envelopes
        if (isEncryptedEnvelope(rawValue)) continue;

        const rawPlaintext = serializer.encode(rawValue);
        const plaintext = toArrayBufferSource(rawPlaintext);
        const ivBuffer = new ArrayBuffer(12);
        const iv = crypto.getRandomValues(new Uint8Array(ivBuffer));
        const aad = computeAad(ctx.storeName, ctx.key, field);

        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          activeKey,
          plaintext,
        );

        trackCounter(primaryKeyId);

        const envelope: EncryptedFieldEnvelope = {
          __encrypted: true,
          v: 1,
          keyId: primaryKeyId,
          iv: toBase64(iv),
          ciphertext: toBase64(new Uint8Array(ciphertext)),
          keyBound: ctx.key !== undefined,
          aadVersion: 2,
        };

        setDeepProperty(record, field, envelope);
      }

      return record;
    },

    async afterRead(ctx) {
      if (!hasCrypto) {
        throw new CryptographicContextUnavailableError();
      }
      if (!isRecord(ctx.value)) return ctx.value;
      const record = structuredClone(ctx.value) as Record<string, unknown>;

      for (const field of fieldPaths) {
        const val = getDeepProperty(record, field);
        if (!isEncryptedEnvelope(val)) continue;

        const keyId = val.keyId ?? "default";
        const decryptKey = getEncryptionKey(keyId);

        const iv = fromBase64(val.iv);
        const ciphertext = fromBase64(val.ciphertext);

        // New envelopes record whether a key was present at write time. Keyless
        // writes use store/field-scoped AAD ("*"); do not bind them to a generated
        // key that did not exist when encryption ran.
        let plaintext: ArrayBuffer;
        const aadKey = val.keyBound === false ? undefined : ctx.key;
        if (val.aadVersion === 2) {
          plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: computeAad(ctx.storeName, aadKey, field) },
            decryptKey,
            ciphertext,
          );
        } else {
          // Existing v1 envelopes used the old toKeyString() representation. Try
          // the original key-bound AAD first, then the legacy wildcard form for
          // records that were encrypted before their generated key was known.
          const legacyKey = val.keyBound === false ? undefined : ctx.key;
          try {
            plaintext = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv, additionalData: computeLegacyAad(ctx.storeName, legacyKey, field) },
              decryptKey,
              ciphertext,
            );
          } catch (legacyKeyError) {
            if (legacyKey === undefined) throw legacyKeyError;
            plaintext = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv, additionalData: computeLegacyAad(ctx.storeName, undefined, field) },
              decryptKey,
              ciphertext,
            );
          }
        }

        const decoded = serializer.decode(new Uint8Array(plaintext));
        setDeepProperty(record, field, decoded);
      }

      return record;
    },
  };
}
