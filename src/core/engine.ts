import type { DatabaseSchema, StoreKey, StoreNames, StoreValue } from "../types/schema";
import { validateDatabaseSchema } from "../types/schema";
import type { IDBStatusSnapshot, StorageQuota } from "../types/status";
import type { IStoragePort, IStorageTransaction, StorageBatchOp } from "../ports/storage.port";
import type { ISyncPort } from "../ports/sync.port";
import type { ILockPort } from "../ports/lock.port";
import { NoopSyncAdapter } from "../adapters/sync/noop-sync-adapter";
import { MiddlewarePipeline } from "../adapters/middleware/pipeline";
import { L1Cache } from "./l1-cache";
import { DependencyTracker } from "./dependency-tracker";
import { WriteCoalescer } from "./write-coalescer";
import { MutationCoordinator } from "./operations/mutation-coordinator";
import { QueryBuilder } from "./query-engine";
import { isValidKey, toKeyString } from "./key-serializer";
import {
  type EngineConfig,
  type DatabaseRuntimeConfig,
  type DatabaseFactoryOptions,
  type ResolvedEngineConfig,
  resolveEngineConfig,
  isDatabaseFactoryOptions,
} from "./config";
import { createAdapterBundle } from "./adapter-factory";
import { StorageLifecycleManager } from "./lifecycle-manager";
import { validateMiddlewareSchema } from "./schema/middleware-validation";
import { reportDiagnostic, reportDiagnosticError } from "./observability/diagnostics";
import { DatabaseDestroyedError, TransactionMiddlewareUnsupportedError } from "./errors";
import {
  assertCompatibleEngineRegistration,
  findRegisteredEngine,
  registerEngine,
  unregisterEngine,
} from "./database-registry";



export { DatabaseConfigurationConflictError, TransactionMiddlewareUnsupportedError } from "./errors";

/**
 * Retrieves an active Engine instance from the registry if one exists with the given name.
 */
export function getDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  name: string,
): Engine<TSchema> | undefined {
  return findRegisteredEngine<TSchema>(name);
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
  syncPort: ISyncPort;
  readonly lockPort: ILockPort;
  readonly middlewarePipeline: MiddlewarePipeline;
  readonly l1Cache: L1Cache;
  readonly dependencyTracker: DependencyTracker;
  readonly mutationCoordinator: MutationCoordinator;
  readonly writeCoalescer: WriteCoalescer;

  private statusListeners = new Set<(status: IDBStatusSnapshot) => void>();
  private storageUnsubscribe?: () => void;
  private syncUnsubscribe?: () => void;
  private fallbackReason: string | null = null;
  private readonly runtimeConfig: ResolvedEngineConfig;
  private readonly lifecycle: StorageLifecycleManager;
  private persistentStorageGranted: boolean | null = null;
  private disposing = false;
  private disposed = false;
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
  constructor(
    schema: TSchema,
    config?: EngineConfig | DatabaseRuntimeConfig | ResolvedEngineConfig,
  ) {
    validateDatabaseSchema(schema);
    this.schema = schema;
    this.runtimeConfig = resolveEngineConfig(schema, config);
    validateMiddlewareSchema(schema, this.runtimeConfig.middleware);

    // Adapter construction is a separate module so environment policy stays out of the orchestrator.
    const adapters = createAdapterBundle(schema, this.runtimeConfig);
    this.storage = adapters.storage;
    this.syncPort = adapters.sync;
    this.lockPort = adapters.lock;
    this.fallbackReason = adapters.fallbackReason;

    // Middleware is an ordered transformation pipeline, outside active IDB transactions.
    this.middlewarePipeline = new MiddlewarePipeline([...this.runtimeConfig.middleware]);

    // Cache and write scheduling have one resolved source of truth, independent from schema declarations.
    this.l1Cache = new L1Cache({
      maxEntries: this.runtimeConfig.cache.maxEntries,
      ttlMs: this.runtimeConfig.cache.ttlMs,
    });

    // 6. Query dependency matching and committed-mutation coordination are separate services.
    this.dependencyTracker = new DependencyTracker();
    this.mutationCoordinator = new MutationCoordinator(
      schema.name,
      this.l1Cache,
      this.dependencyTracker,
      this.syncPort,
      this.runtimeConfig.diagnostics,
    );

    // 7. Write Coalescer
    this.writeCoalescer = new WriteCoalescer(
      this.storage,
      this.l1Cache,
      this.syncPort,
      this.dependencyTracker,
      this.middlewarePipeline,
      { coalesceWindowMs: this.runtimeConfig.writes.coalesceWindowMs },
      this.mutationCoordinator,
    );

    // Setup cross-tab invalidation. Keep the unsubscribe handle so fallback and destroy
    // can release the channel rather than leaving listeners attached to a dead adapter.
    this.bindSyncPort();

    // Forward storage adapter connection state changes to status listeners
    this.storageUnsubscribe = this.storage.onStateChange(() => {
      this.notifyStatusChange();
    });

    this.lifecycle = new StorageLifecycleManager(schema, this.runtimeConfig, {
      getStorage: () => this.storage,
      replaceStorage: async (storage, reason) => {
        reportDiagnostic(this.runtimeConfig.diagnostics, {
          type: "storage-fallback",
          databaseName: this.schema.name,
          from: "indexeddb",
          to: storage.kind ?? "custom",
          reason,
          timestamp: Date.now(),
        });
        this.storageUnsubscribe?.();
        this.storage = storage;
        this.fallbackReason = reason;
        this.writeCoalescer.setStorage(storage);
        this.storageUnsubscribe = storage.onStateChange(() => this.notifyStatusChange());
        this.replaceSyncPort(new NoopSyncAdapter());
      },
      onPersistentStorageResult: (granted) => {
        this.persistentStorageGranted = granted;
        this.notifyStatusChange();
      },
      onOpened: () => {
        if (this.storage.kind === "indexeddb") this.fallbackReason = null;
        reportDiagnostic(this.runtimeConfig.diagnostics, {
          type: "storage-opened",
          databaseName: this.schema.name,
          adapter: this.storage.kind ?? "custom",
          timestamp: Date.now(),
        });
        this.notifyStatusChange();
      },
    });
  }

  // ── Connection Lifecycle ──

  private assertUsable(): void {
    if (this.disposing || this.disposed) {
      throw new DatabaseDestroyedError(this.schema.name);
    }
  }

  async open(): Promise<void> {
    this.assertUsable();
    try {
      await this.lifecycle.open();
    } catch (error) {
      reportDiagnosticError(this.runtimeConfig.diagnostics, error, {
        databaseName: this.schema.name,
        operation: "open",
      });
      throw error;
    }
  }

  private bindSyncPort(): void {
    this.syncUnsubscribe?.();
    this.syncUnsubscribe = this.syncPort.subscribe((envelope) => {
      this.l1Cache.incrementGeneration(envelope.storeName);
      if (envelope.operation === "force_release") {
        this.storage.close().catch(() => {});
        return;
      }
      this.l1Cache.invalidateMatching((entry) => this.dependencyTracker.shouldInvalidate(entry, envelope));
    });
  }

  private replaceSyncPort(syncPort: ISyncPort): void {
    this.syncUnsubscribe?.();
    this.syncPort.close();
    this.syncPort = syncPort;
    this.mutationCoordinator.setSyncPort(syncPort);
    this.writeCoalescer.setSyncPort(syncPort);
    this.bindSyncPort();
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.assertUsable();
    await this.writeCoalescer.drain();
    await this.lifecycle.close();
  }

  /**
   * Destroys the engine instance, closing database connections, sync channels,
   * clearing cache timers, and deregistering from the global database pool.
   */
  async destroy(): Promise<void> {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    try {
      await this.writeCoalescer.drain();
      this.storageUnsubscribe?.();
      this.syncUnsubscribe?.();
      this.l1Cache.clear();
      this.syncPort.close();
      await this.lifecycle.close();
      this.statusListeners.clear();
      unregisterEngine(this.schema.name, this);
      if (defaultEngineInstance === this) defaultEngineInstance = null;
      this.disposed = true;
      reportDiagnostic(this.runtimeConfig.diagnostics, {
        type: "engine-destroyed",
        databaseName: this.schema.name,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.disposing = false;
      throw error;
    }
  }

  // ── Core CRUD Delegations ──

  async get<K extends StoreNames<TSchema>>(
    storeName: K,
    key: StoreKey<TSchema, K>,
  ): Promise<StoreValue<TSchema, K> | undefined> {
    this.assertUsable();
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
    this.assertUsable();
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
    this.assertUsable();
    const resolvedKey = this.resolveWriteKey(storeName, value, key as IDBValidKey | undefined);
    return this.writeCoalescer.put(
      storeName,
      value,
      resolvedKey,
      options,
    ) as Promise<StoreKey<TSchema, K>>;
  }

  /**
   * Atomically reads and updates one record using a short readwrite transaction.
   *
   * The updater must be synchronous and free of external side effects because the
   * transaction may abort. Middleware is deliberately rejected: async transformations
   * (including WebCrypto) cannot safely run inside an active IndexedDB transaction.
   */
  async update<K extends StoreNames<TSchema>>(
    storeName: K,
    key: StoreKey<TSchema, K>,
    updater: (current: StoreValue<TSchema, K> | undefined) => StoreValue<TSchema, K>,
  ): Promise<StoreValue<TSchema, K>> {
    this.assertUsable();
    if (this.middlewarePipeline.hasMiddleware) {
      throw new TransactionMiddlewareUnsupportedError();
    }
    return this.transaction([storeName], "readwrite", async (tx) => {
      const current = await tx.get<StoreValue<TSchema, K>>(storeName, key as IDBValidKey);
      const next = updater(current);
      if (
        next !== null &&
        (typeof next === "object" || typeof next === "function") &&
        typeof (next as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("Database update callbacks must be synchronous; return the next record directly.");
      }
      await tx.put(storeName, next, key as IDBValidKey);
      return next;
    });
  }

  async putMany<K extends StoreNames<TSchema>>(
    storeName: K,
    values: readonly StoreValue<TSchema, K>[],
  ): Promise<StoreKey<TSchema, K>[]> {
    this.assertUsable();
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
    const config = this.schema.stores[storeName];
    const keyPath = config?.keyPath;
    if (keyPath === undefined) return key;

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
    if (!isValidKey(candidate)) {
      if (config?.autoIncrement && key === undefined) return undefined;
      throw new TypeError(
        `Value for store "${storeName}" must contain a valid key at keyPath "${paths.join(", ")}".`,
      );
    }
    if (key !== undefined && toKeyString(key) !== toKeyString(candidate)) {
      throw new TypeError(
        `Supplied key does not match the inline keyPath for store "${storeName}".`,
      );
    }
    return candidate;
  }

  async getAll<K extends StoreNames<TSchema>>(
    storeName: K,
  ): Promise<StoreValue<TSchema, K>[]> {
    this.assertUsable();
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
    this.assertUsable();
    return this.writeCoalescer.delete(storeName, key as IDBValidKey, options);
  }

  async clear<K extends StoreNames<TSchema>>(storeName: K): Promise<void> {
    this.assertUsable();
    return this.writeCoalescer.clear(storeName);
  }

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    this.assertUsable();
    if (ops.length === 0) return [];
    const normalizedOps = ops.map((op) => {
      if (op.type !== "put") return op;
      return {
        ...op,
        key: this.resolveWriteKey(storeName, op.value, op.key),
      };
    });
    return this.writeCoalescer.batch(storeName, normalizedOps);
  }

  async transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    const normalizedNames = [...new Set(storeNames)];
    if (normalizedNames.length === 0) {
      throw new TypeError("A transaction must include at least one object store.");
    }
    for (const name of normalizedNames) {
      if (!(name in this.schema.stores)) {
        throw new TypeError(`Unknown object store "${name}" in transaction.`);
      }
    }
    if (this.middlewarePipeline.hasMiddleware) {
      throw new TransactionMiddlewareUnsupportedError();
    }

    const result = await this.storage.transaction(normalizedNames, mode, (tx) => {
      const guardedTransaction: IStorageTransaction = {
        get: <T>(storeName: string, key: IDBValidKey) => tx.get<T>(storeName, key),
        put: (storeName: string, value: unknown, key?: IDBValidKey) =>
          tx.put(storeName, value, this.resolveWriteKey(storeName, value, key)),
        delete: (storeName: string, key: IDBValidKey) => tx.delete(storeName, key),
        clear: (storeName: string) => tx.clear(storeName),
      };
      return fn(guardedTransaction);
    });
    if (mode === "readwrite") {
      this.mutationCoordinator.afterTransactionCommit(normalizedNames);
    }
    return result;
  }

  // ── Telemetry & Observability ──

  async refreshQuota(): Promise<StorageQuota> {
    this.assertUsable();
    this.currentQuota = await this.storage.getQuota();
    reportDiagnostic(this.runtimeConfig.diagnostics, {
      type: "storage-quota-refreshed",
      databaseName: this.schema.name,
      usageBytes: this.currentQuota.usageBytes,
      quotaBytes: this.currentQuota.quotaBytes,
      isPersisted: this.currentQuota.isPersisted,
      timestamp: Date.now(),
    });
    this.notifyStatusChange();
    return this.currentQuota;
  }

  private cachedStatus: IDBStatusSnapshot | null = null;

  private computeStatus(): IDBStatusSnapshot {
    const connState = this.storage.getState();
    return Object.freeze({
      connectionState: connState,
      isFallbackMode: connState === "FALLBACK_MEMORY",
      fallbackReason: this.fallbackReason,
      persistentStorageGranted: this.persistentStorageGranted,
      isUpgradeBlocked: this.storage.isUpgradeBlocked(),
      requiresReloadForUpgrade: this.storage.requiresReloadForUpgrade(),
      quota: this.currentQuota,
      refreshQuota: async () => this.refreshQuota(),
      reconnect: async () => {
        await this.writeCoalescer.drain();
        await this.lifecycle.close();
        await this.lifecycle.open();
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
 * Create a strongly typed Engine using either the legacy schema/config pair or the modern
 * grouped configuration object.
 *
 * Preferred API:
 * ```ts
 * const db = createDatabase({
 *   schema,
 *   adapters: { storage: customStorage },
 *   middleware: [encryption],
 *   cache: { maxEntries: 500, ttlMs: 30_000 },
 *   writes: { coalesceWindowMs: 0 },
 *   crossTab: { enabled: true },
 *   fallback: { strategy: "memory", requestPersistentStorage: false },
 * });
 * ```
 *
 * The legacy `createDatabase(schema, { storage, sync, lock, middlewares })` form remains supported.
 */
export function createDatabase<TSchema extends DatabaseSchema<any>>(
  options: DatabaseFactoryOptions<TSchema>,
): Engine<TSchema>;
export function createDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  schema: TSchema,
  config?: EngineConfig | DatabaseRuntimeConfig,
): Engine<TSchema>;
export function createDatabase<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  schemaOrOptions: TSchema | DatabaseFactoryOptions<TSchema>,
  legacyConfig?: EngineConfig | DatabaseRuntimeConfig,
): Engine<TSchema> {
  const isFactoryOptions = isDatabaseFactoryOptions(schemaOrOptions);
  const schema = isFactoryOptions ? schemaOrOptions.schema : schemaOrOptions;
  const config = isFactoryOptions ? (schemaOrOptions as DatabaseRuntimeConfig) : legacyConfig;

  validateDatabaseSchema(schema);
  const resolvedConfig = resolveEngineConfig(schema, config);
  const existing = findRegisteredEngine<TSchema>(schema.name);
  if (existing) {
    assertCompatibleEngineRegistration(existing, schema, resolvedConfig);
    return existing;
  }

  const engine = new Engine(schema, resolvedConfig);
  registerEngine(schema, engine, resolvedConfig);
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
