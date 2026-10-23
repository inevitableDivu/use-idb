// ── React Hooks & Context ──
export { IndexedDBProvider, useDatabase } from "./react/context";
export type { IndexedDBProviderProps } from "./react/context";
export { createDatabaseHooks } from "./react/factory";
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
export {
  Engine,
  createDatabase,
  getDatabase,
  getDefaultEngine,
  DatabaseConfigurationConflictError,
  TransactionMiddlewareUnsupportedError,
} from "./core/engine";
export {
  DatabaseDestroyedError,
  DatabaseSchemaTransitionError,
  MiddlewareSchemaConflictError,
} from "./core/errors";
export type { DatabaseInstance } from "./core/engine";
export type {
  EngineConfig,
  DatabaseRuntimeConfig,
  DatabaseFactoryOptions,
  DatabaseAdapters,
  CacheConfig,
  WriteConfig,
  CrossTabConfig,
  FallbackConfig,
  ResolvedEngineConfig,
} from "./core/config";
export type {
  DatabaseDiagnosticsConfig,
  DatabaseDiagnosticEvent,
} from "./core/observability/diagnostics";
export { QueryBuilder } from "./core/query-engine";
export { compileQueryPlan } from "./core/query/query-plan";
export type { QueryPlan, QueryPlanSummary, QueryAccessPath } from "./core/query/query-plan";
export { L1Cache, DELETED_SENTINEL } from "./core/l1-cache";
export type { QuerySnapshot, CacheEntry, L1CacheOptions } from "./core/l1-cache";
export { DependencyTracker } from "./core/dependency-tracker";
export { WriteCoalescer } from "./core/write-coalescer";
export type { WriteCoalescerOptions } from "./core/write-coalescer";
export { serializeKey, isValidKey, toKeyString, hashQuery } from "./core/key-serializer";

// ── Ports ──
export type {
  IStoragePort,
  IStorageTransaction,
  StorageBatchOp,
  StorageEntry,
} from "./ports/storage.port";
export type { ISyncPort, MutationEnvelope } from "./ports/sync.port";
export type { ILockPort } from "./ports/lock.port";
export type { IDBMiddleware } from "./ports/middleware.port";

// ── Adapters ──
export {
  IndexedDBStorageAdapter,
  DatabaseClosingForUpgradeError,
  DatabaseMigrationError,
} from "./adapters/storage/idb-adapter";
export { MemoryStorageAdapter } from "./adapters/storage/memory-adapter";
export { runMigrations } from "./adapters/storage/migration-runner";
export { BroadcastSyncAdapter } from "./adapters/sync/broadcast-adapter";
export { NoopSyncAdapter } from "./adapters/sync/noop-sync-adapter";
export { WebLocksAdapter } from "./adapters/lock/web-locks-adapter";
export { NoopLockAdapter } from "./adapters/lock/noop-lock-adapter";
export { MiddlewarePipeline } from "./adapters/middleware/pipeline";
export {
  createEncryptionMiddleware,
  CryptographicContextUnavailableError,
  KeyNotFoundError,
} from "./adapters/middleware/encryption";
export type {
  KeyRing,
  EncryptedFieldEnvelope,
  EncryptionOptions,
} from "./adapters/middleware/encryption";
export { defaultSerializer } from "./adapters/middleware/serializer";
export type { SerializationHook } from "./adapters/middleware/serializer";

// ── Domain Types ──
export type {
  StringKeyOf,
  KeyPath,
  DatabaseSchema,
  StoreConfig,
  StoreDefinition,
  StoreInput,
  OutOfLineStoreInput,
  OutOfLineStoreDefinition,
  DefaultKeyPath,
  IndexInput,
  IndexObjectConfig,
  IndexesInputMap,
  InferKeyFromPath,
  InferIndexValue,
  IndexConfig,
  MigrationContext,
  DatabaseOptions,
  StoreNames,
  StoreValue,
  StoreKey,
  StoreIndexes,
  StoreMap,
  DatabaseConfig,
  InferStoreItem,
  InferStoreKey,
} from "./types/schema";
export { store, outOfLineStore, validateDatabaseSchema } from "./types/schema";
export type {
  QueryAST,
  QueryExecutionContext,
  CursorDirection,
  QueryFilterPredicate,
  LiveQueryOptions,
  SortDirection,
  QueryBuilder as QueryBuilderType,
  WhereClause,
  ResolveWhereValue,
  ValidWhereField,
} from "./types/query";
export type { ConnectionState, StorageQuota, IDBStatusSnapshot } from "./types/status";
