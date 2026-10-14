import { useState, useCallback } from "react";
import { useDatabase } from "./context";
import type { IStorageTransaction, StorageBatchOp } from "../ports/storage.port";

export interface UseMutationResult {
  put: <T>(
    storeName: string,
    value: T,
    key?: IDBValidKey,
    options?: { optimistic?: boolean },
  ) => Promise<IDBValidKey>;
  bulkPut: <T>(
    storeName: string,
    items: Array<{ key?: IDBValidKey; value: T }>,
    options?: { chunkSize?: number },
  ) => Promise<(IDBValidKey | undefined)[]>;
  deleteRecord: (
    storeName: string,
    key: IDBValidKey,
    options?: { optimistic?: boolean },
  ) => Promise<void>;
  clearStore: (storeName: string) => Promise<void>;
  transaction: <T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ) => Promise<T>;
  isPending: boolean;
  error: Error | null;
}

/**
 * Mutation hook exposing write primitives backed by the microtask WriteCoalescer
 * and explicit multi-store atomic transactions.
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
