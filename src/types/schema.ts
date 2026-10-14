/**
 * String property key or composite compound key tuple representing an IndexedDB keyPath.
 */
export type KeyPath<T> = (keyof T & string) | ReadonlyArray<keyof T & string>;

/**
 * Definition of a secondary index on an IndexedDB object store.
 *
 * @template T - The object store record type.
 */
export interface IndexConfig<T = unknown> {
  /**
   * The field name or compound key path on the record to index.
   */
  keyPath: KeyPath<T>;

  /**
   * Whether to enforce uniqueness constraint across indexed records.
   *
   * @default false
   */
  unique?: boolean;

  /**
   * When keyPath evaluates to an Array, whether to index each element separately.
   *
   * @default false
   */
  multiEntry?: boolean;
}

/**
 * Configuration for an individual IndexedDB object store.
 *
 * @template TRecord - Stored entity record type.
 * @template TKey - Primary key type (e.g. `string` or `number`).
 */
export interface StoreConfig<TRecord = unknown, TKey extends IDBValidKey = string> {
  /**
   * In-line primary key property path on the record object.
   * If omitted, store uses out-of-line keys (e.g. key-value pair store).
   */
  keyPath?: keyof TRecord & string;

  /**
   * Whether primary keys are automatically generated auto-incrementing integers.
   *
   * @default false
   */
  autoIncrement?: boolean;

  /**
   * Map of secondary index definitions for this store.
   */
  indexes?: Record<string, IndexConfig<TRecord>>;

  /**
   * Type marker for primary key inference.
   */
  readonly __keyType?: TKey;
}

/**
 * Migration execution context provided to version upgrade migration functions.
 */
export interface MigrationContext {
  /**
   * Native IDBDatabase instance during `versionchange` transaction.
   */
  db: IDBDatabase;

  /**
   * The active `versionchange` IDBTransaction.
   */
  transaction: IDBTransaction;

  /**
   * Previous version number prior to upgrade.
   */
  oldVersion: number;

  /**
   * Target version number being upgraded to.
   */
  newVersion: number | null;
}

/**
 * Advanced runtime options for the database engine.
 */
export interface DatabaseOptions {
  /**
   * Batch coalescing window in milliseconds.
   * If `0`, groups writes within the same microtask (`queueMicrotask`).
   *
   * @default 0
   */
  coalesceWindowMs?: number;

  /**
   * Maximum capacity of the L1 synchronous cache before LRU eviction.
   *
   * @default 1000
   */
  cacheMaxEntries?: number;

  /**
   * Time-to-live in milliseconds for cache entries with zero active subscribers before garbage collection.
   *
   * @default 60000
   */
  cacheTTLMs?: number;

  /**
   * Whether to broadcast mutations across browser tabs via `BroadcastChannel`.
   *
   * @default true
   */
  enableCrossTabSync?: boolean;

  /**
   * Whether to gracefully fallback to high-fidelity In-Memory storage if IndexedDB is blocked or unsupported.
   *
   * @default true
   */
  fallbackToMemory?: boolean;

  /**
   * Whether to prompt the browser for persistent storage grant (`navigator.storage.persist()`).
   *
   * @default false
   */
  requestPersistentStorage?: boolean;
}

/**
 * Declarative definition of an IndexedDB database schema including version, stores, migrations, and options.
 *
 * @template TStores - Strongly typed map of store configurations.
 */
export interface DatabaseSchema<
  TStores extends Record<string, StoreConfig<any, any>> = Record<string, StoreConfig<any, any>>,
> {
  /**
   * Unique name of the database.
   */
  name: string;

  /**
   * Integer version of the database schema (must be $\ge 1$).
   */
  version: number;

  /**
   * Object store configurations.
   */
  stores: TStores;

  /**
   * Step-by-step schema migrations indexed by target version number.
   */
  migrations?: Record<number, (ctx: MigrationContext) => void | Promise<void>>;

  /**
   * Runtime engine tuning options.
   */
  options?: DatabaseOptions;
}

// Type Inference Helpers
export type StoreNames<S extends DatabaseSchema<any>> = keyof S["stores"] & string;

export type StoreValue<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends StoreConfig<infer R, any> ? R : never;

export type StoreKey<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends StoreConfig<any, infer Key> ? Key : IDBValidKey;

export type StoreIndexes<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K]["indexes"] extends Record<string, any>
    ? keyof S["stores"][K]["indexes"] & string
    : string;
