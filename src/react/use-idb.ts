import { useSyncExternalStore, useCallback, useMemo, useEffect } from "react";
import { useDatabase } from "./context";
import { toKeyString } from "../core/key-serializer";
import type { QuerySnapshot } from "../core/l1-cache";

export interface UseIdbOptions<T> {
  defaultValue?: T;
  storeName?: string;
  optimistic?: boolean;
}

export interface UseIdbReturn<T> {
  value: T | undefined;
  setValue: (updater: T | ((prev: T | undefined) => T)) => Promise<void>;
  remove: () => Promise<void>;
  loading: boolean;
  error: Error | null;
}

function isFunctionUpdater<T>(
  updater: T | ((prev: T | undefined) => T),
): updater is (prev: T | undefined) => T {
  return typeof updater === "function";
}

/**
 * High-level, zero-config reactive React hook for IndexedDB key-value storage.
 * Completely tear-free via useSyncExternalStore with synchronous L1 Cache reads.
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
