import { describe, it, expect } from "vitest";
import { defaultSerializer, toKeyString } from "../src";

describe("Pluggable & Rich Serialization", () => {
  it("preserves Date, BigInt, Uint8Array, Map, and Set across serialization roundtrip", () => {
    const payload = {
      date: new Date("2026-10-17T09:00:00.000Z"),
      bigInt: 9007199254740993n,
      buffer: new Uint8Array([0, 42, 128, 255]),
      map: new Map<string, unknown>([
        ["alpha", 1],
        ["nestedDate", new Date("2025-01-01T00:00:00.000Z")],
      ]),
      set: new Set(["a", "b", "c"]),
      nested: {
        count: 42,
        active: true,
      },
    };

    const encoded = defaultSerializer.encode(payload);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = defaultSerializer.decode(encoded) as typeof payload;
    expect(decoded.date).toBeInstanceOf(Date);
    expect(decoded.date.toISOString()).toBe("2026-10-17T09:00:00.000Z");
    expect(decoded.bigInt).toBe(9007199254740993n);
    expect(decoded.buffer).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.buffer)).toEqual([0, 42, 128, 255]);
    expect(decoded.map).toBeInstanceOf(Map);
    expect(decoded.map.get("alpha")).toBe(1);
    expect(decoded.map.get("nestedDate")).toEqual(new Date("2025-01-01T00:00:00.000Z"));
    expect(decoded.set).toBeInstanceOf(Set);
    expect(Array.from(decoded.set)).toEqual(["a", "b", "c"]);
    expect(decoded.nested).toEqual({ count: 42, active: true });
  });
});

describe("Collision-safe IndexedDB key identity", () => {
  it("distinguishes key types, compound-key boundaries, and typed-array views", () => {
    expect(toKeyString(1)).not.toBe(toKeyString("1"));
    expect(toKeyString(["a,b", "c"])).not.toBe(toKeyString(["a", "b,c"]));
    expect(toKeyString(new Uint8Array([1, 2]))).not.toBe(toKeyString(new Uint16Array(new Uint8Array([1, 2]).buffer)));
    expect(toKeyString(new Date("2026-01-01T00:00:00.000Z"))).not.toBe(toKeyString("2026-01-01T00:00:00.000Z"));
  });
});
