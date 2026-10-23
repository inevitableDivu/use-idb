import { useSyncExternalStore, useCallback, useMemo, useEffect } from "react";
import { useDatabase } from "./context";
import { toKeyString } from "../core/key-serializer";
import type { QuerySnapshot } from "../core/l1-cache";
import type { Engine } from "../core/engine";

const patchQueues = new WeakMap<Engine, Map<string, Promise<unknown>>>();

const STATIC_IDLE_SNAPSHOT: QuerySnapshot<any> = Object.freeze({
  data: undefined,
  isLoading: false,
  isFetching: false,
  error: null,
});

/**
 * Options for the {@link useRecord} hook.
 *
 * @template T - The entity record type.
 */
export interface UseRecordOptions<T> {
  /**
   * Initial fallback value while reading from storage or if the record does not exist.
   */
  defaultValue?: T;

  /**
   * Whether to optimistically update the synchronous L1 cache before the write transaction commits.
   *
   * @default true
   */
  optimistic?: boolean;
}

/**
 * Result returned by the {@link useRecord} hook.
 *
 * @template T - The entity record type.
 */
export interface UseRecordResult<T> {
  /**
   * The current synchronous record value.
   */
  data: T | undefined;

  /**
   * `true` during the initial read if no `defaultValue` was provided.
   */
  isLoading: boolean;

  /**
   * `true` whenever an active asynchronous read is in flight.
   */
  isFetching: boolean;

  /**
   * Error encountered during read or write operations, or `null` if healthy.
   */
  error: Error | null;

  /**
   * Completely replaces the record in the store.
   *
   * @param val - The complete new record value.
   */
  set: (val: T) => Promise<void>;

  /**
   * Performs a partial shallow patch of the record, merging fields into existing record.
   *
   * @param patch - Partial fields to update on the record.
   */
  patch: (patch: Partial<T>) => Promise<void>;

  /**
   * Removes the record from the object store.
   */
  remove: () => Promise<void>;
}

/**
 * React hook for reading, writing, and optimistically subscribing to a single record
 * by primary key in an IndexedDB object store.
 *
 * Backed by synchronous L1 memory cache and `useSyncExternalStore` for React 19 Concurrent Mode safety.
 *
 * @template T - Entity record type.
 * @param storeName - Target object store name.
 * @param key - Record primary key (`string`, `number`, `Date`, etc.). If `undefined`, hook stays idle.
 * @param options - Cache and fallback behavior options.
 * @param customEngine - Optional engine instance override.
 * @returns Synchronous {@link UseRecordResult} interface.
 */
export function useRecord<T extends object = Record<string, unknown>>(
  storeName: string,
  key: IDBValidKey | undefined,
  options?: UseRecordOptions<T>,
  customEngine?: Engine,
): UseRecordResult<T> {
  const defaultEngine = useDatabase();
  const engine = customEngine ?? defaultEngine;
  const optimistic = options?.optimistic ?? true;
  const isKeyDefined = key !== undefined;
  const keyStr = isKeyDefined ? toKeyString(key) : "__undefined__";
  const queryHash = `record:${storeName}:${keyStr}`;

  const entry = useMemo(
    () => (isKeyDefined ? engine.l1Cache.getOrCreateEntry<T>(queryHash, [storeName], key) : null),
    [engine, queryHash, storeName, key, isKeyDefined],
  );

  const defaultValue = options?.defaultValue;
  const defaultFallbackSnapshot = useMemo((): QuerySnapshot<T> => {
    if (defaultValue === undefined) return STATIC_IDLE_SNAPSHOT;
    return Object.freeze({
      data: defaultValue,
      isLoading: false,
      isFetching: false,
      error: null,
    });
  }, [defaultValue]);

  const fetchRecord = useCallback(
    (force = false) => {
      if (!entry || !isKeyDefined) return;
      if (force || entry.status === "idle") {
        const requestId = engine.l1Cache.markPending(entry, [storeName]);
        engine
          .get(storeName, key)
          .then((val) => {
            engine.l1Cache.resolve(entry, val as T | undefined, requestId);
          })
          .catch((err) => {
            engine.l1Cache.reject(
              entry,
              err instanceof Error ? err : new Error(String(err)),
              requestId,
            );
          });
      }
    },
    [engine, entry, storeName, key, isKeyDefined],
  );

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  const fetcher = useCallback(async () => {
    fetchRecord(true);
  }, [fetchRecord]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!isKeyDefined) return () => {};
      const unsubscribe = engine.l1Cache.subscribe(queryHash, onStoreChange, fetcher);
      fetchRecord();
      return unsubscribe;
    },
    [engine, queryHash, isKeyDefined, fetchRecord, fetcher],
  );

  const getSnapshot = useCallback((): QuerySnapshot<T> => {
    if (!entry) {
      return defaultFallbackSnapshot;
    }
    return entry.snapshot as QuerySnapshot<T>;
  }, [entry, defaultFallbackSnapshot]);

  const getServerSnapshot = useCallback((): QuerySnapshot<T> => {
    return defaultFallbackSnapshot;
  }, [defaultFallbackSnapshot]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const set = useCallback(
    async (val: T) => {
      if (!isKeyDefined) throw new Error("Cannot set record with undefined key");
      const keyPath = engine.schema.stores[storeName]?.keyPath;
      if (keyPath !== undefined && val !== null && typeof val === "object") {
        const paths = typeof keyPath === "string" ? [keyPath] : keyPath;
        const parts = paths.map((path) => {
          let current: unknown = val;
          for (const segment of path.split(".")) {
            if (current === null || typeof current !== "object") return undefined;
            current = (current as Record<string, unknown>)[segment];
          }
          return current;
        });
        const inlineKey = Array.isArray(keyPath) ? parts : parts[0];
        if (inlineKey !== undefined && toKeyString(inlineKey) !== toKeyString(key)) {
          throw new Error("Record inline key does not match the key tracked by useRecord");
        }
      }
      await engine.put(storeName, val, key, { optimistic });
    },
    [engine, storeName, key, isKeyDefined, optimistic],
  );

  const patch = useCallback(
    async (partialVal: Partial<T>) => {
      if (!isKeyDefined) throw new Error("Cannot patch record with undefined key");
      // Serialize patches for this engine/store/key so concurrent shallow merges do not
      // overwrite fields from one another. Read persisted state inside the queue, not a
      // potentially stale render snapshot.
      const queueKey = `${storeName}:${toKeyString(key)}`;
      let queues = patchQueues.get(engine);
      if (!queues) {
        queues = new Map();
        patchQueues.set(engine, queues);
      }
      const previous = queues.get(queueKey) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const current = (await engine.get(storeName, key)) as T | undefined;
        const next = { ...(current ?? {}), ...partialVal } as T;
        await engine.put(storeName, next, key, { optimistic });
      });
      queues.set(queueKey, operation);
      try {
        await operation;
      } finally {
        if (queues.get(queueKey) === operation) queues.delete(queueKey);
      }
    },
    [engine, storeName, key, isKeyDefined, optimistic],
  );

  const remove = useCallback(async () => {
    if (!isKeyDefined) throw new Error("Cannot remove record with undefined key");
    await engine.delete(storeName, key, { optimistic });
  }, [engine, storeName, key, isKeyDefined, optimistic]);

  const resolvedData = snapshot.data !== undefined ? snapshot.data : defaultValue;
  const isLoading = defaultValue !== undefined ? false : snapshot.isLoading;

  return {
    data: resolvedData,
    isLoading,
    isFetching: snapshot.isFetching,
    error: snapshot.error,
    set,
    patch,
    remove,
  };
}
