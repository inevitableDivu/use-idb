import { useDatabase } from "./context";
import {
  useRecord as useRecordUntyped,
  type UseRecordOptions,
  type UseRecordResult,
} from "./use-record";
import {
  useLiveQuery as useLiveQueryUntyped,
  type UseLiveQueryResult,
} from "./use-live-query";
import {
  useMutation as useMutationUntyped,
} from "./use-mutation";
import { useIDBStatus as useIDBStatusUntyped } from "./use-idb-status";
import type { DatabaseSchema, StoreNames, StoreValue, StoreKey } from "../types/schema";
import type { Engine } from "../core/engine";
import type { QueryBuilder } from "../core/query-engine";
import type { LiveQueryOptions } from "../types/query";
import type { IDBStatusSnapshot } from "../types/status";

/**
 * Creates strongly typed React hooks bound to an inferred database instance.
 *
 * Guarantees compile-time validation of store names, primary keys, and entity value types.
 * Binds directly to the provided {@link Engine} instance or resolves from Context.
 *
 * @template TSchema - Inferred database configuration.
 * @param providedEngine - Database instance. If omitted, consumes Engine from Context.
 * @returns Object containing type-safe `useRecord`, `useLiveQuery`, `useMutation`, and `useIDBStatus` hooks.
 *
 * @example
 * ```typescript
 * import { createDatabaseHooks } from "use-idb";
 * import { db } from "./db";
 *
 * const { useRecord, useLiveQuery } = createDatabaseHooks(db);
 *
 * function UserProfile({ id }: { id: string }) {
 *   // Autocomplete only permits valid store names and keys
 *   const { data: user } = useRecord("users", id);
 *   return <div>{user?.name}</div>;
 * }
 * ```
 */
export function createDatabaseHooks<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  providedEngine?: Engine<TSchema>,
) {
  type Names = StoreNames<TSchema>;
  type Item<K extends Names> = StoreValue<TSchema, K>;
  type Key<K extends Names> = StoreKey<TSchema, K>;

  function useResolvedEngine(): Engine<TSchema> {
    const contextEngine = useDatabase();
    return (providedEngine ?? contextEngine) as Engine<TSchema>;
  }

  return {
    useRecord: <K extends StoreNames<TSchema>>(
      storeName: K,
      key: StoreKey<TSchema, K> | undefined,
      options?: UseRecordOptions<StoreValue<TSchema, K>>,
    ): UseRecordResult<
      StoreValue<TSchema, K> extends object ? StoreValue<TSchema, K> : Record<string, unknown>
    > => {
      const engine = useResolvedEngine();
      return useRecordUntyped<
        StoreValue<TSchema, K> extends object ? StoreValue<TSchema, K> : Record<string, unknown>
      >(
        storeName,
        key as IDBValidKey | undefined,
        options as
          | UseRecordOptions<
              StoreValue<TSchema, K> extends object
                ? StoreValue<TSchema, K>
                : Record<string, unknown>
            >
          | undefined,
        engine,
      );
    },

    useLiveQuery: <T>(
      queryFn: (db: Engine<TSchema>) => QueryBuilder<any, any, any> | Promise<T>,
      deps: unknown[] = [],
      options?: LiveQueryOptions<T>,
    ): UseLiveQueryResult<T> => {
      const engine = useResolvedEngine();
      return useLiveQueryUntyped<T>(
        queryFn as (db: Engine) => QueryBuilder<any, any, any> | Promise<T>,
        deps,
        options,
        engine,
      );
    },

    useMutation: <K extends Names>(storeName: K) => {
      const engine = useResolvedEngine();
      const mutation = useMutationUntyped(engine);
      return {
        ...mutation,
        put: (
          value: Item<K>,
          key?: Key<K>,
          options?: { optimistic?: boolean },
        ): Promise<Key<K>> =>
          mutation.put(storeName, value, key as IDBValidKey | undefined, options) as Promise<Key<K>>,
        bulkPut: (
          items: Array<{ key?: Key<K>; value: Item<K> }>,
          options?: { chunkSize?: number },
        ): Promise<(Key<K> | undefined)[]> =>
          mutation.bulkPut(
            storeName,
            items as Array<{ key?: IDBValidKey; value: Item<K> }>,
            options,
          ) as Promise<(Key<K> | undefined)[]>,
        deleteRecord: (key: Key<K>, options?: { optimistic?: boolean }): Promise<void> =>
          mutation.deleteRecord(storeName, key as IDBValidKey, options),
        remove: (key: Key<K>, options?: { optimistic?: boolean }): Promise<void> =>
          mutation.deleteRecord(storeName, key as IDBValidKey, options),
        clearStore: (): Promise<void> => mutation.clearStore(storeName),
      };
    },

    useIDBStatus: (): IDBStatusSnapshot => {
      const engine = useResolvedEngine();
      return useIDBStatusUntyped(engine);
    },
  };
}
