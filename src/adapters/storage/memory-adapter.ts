import type { ConnectionState, StorageQuota } from "../../types/status";
import type { QueryAST } from "../../types/query";
import type { DatabaseSchema, StoreConfig } from "../../types/schema";
import type {
  IStoragePort,
  IStorageTransaction,
  StorageBatchOp,
  StorageEntry,
} from "../../ports/storage.port";
import { isValidKey } from "../../core/key-serializer";

interface MemoryRecord {
  key: IDBValidKey;
  value: unknown;
}

type StoreData = Map<string, MemoryRecord>;

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  // Older runtimes without structuredClone are best-effort only. Browser IndexedDB
  // environments supported by this package provide structuredClone.
  return value;
}

function dataError(message: string): DOMException {
  return new DOMException(message, "DataError");
}

function keyRank(key: IDBValidKey): number {
  if (typeof key === "number") return 0;
  if (key instanceof Date) return 1;
  if (typeof key === "string") return 2;
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 3;
  return 4;
}

function binaryBytes(key: ArrayBuffer | ArrayBufferView): Uint8Array {
  return key instanceof ArrayBuffer
    ? new Uint8Array(key)
    : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}

/** Compare keys using IndexedDB's type ordering for numbers, dates, strings, binary keys, and arrays. */
function compareKeys(left: IDBValidKey, right: IDBValidKey): number {
  const leftRank = keyRank(left);
  const rightRank = keyRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;

  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime() ? 0 : left.getTime() < right.getTime() ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (
    (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) &&
    (right instanceof ArrayBuffer || ArrayBuffer.isView(right))
  ) {
    const leftBytes = binaryBytes(left);
    const rightBytes = binaryBytes(right);
    for (let i = 0; i < Math.min(leftBytes.length, rightBytes.length); i++) {
      if (leftBytes[i] !== rightBytes[i]) return leftBytes[i]! - rightBytes[i]!;
    }
    return leftBytes.length - rightBytes.length;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const compared = compareKeys(left[i]!, right[i]!);
      if (compared !== 0) return compared;
    }
    return left.length - right.length;
  }
  return 0;
}

function sameKey(left: IDBValidKey, right: IDBValidKey): boolean {
  return compareKeys(left, right) === 0;
}

/** Normalize keys according to IndexedDB key equality, not JS typed-array constructor identity. */
function keyIdentity(key: IDBValidKey): string {
  if (!isValidKey(key)) throw dataError("Invalid IndexedDB primary key.");
  if (typeof key === "number") return JSON.stringify(["number", Object.is(key, -0) ? 0 : key]);
  if (key instanceof Date) return JSON.stringify(["date", key.getTime()]);
  if (typeof key === "string") return JSON.stringify(["string", key]);
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    return JSON.stringify(["binary", Array.from(binaryBytes(key))]);
  }
  if (Array.isArray(key)) return JSON.stringify(["array", key.map((part) => keyIdentity(part))]);
  throw dataError("Unsupported IndexedDB key type.");
}

/**
 * Volatile storage adapter for SSR, tests, and explicitly permitted fallback.
 *
 * The adapter aims to match IndexedDB transaction, key-path, cloning, and unique-index
 * semantics. It remains process-local and is never a durable or cross-tab shared store.
 */
export class MemoryStorageAdapter implements IStoragePort {
  readonly kind = "memory" as const;
  private stores = new Map<string, StoreData>();
  private autoIncrementCounters = new Map<string, number>();
  private storeVersions = new Map<string, number>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = "IDLE";

  private schema?: DatabaseSchema;

  constructor(schema?: DatabaseSchema) {
    this.schema = schema;
  }

  /** Let Engine provide store/index definitions when users inject a memory adapter manually. */
  setSchema(schema: DatabaseSchema): void {
    this.schema = schema;
  }

  private storeConfig(storeName: string): StoreConfig | undefined {
    return this.schema?.stores[storeName] as StoreConfig | undefined;
  }

  private ensureStoreIn(
    storeName: string,
    stores: Map<string, StoreData>,
  ): StoreData {
    let store = stores.get(storeName);
    if (!store) {
      store = new Map();
      stores.set(storeName, store);
    }
    return store;
  }

  private ensureStore(storeName: string): StoreData {
    return this.ensureStoreIn(storeName, this.stores);
  }

  private nextKey(storeName: string, counters = this.autoIncrementCounters): number {
    const next = (counters.get(storeName) ?? 0) + 1;
    counters.set(storeName, next);
    return next;
  }

  private bumpVersion(storeName: string): void {
    this.storeVersions.set(storeName, (this.storeVersions.get(storeName) ?? 0) + 1);
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
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
    return () => this.stateListeners.delete(listener);
  }

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const record = this.ensureStore(storeName).get(keyIdentity(key));
    return record ? cloneValue(record.value as T) : undefined;
  }

  private matchesRange(itemKey: unknown, range?: IDBKeyRange | IDBValidKey): boolean {
    if (range === undefined) return true;
    if (isValidKey(range)) return sameKey(itemKey as IDBValidKey, range);
    if (typeof IDBKeyRange !== "undefined" && range instanceof IDBKeyRange) {
      try {
        return range.includes(itemKey as IDBValidKey);
      } catch {
        return false;
      }
    }
    return true;
  }

  private extractPath(record: unknown, keyPath: string): unknown {
    if (record === null || typeof record !== "object") return undefined;
    let current: unknown = record;
    for (const part of keyPath.split(".")) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private extractIndexValue(record: unknown, indexPath?: string | readonly string[]): unknown {
    if (!indexPath) return undefined;
    if (typeof indexPath !== "string") {
      return indexPath.map((path) => this.extractPath(record, path));
    }
    return this.extractPath(record, indexPath);
  }

  private indexKeyPath(storeName: string, indexName: string): string | readonly string[] {
    return this.storeConfig(storeName)?.indexes?.[indexName]?.keyPath ?? indexName;
  }

  private resolvePrimaryKey(
    storeName: string,
    value: unknown,
    explicitKey: IDBValidKey | undefined,
    counters: Map<string, number>,
  ): IDBValidKey {
    const config = this.storeConfig(storeName);
    const keyPath = config?.keyPath;

    let candidate = explicitKey;
    if (keyPath !== undefined) {
      const inlineKey = this.extractIndexValue(value, keyPath) as IDBValidKey | undefined;
      if (explicitKey !== undefined && (!isValidKey(inlineKey) || !sameKey(explicitKey, inlineKey))) {
        throw dataError("The supplied key does not match the store's inline keyPath.");
      }
      candidate = inlineKey;
    } else if (candidate === undefined && !this.schema && value !== null && typeof value === "object" && "id" in value) {
      // Backward-compatible convenience mode for direct adapter users without a schema.
      const id = (value as Record<string, unknown>).id;
      if (isValidKey(id)) candidate = id;
    }
    if (candidate === undefined && (config?.autoIncrement === true || !this.schema)) {
      candidate = this.nextKey(storeName, counters);
    }
    if (!isValidKey(candidate)) {
      throw dataError("The value does not provide a valid primary key for this object store.");
    }
    if (typeof candidate === "number" && config?.autoIncrement) {
      counters.set(storeName, Math.max(counters.get(storeName) ?? 0, candidate));
    }
    return candidate;
  }

  private assertUniqueIndexes(
    storeName: string,
    key: IDBValidKey,
    value: unknown,
    stores: Map<string, StoreData>,
  ): void {
    const config = this.storeConfig(storeName);
    if (!config?.indexes) return;
    const records = this.ensureStoreIn(storeName, stores);

    for (const [indexName, index] of Object.entries(config.indexes)) {
      if (!index.unique) continue;
      const keyPath = index.keyPath;
      const newValue = this.extractIndexValue(value, keyPath);
      const newKeys = index.multiEntry && Array.isArray(newValue) ? newValue : [newValue];

      for (const existing of records.values()) {
        if (sameKey(existing.key, key)) continue;
        const existingValue = this.extractIndexValue(existing.value, keyPath);
        const existingKeys = index.multiEntry && Array.isArray(existingValue)
          ? existingValue
          : [existingValue];

        for (const candidate of newKeys) {
          if (!isValidKey(candidate)) continue;
          if (existingKeys.some((existingKey) => isValidKey(existingKey) && sameKey(existingKey, candidate))) {
            throw new DOMException(
              `Unique index constraint failed for "${storeName}.${indexName}".`,
              "ConstraintError",
            );
          }
        }
      }
    }
  }

  private putInto(
    storeName: string,
    value: unknown,
    key: IDBValidKey | undefined,
    stores: Map<string, StoreData>,
    counters: Map<string, number>,
  ): IDBValidKey {
    const resolvedKey = this.resolvePrimaryKey(storeName, value, key, counters);
    this.assertUniqueIndexes(storeName, resolvedKey, value, stores);
    this.ensureStoreIn(storeName, stores).set(keyIdentity(resolvedKey), {
      key: cloneValue(resolvedKey),
      value: cloneValue(value),
    });
    return resolvedKey;
  }

  async getAll<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]> {
    const entries = await this.getAllWithKeys<T>(storeName, indexName, range, limit);
    return entries.map((entry) => entry.value);
  }

  async getAllWithKeys<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<StorageEntry<T>[]> {
    if (limit !== undefined && limit <= 0) return [];
    const store = this.ensureStore(storeName);
    const indexPath = indexName ? this.indexKeyPath(storeName, indexName) : undefined;
    const indexConfig = indexName ? this.storeConfig(storeName)?.indexes?.[indexName] : undefined;
    const matched: Array<{ entry: StorageEntry<T>; orderKey: IDBValidKey }> = [];

    for (const record of store.values()) {
      const target = indexName
        ? this.extractIndexValue(record.value, indexPath)
        : record.key;
      const keys = indexName && indexConfig?.multiEntry && Array.isArray(target)
        ? target
        : [target];
      const seen = new Set<string>();
      for (const indexKey of keys) {
        if (!isValidKey(indexKey) || !this.matchesRange(indexKey, range)) continue;
        const keyToken = keyIdentity(indexKey);
        if (seen.has(keyToken)) continue;
        seen.add(keyToken);
        matched.push({
          entry: { key: cloneValue(record.key), value: cloneValue(record.value as T) },
          orderKey: indexKey,
        });
      }
    }

    matched.sort((left, right) =>
      compareKeys(left.orderKey, right.orderKey) || compareKeys(left.entry.key, right.entry.key),
    );
    const limited = limit === undefined ? matched : matched.slice(0, limit);
    return limited.map((item) => item.entry);
  }

  async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    // The in-memory key generator must roll back when a write fails (e.g. unique-index violation).
    const stagedCounters = new Map(this.autoIncrementCounters);
    const resolvedKey = this.putInto(storeName, value, key, this.stores, stagedCounters);
    this.autoIncrementCounters = stagedCounters;
    this.bumpVersion(storeName);
    return cloneValue(resolvedKey);
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    this.ensureStore(storeName).delete(keyIdentity(key));
    this.bumpVersion(storeName);
  }

  async clear(storeName: string): Promise<void> {
    this.ensureStore(storeName).clear();
    this.bumpVersion(storeName);
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

    const resolvedPath = indexName
      ? keyPath ?? this.indexKeyPath(storeName, indexName)
      : undefined;
    let total = 0;
    for (const record of store.values()) {
      const target = indexName
        ? this.extractIndexValue(record.value, resolvedPath)
        : record.key;
      if (multiEntry && Array.isArray(target)) {
        const seen = new Set<string>();
        for (const entry of target) {
          if (!isValidKey(entry)) continue;
          const identity = keyIdentity(entry);
          if (!seen.has(identity) && this.matchesRange(entry, range)) {
            seen.add(identity);
            total++;
          }
        }
      } else if (target !== undefined && this.matchesRange(target, range)) {
        total++;
      }
    }
    return total;
  }

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    if (ops.length === 0) return [];
    // Apply to a staging copy so any key/constraint failure rolls back the entire batch.
    const stagedStores = new Map(this.stores);
    stagedStores.set(storeName, new Map(
      Array.from(this.ensureStore(storeName), ([id, record]) => [
        id,
        { key: cloneValue(record.key), value: cloneValue(record.value) },
      ]),
    ));
    const stagedCounters = new Map(this.autoIncrementCounters);
    const results: (IDBValidKey | undefined)[] = [];

    for (const op of ops) {
      if (op.type === "put") {
        results.push(this.putInto(storeName, op.value, op.key, stagedStores, stagedCounters));
      } else {
        if (op.key === undefined) throw dataError("A delete operation requires a primary key.");
        stagedStores.get(storeName)!.delete(keyIdentity(op.key));
        results.push(undefined);
      }
    }

    this.stores.set(storeName, stagedStores.get(storeName)!);
    this.autoIncrementCounters = stagedCounters;
    this.bumpVersion(storeName);
    return results;
  }

  async transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const uniqueNames = [...new Set(storeNames)];
    if (uniqueNames.length === 0) throw new TypeError("A transaction requires at least one store.");
    if (this.schema) {
      for (const name of uniqueNames) {
        if (!(name in this.schema.stores)) throw new TypeError(`Unknown object store "${name}".`);
      }
    }

    const stagedStores = new Map<string, StoreData>();
    for (const name of uniqueNames) {
      const live = this.ensureStore(name);
      stagedStores.set(name, new Map(
        Array.from(live, ([id, record]) => [
          id,
          { key: cloneValue(record.key), value: cloneValue(record.value) },
        ]),
      ));
    }
    const stagedCounters = new Map(this.autoIncrementCounters);
    const startingVersions = new Map(uniqueNames.map((name) => [name, this.storeVersions.get(name) ?? 0]));
    const dirty = new Set<string>();

    const assertWritable = (storeName: string) => {
      if (mode !== "readwrite") throw new DOMException("A readonly transaction cannot modify data.", "ReadOnlyError");
      if (!stagedStores.has(storeName)) {
        throw new DOMException(`Object store "${storeName}" is outside this transaction.`, "NotFoundError");
      }
      dirty.add(storeName);
    };
    const tx: IStorageTransaction = {
      get: async <V>(storeName: string, key: IDBValidKey): Promise<V | undefined> => {
        const store = stagedStores.get(storeName);
        if (!store) throw new DOMException(`Object store "${storeName}" is outside this transaction.`, "NotFoundError");
        const record = store.get(keyIdentity(key));
        return record ? cloneValue(record.value as V) : undefined;
      },
      put: async (storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> => {
        assertWritable(storeName);
        return this.putInto(storeName, value, key, stagedStores, stagedCounters);
      },
      delete: async (storeName: string, key: IDBValidKey): Promise<void> => {
        assertWritable(storeName);
        stagedStores.get(storeName)!.delete(keyIdentity(key));
      },
      clear: async (storeName: string): Promise<void> => {
        assertWritable(storeName);
        stagedStores.get(storeName)!.clear();
      },
    };

    const result = await fn(tx);
    if (mode === "readwrite" && dirty.size > 0) {
      // Memory transactions are optimistic-serializable. Reject rather than overwrite
      // a concurrent write that happened while the user callback was awaiting.
      for (const name of uniqueNames) {
        if ((this.storeVersions.get(name) ?? 0) !== startingVersions.get(name)) {
          throw new DOMException(
            "The in-memory transaction conflicted with another write; retry the transaction explicitly.",
            "AbortError",
          );
        }
      }
      for (const name of dirty) {
        this.stores.set(name, stagedStores.get(name)!);
        this.bumpVersion(name);
      }
      this.autoIncrementCounters = stagedCounters;
    }
    return result;
  }

  async cursor<T>(ast: QueryAST<T>, signal?: AbortSignal): Promise<T[]> {
    return (await this.cursorWithKeys(ast, signal)).map((entry) => entry.value);
  }

  async cursorWithKeys<T>(ast: QueryAST<T>, signal?: AbortSignal): Promise<StorageEntry<T>[]> {
    if (signal?.aborted) throw new DOMException("The query was aborted.", "AbortError");
    if (ast.limitCount !== undefined && ast.limitCount <= 0) return [];
    const store = this.ensureStore(ast.storeName);
    const matched: Array<{ entry: StorageEntry<T>; orderKey: IDBValidKey }> = [];
    const indexPath = ast.indexName
      ? ast.fieldPath ?? this.indexKeyPath(ast.storeName, ast.indexName)
      : undefined;

    for (const record of store.values()) {
      if (signal?.aborted) throw new DOMException("The query was aborted.", "AbortError");
      const target = ast.indexName ? this.extractIndexValue(record.value, indexPath) : record.key;
      const keys = ast.indexMultiEntry && Array.isArray(target) ? target : [target];
      const seen = new Set<string>();
      for (const indexKey of keys) {
        if (!isValidKey(indexKey) || !this.matchesRange(indexKey, ast.range)) continue;
        const token = keyIdentity(indexKey);
        if (seen.has(token)) continue;
        seen.add(token);
        matched.push({
          entry: { key: cloneValue(record.key), value: cloneValue(record.value as T) },
          orderKey: indexKey,
        });
      }
    }

    matched.sort((left, right) =>
      compareKeys(left.orderKey, right.orderKey) || compareKeys(left.entry.key, right.entry.key),
    );
    if (ast.direction === "prev" || ast.direction === "prevunique") matched.reverse();

    let entries = matched.map((item) => item.entry);
    if (ast.filterPredicate) entries = entries.filter((entry) => ast.filterPredicate!(entry.value));
    if (ast.offsetCount > 0) entries = entries.slice(ast.offsetCount);
    if (ast.limitCount !== undefined) entries = entries.slice(0, ast.limitCount);
    return entries;
  }

  async getQuota(): Promise<StorageQuota> {
    return { usageBytes: null, quotaBytes: null, percentUsed: null, isPersisted: null };
  }

  async requestPersistentStorage(): Promise<boolean> {
    return false;
  }

  isUpgradeBlocked(): boolean {
    return false;
  }

  requiresReloadForUpgrade(): boolean {
    return false;
  }
}