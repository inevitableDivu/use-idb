export type KeyPath<T> = (keyof T & string) | ReadonlyArray<keyof T & string>;

export interface IndexConfig<T = unknown> {
  keyPath: KeyPath<T>;
  unique?: boolean;
  multiEntry?: boolean;
}

export interface StoreConfig<TRecord = unknown, TKey extends IDBValidKey = string> {
  keyPath?: keyof TRecord & string;
  autoIncrement?: boolean;
  indexes?: Record<string, IndexConfig<TRecord>>;
  readonly __keyType?: TKey;
}

export interface MigrationContext {
  db: IDBDatabase;
  transaction: IDBTransaction;
  oldVersion: number;
  newVersion: number | null;
}

export interface DatabaseOptions {
  coalesceWindowMs?: number; // Default: 0 (microtask)
  cacheMaxEntries?: number; // Default: 1000
  cacheTTLMs?: number; // Default: 60_000ms after 0 subscribers
  enableCrossTabSync?: boolean; // Default: true
  fallbackToMemory?: boolean; // Default: true
  requestPersistentStorage?: boolean; // Default: false
}

export interface DatabaseSchema<
  TStores extends Record<string, StoreConfig<any, any>> = Record<string, StoreConfig<any, any>>,
> {
  name: string;
  version: number;
  stores: TStores;
  migrations?: Record<number, (ctx: MigrationContext) => void | Promise<void>>;
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
