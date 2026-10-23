/**
 * String property key or composite compound key tuple representing an IndexedDB keyPath.
 */
export type StringKeyOf<T> = Extract<keyof T, string>;

export type KeyPath<T> = StringKeyOf<T> | readonly [StringKeyOf<T>, ...StringKeyOf<T>[]];

export type InferKeyFromPath<TItem, TPath extends KeyPath<TItem>> = TPath extends keyof TItem
  ? TItem[TPath]
  : TPath extends readonly (keyof TItem)[]
    ? { -readonly [K in keyof TPath]: TItem[Extract<TPath[K], keyof TItem>] }
    : never;

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
  keyPath?: KeyPath<TRecord>;

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
  readonly __recordType?: TRecord;
}

export type IndexObjectConfig<TItem, TPath extends KeyPath<TItem> = KeyPath<TItem>> = {
  readonly keyPath: TPath;
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
};

export type IndexInput<TItem> = KeyPath<TItem> | IndexObjectConfig<TItem>;
export type IndexesInputMap<TItem> = Record<string, IndexInput<TItem>>;

export type InferIndexValue<TItem, TIndex extends IndexInput<TItem>> =
  TIndex extends KeyPath<TItem>
    ? InferKeyFromPath<TItem, TIndex>
    : TIndex extends IndexObjectConfig<TItem, infer TPath>
      ? TIndex extends { readonly multiEntry: true }
        ? InferKeyFromPath<TItem, TPath> extends readonly (infer TElement)[]
          ? TElement
          : InferKeyFromPath<TItem, TPath>
        : InferKeyFromPath<TItem, TPath>
      : never;

export interface StoreInput<
  TItem extends object,
  TPath extends KeyPath<TItem> = KeyPath<TItem>,
  TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
> {
  readonly keyPath: TPath;
  readonly autoIncrement?: boolean;
  readonly indexes?: TIndexes;
}

export type DefaultKeyPath<TItem extends object> = "id" extends StringKeyOf<TItem>
  ? "id"
  : KeyPath<TItem>;

export interface StoreDefinition<
  TItem extends object = object,
  TPath extends KeyPath<TItem> = KeyPath<TItem>,
  TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
> extends StoreConfig<TItem, InferKeyFromPath<TItem, TPath> & IDBValidKey> {
  readonly keyPath: TPath;
  readonly indexes: Record<string, IndexConfig<TItem>>;
  readonly $types: {
    readonly item: TItem;
    readonly key: InferKeyFromPath<TItem, TPath>;
    readonly keyPath: TPath;
    readonly indexes: TIndexes;
  };
}

/**
 * Configuration for a store whose primary key is supplied separately to put/get/delete.
 * Use this helper when a record does not contain an inline primary key.
 */
export interface OutOfLineStoreInput<
  TItem extends object,
  TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
> {
  readonly autoIncrement?: boolean;
  readonly indexes?: TIndexes;
}

/**
 * Type-preserving out-of-line store definition. The key type can be declared explicitly
 * because IndexedDB cannot infer an out-of-line key type from a record property.
 */
export interface OutOfLineStoreDefinition<
  TItem extends object = object,
  TKey extends IDBValidKey = IDBValidKey,
  TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
> extends StoreConfig<TItem, TKey> {
  readonly indexes: Record<string, IndexConfig<TItem>>;
  readonly $types: {
    readonly item: TItem;
    readonly key: TKey;
    readonly keyPath: undefined;
    readonly indexes: TIndexes;
  };
}

type RuntimeKeyPath = string | readonly string[];
type RuntimeIndexConfig = {
  keyPath: RuntimeKeyPath;
  unique?: boolean;
  multiEntry?: boolean;
};
type RuntimeStoreConfig = {
  keyPath: RuntimeKeyPath;
  autoIncrement: boolean;
  indexes: Record<string, RuntimeIndexConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeKeyPath(value: unknown): value is RuntimeKeyPath {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"))
  );
}

function normalizeStore(config: unknown): RuntimeStoreConfig {
  if (!isRecord(config) || !isRuntimeKeyPath(config.keyPath)) {
    throw new TypeError("A store definition requires a valid keyPath.");
  }
  if (config.autoIncrement !== undefined && typeof config.autoIncrement !== "boolean") {
    throw new TypeError("Store autoIncrement must be a boolean.");
  }
  const indexes: Record<string, RuntimeIndexConfig> = {};
  if (config.indexes !== undefined) {
    if (!isRecord(config.indexes)) {
      throw new TypeError("Store indexes must be an object map.");
    }
    for (const [name, input] of Object.entries(config.indexes)) {
      if (isRuntimeKeyPath(input)) {
        indexes[name] = { keyPath: input };
        continue;
      }
      if (!isRecord(input) || !isRuntimeKeyPath(input.keyPath)) {
        throw new TypeError(`Index "${name}" requires a valid keyPath.`);
      }
      if (
        (input.unique !== undefined && typeof input.unique !== "boolean") ||
        (input.multiEntry !== undefined && typeof input.multiEntry !== "boolean")
      ) {
        throw new TypeError(`Index "${name}" options must be booleans.`);
      }
      indexes[name] = {
        keyPath: input.keyPath,
        unique: input.unique as boolean | undefined,
        multiEntry: input.multiEntry as boolean | undefined,
      };
    }
  }
  return {
    keyPath: config.keyPath,
    autoIncrement: config.autoIncrement === true,
    indexes,
  };
}

export function store<TItem extends object>(): <
  const TPath extends KeyPath<TItem>,
  const TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
>(
  config: StoreInput<TItem, TPath, TIndexes>,
) => StoreDefinition<TItem, TPath, TIndexes>;
export function store<TItem extends object>(
  config: StoreInput<TItem, DefaultKeyPath<TItem>, IndexesInputMap<TItem>>,
): StoreDefinition<TItem, DefaultKeyPath<TItem>, IndexesInputMap<TItem>>;
export function store(config?: unknown): unknown {
  if (!config) {
    return (deferred: unknown) => normalizeStore(deferred);
  }
  return normalizeStore(config);
}

function normalizeOutOfLineStore(config: unknown): unknown {
  const input = config === undefined ? {} : config;
  if (!isRecord(input)) {
    throw new TypeError("An out-of-line store configuration must be an object.");
  }
  if (input.keyPath !== undefined) {
    throw new TypeError("Out-of-line stores cannot declare keyPath; use store<T>() for inline keys.");
  }
  if (input.autoIncrement !== undefined && typeof input.autoIncrement !== "boolean") {
    throw new TypeError("Store autoIncrement must be a boolean.");
  }

  const indexes: Record<string, RuntimeIndexConfig> = {};
  if (input.indexes !== undefined) {
    if (!isRecord(input.indexes)) throw new TypeError("Store indexes must be an object map.");
    for (const [name, indexInput] of Object.entries(input.indexes)) {
      if (isRuntimeKeyPath(indexInput)) {
        indexes[name] = { keyPath: indexInput };
        continue;
      }
      if (!isRecord(indexInput) || !isRuntimeKeyPath(indexInput.keyPath)) {
        throw new TypeError(`Index "${name}" requires a valid keyPath.`);
      }
      if (
        (indexInput.unique !== undefined && typeof indexInput.unique !== "boolean") ||
        (indexInput.multiEntry !== undefined && typeof indexInput.multiEntry !== "boolean")
      ) {
        throw new TypeError(`Index "${name}" options must be booleans.`);
      }
      if (indexInput.multiEntry === true && Array.isArray(indexInput.keyPath)) {
        throw new TypeError(`Index "${name}" cannot combine multiEntry with a compound keyPath.`);
      }
      indexes[name] = {
        keyPath: indexInput.keyPath,
        unique: indexInput.unique as boolean | undefined,
        multiEntry: indexInput.multiEntry as boolean | undefined,
      };
    }
  }
  return {
    autoIncrement: input.autoIncrement === true,
    indexes,
  };
}

/**
 * Defines a typed store whose keys are stored out-of-line.
 *
 * ```ts
 * const events = outOfLineStore<Event, string>()({ indexes: { by_kind: "kind" } });
 * ```
 */
export function outOfLineStore<
  TItem extends object,
  TKey extends IDBValidKey = IDBValidKey,
>(): <
  const TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
>(
  config?: OutOfLineStoreInput<TItem, TIndexes>,
) => OutOfLineStoreDefinition<TItem, TKey, TIndexes>;
export function outOfLineStore<
  TItem extends object,
  TKey extends IDBValidKey = IDBValidKey,
  const TIndexes extends IndexesInputMap<TItem> = Record<never, never>,
>(
  config?: OutOfLineStoreInput<TItem, TIndexes>,
): OutOfLineStoreDefinition<TItem, TKey, TIndexes>;
export function outOfLineStore(config?: unknown): unknown {
  if (config === undefined) {
    return (deferred: unknown) => normalizeOutOfLineStore(deferred);
  }
  return normalizeOutOfLineStore(config);
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
   * Migrations MUST be synchronous IDB operations to prevent premature browser auto-commit.
   */
  migrations?: Record<number, (ctx: MigrationContext) => void>;

  /**
   * Runtime engine tuning options.
   */
  options?: DatabaseOptions;
}


/**
 * Validate database configuration before touching browser storage. This keeps configuration
 * mistakes deterministic and prevents them from being mistaken for IndexedDB availability errors.
 */
export function validateDatabaseSchema(schema: DatabaseSchema): void {
  if (!isRecord(schema)) throw new TypeError("Database schema must be an object.");
  if (typeof schema.name !== "string" || schema.name.trim().length === 0) {
    throw new TypeError("Database name must be a non-empty string.");
  }
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    throw new RangeError("Database version must be a positive safe integer.");
  }
  if (!isRecord(schema.stores)) throw new TypeError("Database stores must be an object map.");

  for (const [storeName, config] of Object.entries(schema.stores)) {
    if (!storeName || !isRecord(config)) {
      throw new TypeError("Each object store must have a non-empty name and an object configuration.");
    }
    if (config.keyPath !== undefined && !isRuntimeKeyPath(config.keyPath)) {
      throw new TypeError(`Store "${storeName}" has an invalid keyPath.`);
    }
    if (config.autoIncrement !== undefined && typeof config.autoIncrement !== "boolean") {
      throw new TypeError(`Store "${storeName}" autoIncrement must be a boolean.`);
    }
    if (config.autoIncrement === true && (Array.isArray(config.keyPath) || config.keyPath === "")) {
      throw new TypeError(`Store "${storeName}" cannot use autoIncrement with an empty or compound keyPath.`);
    }
    if (config.indexes !== undefined && !isRecord(config.indexes)) {
      throw new TypeError(`Store "${storeName}" indexes must be an object map.`);
    }
    for (const [indexName, index] of Object.entries(config.indexes ?? {})) {
      if (!indexName || !isRecord(index) || !isRuntimeKeyPath(index.keyPath)) {
        throw new TypeError(`Index "${storeName}.${indexName}" has an invalid keyPath.`);
      }
      if (
        (index.unique !== undefined && typeof index.unique !== "boolean") ||
        (index.multiEntry !== undefined && typeof index.multiEntry !== "boolean")
      ) {
        throw new TypeError(`Index "${storeName}.${indexName}" options must be booleans.`);
      }
      if (index.multiEntry === true && Array.isArray(index.keyPath)) {
        throw new TypeError(`Index "${storeName}.${indexName}" cannot combine multiEntry with a compound keyPath.`);
      }
    }
  }

  if (schema.migrations !== undefined) {
    if (!isRecord(schema.migrations)) {
      throw new TypeError("Migrations must be an object keyed by schema version.");
    }
    for (const [version, migrate] of Object.entries(schema.migrations)) {
      const targetVersion = Number(version);
      if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > schema.version) {
        throw new RangeError(`Migration version "${version}" must be between 1 and the database version.`);
      }
      if (typeof migrate !== "function") throw new TypeError(`Migration v${version} must be a function.`);
    }
  }

  const options = schema.options;
  if (!options) return;
  if (
    options.coalesceWindowMs !== undefined &&
    (!Number.isSafeInteger(options.coalesceWindowMs) || options.coalesceWindowMs < 0)
  ) {
    throw new RangeError("coalesceWindowMs must be a non-negative safe integer.");
  }
  if (
    options.cacheMaxEntries !== undefined &&
    (!Number.isSafeInteger(options.cacheMaxEntries) || options.cacheMaxEntries < 1)
  ) {
    throw new RangeError("cacheMaxEntries must be a positive safe integer.");
  }
  if (
    options.cacheTTLMs !== undefined &&
    (!Number.isSafeInteger(options.cacheTTLMs) || options.cacheTTLMs < 0)
  ) {
    throw new RangeError("cacheTTLMs must be a non-negative safe integer.");
  }
  for (const option of ["enableCrossTabSync", "fallbackToMemory", "requestPersistentStorage"] as const) {
    if (options[option] !== undefined && typeof options[option] !== "boolean") {
      throw new TypeError(`${option} must be a boolean.`);
    }
  }
}

export type StoreMap = Record<string, StoreConfig<any, any>>;
export type DatabaseConfig<TStores extends StoreMap> = DatabaseSchema<TStores>;

// Type Inference Helpers
export type StoreNames<S extends DatabaseSchema<any>> = keyof S["stores"] & string;

export type StoreValue<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends { readonly $types: { readonly item: infer R extends object } }
    ? R
    : S["stores"][K] extends { readonly __recordType?: infer R extends object }
      ? R
      : unknown;

export type StoreKey<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends { readonly $types: { readonly key: infer Key } }
    ? Key extends IDBValidKey
      ? Key
      : IDBValidKey
    : S["stores"][K] extends { readonly __keyType?: infer Key extends IDBValidKey }
      ? Key
      : IDBValidKey;

export type StoreIndexes<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends { readonly $types: { readonly indexes: infer Indexes } }
    ? keyof Indexes & string
    : S["stores"][K]["indexes"] extends Record<string, any>
    ? keyof S["stores"][K]["indexes"] & string
    : string;

export type InferStoreItem<TStores extends StoreMap, K extends keyof TStores> =
  TStores[K] extends { readonly $types: { readonly item: infer TItem extends object } }
    ? TItem
    : TStores[K] extends { readonly __recordType?: infer TItem extends object }
      ? TItem
      : unknown;

export type InferStoreKey<TStores extends StoreMap, K extends keyof TStores> =
  TStores[K] extends { readonly $types: { readonly key: infer TKey } }
    ? TKey extends IDBValidKey
      ? TKey
      : IDBValidKey
    : TStores[K] extends { readonly __keyType?: infer TKey extends IDBValidKey }
      ? TKey
      : IDBValidKey;
