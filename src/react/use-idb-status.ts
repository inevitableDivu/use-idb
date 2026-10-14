import { useSyncExternalStore, useCallback } from "react";
import { useDatabase } from "./context";
import { Engine } from "../core/engine";
import type { IDBStatusSnapshot } from "../types/status";

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
 *
 * @example
 * ```tsx
 * import { useIDBStatus } from "use-idb";
 *
 * function StorageIndicator() {
 *   const { connectionState, quota, isUpgradeBlocked, reconnect } = useIDBStatus();
 *
 *   if (isUpgradeBlocked) {
 *     return <div className="alert">Database upgrade blocked by another tab. Please close other tabs.</div>;
 *   }
 *
 *   return (
 *     <div>
 *       <span>Status: {connectionState}</span>
 *       {quota.percentUsed !== null && <span>Used: {quota.percentUsed.toFixed(1)}%</span>}
 *       {connectionState === "CLOSED" && <button onClick={() => reconnect()}>Reconnect</button>}
 *     </div>
 *   );
 * }
 * ```
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
    return {
      connectionState: "SSR",
      isFallbackMode: true,
      isUpgradeBlocked: false,
      requiresReloadForUpgrade: false,
      quota: {
        usageBytes: null,
        quotaBytes: null,
        percentUsed: null,
        isPersisted: null,
      },
      reconnect: async () => {},
    };
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
