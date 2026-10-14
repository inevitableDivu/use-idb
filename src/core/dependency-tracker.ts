import type { MutationEnvelope } from "../ports/sync.port";
import type { CacheEntry } from "./l1-cache";
import { toKeyString } from "./key-serializer";

/**
 * Granular dependency tracker that matches mutation envelopes
 * against active cache entries, determining which queries need invalidation.
 */
export class DependencyTracker {
  /**
   * Determines if a cache entry should be invalidated by a given mutation.
   *
   * Matching rules:
   * 1. The entry must depend on the mutated store.
   * 2. If operation is 'clear' or entry has no key dependency (full store query) → always invalidate.
   * 3. If entry watches a specific key → only invalidate if that key is in affectedKeys.
   * 4. If entry watches a key range → only invalidate if any affected key falls within the range.
   */
  shouldInvalidate(entry: CacheEntry, envelope: MutationEnvelope): boolean {
    // Must depend on the same store
    if (!entry.storeNames.has(envelope.storeName)) {
      return false;
    }

    // 'clear' always invalidates everything in the store
    if (envelope.operation === "clear") {
      return true;
    }

    // No key dependency means this is a full-store query → always invalidate
    if (entry.keyDependency === undefined) {
      return true;
    }

    // Specific key dependency
    if (isValidKey(entry.keyDependency)) {
      const depKeyStr = toKeyString(entry.keyDependency);
      return envelope.affectedKeys.some((k) => toKeyString(k) === depKeyStr);
    }

    // Key range dependency
    if (entry.keyDependency instanceof IDBKeyRange) {
      const range = entry.keyDependency;
      return envelope.affectedKeys.some((k) => {
        try {
          return range.includes(k);
        } catch {
          // If includes() throws (e.g., type mismatch), treat as invalidated
          return true;
        }
      });
    }

    // Unknown dependency shape, invalidate to be safe
    return true;
  }

  /**
   * Given all cache entries and a mutation envelope, returns the query hashes
   * that need to be re-fetched.
   */
  getInvalidatedHashes(entries: Iterable<CacheEntry>, envelope: MutationEnvelope): string[] {
    const invalidated: string[] = [];
    for (const entry of entries) {
      if (this.shouldInvalidate(entry, envelope)) {
        invalidated.push(entry.queryHash);
      }
    }
    return invalidated;
  }
}

function isValidKey(value: unknown): value is IDBValidKey {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  return (
    t === "string" ||
    (t === "number" && !Number.isNaN(value)) ||
    value instanceof Date ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    Array.isArray(value)
  );
}
