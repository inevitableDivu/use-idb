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
  type UseMutationResult,
} from "./use-mutation";
import { useIDBStatus as useIDBStatusUntyped } from "./use-idb-status";
import type { DatabaseSchema, StoreNames, StoreValue, StoreKey } from "../types/schema";
import type { Engine } from "../core/engine";
import type { QueryBuilder } from "../core/query-engine";
import type { LiveQueryOptions } from "../types/query";
import type { IDBStatusSnapshot } from "../types/status";

/**
 * Creates strongly typed React hooks bound to a specific {@link DatabaseSchema}.
 *
 * Guarantees compile-time validation of store names, primary keys, and entity value types.
 * Binds directly to the provided {@link Engine} instance or resolves from Context.
 *
 * @template TSchema - Strongly typed database schema definition.
 * @param providedEngine - Optional Engine instance. If omitted, consumes Engine from Context.
 * @returns Object containing type-safe `useRecord`, `useLiveQuery`, `useMutation`, and `useIDBStatus` hooks.
 *
 * @example
 * ```typescript
 * import { createDatabaseHooks } from "use-idb";
 * import type { AppSchema } from "./schema";
 *
 * const { useRecord, useLiveQuery } = createDatabaseHooks<AppSchema>();
 *
 * function UserProfile({ id }: { id: string }) {
 *   // Autocomplete only permits valid store names and keys
 *   const { data: user } = useRecord("users", id);
 *   return <div>{user?.name}</div>;
 * }
 * ```
 */
export function createDatabaseHooks<TSchema extends DatabaseSchema<any>>(
  providedEngine?: Engine<TSchema>,
) {
  function useResolvedEngine(): Engine<TSchema> {
    const contextEngine = useDatabase();
    return (providedEngine ?? contextEngine) as Engine<TSchema>;
  }

  return {
    useRecord: <K extends StoreNames<TSchema>>(
      storeName: K,
      key: StoreKey<TSchema, K> | undefined,
      options?: UseRecordOptions<StoreValue<TSchema, K>>,
    ): UseRecordResult<StoreValue<TSchema, K>> => {
      const engine = useResolvedEngine();
      return useRecordUntyped<StoreValue<TSchema, K>>(
        storeName,
        key as IDBValidKey | undefined,
        options,
        engine,
      );
    },

    useLiveQuery: <T>(
      queryFn: (db: Engine<TSchema>) => QueryBuilder<T> | Promise<T>,
      deps: unknown[] = [],
      options?: LiveQueryOptions<T>,
    ): UseLiveQueryResult<T> => {
      const engine = useResolvedEngine();
      return useLiveQueryUntyped<T>(
        queryFn as (db: Engine) => QueryBuilder<T> | Promise<T>,
        deps,
        options,
        engine,
      );
    },

    useMutation: (): UseMutationResult => {
      const engine = useResolvedEngine();
      return useMutationUntyped(engine);
    },

    useIDBStatus: (): IDBStatusSnapshot => {
      const engine = useResolvedEngine();
      return useIDBStatusUntyped(engine);
    },
  };
}
