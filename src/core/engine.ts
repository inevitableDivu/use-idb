import type { DatabaseSchema, StoreKey, StoreNames, StoreValue } from "../types/schema";
import type { IDBStatusSnapshot, StorageQuota } from "../types/status";
import type { IStoragePort, IStorageTransaction, StorageBatchOp } from "../ports/storage.port";
import type { ISyncPort } from "../ports/sync.port";
import type { ILockPort } from "../ports/lock.port";
import type { IDBMiddleware } from "../ports/middleware.port";
import { IndexedDBStorageAdapter } from "../adapters/storage/idb-adapter";
import { MemoryStorageAdapter } from "../adapters/storage/memory-adapter";
import { BroadcastSyncAdapter } from "../adapters/sync/broadcast-adapter";
import { NoopSyncAdapter } from "../adapters/sync/noop-sync-adapter";
import { WebLocksAdapter } from "../adapters/lock/web-locks-adapter";
import { NoopLockAdapter } from "../adapters/lock/noop-lock-adapter";
import { MiddlewarePipeline } from "../adapters/middleware/pipeline";
import { L1Cache } from "./l1-cache";
import { DependencyTracker } from "./dependency-tracker";
import { WriteCoalescer } from "./write-coalescer";
import { QueryBuilder } from "./query-engine";
import { isValidKey } from "./key-serializer";

/**
 * Advanced configuration options for instantiating an {@link Engine}.
 */
export interface EngineConfig {
  /**
   * Custom storage port adapter implementation.
   */
  storage?: IStoragePort;

  /**
   * Custom cross-tab synchronization port adapter.
   */
  sync?: ISyncPort;

  /**
   * Custom concurrency and lock port adapter.
   */
  lock?: ILockPort;

  /**
   * Ordered array of middleware interceptors (e.g. field-level encryption).
   */
  middlewares?: IDBMiddleware[];
}

const databaseRegistry = new Map<string, Engine<any>>();

/**
 * Retrieves an active Engine instance from the registry if one exists with the given name.
 */
export function getDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  name: string,
): Engine<TSchema> | undefined {
  return databaseRegistry.get(name) as Engine<TSchema> | undefined;
}

/**
 * Central orchestrator of the Pragmatic Hexagonal storage architecture.
 *
 * Coordinates ports and adapters with the internal L1 synchronous cache,
 * write coalescing, cross-tab synchronization, and query compilation.
 *
 * @template TSchema - Strongly typed database schema definition.
 */
export class Engine<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  readonly schema: TSchema;
  storage: IStoragePort;
  readonly syncPort: ISyncPort;
  readonly lockPort: ILockPort;
  readonly middlewarePipeline: MiddlewarePipeline;
  readonly l1Cache: L1Cache;
  readonly dependencyTracker: DependencyTracker;
  readonly writeCoalescer: WriteCoalescer;

  private statusListeners = new Set<(status: IDBStatusSnapshot) => void>();
  private storageUnsubscribe?: () => void;
  private currentQuota: StorageQuota = {
    usageBytes: null,
    quotaBytes: null,
    percentUsed: null,
    isPersisted: null,
  };

  /**
   * Constructs an Engine instance bound to the provided database schema.
   *
   * @param schema - Database schema including name, version, stores, and migration scripts.
   * @param config - Optional adapter overrides and middlewares.
   */
  constructor(schema: TSchema, config?: EngineConfig) {
    this.schema = schema;

    // 1. Lock Adapter resolution
    if (config?.lock) {
      this.lockPort = config.lock;
    } else if (typeof navigator !== "undefined" && navigator.locks) {
      this.lockPort = new WebLocksAdapter();
    } else {
      this.lockPort = new NoopLockAdapter();
    }

    // 2. Sync Adapter resolution
    if (config?.sync) {
      this.syncPort = config.sync;
    } else if (
      schema.options?.enableCrossTabSync !== false &&
      typeof window !== "undefined" &&
      typeof BroadcastChannel !== "undefined"
    ) {
      this.syncPort = new BroadcastSyncAdapter(schema.name);
    } else {
      this.syncPort = new NoopSyncAdapter();
    }

    // 3. Storage Adapter resolution: pass lockPort and syncPort to IDB adapter
    if (config?.storage) {
      this.storage = config.storage;
    } else if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
      try {
        this.storage = new IndexedDBStorageAdapter(schema, this.lockPort, this.syncPort);
      } catch {
        this.storage = new MemoryStorageAdapter();
      }
    } else {
      this.storage = new MemoryStorageAdapter();
    }

    // 4. Middleware Pipeline
    this.middlewarePipeline = new MiddlewarePipeline(config?.middlewares ?? []);

    // 5. L1 Synchronous Cache
    this.l1Cache = new L1Cache({
      maxEntries: schema.options?.cacheMaxEntries,
      ttlMs: schema.options?.cacheTTLMs,
    });

    // 6. Dependency Tracker
    this.dependencyTracker = new DependencyTracker();

    // 7. Write Coalescer
    this.writeCoalescer = new WriteCoalescer(
      this.storage,
      this.l1Cache,
      this.syncPort,
      this.dependencyTracker,
      this.middlewarePipeline,
      { coalesceWindowMs: schema.options?.coalesceWindowMs },
    );

    // Setup Cross-Tab Remote Invalidation
    this.syncPort.subscribe((envelope) => {
      this.l1Cache.incrementGeneration(envelope.storeName);
      if (envelope.operation === "force_release") {
        this.storage.close().catch(() => {});
        return;
      }
      this.l1Cache.invalidateMatching((entry) => {
        return this.dependencyTracker.shouldInvalidate(entry, envelope);
      });
    });

    // Forward storage adapter connection state changes to status listeners
    this.storageUnsubscribe = this.storage.onStateChange(() => {
      this.notifyStatusChange();
    });
  }

  // ── Connection Lifecycle ──

  async open(): Promise<void> {
    try {
      await this.storage.open();
    } catch (err) {
      if (this.schema.options?.fallbackToMemory !== false) {
        console.warn(
          `[use-idb] IndexedDB open failed: ${String(err)}. Falling back to MemoryStorageAdapter.`,
        );
        this.storageUnsubscribe?.();
        this.storage = new MemoryStorageAdapter();
        this.writeCoalescer.setStorage(this.storage);
        this.storageUnsubscribe = this.storage.onStateChange(() => {
          this.notifyStatusChange();
        });
        await this.storage.open();
      } else {
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Destroys the engine instance, closing database connections, sync channels,
   * clearing cache timers, and deregistering from the global database pool.
   */
  async destroy(): Promise<void> {
    this.storageUnsubscribe?.();
    this.l1Cache.clear();
    this.syncPort.close();
    await this.storage.close();
    this.statusListeners.clear();
    databaseRegistry.delete(this.schema.name);
  }

  // ── Core CRUD Delegations ──

  async get<K extends StoreNames<TSchema>>(
    storeName: K,
    key: StoreKey<TSchema, K>,
  ): Promise<StoreValue<TSchema, K> | undefined> {
    const raw = await this.storage.get(storeName, key);
    if (raw === undefined) return undefined;
    return (await this.middlewarePipeline.runAfterRead(storeName, raw, key)) as StoreValue<TSchema, K>;
  }

  query<K extends StoreNames<TSchema>>(
    storeName: K,
  ): QueryBuilder<
    StoreValue<TSchema, K> extends object ? StoreValue<TSchema, K> : Record<string, unknown>,
    TSchema["stores"][K]
  > {
    type Item = StoreValue<TSchema, K> extends object
      ? StoreValue<TSchema, K>
      : Record<string, unknown>;
    return new QueryBuilder(
      this.storage,
      storeName,
      this.middlewarePipeline,
      this.schema.stores[storeName] as TSchema["stores"][K],
    ) as unknown as QueryBuilder<Item, TSchema["stores"][K]>;
  }

  async put<K extends StoreNames<TSchema>>(
    storeName: K,
    value: StoreValue<TSchema, K>,
    key?: StoreKey<TSchema, K>,
    options?: { optimistic?: boolean },
  ): Promise<StoreKey<TSchema, K>> {
    const resolvedKey = this.resolveWriteKey(storeName, value, key as IDBValidKey | undefined);
    return this.writeCoalescer.put(
      storeName,
      value,
      resolvedKey,
      options,
    ) as Promise<StoreKey<TSchema, K>>;
  }

  async putMany<K extends StoreNames<TSchema>>(
    storeName: K,
    values: readonly StoreValue<TSchema, K>[],
  ): Promise<StoreKey<TSchema, K>[]> {
    if (values.length === 0) return [];
    const results = await this.writeCoalescer.batch(
      storeName,
      values.map((value) => ({
        type: "put" as const,
        value,
        key: this.resolveWriteKey(storeName, value, undefined),
      })),
    );
    return results as StoreKey<TSchema, K>[];
  }

  private resolveWriteKey(storeName: string, value: unknown, key?: IDBValidKey): IDBValidKey | undefined {
    if (key !== undefined) return key;
    const keyPath = this.schema.stores[storeName]?.keyPath;
    if (keyPath === undefined || value === null || typeof value !== "object") return undefined;
    const paths: readonly string[] =
      typeof keyPath === "string" ? [keyPath] : (keyPath as readonly string[]);
    const keyParts: unknown[] = [];
    for (const path of paths) {
      let current: unknown = value;
      for (const part of path.split(".")) {
        if (current === null || typeof current !== "object") {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[part];
      }
      keyParts.push(current);
    }
    const candidate = Array.isArray(keyPath) ? keyParts : keyParts[0];
    return isValidKey(candidate) ? candidate : undefined;
  }

  async getAll<K extends StoreNames<TSchema>>(
    storeName: K,
  ): Promise<StoreValue<TSchema, K>[]> {
    const entries = this.storage.getAllWithKeys
      ? await this.storage.getAllWithKeys<StoreValue<TSchema, K>>(storeName)
      : (await this.storage.getAll<StoreValue<TSchema, K>>(storeName)).map((value) => {
          const keyPath = this.schema.stores[storeName]?.keyPath;
          let key: IDBValidKey | undefined;
          if (keyPath !== undefined && value !== null && typeof value === "object") {
            const paths: readonly string[] =
              typeof keyPath === "string" ? [keyPath] : (keyPath as readonly string[]);
            const parts = paths.map((path) => {
              let current: unknown = value;
              for (const part of path.split(".")) {
                if (current === null || typeof current !== "object") return undefined;
                current = (current as Record<string, unknown>)[part];
              }
              return current;
            });
            const candidate = Array.isArray(keyPath) ? parts : parts[0];
            if (isValidKey(candidate)) key = candidate;
          }
          return { key, value };
        });

    const transformed: StoreValue<TSchema, K>[] = [];
    for (const entry of entries) {
      // Field-encryption middleware authenticates ciphertext against the primary key.
      // Preserve the real key when the storage adapter can provide it.
      transformed.push(
        (await this.middlewarePipeline.runAfterRead(storeName, entry.value, entry.key)) as StoreValue<TSchema, K>,
      );
    }
    return transformed;
  }

  async delete<K extends StoreNames<TSchema>>(
    storeName: K,
    key: StoreKey<TSchema, K>,
    options?: { optimistic?: boolean },
  ): Promise<void> {
    return this.writeCoalescer.delete(storeName, key as IDBValidKey, options);
  }

  async clear<K extends StoreNames<TSchema>>(storeName: K): Promise<void> {
    return this.writeCoalescer.clear(storeName);
  }

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    return this.writeCoalescer.batch(storeName, ops);
  }

  async transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    return this.storage.transaction(storeNames, mode, fn);
  }

  // ── Telemetry & Observability ──

  async refreshQuota(): Promise<StorageQuota> {
    this.currentQuota = await this.storage.getQuota();
    this.notifyStatusChange();
    return this.currentQuota;
  }

  private cachedStatus: IDBStatusSnapshot | null = null;

  private computeStatus(): IDBStatusSnapshot {
    const connState = this.storage.getState();
    return Object.freeze({
      connectionState: connState,
      isFallbackMode: connState === "FALLBACK_MEMORY",
      isUpgradeBlocked: this.storage.isUpgradeBlocked(),
      requiresReloadForUpgrade: this.storage.requiresReloadForUpgrade(),
      quota: this.currentQuota,
      reconnect: async () => {
        await this.storage.close();
        await this.open();
      },
    });
  }

  getStatus(): IDBStatusSnapshot {
    if (!this.cachedStatus) {
      this.cachedStatus = this.computeStatus();
    }
    return this.cachedStatus;
  }

  onStatusChange(listener: (status: IDBStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notifyStatusChange(): void {
    this.cachedStatus = this.computeStatus();
    for (const listener of this.statusListeners) {
      listener(this.cachedStatus);
    }
  }
}

export type DatabaseInstance<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>> =
  Engine<TSchema>;

/**
 * Creates and configures an {@link Engine} instance bound to the provided database schema.
 * Reuses existing instances from the connection registry if one matching the schema name exists.
 *
 * @template TSchema - Strongly typed database schema definition.
 * @param schema - Database schema including name, version, stores, and migration scripts.
 * @param config - Optional adapter overrides and middlewares.
 * @returns Configured {@link Engine} instance.
 */
export function createDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  schema: TSchema,
  config?: EngineConfig,
): Engine<TSchema> {
  const existing = databaseRegistry.get(schema.name);
  if (existing) {
    return existing as Engine<TSchema>;
  }

  const engine = new Engine(schema, config);
  databaseRegistry.set(schema.name, engine);
  return engine;
}

let defaultEngineInstance: Engine | null = null;

/**
 * Retrieves the global singleton {@link Engine} instance used for zero-config key-value storage.
 *
 * Lazily creates a database named `"__use_idb_default__"` with a single `"keyval"` store on first invocation.
 *
 * @returns The default singleton {@link Engine} instance.
 */
export function getDefaultEngine(): Engine {
  if (!defaultEngineInstance) {
    defaultEngineInstance = createDatabase({
      name: "__use_idb_default__",
      version: 1,
      stores: {
        keyval: {},
      },
    });
  }
  return defaultEngineInstance;
}
