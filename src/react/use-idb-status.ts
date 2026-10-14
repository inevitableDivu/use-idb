import { useSyncExternalStore, useCallback } from "react";
import { useDatabase } from "./context";
import { Engine } from "../core/engine";
import type { IDBStatusSnapshot } from "../types/status";

/**
 * Exposes operational telemetry for the IndexedDB engine:
 * connection lifecycle states, quota usage, upgrade locks, and reconnect actions.
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
