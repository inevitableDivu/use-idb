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
  if (typeof key === "string") return key;
  if (typeof key === "number") return String(key);
  if (typeof key === "boolean") return key ? "1" : "0";
  if (key instanceof Date) return `date:${key.toISOString()}`;
  if (key instanceof ArrayBuffer) {
    return `buffer:${Array.from(new Uint8Array(key)).join(",")}`;
  }
  if (ArrayBuffer.isView(key)) {
    return `view:${Array.from(new Uint8Array(key.buffer)).join(",")}`;
  }
  if (Array.isArray(key)) {
    return `[${key.map(toKeyString).join(",")}]`;
  }
  if (key === null) return "null";
  if (key === undefined) return "undefined";
  return JSON.stringify(key);
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
    stringifyRange(ast.range),
    ast.direction,
    String(ast.offsetCount),
    ast.limitCount !== undefined ? String(ast.limitCount) : "*",
    ast.isCount ? "count" : "data",
    queryKey ?? ast.queryKey ?? (ast.filterPredicate ? ast.filterPredicate.toString() : ""),
  ];
  return parts.join("|");
}
