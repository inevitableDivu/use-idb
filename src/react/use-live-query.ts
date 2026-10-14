import { useSyncExternalStore, useCallback, useMemo, useEffect } from "react";
import { useDatabase } from "./context";
import { Engine } from "../core/engine";
import { QueryBuilder } from "../core/query-engine";
import { hashQuery } from "../core/key-serializer";
import type { LiveQueryOptions } from "../types/query";
import type { QuerySnapshot } from "../core/l1-cache";

export interface UseLiveQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Subscribes to an arbitrary IndexedDB query or multi-store read.
 * Automatically re-renders with zero UI tearing via useSyncExternalStore
 * only when the tracked key range or store mutates.
 */
export function useLiveQuery<T>(
  queryFn: (db: Engine) => QueryBuilder<T> | Promise<T>,
  deps: unknown[] = [],
  options?: LiveQueryOptions<T>,
): UseLiveQueryResult<T> {
  const engine = useDatabase();
  const enabled = options?.enabled !== false;

  const depsHash = useMemo(() => {
    try {
      return JSON.stringify(deps);
    } catch {
      return String(deps.length);
    }
  }, [deps]);

  // Execute queryFn once to inspect if it returns a QueryBuilder with an AST
  const { queryAst, storeName } = useMemo(() => {
    try {
      const result = queryFn(engine);
      if (result instanceof QueryBuilder) {
        const ast = result.getAST();
        return { queryAst: ast, storeName: ast.storeName };
      }
    } catch {
      // Ignore
    }
    return { queryAst: undefined, storeName: "default" };
  }, [engine, queryFn]);

  const queryHash = useMemo(() => {
    if (queryAst) {
      return `query:${hashQuery(queryAst)}:${depsHash}`;
    }
    return `custom-query:${depsHash}`;
  }, [queryAst, depsHash]);

  const entry = useMemo(
    () =>
      engine.l1Cache.getOrCreateEntry<T>(
        queryHash,
        [storeName],
        queryAst?.range,
        queryAst?.indexName,
      ),
    [engine, queryHash, storeName, queryAst],
  );

  const executeFetch = useCallback(async () => {
    if (!enabled) return;
    engine.l1Cache.markPending(entry, [storeName]);

    const promise = (async () => {
      try {
        const result = queryFn(engine);
        const data =
          result instanceof QueryBuilder
            ? ((await result.toArray()) as unknown as T)
            : await result;
        engine.l1Cache.resolve(entry, data);
        return data;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        engine.l1Cache.reject(entry, error);
        throw error;
      }
    })();

    engine.l1Cache.setPromise(queryHash, promise);
    try {
      await promise;
    } catch {
      // Handled in promise
    }
  }, [engine, entry, queryFn, storeName, enabled, queryHash]);

  useEffect(() => {
    if (entry.status === "idle" && enabled) {
      executeFetch().catch(() => {});
    }
  }, [entry.status, enabled, executeFetch]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = engine.l1Cache.subscribe(queryHash, onStoreChange, executeFetch);
      if (entry.status === "idle" && enabled) {
        executeFetch().catch(() => {});
      }
      return unsubscribe;
    },
    [engine, queryHash, entry.status, enabled, executeFetch],
  );

  const getSnapshot = useCallback(() => {
    return entry.snapshot as QuerySnapshot<T>;
  }, [entry]);

  const getServerSnapshot = useCallback((): QuerySnapshot<T> => {
    return Object.freeze({
      data: options?.initialData,
      isLoading: !options?.initialData,
      isFetching: false,
      error: null,
    });
  }, [options?.initialData]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // React Suspense support
  const suspensePromise = options?.suspense ? engine.l1Cache.getPromise(queryHash) : undefined;
  if (options?.suspense && snapshot.isLoading && suspensePromise) {
    throw suspensePromise;
  }

  const resolvedData = snapshot.data !== undefined ? snapshot.data : options?.initialData;

  return {
    data: resolvedData,
    isLoading: snapshot.isLoading,
    isFetching: snapshot.isFetching,
    error: snapshot.error,
    refetch: executeFetch,
  };
}
