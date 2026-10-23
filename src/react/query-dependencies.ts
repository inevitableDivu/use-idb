const objectIds = new WeakMap<object, number>();
const symbolIds = new Map<symbol, number>();
let nextIdentity = 1;

function identityOf(value: object | symbol): number {
  if (typeof value === "symbol") {
    let id = symbolIds.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      symbolIds.set(value, id);
    }
    return id;
  }
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextIdentity++;
    objectIds.set(value, id);
  }
  return id;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeDependency(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["number", "NaN"];
    if (Object.is(value, -0)) return ["number", "-0"];
    if (value === Infinity) return ["number", "+Infinity"];
    if (value === -Infinity) return ["number", "-Infinity"];
    return ["number", value];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "symbol") return ["symbol", identityOf(value)];
  if (typeof value === "function") return ["function", identityOf(value)];

  if (value instanceof Date) return ["date", value.getTime()];
  if (value instanceof ArrayBuffer) return ["array-buffer", Array.from(new Uint8Array(value))];
  if (ArrayBuffer.isView(value)) {
    return [
      "typed-array",
      value.constructor.name,
      Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    ];
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) return ["cycle", identityOf(objectValue)];

  if (Array.isArray(value)) {
    ancestors.add(objectValue);
    try {
      return ["array", value.map((item) => encodeDependency(item, ancestors))];
    } finally {
      ancestors.delete(objectValue);
    }
  }
  if (value instanceof Map) {
    ancestors.add(objectValue);
    try {
      const entries = Array.from(value, ([key, item]) => [
        encodeDependency(key, ancestors),
        encodeDependency(item, ancestors),
      ]);
      entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return ["map", entries];
    } finally {
      ancestors.delete(objectValue);
    }
  }
  if (value instanceof Set) {
    ancestors.add(objectValue);
    try {
      const values = Array.from(value, (item) => encodeDependency(item, ancestors));
      values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return ["set", values];
    } finally {
      ancestors.delete(objectValue);
    }
  }
  if (isPlainObject(objectValue)) {
    ancestors.add(objectValue);
    try {
      return [
        "object",
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, encodeDependency((value as Record<string, unknown>)[key], ancestors)]),
      ];
    } finally {
      ancestors.delete(objectValue);
    }
  }

  // DOM objects, class instances, and other opaque values use reference identity rather than
  // lossy JSON.stringify fallbacks or collisions between two instances with the same fields.
  return ["reference", identityOf(objectValue)];
}

/**
 * Stable query dependency identity for JSON-like data, with identity tokens for functions,
 * symbols, cyclic structures, DOM nodes, and other non-serializable values.
 */
export function hashDependencies(dependencies: readonly unknown[]): string {
  return JSON.stringify(encodeDependency(dependencies, new WeakSet<object>()));
}
