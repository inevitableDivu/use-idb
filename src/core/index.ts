export {
  Engine,
  createDatabase,
  getDatabase,
  getDefaultEngine,
  DatabaseConfigurationConflictError,
  TransactionMiddlewareUnsupportedError,
} from "./engine";
export type { DatabaseInstance } from "./engine";
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
} from "./config";
export type {
  DatabaseDiagnosticsConfig,
  DatabaseDiagnosticEvent,
} from "./observability/diagnostics";
export { store, outOfLineStore, validateDatabaseSchema } from "../types/schema";
export {
  DatabaseDestroyedError,
  DatabaseSchemaTransitionError,
  MiddlewareSchemaConflictError,
} from "./errors";
export {
  DatabaseClosingForUpgradeError,
  DatabaseMigrationError,
} from "../adapters/storage/idb-adapter";
export type {
  DatabaseConfig,
  DatabaseSchema,
  StoreConfig,
  StoreDefinition,
  StoreInput,
  OutOfLineStoreInput,
  OutOfLineStoreDefinition,
  StoreMap,
  StoreNames,
  StoreValue,
  StoreKey,
  IndexConfig,
  IndexInput,
  IndexObjectConfig,
  InferKeyFromPath,
  InferIndexValue,
} from "../types/schema";
export type { QueryExecutionContext } from "../types/query";
export { QueryBuilder } from "./query-engine";
export { compileQueryPlan } from "./query/query-plan";
export type { QueryPlan, QueryPlanSummary, QueryAccessPath } from "./query/query-plan";
export { L1Cache, DELETED_SENTINEL } from "./l1-cache";
export type { QuerySnapshot, CacheEntry, L1CacheOptions } from "./l1-cache";
export { DependencyTracker } from "./dependency-tracker";
export { WriteCoalescer } from "./write-coalescer";
export type { WriteCoalescerOptions } from "./write-coalescer";
export { serializeKey, isValidKey, hashQuery } from "./key-serializer";
