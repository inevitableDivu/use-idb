/**
 * Pluggable serialization interface for pre-encryption transformation.
 */
export interface SerializationHook {
  /** Encodes an arbitrary value into a raw binary buffer for encryption. */
  encode: (value: unknown) => Uint8Array;

  /** Decodes a raw binary buffer back into its original runtime structure. */
  decode: (buffer: Uint8Array) => unknown;
}

const SERIALIZER_MARKER = "__use_idb_serializer__";
const SERIALIZER_VERSION = 1;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function tagged(type: string, payload?: unknown): Record<string, unknown> {
  return { [SERIALIZER_MARKER]: SERIALIZER_VERSION, type, payload };
}

function encodeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === undefined) return tagged("undefined");
  if (typeof value === "bigint") return tagged("bigint", value.toString());
  if (typeof value === "number") {
    if (Number.isNaN(value)) return tagged("number", "NaN");
    if (value === Infinity) return tagged("number", "+Infinity");
    if (value === -Infinity) return tagged("number", "-Infinity");
    if (Object.is(value, -0)) return tagged("number", "-0");
    return value;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value !== "object") {
    throw new TypeError(`Unsupported value for IndexedDB serialization: ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Cyclic values are not supported by the built-in serializer.");
  }

  if (value instanceof Date) return tagged("date", value.getTime());
  if (value instanceof ArrayBuffer) {
    return tagged("array-buffer", toBase64(new Uint8Array(value)));
  }
  if (ArrayBuffer.isView(value)) {
    return tagged("typed-array", {
      constructor: value.constructor.name,
      bytes: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    });
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => encodeValue(item, ancestors));
    }
    if (value instanceof Map) {
      return tagged(
        "map",
        Array.from(value, ([key, item]) => [
          encodeValue(key, ancestors),
          encodeValue(item, ancestors),
        ]),
      );
    }
    if (value instanceof Set) {
      return tagged(
        "set",
        Array.from(value, (item) => encodeValue(item, ancestors)),
      );
    }

    // Wrap every ordinary object as entries. User data can therefore contain fields that
    // resemble serializer metadata without being misinterpreted during decode.
    return tagged(
      "object",
      Object.keys(value).map((key) => [
        key,
        encodeValue((value as Record<string, unknown>)[key], ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function decodeTypedArray(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Malformed typed-array serialization payload.");
  }
  const descriptor = payload as { constructor?: unknown; bytes?: unknown };
  if (typeof descriptor.constructor !== "string" || typeof descriptor.bytes !== "string") {
    throw new TypeError("Malformed typed-array serialization payload.");
  }
  const bytes = fromBase64(descriptor.bytes);
  const copy = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  switch (descriptor.constructor) {
    case "DataView":
      return new DataView(copy);
    case "Int8Array":
      return new Int8Array(copy);
    case "Uint8Array":
      return new Uint8Array(copy);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(copy);
    case "Int16Array":
      return new Int16Array(copy);
    case "Uint16Array":
      return new Uint16Array(copy);
    case "Int32Array":
      return new Int32Array(copy);
    case "Uint32Array":
      return new Uint32Array(copy);
    case "Float32Array":
      return new Float32Array(copy);
    case "Float64Array":
      return new Float64Array(copy);
    case "BigInt64Array":
      return new BigInt64Array(copy);
    case "BigUint64Array":
      return new BigUint64Array(copy);
    default:
      throw new TypeError(`Unsupported typed-array constructor "${descriptor.constructor}".`);
  }
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (record[SERIALIZER_MARKER] !== SERIALIZER_VERSION || typeof record.type !== "string") {
    // This path is for ordinary structures decoded from older envelopes.
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      Object.defineProperty(result, key, {
        value: decodeValue(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }

  switch (record.type) {
    case "undefined":
      return undefined;
    case "bigint":
      if (typeof record.payload !== "string")
        throw new TypeError("Malformed bigint serializer payload.");
      return BigInt(record.payload);
    case "number":
      if (record.payload === "NaN") return Number.NaN;
      if (record.payload === "+Infinity") return Infinity;
      if (record.payload === "-Infinity") return -Infinity;
      if (record.payload === "-0") return -0;
      throw new TypeError("Malformed number serializer payload.");
    case "date":
      if (typeof record.payload !== "number")
        throw new TypeError("Malformed date serializer payload.");
      return new Date(record.payload);
    case "array-buffer": {
      if (typeof record.payload !== "string")
        throw new TypeError("Malformed ArrayBuffer serializer payload.");
      const bytes = fromBase64(record.payload);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case "typed-array":
      return decodeTypedArray(record.payload);
    case "map":
      if (!Array.isArray(record.payload)) throw new TypeError("Malformed Map serializer payload.");
      return new Map(
        record.payload.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new TypeError("Malformed Map entry in serializer payload.");
          }
          return [decodeValue(entry[0]), decodeValue(entry[1])];
        }),
      );
    case "set":
      if (!Array.isArray(record.payload)) throw new TypeError("Malformed Set serializer payload.");
      return new Set(record.payload.map(decodeValue));
    case "object": {
      if (!Array.isArray(record.payload))
        throw new TypeError("Malformed object serializer payload.");
      const result: Record<string, unknown> = {};
      for (const entry of record.payload) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          throw new TypeError("Malformed object entry in serializer payload.");
        }
        Object.defineProperty(result, entry[0], {
          value: decodeValue(entry[1]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    case "root":
      return decodeValue(record.payload);
    default:
      throw new TypeError(`Unknown serializer tag "${record.type}".`);
  }
}

function decodeLegacyJSON(json: string): unknown {
  return JSON.parse(json, (_key, val) => {
    if (val && typeof val === "object" && "__t" in val) {
      const taggedValue = val as { __t: string; v: unknown };
      switch (taggedValue.__t) {
        case "bigint":
          return BigInt(taggedValue.v as string);
        case "date":
          return new Date(taggedValue.v as string);
        case "u8":
          return fromBase64(taggedValue.v as string);
        case "map":
          return new Map(taggedValue.v as Array<[unknown, unknown]>);
        case "set":
          return new Set(taggedValue.v as unknown[]);
      }
    }
    return val;
  });
}

/**
 * Built-in versioned serializer. It preserves Date, BigInt, ArrayBuffer, DataView,
 * typed arrays, Map, Set, undefined, and non-finite numbers. Objects use an explicit
 * entry envelope to avoid collisions with user properties that resemble metadata.
 *
 * Decoder compatibility: envelopes written by the earlier __t-based JSON format remain readable.
 */
export const defaultSerializer: SerializationHook = {
  encode(value: unknown): Uint8Array {
    const tree = tagged("root", encodeValue(value, new WeakSet<object>()));
    return new TextEncoder().encode(JSON.stringify(tree));
  },

  decode(buffer: Uint8Array): unknown {
    const json = new TextDecoder().decode(buffer);
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)[SERIALIZER_MARKER] === SERIALIZER_VERSION &&
      (parsed as Record<string, unknown>).type === "root"
    ) {
      return decodeValue(parsed);
    }
    return decodeLegacyJSON(json);
  },
};
