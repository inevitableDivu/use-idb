import { useSyncExternalStore, useCallback, useMemo, useEffect, useRef } from "react";
import { useDatabase } from "./context";
import { Engine } from "../core/engine";
import { QueryBuilder } from "../core/query-engine";
import { hashQuery } from "../core/key-serializer";
import type { StoreConfig } from "../types/schema";
import type { LiveQueryOptions } from "../types/query";
import type { QuerySnapshot } from "../core/l1-cache";

/**
 * Result returned by the {@link useLiveQuery} hook.
 *
 * @template T - The query result type (array, single value, or count number).
 */
export interface UseLiveQueryResult<T> {
  /**
   * The current synchronous query results.
   * If unset and `options.initialData` was provided, returns `initialData`.
   */
  data: T | undefined;

  /**
   * `true` during the initial query execution if no `initialData` was provided.
   */
  isLoading: boolean;

  /**
   * `true` whenever an active asynchronous fetch is running in the background.
   */
  isFetching: boolean;

  /**
   * Error caught during query execution, or `null` if healthy.
   */
  error: Error | null;

  /**
   * Triggers an explicit re-fetch of the query against storage.
   */
  refetch: () => Promise<void>;
}

/**
 * Subscribes to an IndexedDB query, multi-store read, or live count query.
 *
 * Automatically re-renders with zero UI tearing via `useSyncExternalStore`
 * only when the tracked key range or store mutates.
 *
 * Adheres to React 19 Concurrent Mode and synchronous Suspense contracts.
 *
 * @template T - The resolved query return type.
 * @param queryFn - Function that returns a {@link QueryBuilder} or Promise of data.
 * @param deps - Dependency array. Changes to dependencies trigger a query re-execution.
 * @param options - Configuration options (`initialData`, `suspense`, `enabled`, `queryKey`).
 * @param customEngine - Optional engine instance override.
 * @returns Object with `data`, `isLoading`, `isFetching`, `error`, and `refetch`.
 */
export function useLiveQuery<T>(
  queryFn: (db: Engine) => QueryBuilder<any, any, any> | Promise<T>,
  deps: unknown[] = [],
  options?: LiveQueryOptions<T>,
  customEngine?: Engine,
): UseLiveQueryResult<T> {
  const defaultEngine = useDatabase();
  const engine = customEngine ?? defaultEngine;
  const enabled = options?.enabled !== false;

  const queryFnRef = useRef(queryFn);
  queryFnRef.current = queryFn;

  const depsHash = useMemo(() => {
    try {
      return JSON.stringify(deps);
    } catch {
      return String(deps.length);
    }
  }, [deps]);

  // Inspect QueryBuilder metadata once per dependency change
  const { queryAst, storeNames } = useMemo(() => {
    try {
      const queryBuilders: QueryBuilder<any, any, any>[] = [];
      const metadataStorage = new Proxy(engine.storage, {
        get(target, property, receiver) {
          if (property === "cursor" || property === "getAll") {
            return async () => [];
          }
          if (property === "get") return async () => undefined;
          if (property === "count") return async () => 0;
          return Reflect.get(target, property, receiver);
        },
      });
      const trackedEngine = new Proxy(engine, {
        get(target, property, receiver) {
          if (property === "query") {
            return (name: string) => {
              const builder = new QueryBuilder<Record<string, unknown>, unknown>(
                metadataStorage,
                name,
                target.middlewarePipeline,
                target.schema.stores[name] as StoreConfig<Record<string, unknown>>,
              );
              queryBuilders.push(builder);
              return builder;
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const result = queryFnRef.current(trackedEngine);
      const builder = result instanceof QueryBuilder ? result : queryBuilders[0];
      if (builder) {
        const names = [...new Set(queryBuilders.map((queryBuilder) => queryBuilder.getAST().storeName))];
        const ast = builder.getAST();
        if (names.length > 1) {
          ast.range = undefined;
          ast.indexName = undefined;
          ast.filterPredicate = undefined;
        }
        return { queryAst: ast, storeNames: names };
      }
    } catch {
      // Handled during fetch execution
    }
    return { queryAst: undefined, storeNames: ["default"] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, depsHash]);

  const queryHash = useMemo(() => {
    if (queryAst) {
      return `query:${hashQuery(queryAst, options?.queryKey)}:${storeNames.join(",")}:${depsHash}`;
    }
    return `custom-query:${options?.queryKey ?? ""}:${depsHash}`;
  }, [queryAst, options?.queryKey, depsHash, storeNames]);

  const entry = useMemo(
    () =>
      engine.l1Cache.getOrCreateEntry<T>(
        queryHash,
        storeNames,
        queryAst?.range,
        queryAst?.indexName,
      ),
    [engine, queryHash, storeNames, queryAst],
  );

  const executeFetch = useCallback((): Promise<T> => {
    if (!enabled) return Promise.resolve(undefined as unknown as T);
    const requestId = engine.l1Cache.markPending(entry, storeNames);

    const promise = (async () => {
      try {
        const result = queryFnRef.current(engine);
        let data: T;
        if (result instanceof QueryBuilder) {
          const ast = result.getAST();
          if (ast.isCount) {
            data = (await result.count()) as unknown as T;
          } else {
            data = (await result.toArray()) as unknown as T;
          }
        } else {
          data = await result;
        }

        engine.l1Cache.resolve(entry, data, requestId);
        return data;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        engine.l1Cache.reject(entry, error, requestId);
        throw error;
      }
    })();

    engine.l1Cache.setPromise(queryHash, promise);
    return promise;
  }, [engine, entry, storeNames, enabled, queryHash]);

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

  const getSnapshot = useCallback((): QuerySnapshot<T> => {
    return entry.snapshot as QuerySnapshot<T>;
  }, [entry]);

  const fallbackServerSnapshot = useMemo((): QuerySnapshot<T> => {
    return Object.freeze({
      data: options?.initialData,
      isLoading: options?.initialData === undefined,
      isFetching: false,
      error: null,
    });
  }, [options?.initialData]);

  const getServerSnapshot = useCallback((): QuerySnapshot<T> => {
    return fallbackServerSnapshot;
  }, [fallbackServerSnapshot]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // REA-02: Synchronous React Suspense Contract
  if (options?.suspense && snapshot.isLoading) {
    let promise = engine.l1Cache.getPromise(queryHash) as Promise<T> | undefined;
    if (!promise) {
      promise = executeFetch();
    }
    throw promise;
  }

  const resolvedData = snapshot.data !== undefined ? snapshot.data : options?.initialData;

  const refetch = useCallback(async () => {
    await executeFetch();
  }, [executeFetch]);

  return {
    data: resolvedData,
    isLoading: snapshot.isLoading,
    isFetching: snapshot.isFetching,
    error: snapshot.error,
    refetch,
  };
}
