export type ConnectionState =
  | "SSR"
  | "IDLE"
  | "CONNECTING"
  | "OPEN"
  | "UPGRADING"
  | "BLOCKED"
  | "CLOSING_FOR_UPGRADE"
  | "RECONNECTING"
  | "FALLBACK_MEMORY"
  | "ERROR";

export interface StorageQuota {
  usageBytes: number | null;
  quotaBytes: number | null;
  percentUsed: number | null;
  isPersisted: boolean | null;
}

export interface IDBStatusSnapshot {
  connectionState: ConnectionState;
  isFallbackMode: boolean;
  isUpgradeBlocked: boolean;
  requiresReloadForUpgrade: boolean;
  quota: StorageQuota;
  reconnect: () => Promise<void>;
}
