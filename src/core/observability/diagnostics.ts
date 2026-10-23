/** Diagnostics intentionally omit record values and primary keys to avoid leaking application data. */
export type DatabaseDiagnosticEvent =
  | {
      type: "storage-opened";
      databaseName: string;
      adapter: string;
      timestamp: number;
    }
  | {
      type: "storage-fallback";
      databaseName: string;
      from: string;
      to: string;
      reason: string;
      timestamp: number;
    }
  | {
      type: "mutation-committed";
      databaseName: string;
      storeName: string;
      operation: string;
      affectedRecordCount: number;
      timestamp: number;
    }
  | {
      type: "transaction-committed";
      databaseName: string;
      storeNames: readonly string[];
      timestamp: number;
    }
  | {
      type: "storage-quota-refreshed";
      databaseName: string;
      usageBytes: number | null;
      quotaBytes: number | null;
      isPersisted: boolean | null;
      timestamp: number;
    }
  | {
      type: "engine-destroyed";
      databaseName: string;
      timestamp: number;
    };

export interface DatabaseDiagnosticsConfig {
  /**
   * Receives best-effort lifecycle and mutation events. Exceptions from this callback are swallowed
   * so logging/telemetry cannot break persistence operations.
   */
  onEvent?: (event: DatabaseDiagnosticEvent) => void;
  /**
   * Receives operation errors with a short context label. Exceptions are swallowed.
   */
  onError?: (error: unknown, context: { databaseName: string; operation: string }) => void;
}

export function reportDiagnostic(
  diagnostics: DatabaseDiagnosticsConfig | undefined,
  event: DatabaseDiagnosticEvent,
): void {
  try {
    diagnostics?.onEvent?.(event);
  } catch {
    // Observability must never alter application or persistence semantics.
  }
}

export function reportDiagnosticError(
  diagnostics: DatabaseDiagnosticsConfig | undefined,
  error: unknown,
  context: { databaseName: string; operation: string },
): void {
  try {
    diagnostics?.onError?.(error, context);
  } catch {
    // Error reporting is also best-effort.
  }
}
