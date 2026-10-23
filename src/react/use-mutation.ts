import { useState, useCallback, useRef } from "react";
import { useDatabase } from "./context";
import type { IStorageTransaction, StorageBatchOp } from "../ports/storage.port";
import type { Engine } from "../core/engine";

/**
 * Result returned by the {@link useMutation} hook.
 */
export interface UseMutationResult {
  /**
   * Puts a record into an object store.
   *
   * @param storeName - Target object store name.
   * @param value - Record value to store.
   * @param key - Out-of-line primary key (optional if store uses inline keyPath).
   * @param options - Cache and optimistic options.
   * @returns Promise resolving to the primary key.
   */
  put<T>(
    storeName: string,
    value: T,
    key?: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<IDBValidKey>;

  /**
   * Writes an array of records in batched chunks.
   *
   * @param storeName - Target object store name.
   * @param items - Records to insert or update.
   * @param options - Chunk size options.
   * @returns Array of resulting primary keys.
   */
  bulkPut<T>(
    storeName: string,
    items: Array<{ key?: IDBValidKey; value: T }>,
    options?: { chunkSize?: number },
  ): Promise<(IDBValidKey | undefined)[]>;

  /**
   * Removes a record from an object store by primary key.
   *
   * @param storeName - Target object store name.
   * @param key - Primary key of record to delete.
   * @param options - Optimistic options.
   */
  deleteRecord(
    storeName: string,
    key: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<void>;

  /**
   * Deletes all records in an object store.
   *
   * @param storeName - Target object store name.
   */
  clearStore(storeName: string): Promise<void>;

  /**
   * Executes an explicit atomic transaction across multiple stores.
   *
   * @param storeNames - Array of store names involved in the transaction.
   * @param mode - `"readonly"` or `"readwrite"`.
   * @param fn - Asynchronous transaction work.
   */
  transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T>;

  /**
   * `true` whenever one or more mutations are actively executing in flight.
   */
  isPending: boolean;

  /**
   * Most recent mutation error, or `null` if healthy.
   */
  error: Error | null;
}

/**
 * React hook providing imperative mutation primitives for writing, deleting,
 * and bulk importing records into IndexedDB.
 *
 * Implements concurrency-safe `isPending` state via an active mutation counter ref,
 * preventing premature pending resets during overlapping concurrent writes.
 *
 * @param customEngine - Optional engine instance override.
 * @returns Interface containing mutation methods and pending/error states.
 */
export function useMutation(customEngine?: Engine): UseMutationResult {
  const defaultEngine = useDatabase();
  const engine = customEngine ?? defaultEngine;

  const activeMutationsRef = useRef(0);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const put = useCallback(
    async <T>(
      storeName: string,
      value: T,
      key?: IDBValidKey,
      options?: { optimistic?: boolean },
    ): Promise<IDBValidKey> => {
      activeMutationsRef.current++;
      setIsPending(true);
      setError(null);
      try {
        return await engine.put(storeName, value, key, options);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
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
      activeMutationsRef.current++;
      setIsPending(true);
      setError(null);
      const chunkSize = options?.chunkSize ?? 500;
      if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
        throw new RangeError("bulkPut chunkSize must be a positive safe integer");
      }
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
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
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
      activeMutationsRef.current++;
      setIsPending(true);
      setError(null);
      try {
        await engine.delete(storeName, key, options);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
      }
    },
    [engine],
  );

  const clearStore = useCallback(
    async (storeName: string): Promise<void> => {
      activeMutationsRef.current++;
      setIsPending(true);
      setError(null);
      try {
        await engine.clear(storeName);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
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
      activeMutationsRef.current++;
      setIsPending(true);
      setError(null);
      try {
        return await engine.transaction(storeNames, mode, fn);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
        setIsPending(activeMutationsRef.current > 0);
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
