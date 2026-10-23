import type { DatabaseSchema } from "../types/schema";
import type { IStoragePort } from "../ports/storage.port";
import type { ISyncPort } from "../ports/sync.port";
import type { ILockPort } from "../ports/lock.port";
import type { IDBMiddleware } from "../ports/middleware.port";
import type { DatabaseDiagnosticsConfig } from "./observability/diagnostics";

/** Backward-compatible adapter overrides accepted by the original createDatabase(schema, config) API. */
export interface EngineConfig {
  /** Custom storage port implementation. */
  storage?: IStoragePort;
  /** Custom synchronization port implementation. */
  sync?: ISyncPort;
  /** Custom lock port implementation. */
  lock?: ILockPort;
  /** Ordered middleware chain. */
  middlewares?: readonly IDBMiddleware[];
}

/** Explicitly grouped adapter dependencies for the modern configuration API. */
export interface DatabaseAdapters {
  storage?: IStoragePort;
  sync?: ISyncPort;
  lock?: ILockPort;
}

/** L1 cache behavior. Defaults: maxEntries=1000, ttlMs=60000. */
export interface CacheConfig {
  maxEntries?: number;
  ttlMs?: number;
}

/** Write scheduling behavior. Defaults to coalescing writes queued in the same microtask. */
export interface WriteConfig {
  coalesceWindowMs?: number;
}

/** Cross-context event delivery policy. */
export interface CrossTabConfig {
  enabled?: boolean;
}

/** Storage recovery policy. Memory fallback is volatile and process-local. */
export interface FallbackConfig {
  strategy?: "memory" | "error";
  requestPersistentStorage?: boolean;
}

/**
 * Modern runtime configuration, separate from the persistent schema definition.
 *
 * The schema describes durable object stores and migrations. This object describes how an
 * Engine instance executes at runtime: adapters, middleware, cache, write batching, cross-tab
 * notifications, and fallback. All groups are optional and receive safe defaults.
 */
export interface DatabaseRuntimeConfig {
  adapters?: DatabaseAdapters;
  middleware?: readonly IDBMiddleware[];
  cache?: CacheConfig;
  writes?: WriteConfig;
  crossTab?: CrossTabConfig;
  fallback?: FallbackConfig;
  diagnostics?: DatabaseDiagnosticsConfig;
}

/** Preferred factory input; all runtime concerns stay separate from the schema. */
export interface DatabaseFactoryOptions<
  TSchema extends DatabaseSchema<any>,
> extends DatabaseRuntimeConfig {
  schema: TSchema;
}

/** Fully normalized options consumed by Engine and registration compatibility checks. */
export interface ResolvedEngineConfig {
  readonly __resolved: true;
  readonly adapters: Readonly<DatabaseAdapters>;
  readonly middleware: readonly IDBMiddleware[];
  readonly cache: Readonly<{ maxEntries: number; ttlMs: number }>;
  readonly writes: Readonly<{ coalesceWindowMs: number }>;
  readonly crossTab: Readonly<{ enabled: boolean }>;
  readonly fallback: Readonly<{ strategy: "memory" | "error"; requestPersistentStorage: boolean }>;
  readonly diagnostics?: DatabaseDiagnosticsConfig;
}

const DEFAULTS = Object.freeze({
  cacheMaxEntries: 1_000,
  cacheTtlMs: 60_000,
  coalesceWindowMs: 0,
});

/**
 * Resolve legacy schema options plus old/new runtime API inputs into one internal contract.
 * Explicit new options win over legacy runtime values, which win over schema-level compatibility
 * options, followed by defaults.
 */
export function resolveEngineConfig(
  schema: DatabaseSchema<any>,
  config?: EngineConfig | DatabaseRuntimeConfig | ResolvedEngineConfig,
): ResolvedEngineConfig {
  if (config && "__resolved" in config && config.__resolved) {
    return config as ResolvedEngineConfig;
  }

  const source = config ?? {};
  const modern = isModernRuntimeConfig(source);
  const legacy = source as EngineConfig;
  const runtime = source as DatabaseRuntimeConfig;
  const schemaOptions = schema.options;

  const adapters: DatabaseAdapters = modern
    ? {
        storage: runtime.adapters?.storage,
        sync: runtime.adapters?.sync,
        lock: runtime.adapters?.lock,
      }
    : {
        storage: legacy.storage,
        sync: legacy.sync,
        lock: legacy.lock,
      };

  const middleware = modern ? [...(runtime.middleware ?? [])] : [...(legacy.middlewares ?? [])];

  const cacheMaxEntries =
    runtime.cache?.maxEntries ?? schemaOptions?.cacheMaxEntries ?? DEFAULTS.cacheMaxEntries;
  const cacheTtlMs = runtime.cache?.ttlMs ?? schemaOptions?.cacheTTLMs ?? DEFAULTS.cacheTtlMs;
  const coalesceWindowMs =
    runtime.writes?.coalesceWindowMs ??
    schemaOptions?.coalesceWindowMs ??
    DEFAULTS.coalesceWindowMs;
  const crossTabEnabled = runtime.crossTab?.enabled ?? schemaOptions?.enableCrossTabSync ?? true;
  const fallbackStrategy =
    runtime.fallback?.strategy ?? ((schemaOptions?.fallbackToMemory ?? true) ? "memory" : "error");
  const requestPersistentStorage =
    runtime.fallback?.requestPersistentStorage ?? schemaOptions?.requestPersistentStorage ?? false;

  if (!Number.isSafeInteger(cacheMaxEntries) || cacheMaxEntries < 1) {
    throw new RangeError("cache.maxEntries must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new RangeError("cache.ttlMs must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(coalesceWindowMs) || coalesceWindowMs < 0) {
    throw new RangeError("writes.coalesceWindowMs must be a non-negative safe integer.");
  }
  if (typeof crossTabEnabled !== "boolean") {
    throw new TypeError("crossTab.enabled must be a boolean.");
  }
  if (fallbackStrategy !== "memory" && fallbackStrategy !== "error") {
    throw new TypeError('fallback.strategy must be either "memory" or "error".');
  }
  if (typeof requestPersistentStorage !== "boolean") {
    throw new TypeError("fallback.requestPersistentStorage must be a boolean.");
  }

  return Object.freeze({
    __resolved: true as const,
    adapters: Object.freeze(adapters),
    middleware: Object.freeze(middleware),
    cache: Object.freeze({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs }),
    writes: Object.freeze({ coalesceWindowMs }),
    crossTab: Object.freeze({ enabled: crossTabEnabled }),
    fallback: Object.freeze({ strategy: fallbackStrategy, requestPersistentStorage }),
    diagnostics: runtime.diagnostics,
  });
}

function isModernRuntimeConfig(
  config: EngineConfig | DatabaseRuntimeConfig | ResolvedEngineConfig,
): config is DatabaseRuntimeConfig {
  return (
    "adapters" in config ||
    "middleware" in config ||
    "cache" in config ||
    "writes" in config ||
    "crossTab" in config ||
    "fallback" in config ||
    "diagnostics" in config
  );
}

export function isDatabaseFactoryOptions<TSchema extends DatabaseSchema<any>>(
  value: DatabaseFactoryOptions<TSchema> | DatabaseSchema<any>,
): value is DatabaseFactoryOptions<TSchema> {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    typeof (value as { schema?: unknown }).schema === "object" &&
    (value as { schema?: unknown }).schema !== null
  );
}
