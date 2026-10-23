import type { DatabaseSchema } from "../types/schema";
import type { IStoragePort } from "../ports/storage.port";
import type { ISyncPort } from "../ports/sync.port";
import type { ILockPort } from "../ports/lock.port";
import type { ResolvedEngineConfig } from "./config";
import { IndexedDBStorageAdapter } from "../adapters/storage/idb-adapter";
import { MemoryStorageAdapter } from "../adapters/storage/memory-adapter";
import { BroadcastSyncAdapter } from "../adapters/sync/broadcast-adapter";
import { NoopSyncAdapter } from "../adapters/sync/noop-sync-adapter";
import { WebLocksAdapter } from "../adapters/lock/web-locks-adapter";
import { NoopLockAdapter } from "../adapters/lock/noop-lock-adapter";

export interface AdapterBundle {
  storage: IStoragePort;
  sync: ISyncPort;
  lock: ILockPort;
  fallbackReason: string | null;
}

/**
 * Resolve environment defaults once, keeping environment detection out of Engine orchestration.
 * Injected adapters always take precedence, except cross-tab invalidation is deliberately disabled
 * for the package's process-local MemoryStorageAdapter because its records are not shared.
 */
export function createAdapterBundle(
  schema: DatabaseSchema<any>,
  config: ResolvedEngineConfig,
): AdapterBundle {
  const lock =
    config.adapters.lock ??
    (typeof navigator !== "undefined" && navigator.locks
      ? new WebLocksAdapter()
      : new NoopLockAdapter());

  let sync =
    config.adapters.sync ??
    (config.crossTab.enabled &&
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastSyncAdapter(schema.name)
      : new NoopSyncAdapter());

  let storage: IStoragePort;
  let fallbackReason: string | null = null;

  if (config.adapters.storage) {
    storage = config.adapters.storage;
  } else if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
    storage = new IndexedDBStorageAdapter(schema, lock, sync);
  } else {
    if (config.fallback.strategy === "error") {
      throw new DOMException(
        'IndexedDB is unavailable and fallback.strategy is "error". Provide a storage adapter or permit memory fallback.',
        "NotSupportedError",
      );
    }
    storage = new MemoryStorageAdapter(schema);
    fallbackReason =
      "IndexedDB is unavailable in this environment. Memory storage is volatile and process-local.";
  }

  if (storage instanceof MemoryStorageAdapter) {
    storage.setSchema(schema);
    fallbackReason ??= "MemoryStorageAdapter is volatile and process-local.";
    sync.close();
    sync = new NoopSyncAdapter();
  }

  return { storage, sync, lock, fallbackReason };
}

/** Construct the package's supported in-memory fallback from the composition root. */
export function createMemoryFallbackStorage(schema: DatabaseSchema<any>): IStoragePort {
  return new MemoryStorageAdapter(schema);
}
