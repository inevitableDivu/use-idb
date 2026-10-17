/**
 * Pluggable serialization interface for pre-encryption transformation.
 */
export interface SerializationHook {
  /**
   * Encodes an arbitrary value into a raw binary buffer for encryption.
   */
  encode: (value: unknown) => Uint8Array;

  /**
   * Decodes a raw binary buffer back into its original runtime structure.
   */
  decode: (buffer: Uint8Array) => unknown;
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

/**
 * Built-in rich serializer preserving Date, BigInt, Uint8Array, Map, and Set
 * with zero external dependencies.
 */
export const defaultSerializer: SerializationHook = {
  encode(value: unknown): Uint8Array {
    const jsonStr = JSON.stringify(value, function (this: any, key, val) {
      const raw = this ? this[key] : val;
      if (raw instanceof Date) {
        return { __t: "date", v: raw.toISOString() };
      }
      if (typeof val === "bigint" || typeof raw === "bigint") {
        return { __t: "bigint", v: (val ?? raw).toString() };
      }
      if (val instanceof Uint8Array || raw instanceof Uint8Array) {
        return { __t: "u8", v: toBase64(val ?? raw) };
      }
      if (val instanceof Map || raw instanceof Map) {
        return { __t: "map", v: Array.from((val ?? raw).entries()) };
      }
      if (val instanceof Set || raw instanceof Set) {
        return { __t: "set", v: Array.from((val ?? raw).values()) };
      }
      return val;
    });
    return new TextEncoder().encode(jsonStr);
  },

  decode(buffer: Uint8Array): unknown {
    const jsonStr = new TextDecoder().decode(buffer);
    return JSON.parse(jsonStr, (_key, val) => {
      if (val && typeof val === "object" && "__t" in val) {
        const tagged = val as { __t: string; v: unknown };
        switch (tagged.__t) {
          case "bigint":
            return BigInt(tagged.v as string);
          case "date":
            return new Date(tagged.v as string);
          case "u8":
            return fromBase64(tagged.v as string);
          case "map":
            return new Map(tagged.v as Array<[unknown, unknown]>);
          case "set":
            return new Set(tagged.v as unknown[]);
        }
      }
      return val;
    });
  },
};
