import { useSyncExternalStore, useCallback, useMemo, useEffect } from "react";
import { useDatabase } from "./context";
import { toKeyString } from "../core/key-serializer";
import type { QuerySnapshot } from "../core/l1-cache";

export interface UseRecordOptions<T> {
  defaultValue?: T;
  optimistic?: boolean;
}

export interface UseRecordResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  set: (val: T) => Promise<void>;
  patch: (partial: Partial<T>) => Promise<void>;
  remove: () => Promise<void>;
}

/**
 * Ergonomic hook for watching and mutating a single record by primary key
 * with built-in optimistic updates and zero UI tearing.
 */
export function useRecord<T = unknown>(
  storeName: string,
  key: IDBValidKey | undefined,
  options?: UseRecordOptions<T>,
): UseRecordResult<T> {
  const engine = useDatabase();
  const optimistic = options?.optimistic ?? true;
  const isKeyDefined = key !== undefined;
  const keyStr = isKeyDefined ? toKeyString(key) : "__undefined__";
  const queryHash = `record:${storeName}:${keyStr}`;

  const entry = useMemo(
    () => (isKeyDefined ? engine.l1Cache.getOrCreateEntry<T>(queryHash, [storeName], key) : null),
    [engine, queryHash, storeName, key, isKeyDefined],
  );

  const fetchRecord = useCallback(() => {
    if (!entry || !isKeyDefined) return;
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
  }, [engine, entry, storeName, key, isKeyDefined]);

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  const fetcher = useCallback(async () => {
    fetchRecord();
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
      return Object.freeze({
        data: options?.defaultValue,
        isLoading: false,
        isFetching: false,
        error: null,
      });
    }
    return entry.snapshot as QuerySnapshot<T>;
  }, [entry, options?.defaultValue]);

  const getServerSnapshot = useCallback((): QuerySnapshot<T> => {
    return Object.freeze({
      data: options?.defaultValue,
      isLoading: false,
      isFetching: false,
      error: null,
    });
  }, [options?.defaultValue]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const set = useCallback(
    async (val: T) => {
      if (!isKeyDefined) throw new Error("Cannot set record with undefined key");
      await engine.put(storeName, val, key, { optimistic });
    },
    [engine, storeName, key, isKeyDefined, optimistic],
  );

  const patch = useCallback(
    async (partial: Partial<T>) => {
      if (!isKeyDefined) throw new Error("Cannot patch record with undefined key");
      const current = snapshot.data !== undefined ? snapshot.data : options?.defaultValue;
      const merged =
        typeof current === "object" && current !== null
          ? { ...current, ...partial }
          : (partial as unknown as T);
      await engine.put(storeName, merged, key, { optimistic });
    },
    [engine, storeName, key, isKeyDefined, snapshot.data, options?.defaultValue, optimistic],
  );

  const remove = useCallback(async () => {
    if (!isKeyDefined) return;
    await engine.delete(storeName, key, { optimistic });
  }, [engine, storeName, key, isKeyDefined, optimistic]);

  const resolvedData = snapshot.data !== undefined ? snapshot.data : options?.defaultValue;

  return {
    data: resolvedData,
    isLoading: snapshot.isLoading,
    isFetching: snapshot.isFetching,
    error: snapshot.error,
    set,
    patch,
    remove,
  };
}
