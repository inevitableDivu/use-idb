import type { DatabaseSchema } from "../types/schema";
import type { QueryAST } from "../types/query";
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

/**
 * Configuration options for creating an {@link Engine} instance.
 */
export interface EngineConfig {
  /**
   * Custom storage adapter implementing {@link IStoragePort}.
   * If omitted, automatically selects {@link IndexedDBStorageAdapter} (or {@link MemoryStorageAdapter} fallback).
   */
  storage?: IStoragePort;

  /**
   * Custom cross-tab synchronization adapter implementing {@link ISyncPort}.
   * If omitted and BroadcastChannel is supported, uses {@link BroadcastSyncAdapter}.
   */
  sync?: ISyncPort;

  /**
   * Concurrency lock adapter implementing {@link ILockPort}.
   * If omitted and `navigator.locks` is available, uses {@link WebLocksAdapter}.
   */
  lock?: ILockPort;

  /**
   * Middleware plugins to intercept write and read pipelines.
   */
  middlewares?: IDBMiddleware[];
}

/**
 * Enterprise Core Engine coordinating storage adapters, L1 snapshot cache,
 * write coalescing, cross-tab synchronization, and query compilation.
 *
 * @template TSchema - Strongly typed database schema definition.
 */
export class Engine<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>> {
  readonly schema: TSchema;
  readonly storage: IStoragePort;
  readonly syncPort: ISyncPort;
  readonly lockPort: ILockPort;
  readonly middlewarePipeline: MiddlewarePipeline;
  readonly l1Cache: L1Cache;
  readonly dependencyTracker: DependencyTracker;
  readonly writeCoalescer: WriteCoalescer;

  private statusListeners = new Set<(status: IDBStatusSnapshot) => void>();
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

    // Storage Adapter resolution: prefer IndexedDB, fallback to Memory
    if (config?.storage) {
      this.storage = config.storage;
    } else if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
      try {
        this.storage = new IndexedDBStorageAdapter(schema);
      } catch {
        this.storage = new MemoryStorageAdapter();
      }
    } else {
      this.storage = new MemoryStorageAdapter();
    }

    // Sync Adapter resolution
    if (config?.sync) {
      this.syncPort = config.sync;
    } else if (
      schema.options?.enableCrossTabSync !== false &&
      typeof BroadcastChannel !== "undefined"
    ) {
      this.syncPort = new BroadcastSyncAdapter(schema.name);
    } else {
      this.syncPort = new NoopSyncAdapter();
    }

    // Lock Adapter resolution
    if (config?.lock) {
      this.lockPort = config.lock;
    } else if (typeof navigator !== "undefined" && navigator.locks) {
      this.lockPort = new WebLocksAdapter();
    } else {
      this.lockPort = new NoopLockAdapter();
    }

    // Middleware Pipeline
    this.middlewarePipeline = new MiddlewarePipeline(config?.middlewares ?? []);

    // L1 Synchronous Cache
    this.l1Cache = new L1Cache({
      maxEntries: schema.options?.cacheMaxEntries,
      ttlMs: schema.options?.cacheTTLMs,
    });

    // Dependency Tracker
    this.dependencyTracker = new DependencyTracker();

    // Write Coalescer
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
      // Invalidate relevant cache entries
      this.l1Cache.invalidateMatching((entry) => {
        return this.dependencyTracker.shouldInvalidate(entry, envelope);
      });
      this.notifyStatusChange();
    });

    // Listen to storage state transitions
    this.storage.onStateChange(() => {
      this.notifyStatusChange();
    });
  }

  // ── Lifecycle ──

  async open(): Promise<void> {
    try {
      await this.storage.open();
    } catch (err) {
      // If native open throws (e.g., SecurityError in private browsing),
      // fallback to memory storage if enabled
      if (
        this.schema.options?.fallbackToMemory !== false &&
        !(this.storage instanceof MemoryStorageAdapter)
      ) {
        const memStorage = new MemoryStorageAdapter();
        await memStorage.open();
        // Overwrite storage reference
        (this as { storage: IStoragePort }).storage = memStorage;
      } else {
        throw err;
      }
    }
    this.refreshQuota().catch(() => {});
  }

  async close(): Promise<void> {
    await this.storage.close();
    this.syncPort.close();
    this.l1Cache.clear();
  }

  // ── Query Engine ──

  query<T = unknown>(storeName: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.storage, storeName, this.middlewarePipeline);
  }

  async fetchQuery<T>(ast: QueryAST<T>): Promise<T[]> {
    const raw = await this.storage.cursor(ast);
    const results: T[] = [];
    for (const item of raw) {
      const processed = await this.middlewarePipeline.runAfterRead(ast.storeName, item);
      results.push(processed as T);
    }
    return results;
  }

  // ── CRUD Operations ──

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const raw = await this.storage.get<T>(storeName, key);
    if (raw === undefined) return undefined;
    return (await this.middlewarePipeline.runAfterRead(storeName, raw)) as T;
  }

  async put<T = unknown>(
    storeName: string,
    value: T,
    key?: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<IDBValidKey> {
    return this.writeCoalescer.put(storeName, value, key, options);
  }

  async delete(
    storeName: string,
    key: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<void> {
    return this.writeCoalescer.delete(storeName, key, options);
  }

  async clear(storeName: string): Promise<void> {
    return this.writeCoalescer.clear(storeName);
  }

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    return this.storage.batch(storeName, ops);
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

  private cachedStatus: IDBStatusSnapshot = Object.freeze({
    connectionState: "IDLE",
    isFallbackMode: false,
    isUpgradeBlocked: false,
    requiresReloadForUpgrade: false,
    quota: {
      usageBytes: null,
      quotaBytes: null,
      percentUsed: null,
      isPersisted: null,
    },
    reconnect: async () => {},
  });

  getStatus(): IDBStatusSnapshot {
    return this.cachedStatus;
  }

  onStatusChange(listener: (status: IDBStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notifyStatusChange(): void {
    const nextStatus: IDBStatusSnapshot = Object.freeze({
      connectionState: this.storage.getState(),
      isFallbackMode: this.storage instanceof MemoryStorageAdapter,
      isUpgradeBlocked: this.storage.isUpgradeBlocked(),
      requiresReloadForUpgrade: this.storage.requiresReloadForUpgrade(),
      quota: this.currentQuota,
      reconnect: async () => {
        await this.storage.close();
        await this.open();
      },
    });

    if (
      this.cachedStatus.connectionState === nextStatus.connectionState &&
      this.cachedStatus.isFallbackMode === nextStatus.isFallbackMode &&
      this.cachedStatus.isUpgradeBlocked === nextStatus.isUpgradeBlocked &&
      this.cachedStatus.requiresReloadForUpgrade === nextStatus.requiresReloadForUpgrade &&
      this.cachedStatus.quota.usageBytes === nextStatus.quota.usageBytes &&
      this.cachedStatus.quota.quotaBytes === nextStatus.quota.quotaBytes &&
      this.cachedStatus.quota.percentUsed === nextStatus.quota.percentUsed
    ) {
      return;
    }

    this.cachedStatus = nextStatus;
    for (const listener of this.statusListeners) {
      listener(this.cachedStatus);
    }
  }
}

// ── Factory Helpers ──

/**
 * Creates, configures, and auto-initializes a new {@link Engine} instance for the provided schema.
 *
 * In browser environments, automatically triggers asynchronous database opening in the background.
 *
 * @template TSchema - Schema definition type.
 * @param schema - Database schema defining stores, indices, version, and migrations.
 * @param config - Optional configuration and adapter overrides.
 * @returns Fully configured {@link Engine} client.
 *
 * @example
 * ```typescript
 * import { createDatabase } from "use-idb";
 *
 * export const db = createDatabase({
 *   name: "ecommerce-app",
 *   version: 1,
 *   stores: {
 *     products: { keyPath: "id", indexes: { category: { keyPath: "category" } } },
 *     cart: { keyPath: "itemId" },
 *   },
 * });
 * ```
 */
export function createDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  schema: TSchema,
  config?: EngineConfig,
): Engine<TSchema> {
  const engine = new Engine(schema, config);
  // Auto-open in browser environments
  if (typeof window !== "undefined") {
    engine.open().catch(() => {});
  }
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
