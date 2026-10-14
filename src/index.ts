// ── React Hooks & Context ──
export { IndexedDBProvider, useDatabase } from "./react/context";
export type { IndexedDBProviderProps } from "./react/context";
export { useIdb } from "./react/use-idb";
export type { UseIdbOptions, UseIdbReturn } from "./react/use-idb";
export { useLiveQuery } from "./react/use-live-query";
export type { UseLiveQueryResult } from "./react/use-live-query";
export { useRecord } from "./react/use-record";
export type { UseRecordOptions, UseRecordResult } from "./react/use-record";
export { useMutation } from "./react/use-mutation";
export type { UseMutationResult } from "./react/use-mutation";
export { useIDBStatus } from "./react/use-idb-status";

// ── Core Engine & Factories ──
export { Engine, createDatabase, getDefaultEngine } from "./core/engine";
export type { EngineConfig } from "./core/engine";
export { QueryBuilder } from "./core/query-engine";
export { L1Cache } from "./core/l1-cache";
export type { QuerySnapshot, CacheEntry, L1CacheOptions } from "./core/l1-cache";
export { DependencyTracker } from "./core/dependency-tracker";
export { WriteCoalescer } from "./core/write-coalescer";
export type { WriteCoalescerOptions } from "./core/write-coalescer";
export { serializeKey, isValidKey, hashQuery } from "./core/key-serializer";

// ── Ports ──
export type { IStoragePort, IStorageTransaction, StorageBatchOp } from "./ports/storage.port";
export type { ISyncPort, MutationEnvelope } from "./ports/sync.port";
export type { ILockPort } from "./ports/lock.port";
export type { IDBMiddleware } from "./ports/middleware.port";

// ── Adapters ──
export { IndexedDBStorageAdapter } from "./adapters/storage/idb-adapter";
export { MemoryStorageAdapter } from "./adapters/storage/memory-adapter";
export { runMigrations } from "./adapters/storage/migration-runner";
export { BroadcastSyncAdapter } from "./adapters/sync/broadcast-adapter";
export { NoopSyncAdapter } from "./adapters/sync/noop-sync-adapter";
export { WebLocksAdapter } from "./adapters/lock/web-locks-adapter";
export { NoopLockAdapter } from "./adapters/lock/noop-lock-adapter";
export { MiddlewarePipeline } from "./adapters/middleware/pipeline";
export { createEncryptionMiddleware } from "./adapters/middleware/encryption";

// ── Domain Types ──
export type {
  DatabaseSchema,
  StoreConfig,
  IndexConfig,
  MigrationContext,
  DatabaseOptions,
  StoreNames,
  StoreValue,
  StoreKey,
  StoreIndexes,
} from "./types/schema";
export type {
  QueryAST,
  CursorDirection,
  QueryFilterPredicate,
  LiveQueryOptions,
} from "./types/query";
export type { ConnectionState, StorageQuota, IDBStatusSnapshot } from "./types/status";
