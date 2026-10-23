/**
 * Connection lifecycle states of the underlying IndexedDB storage adapter.
 */
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
  | "ERROR"
  | "QUOTA_EXCEEDED";

/**
 * Storage quota telemetry retrieved from `navigator.storage.estimate()`.
 */
export interface StorageQuota {
  /**
   * Approximate number of bytes used by the current origin across storage.
   */
  usageBytes: number | null;

  /**
   * Approximate total storage quota granted to this origin in bytes.
   */
  quotaBytes: number | null;

  /**
   * Percentage of quota currently used (from 0 to 100), or `null` if unsupported.
   */
  percentUsed: number | null;

  /**
   * Whether the browser has granted persistent storage permission preventing eviction under storage pressure.
   */
  isPersisted: boolean | null;
}

/**
 * Telemetry snapshot representing the engine's active operational status.
 */
export interface IDBStatusSnapshot {
  /**
   * Current connection lifecycle state.
   */
  connectionState: ConnectionState;

  /**
   * `true` if operating on the In-Memory storage adapter fallback (e.g. private browsing).
   */
  isFallbackMode: boolean;
  /** Why the engine selected in-memory storage, or null when IndexedDB is active. */
  fallbackReason: string | null;

  /** Whether a persistent-storage request was explicitly made and its result, or null when not requested/unsupported. */
  persistentStorageGranted: boolean | null;

  /**
   * `true` if a schema upgrade is blocked by another tab keeping an older database connection open.
   */
  isUpgradeBlocked: boolean;

  /**
   * `true` if another tab upgraded the database version and this tab closed its connection and should reload.
   */
  requiresReloadForUpgrade: boolean;

  /**
   * Current storage quota metrics.
   */
  quota: StorageQuota;

  /**
   * Re-estimate quota and refresh the current persistence grant state.
   */
  refreshQuota: () => Promise<StorageQuota>;

  /**
   * Method to close and re-establish the selected storage connection.
   */
  reconnect: () => Promise<void>;
}
