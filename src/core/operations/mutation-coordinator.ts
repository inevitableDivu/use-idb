import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";
import type { L1Cache } from "../l1-cache";
import type { DependencyTracker } from "../dependency-tracker";
import type { DatabaseDiagnosticsConfig } from "../observability/diagnostics";
import { reportDiagnostic } from "../observability/diagnostics";

export interface CommittedStoreMutation {
  storeName: string;
  operation: MutationEnvelope["operation"];
  affectedKeys?: IDBValidKey[];
  /** When true, key-specific record snapshots have already been committed by the caller. */
  preserveRecordSnapshots?: boolean;
}

/**
 * The single post-commit path for cache generations, query invalidation, and cross-tab hints.
 *
 * This class never writes to storage and is called only after the storage adapter confirms a
 * commit. Notifications are best-effort and can never change the outcome of a committed write.
 */
export class MutationCoordinator {
  constructor(
    private readonly databaseName: string,
    private readonly cache: L1Cache,
    private readonly dependencies: DependencyTracker,
    private syncPort: ISyncPort,
    private readonly diagnostics?: DatabaseDiagnosticsConfig,
  ) {}

  setSyncPort(syncPort: ISyncPort): void {
    this.syncPort = syncPort;
  }

  afterStoreCommit(mutation: CommittedStoreMutation): MutationEnvelope {
    const affectedKeys = mutation.affectedKeys ?? [];
    this.cache.incrementGeneration(mutation.storeName);

    const envelope: MutationEnvelope = {
      version: 1,
      originTabId: this.syncPort.tabId,
      timestamp: Date.now(),
      storeName: mutation.storeName,
      operation: mutation.operation,
      affectedKeys,
    };

    this.cache.invalidateMatching((entry) => {
      if (
        mutation.preserveRecordSnapshots &&
        entry.queryHash.startsWith(`record:${mutation.storeName}:`)
      ) {
        return false;
      }
      return this.dependencies.shouldInvalidate(entry, envelope);
    });

    this.publishSafely(envelope);
    reportDiagnostic(this.diagnostics, {
      type: "mutation-committed",
      databaseName: this.databaseName,
      storeName: mutation.storeName,
      operation: mutation.operation,
      affectedRecordCount: affectedKeys.length,
      timestamp: Date.now(),
    });
    return envelope;
  }

  /** Called only after an explicit multi-store readwrite transaction has committed. */
  afterTransactionCommit(storeNames: readonly string[]): void {
    const changedStores = [...new Set(storeNames)];
    for (const storeName of changedStores) {
      this.cache.incrementGeneration(storeName);
    }

    const changed = new Set(changedStores);
    this.cache.invalidateMatching((entry) =>
      Array.from(entry.storeNames).some((storeName) => changed.has(storeName)),
    );

    for (const storeName of changedStores) {
      this.publishSafely({
        version: 1,
        originTabId: this.syncPort.tabId,
        timestamp: Date.now(),
        storeName,
        operation: "invalidate",
        affectedKeys: [],
      });
    }
    reportDiagnostic(this.diagnostics, {
      type: "transaction-committed",
      databaseName: this.databaseName,
      storeNames: changedStores,
      timestamp: Date.now(),
    });
  }

  private publishSafely(envelope: MutationEnvelope): void {
    try {
      this.syncPort.publish(envelope);
    } catch {
      // Cache invalidation is local and committed storage is authoritative.
      // Receivers can always refetch; a transport error must not reject the write.
    }
  }
}
