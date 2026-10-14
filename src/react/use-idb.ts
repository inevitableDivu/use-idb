import { useSyncExternalStore, useCallback, useMemo, useEffect } from "react";
import { useDatabase } from "./context";
import { toKeyString } from "../core/key-serializer";
import type { QuerySnapshot } from "../core/l1-cache";

/**
 * Configuration options for the {@link useIdb} hook.
 *
 * @template T - The stored value type.
 */
export interface UseIdbOptions<T> {
  /**
   * The initial fallback value returned while the asynchronous IndexedDB read is resolving,
   * or if the key does not yet exist in storage.
   */
  defaultValue?: T;

  /**
   * Target object store name within the database.
   * Defaults to `"keyval"`.
   */
  storeName?: string;

  /**
   * Whether to apply changes optimistically to the synchronous L1 cache before the
   * underlying IndexedDB transaction commits to disk.
   *
   * @default true
   */
  optimistic?: boolean;
}

/**
 * Return signature of the {@link useIdb} hook.
 *
 * @template T - The stored value type.
 */
export interface UseIdbReturn<T> {
  /**
   * The current synchronous value resolved from the L1 cache or IndexedDB.
   * If unset and `defaultValue` was provided, returns `defaultValue`.
   */
  value: T | undefined;

  /**
   * Updates or sets the stored value for the tracked key.
   * Supports both direct values and functional updater callbacks `(prev) => next`.
   *
   * @param updater - New value or functional transformation receiving current value.
   * @returns Promise that resolves once the write has been batched and committed.
   *
   * @example
   * ```tsx
   * // Direct value:
   * await setValue("dark");
   *
   * // Functional update:
   * await setValue((prev) => (prev === "dark" ? "light" : "dark"));
   * ```
   */
  setValue: (updater: T | ((prev: T | undefined) => T)) => Promise<void>;

  /**
   * Deletes the record associated with this key from IndexedDB and the L1 cache.
   *
   * @returns Promise that resolves once the deletion has committed.
   */
  remove: () => Promise<void>;

  /**
   * `true` during the initial read if no `defaultValue` was provided.
   */
  loading: boolean;

  /**
   * Contains any Error thrown during read or write operations, or `null` if healthy.
   */
  error: Error | null;
}

function isFunctionUpdater<T>(
  updater: T | ((prev: T | undefined) => T),
): updater is (prev: T | undefined) => T {
  return typeof updater === "function";
}

/**
 * Zero-config reactive React hook for IndexedDB key-value storage.
 *
 * Powered by `useSyncExternalStore` for tear-free rendering with synchronous L1 Cache reads,
 * microtask write coalescing, and optimistic updates.
 *
 * If used outside an `<IndexedDBProvider>`, automatically binds to a shared default database (`__use_idb_default__`).
 *
 * @template T - The stored value type.
 * @param key - The unique string key for the record.
 * @param options - Optional configuration including `defaultValue`, `storeName`, and `optimistic`.
 * @returns Object containing `value`, `setValue`, `remove`, `loading`, and `error`.
 *
 * @example
 * ```tsx
 * import { useIdb } from "use-idb";
 *
 * function ThemeSelector() {
 *   const { value: theme, setValue } = useIdb("theme", { defaultValue: "light" });
 *
 *   return (
 *     <button onClick={() => setValue((prev) => (prev === "light" ? "dark" : "light"))}>
 *       Current Theme: {theme}
 *     </button>
 *   );
 * }
 * ```
 */
export function useIdb<T>(key: string, options?: UseIdbOptions<T>): UseIdbReturn<T> {
  const engine = useDatabase();
  const storeName = options?.storeName ?? "keyval";
  const queryHash = `record:${storeName}:${toKeyString(key)}`;

  const entry = useMemo(
    () => engine.l1Cache.getOrCreateEntry<T>(queryHash, [storeName], key),
    [engine, queryHash, storeName, key],
  );

  const fetchRecord = useCallback(() => {
    if (entry.status === "idle") {
      engine.l1Cache.markPending(entry, [storeName]);
      engine
        .get<T>(storeName, key)
        .then((val) => {
          engine.l1Cache.resolve(entry, val);
        })
        .catch((err) => {
          engine.l1Cache.reject(entry, err instanceof Error ? err : new Error(String(err)));
        });
    }
  }, [engine, entry, storeName, key]);

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  const fetcher = useCallback(async () => {
    fetchRecord();
  }, [fetchRecord]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = engine.l1Cache.subscribe(queryHash, onStoreChange, fetcher);
      fetchRecord();
      return unsubscribe;
    },
    [engine, queryHash, fetchRecord, fetcher],
  );

  const getSnapshot = useCallback(() => {
    return entry.snapshot as QuerySnapshot<T>;
  }, [entry]);

  const getServerSnapshot = useCallback((): QuerySnapshot<T> => {
    return Object.freeze({
      data: options?.defaultValue,
      isLoading: false,
      isFetching: false,
      error: null,
    });
  }, [options?.defaultValue]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    async (updater: T | ((prev: T | undefined) => T)) => {
      const currentVal = snapshot.data !== undefined ? snapshot.data : options?.defaultValue;
      const nextVal = isFunctionUpdater(updater) ? updater(currentVal) : updater;
      await engine.put(storeName, nextVal, key, {
        optimistic: options?.optimistic ?? true,
      });
    },
    [engine, storeName, key, snapshot.data, options?.defaultValue, options?.optimistic],
  );

  const remove = useCallback(async () => {
    await engine.delete(storeName, key, {
      optimistic: options?.optimistic ?? true,
    });
  }, [engine, storeName, key, options?.optimistic]);

  const resolvedValue = snapshot.data !== undefined ? snapshot.data : options?.defaultValue;
  const isInitialLoading = snapshot.isLoading && options?.defaultValue === undefined;

  return {
    value: resolvedValue,
    setValue,
    remove,
    loading: isInitialLoading,
    error: snapshot.error,
  };
}
