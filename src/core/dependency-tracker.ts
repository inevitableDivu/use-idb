import type { MutationEnvelope } from "../ports/sync.port";
import type { CacheEntry } from "./l1-cache";
import { toKeyString, isValidKey } from "./key-serializer";

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
   * 2. If operation is 'clear' or 'force_release' → always invalidate.
   * 3. Secondary index queries (entry.indexName !== undefined) → store-level invalidation fallback.
   *    Guarantees correctness by invalidating whenever the store mutates, eliminating the primary
   *    key vs index range bug without write-path extraction overhead.
   * 4. If entry has no key dependency (full-store query) → always invalidate.
   * 5. If entry watches a specific primary key → only invalidate if that key is in affectedKeys.
   * 6. If entry watches a primary key range → only invalidate if any affected key falls within the range.
   */
  shouldInvalidate(entry: CacheEntry, envelope: MutationEnvelope): boolean {
    // Must depend on the same store
    if (!entry.storeNames.has(envelope.storeName)) {
      return false;
    }

    // 'clear' and 'force_release' always invalidate everything in the store
    if (envelope.operation === "clear" || envelope.operation === "force_release") {
      return true;
    }

    // 1. Secondary index queries: store-level fallback (Option A)
    // Eliminates the bug where mutated primary keys were tested against index value ranges.
    if (entry.indexName !== undefined || entry.indexDependency !== undefined) {
      return true;
    }

    // 2. No key dependency means this is a full-store query → always invalidate
    if (entry.keyDependency === undefined) {
      return true;
    }

    // 3. Specific primary key dependency
    if (isValidKey(entry.keyDependency)) {
      const depKeyStr = toKeyString(entry.keyDependency);
      return envelope.affectedKeys.some((k) => toKeyString(k) === depKeyStr);
    }

    // 4. Primary key range dependency
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
