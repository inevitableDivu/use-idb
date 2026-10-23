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


describe("Versioned rich serializer compatibility", () => {
  it("round-trips ArrayBuffer, DataView, typed arrays, undefined, and special numbers", () => {
    const input = {
      arrayBuffer: new Uint8Array([4, 5, 6]).buffer,
      dataView: new DataView(new Uint8Array([7, 8, 9, 10]).buffer, 1, 2),
      signed: new Int16Array([-2, 300]),
      floats: new Float32Array([1.25, -4.5]),
      bigintArray: new BigInt64Array([12n, -13n]),
      absent: undefined,
      nan: Number.NaN,
      positiveInfinity: Infinity,
      negativeInfinity: -Infinity,
      negativeZero: -0,
    };

    const output = defaultSerializer.decode(defaultSerializer.encode(input)) as typeof input;
    expect(Array.from(new Uint8Array(output.arrayBuffer))).toEqual([4, 5, 6]);
    expect(output.dataView).toBeInstanceOf(DataView);
    expect(Array.from(new Uint8Array(output.dataView.buffer))).toEqual([8, 9]);
    expect(output.signed).toBeInstanceOf(Int16Array);
    expect(Array.from(output.signed)).toEqual([-2, 300]);
    expect(output.floats).toBeInstanceOf(Float32Array);
    expect(Array.from(output.floats)).toEqual([1.25, -4.5]);
    expect(output.bigintArray).toBeInstanceOf(BigInt64Array);
    expect(Array.from(output.bigintArray)).toEqual([12n, -13n]);
    expect("absent" in output).toBe(true);
    expect(output.absent).toBeUndefined();
    expect(Number.isNaN(output.nan)).toBe(true);
    expect(output.positiveInfinity).toBe(Infinity);
    expect(output.negativeInfinity).toBe(-Infinity);
    expect(Object.is(output.negativeZero, -0)).toBe(true);
  });

  it("does not confuse ordinary user objects with serializer metadata", () => {
    const input = {
      __t: "date",
      v: "not a date",
      __use_idb_serializer__: 1,
      type: "date",
      payload: "ordinary user data",
      nested: {
        __t: "map",
        v: [["x", 1]],
      },
    };

    expect(defaultSerializer.decode(defaultSerializer.encode(input))).toEqual(input);
  });

  it("continues decoding legacy serializer envelopes", () => {
    const legacy = {
      oldDate: { __t: "date", v: "2025-01-01T00:00:00.000Z" },
      oldBigInt: { __t: "bigint", v: "9007199254740993" },
      oldBytes: { __t: "u8", v: "AQID" },
      oldMap: { __t: "map", v: [["x", 1]] },
      oldSet: { __t: "set", v: ["a", "b"] },
    };
    const encoded = new TextEncoder().encode(JSON.stringify(legacy));
    const decoded = defaultSerializer.decode(encoded) as typeof legacy & {
      oldDate: Date;
      oldBigInt: bigint;
      oldBytes: Uint8Array;
      oldMap: Map<string, number>;
      oldSet: Set<string>;
    };

    expect(decoded.oldDate).toEqual(new Date("2025-01-01T00:00:00.000Z"));
    expect(decoded.oldBigInt).toBe(9007199254740993n);
    expect(Array.from(decoded.oldBytes)).toEqual([1, 2, 3]);
    expect(decoded.oldMap).toBeInstanceOf(Map);
    expect(decoded.oldMap.get("x")).toBe(1);
    expect(decoded.oldSet).toBeInstanceOf(Set);
    expect(Array.from(decoded.oldSet)).toEqual(["a", "b"]);
  });

  it("rejects cyclic values with an actionable error", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => defaultSerializer.encode(cyclic)).toThrow(/Cyclic values are not supported/);
  });
});

describe("Collision-safe IndexedDB key identity", () => {
  it("distinguishes key types, compound-key boundaries, and typed-array views", () => {
    expect(toKeyString(1)).not.toBe(toKeyString("1"));
    expect(toKeyString(["a,b", "c"])).not.toBe(toKeyString(["a", "b,c"]));
    expect(toKeyString(new Uint8Array([1, 2]))).not.toBe(
      toKeyString(new Uint16Array(new Uint8Array([1, 2]).buffer)),
    );
    expect(toKeyString(new Date("2026-01-01T00:00:00.000Z"))).not.toBe(toKeyString("2026-01-01T00:00:00.000Z"));
    expect(toKeyString(-0)).toBe(toKeyString(0));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(toKeyString(bytes.buffer)).not.toBe(toKeyString(new Uint16Array(bytes.buffer)));
  });
});
