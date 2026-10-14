import type { ConnectionState, StorageQuota } from "../../types/status";
import type { QueryAST } from "../../types/query";
import type { IStoragePort, IStorageTransaction, StorageBatchOp } from "../../ports/storage.port";
import { toKeyString } from "../../core/key-serializer";

type StoreData = Map<string, unknown>;

/**
 * In-memory Map-based storage adapter implementing IStoragePort.
 * Used as fallback for SSR, incognito mode, or when IndexedDB is unavailable.
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
    return store.get(toKeyString(key)) as T | undefined;
  }

  async getAll<T>(
    storeName: string,
    _indexName?: string,
    _range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]> {
    const store = this.ensureStore(storeName);
    const values = Array.from(store.values()) as T[];
    return limit !== undefined ? values.slice(0, limit) : values;
  }

  async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    const store = this.ensureStore(storeName);
    const resolvedKey = key ?? this.nextKey(storeName);
    store.set(toKeyString(resolvedKey), value);
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

  async count(storeName: string, _range?: IDBKeyRange | IDBValidKey): Promise<number> {
    const store = this.ensureStore(storeName);
    return store.size;
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
    // Memory adapter doesn't need real transactions; operations are synchronous on a single Map.
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
    const store = this.ensureStore(ast.storeName);
    let entries = Array.from(store.values()) as T[];

    // Apply direction
    if (ast.direction === "prev" || ast.direction === "prevunique") {
      entries.reverse();
    }

    // Apply filter predicate
    if (ast.filterPredicate) {
      entries = entries.filter(ast.filterPredicate);
    }

    // Apply offset
    if (ast.offsetCount > 0) {
      entries = entries.slice(ast.offsetCount);
    }

    // Apply limit
    if (ast.limitCount !== undefined) {
      entries = entries.slice(0, ast.limitCount);
    }

    return entries;
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
