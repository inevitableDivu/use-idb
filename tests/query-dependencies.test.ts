import { describe, expect, it } from "vitest";
import { hashDependencies } from "../src/react/query-dependencies";

describe("live query dependency identity", () => {
  it("hashes plain objects by stable, sorted keys", () => {
    expect(hashDependencies([{ a: 1, b: 2 }])).toBe(hashDependencies([{ b: 2, a: 1 }]));
  });

  it("does not collapse functions or opaque instances into JSON placeholders", () => {
    const firstFn = () => 1;
    const secondFn = () => 1;
    expect(hashDependencies([firstFn])).not.toBe(hashDependencies([secondFn]));

    class Token {
      constructor(readonly value: number) {}
    }
    expect(hashDependencies([new Token(1)])).not.toBe(hashDependencies([new Token(1)]));
  });

  it("handles cyclic data and maps/sets without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => hashDependencies([cyclic])).not.toThrow();

    const left = new Map<unknown, unknown>([["a", 1], ["b", 2]]);
    const right = new Map<unknown, unknown>([["b", 2], ["a", 1]]);
    expect(hashDependencies([left])).toBe(hashDependencies([right]));

    const setA = new Set(["a", "b"]);
    const setB = new Set(["b", "a"]);
    expect(hashDependencies([setA])).toBe(hashDependencies([setB]));
  });

  it("distinguishes undefined, null, special numbers, and binary view types", () => {
    expect(hashDependencies([undefined])).not.toBe(hashDependencies([null]));
    expect(hashDependencies([Number.NaN])).not.toBe(hashDependencies(["NaN"]));
    expect(hashDependencies([new Uint8Array([1, 2])])).not.toBe(
      hashDependencies([new Uint16Array(new Uint8Array([1, 2]).buffer)]),
    );
  });
});
