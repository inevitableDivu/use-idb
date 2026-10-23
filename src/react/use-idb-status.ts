import { useSyncExternalStore, useCallback, useEffect } from "react";
import { useDatabase } from "./context";
import { Engine } from "../core/engine";
import type { IDBStatusSnapshot } from "../types/status";

const SSR_STATUS_SNAPSHOT: IDBStatusSnapshot = Object.freeze({
  connectionState: "SSR",
  isFallbackMode: true,
  fallbackReason: "Status is not available during server rendering.",
  persistentStorageGranted: null,
  isUpgradeBlocked: false,
  requiresReloadForUpgrade: false,
  quota: Object.freeze({
    usageBytes: null,
    quotaBytes: null,
    percentUsed: null,
    isPersisted: null,
  }),
  refreshQuota: async () => ({ usageBytes: null, quotaBytes: null, percentUsed: null, isPersisted: null }),
  reconnect: async () => {},
});

/**
 * Hook exposing operational telemetry and connection lifecycle state for the IndexedDB engine.
 *
 * Provides real-time reactive insight into:
 * - `connectionState`: `"CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "BLOCKED" | "CORRUPTED" | "SSR"`
 * - `isFallbackMode`: Whether running on In-Memory storage (private browsing / unsupported)
 * - `isUpgradeBlocked`: Whether a schema upgrade is blocked by another open tab
 * - `requiresReloadForUpgrade`: Whether another tab upgraded the schema and this tab must reload
 * - `quota`: Storage usage, quota limit, percentage used, and persistence grant status
 * - `reconnect`: Explicit recovery method to close and reopen the database connection
 *
 * @param customEngine - Optional custom {@link Engine} instance. If omitted, consumes context engine.
 * @returns Synchronous referentially stable {@link IDBStatusSnapshot}.
 */
export function useIDBStatus(customEngine?: Engine): IDBStatusSnapshot {
  const defaultEngine = useDatabase();
  const engine = customEngine ?? defaultEngine;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return engine.onStatusChange(onStoreChange);
    },
    [engine],
  );

  const getSnapshot = useCallback((): IDBStatusSnapshot => {
    return engine.getStatus();
  }, [engine]);

  const getServerSnapshot = useCallback((): IDBStatusSnapshot => {
    return SSR_STATUS_SNAPSHOT;
  }, []);

  // Refresh asynchronously after hydration so quota/persistence telemetry is useful
  // on first use without making rendering wait for browser storage APIs.
  useEffect(() => {
    void engine.refreshQuota().catch(() => {});
  }, [engine]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
