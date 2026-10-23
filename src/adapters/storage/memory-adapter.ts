import type { ConnectionState, StorageQuota } from "../../types/status";
import type { QueryAST } from "../../types/query";
import type { IStoragePort, IStorageTransaction, StorageBatchOp, StorageEntry } from "../../ports/storage.port";
import { toKeyString, isValidKey } from "../../core/key-serializer";

interface MemoryRecord {
  key: IDBValidKey;
  value: unknown;
}

type StoreData = Map<string, MemoryRecord>;

/**
 * In-memory Map-based storage adapter implementing {@link IStoragePort}.
 * Used as high-fidelity fallback for SSR, incognito mode, or when IndexedDB is blocked.
 * Implements complete key-range filtering and secondary index lookup.
 */
export class MemoryStorageAdapter implements IStoragePort {
  private stores = new Map<string, StoreData>();
  private autoIncrementCounters = new Map<string, number>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = "IDLE";

  private ensureStore(storeName: string): StoreData {
    let store = this.stores.get(storeName);
    if (!store) {
      store = new Map();
      this.stores.set(storeName, store);
    }
    return store;
  }

  private nextKey(storeName: string): number {
    const current = this.autoIncrementCounters.get(storeName) ?? 0;
    const next = current + 1;
    this.autoIncrementCounters.set(storeName, next);
    return next;
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  async open(): Promise<void> {
    this.setState("FALLBACK_MEMORY");
  }

  async close(): Promise<void> {
    this.setState("IDLE");
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const store = this.ensureStore(storeName);
    const rec = store.get(toKeyString(key));
    return rec ? (rec.value as T) : undefined;
  }

  private matchesRange(
    itemKey: unknown,
    range?: IDBKeyRange | IDBValidKey,
  ): boolean {
    if (range === undefined) return true;
    if (isValidKey(range)) {
      return toKeyString(itemKey) === toKeyString(range);
    }
    if (range instanceof IDBKeyRange) {
      try {
        return range.includes(itemKey as any);
      } catch {
        return false;
      }
    }
    return true;
  }

  private extractIndexValue(record: unknown, indexPath?: string | readonly string[]): unknown {
    if (!indexPath || record === null || typeof record !== "object") return undefined;
    if (typeof indexPath !== "string") {
      return [...indexPath].map((path) => this.extractIndexValue(record, path));
    }
    const parts = indexPath.split(".");
    let current: unknown = record;
    for (const part of parts) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  async getAll<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]> {
    const store = this.ensureStore(storeName);
    const results: T[] = [];

    for (const rec of store.values()) {
      const compareTarget = indexName
        ? this.extractIndexValue(rec.value, indexName)
        : rec.key;

      if (this.matchesRange(compareTarget, range)) {
        results.push(rec.value as T);
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  async getAllWithKeys<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<StorageEntry<T>[]> {
    if (limit !== undefined && limit <= 0) return [];
    const store = this.ensureStore(storeName);
    const results: StorageEntry<T>[] = [];

    for (const rec of store.values()) {
      const compareTarget = indexName
        ? this.extractIndexValue(rec.value, indexName)
        : rec.key;

      if (this.matchesRange(compareTarget, range)) {
        results.push({ key: rec.key, value: rec.value as T });
        if (limit !== undefined && results.length >= limit) break;
      }
    }

    return results;
  }

  async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    const store = this.ensureStore(storeName);
    let resolvedKey = key;

    // Check if inline key exists in object
    if (resolvedKey === undefined && value !== null && typeof value === "object" && "id" in value) {
      const idVal = (value as Record<string, unknown>).id;
      if (isValidKey(idVal)) {
        resolvedKey = idVal;
      }
    }

    if (resolvedKey === undefined) {
      resolvedKey = this.nextKey(storeName);
    }

    store.set(toKeyString(resolvedKey), { key: resolvedKey, value });
    return resolvedKey;
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    const store = this.ensureStore(storeName);
    store.delete(toKeyString(key));
  }

  async clear(storeName: string): Promise<void> {
    const store = this.ensureStore(storeName);
    store.clear();
  }

  async count(
    storeName: string,
    range?: IDBKeyRange | IDBValidKey,
    indexName?: string,
    keyPath?: string | readonly string[],
    multiEntry = false,
  ): Promise<number> {
    const store = this.ensureStore(storeName);
    if (range === undefined && !indexName) return store.size;

    let total = 0;
    for (const rec of store.values()) {
      const target = indexName
        ? this.extractIndexValue(rec.value, keyPath ?? indexName)
        : rec.key;
      if (multiEntry && Array.isArray(target)) {
        for (const entry of target) {
          if (this.matchesRange(entry, range)) total++;
        }
      } else if (target !== undefined && this.matchesRange(target, range)) {
        total++;
      }
    }
    return total;
  }

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    const results: (IDBValidKey | undefined)[] = [];
    for (const op of ops) {
      if (op.type === "put") {
        const resultKey = await this.put(storeName, op.value, op.key);
        results.push(resultKey);
      } else {
        if (op.key !== undefined) {
          await this.delete(storeName, op.key);
        }
        results.push(undefined);
      }
    }
    return results;
  }

  async transaction<T>(
    _storeNames: string[],
    _mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const tx: IStorageTransaction = {
      get: <V>(storeName: string, key: IDBValidKey): Promise<V | undefined> =>
        this.get<V>(storeName, key),
      put: (storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> =>
        this.put(storeName, value, key),
      delete: (storeName: string, key: IDBValidKey): Promise<void> => this.delete(storeName, key),
      clear: (storeName: string): Promise<void> => this.clear(storeName),
    };
    return fn(tx);
  }

  async cursor<T>(ast: QueryAST<T>): Promise<T[]> {
    return (await this.cursorWithKeys(ast)).map((entry) => entry.value);
  }

  async cursorWithKeys<T>(ast: QueryAST<T>): Promise<StorageEntry<T>[]> {
    if (ast.limitCount !== undefined && ast.limitCount <= 0) return [];
    const store = this.ensureStore(ast.storeName);
    let matched: StorageEntry<T>[] = [];

    for (const rec of store.values()) {
      const compareTarget = ast.indexName
        ? this.extractIndexValue(rec.value, ast.fieldPath ?? ast.indexName)
        : rec.key;

      if (ast.indexMultiEntry && Array.isArray(compareTarget)) {
        for (const entry of compareTarget) {
          if (this.matchesRange(entry, ast.range)) {
            matched.push({ key: rec.key, value: rec.value as T });
          }
        }
      } else if (this.matchesRange(compareTarget, ast.range)) {
        matched.push({ key: rec.key, value: rec.value as T });
      }
    }

    if (ast.direction === "prev" || ast.direction === "prevunique") {
      matched.reverse();
    }

    if (ast.filterPredicate) {
      matched = matched.filter((entry) => ast.filterPredicate!(entry.value));
    }
    if (ast.offsetCount > 0) {
      matched = matched.slice(ast.offsetCount);
    }
    if (ast.limitCount !== undefined) {
      matched = matched.slice(0, ast.limitCount);
    }

    return matched;
  }

  async getQuota(): Promise<StorageQuota> {
    return {
      usageBytes: null,
      quotaBytes: null,
      percentUsed: null,
      isPersisted: null,
    };
  }

  isUpgradeBlocked(): boolean {
    return false;
  }

  requiresReloadForUpgrade(): boolean {
    return false;
  }
}
