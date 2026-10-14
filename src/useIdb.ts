import { useState, useCallback } from "react";
import type { UseIdbOptions, UseIdbReturn } from "./types";

function isFunctionUpdater<T>(
  updater: T | ((prev: T | undefined) => T),
): updater is (prev: T | undefined) => T {
  return typeof updater === "function";
}

/**
 * Minimal initial hook stub for useIdb.
 * Full IndexedDB operations and synchronization will be implemented in Step 3.
 */
export function useIdb<T>(_key: string, options?: UseIdbOptions<T>): UseIdbReturn<T> {
  const [value, setVal] = useState<T | undefined>(options?.defaultValue);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const setValue = useCallback(async (updater: T | ((prev: T | undefined) => T)) => {
    setLoading(true);
    try {
      setVal((prev) => (isFunctionUpdater(updater) ? updater(prev) : updater));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    value,
    setValue,
    loading,
    error,
  };
}
