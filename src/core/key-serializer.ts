import type { QueryAST } from "../types/query";

/**
 * Validates if a value is a valid IndexedDB key.
 * Per spec, IDBValidKey is: number (not NaN), string, Date (not invalid), ArrayBuffer / DataView / TypedArray, or Array of valid keys.
 */
export function isValidKey(key: unknown): key is IDBValidKey {
  if (key === null || key === undefined) return false;
  const t = typeof key;
  if (t === "string") return true;
  if (t === "number") return !Number.isNaN(key);
  if (key instanceof Date) return !Number.isNaN(key.getTime());
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return true;
  if (Array.isArray(key)) return key.every(isValidKey);
  return false;
}

/**
 * Serializes keys, transparently converting booleans (false -> 0, true -> 1)
 * to prevent DataError when querying or indexing.
 */
export function serializeKey(key: unknown): IDBValidKey {
  if (typeof key === "boolean") {
    return key ? 1 : 0;
  }
  if (isValidKey(key)) {
    return key;
  }
  if (key === null || key === undefined) {
    throw new TypeError("Invalid IndexedDB key: null or undefined");
  }
  if (Array.isArray(key)) {
    return key.map(serializeKey);
  }
  throw new TypeError(`Unsupported key type: ${typeof key}`);
}

/**
 * Safely converts any valid key or arbitrary key to a deterministic string
 * without triggering no-base-to-string lint warnings.
 */
export function toKeyString(key: unknown): string {
  const encode = (value: unknown): unknown => {
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
    if (value instanceof Date) return ["date", value.getTime()];
    if (value instanceof ArrayBuffer) return ["array-buffer", Array.from(new Uint8Array(value))];
    if (ArrayBuffer.isView(value)) {
      return [
        "array-buffer-view",
        value.constructor.name,
        Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      ];
    }
    if (Array.isArray(value)) return ["array", value.map(encode)];
    if (typeof value === "object") {
      return ["object", Object.keys(value as object).sort().map((key) => [key, encode((value as Record<string, unknown>)[key])])];
    }
    return [typeof value, String(value)];
  };
  return JSON.stringify(encode(key));
}

function stringifyRange(range?: IDBKeyRange | IDBValidKey): string {
  if (range === undefined) return "*";
  if (isValidKey(range)) return `exact:${toKeyString(range)}`;
  if (range instanceof IDBKeyRange) {
    return `[${toKeyString(range.lower)},${toKeyString(range.upper)},${String(range.lowerOpen)},${String(range.upperOpen)}]`;
  }
  return toKeyString(range);
}

/**
 * Computes a deterministic query hash string for L1 cache lookup.
 * Includes queryKey or filter predicate to eliminate cache collisions.
 */
export function hashQuery<T>(ast: QueryAST<T>, queryKey?: string): string {
  const parts = [
    ast.storeName,
    ast.indexName ?? "",
    ast.fieldName ?? "",
    stringifyRange(ast.range),
    ast.direction,
    String(ast.offsetCount),
    ast.limitCount !== undefined ? String(ast.limitCount) : "*",
    ast.isCount ? "count" : "data",
    ast.orderField ?? "",
    ast.orderDirection ?? "",
    ast.selectedFields?.join(",") ?? "",
    ast.filterKey ?? "",
    queryKey ?? ast.queryKey ?? (ast.filterPredicate ? ast.filterPredicate.toString() : ""),
  ];
  return parts.join("|");
}
