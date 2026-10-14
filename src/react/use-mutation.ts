import { useState, useCallback } from "react";
import { useDatabase } from "./context";
import type { IStorageTransaction, StorageBatchOp } from "../ports/storage.port";

/**
 * Write primitives and state returned by the {@link useMutation} hook.
 */
export interface UseMutationResult {
  /**
   * Writes a record into an object store via the microtask {@link WriteCoalescer}.
   * Concurrent calls in the same microtask are bundled into a single atomic transaction.
   *
   * @template T - The stored record type.
   * @param storeName - Target object store name.
   * @param value - Record value to store.
   * @param key - Explicit primary key (required if out-of-line keys or keyval store).
   * @param options - Optional configuration (e.g. `optimistic: boolean`).
   * @returns The generated or provided primary key.
   */
  put: <T>(
    storeName: string,
    value: T,
    key?: IDBValidKey,
    options?: { optimistic?: boolean },
  ) => Promise<IDBValidKey>;

  /**
   * High-throughput chunked bulk insert/upsert across an object store.
   *
   * @template T - The stored record type.
   * @param storeName - Target object store name.
   * @param items - Array of `{ key, value }` objects to insert.
   * @param options - Chunking options (`chunkSize`, defaults to 500).
   * @returns Array of resulting primary keys.
   */
  bulkPut: <T>(
    storeName: string,
    items: Array<{ key?: IDBValidKey; value: T }>,
    options?: { chunkSize?: number },
  ) => Promise<(IDBValidKey | undefined)[]>;

  /**
   * Deletes a record by key via the write coalescer with optimistic overlay removal.
   *
   * @param storeName - Target object store name.
   * @param key - Primary key of record to delete.
   * @param options - Optional configuration (e.g. `optimistic: boolean`).
   */
  deleteRecord: (
    storeName: string,
    key: IDBValidKey,
    options?: { optimistic?: boolean },
  ) => Promise<void>;

  /**
   * Truncates and deletes all records in the specified object store.
   *
   * @param storeName - Target object store name to clear.
   */
  clearStore: (storeName: string) => Promise<void>;

  /**
   * Executes an explicit atomic multi-store IndexedDB transaction.
   *
   * @template T - Return type of transaction callback.
   * @param storeNames - Array of stores accessed inside the transaction.
   * @param mode - `"readonly"` or `"readwrite"`.
   * @param fn - Asynchronous transaction execution block receiving a transaction proxy.
   * @returns Value returned from `fn`.
   */
  transaction: <T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ) => Promise<T>;

  /**
   * `true` whenever any mutation initiated by this hook instance is currently processing.
   */
  isPending: boolean;

  /**
   * Error caught during the most recent mutation execution, or `null` if none.
   */
  error: Error | null;
}

/**
 * Mutation hook exposing write primitives backed by the microtask `WriteCoalescer`
 * and explicit multi-store atomic transactions.
 *
 * @returns Object containing `put`, `bulkPut`, `deleteRecord`, `clearStore`, `transaction`, `isPending`, and `error`.
 *
 * @example
 * ```tsx
 * import { useMutation } from "use-idb";
 *
 * function AddUserForm() {
 *   const { put, isPending, error } = useMutation();
 *
 *   const handleSubmit = async (e: React.FormEvent) => {
 *     e.preventDefault();
 *     await put("users", { id: "u_1", name: "Alice" }, "u_1");
 *   };
 *
 *   return (
 *     <form onSubmit={handleSubmit}>
 *       <button type="submit" disabled={isPending}>
 *         {isPending ? "Saving..." : "Add User"}
 *       </button>
 *       {error && <p style={{ color: "red" }}>{error.message}</p>}
 *     </form>
 *   );
 * }
 * ```
 */
export function useMutation(): UseMutationResult {
  const engine = useDatabase();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const put = useCallback(
    async <T>(
      storeName: string,
      value: T,
      key?: IDBValidKey,
      options?: { optimistic?: boolean },
    ): Promise<IDBValidKey> => {
      setIsPending(true);
      setError(null);
      try {
        return await engine.put(storeName, value, key, options);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [engine],
  );

  const bulkPut = useCallback(
    async <T>(
      storeName: string,
      items: Array<{ key?: IDBValidKey; value: T }>,
      options?: { chunkSize?: number },
    ): Promise<(IDBValidKey | undefined)[]> => {
      setIsPending(true);
      setError(null);
      const chunkSize = options?.chunkSize ?? 500;
      const results: (IDBValidKey | undefined)[] = [];

      try {
        for (let i = 0; i < items.length; i += chunkSize) {
          const chunk = items.slice(i, i + chunkSize);
          const ops: StorageBatchOp[] = chunk.map((item) => ({
            type: "put",
            key: item.key,
            value: item.value,
          }));
          const chunkResults = await engine.batch(storeName, ops);
          results.push(...chunkResults);
        }
        return results;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [engine],
  );

  const deleteRecord = useCallback(
    async (
      storeName: string,
      key: IDBValidKey,
      options?: { optimistic?: boolean },
    ): Promise<void> => {
      setIsPending(true);
      setError(null);
      try {
        await engine.delete(storeName, key, options);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [engine],
  );

  const clearStore = useCallback(
    async (storeName: string): Promise<void> => {
      setIsPending(true);
      setError(null);
      try {
        await engine.clear(storeName);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [engine],
  );

  const transaction = useCallback(
    async <T>(
      storeNames: string[],
      mode: "readonly" | "readwrite",
      fn: (tx: IStorageTransaction) => Promise<T>,
    ): Promise<T> => {
      setIsPending(true);
      setError(null);
      try {
        return await engine.transaction(storeNames, mode, fn);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [engine],
  );

  return {
    put,
    bulkPut,
    deleteRecord,
    clearStore,
    transaction,
    isPending,
    error,
  };
}
