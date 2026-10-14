import type { IStoragePort, StorageBatchOp } from "../ports/storage.port";
import type { ISyncPort, MutationEnvelope } from "../ports/sync.port";
import type { L1Cache } from "./l1-cache";
import type { MiddlewarePipeline } from "../adapters/middleware/pipeline";
import { toKeyString } from "./key-serializer";
import type { DependencyTracker } from "./dependency-tracker";

interface QueuedPut {
  type: "put";
  key?: IDBValidKey;
  value: unknown;
  transformedValue?: unknown;
  optimistic: boolean;
  resolvers: Array<(key: IDBValidKey) => void>;
  rejecters: Array<(err: Error) => void>;
}

interface QueuedDelete {
  type: "delete";
  key: IDBValidKey;
  optimistic: boolean;
  resolvers: Array<() => void>;
  rejecters: Array<(err: Error) => void>;
}

type QueuedOp = QueuedPut | QueuedDelete;

interface StoreBatch {
  clearRequested: boolean;
  clearResolvers: Array<() => void>;
  clearRejecters: Array<(err: Error) => void>;
  operations: Map<string | symbol, QueuedOp>;
  timer?: ReturnType<typeof setTimeout>;
  microtaskScheduled: boolean;
}

export interface WriteCoalescerOptions {
  coalesceWindowMs?: number;
}

export class WriteCoalescer {
  private batches = new Map<string, StoreBatch>();

  constructor(
    private readonly storage: IStoragePort,
    private readonly l1Cache: L1Cache,
    private readonly syncPort: ISyncPort,
    private readonly dependencyTracker?: DependencyTracker,
    private readonly middleware?: MiddlewarePipeline,
    private readonly options?: WriteCoalescerOptions,
  ) {}

  private getOrCreateBatch(storeName: string): StoreBatch {
    let batch = this.batches.get(storeName);
    if (!batch) {
      batch = {
        clearRequested: false,
        clearResolvers: [],
        clearRejecters: [],
        operations: new Map(),
        microtaskScheduled: false,
      };
      this.batches.set(storeName, batch);
    }
    return batch;
  }

  private scheduleFlush(storeName: string, batch: StoreBatch): void {
    const windowMs = this.options?.coalesceWindowMs ?? 0;

    if (windowMs > 0) {
      if (batch.timer === undefined) {
        batch.timer = setTimeout(() => {
          batch.timer = undefined;
          this.flush(storeName).catch(() => {});
        }, windowMs);
      }
    } else {
      if (!batch.microtaskScheduled) {
        batch.microtaskScheduled = true;
        queueMicrotask(() => {
          batch.microtaskScheduled = false;
          this.flush(storeName).catch(() => {});
        });
      }
    }
  }

  async put(
    storeName: string,
    value: unknown,
    key?: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<IDBValidKey> {
    const batch = this.getOrCreateBatch(storeName);
    const opKey = key !== undefined ? toKeyString(key) : Symbol("autoincrement");
    const optimistic = options?.optimistic ?? true;

    // Apply optimistic update to cache if key is known
    if (optimistic && key !== undefined) {
      const entry = this.l1Cache.getOrCreateEntry(
        `record:${storeName}:${toKeyString(key)}`,
        [storeName],
        key,
      );
      this.l1Cache.setOptimistic(entry, value);
    }

    return new Promise<IDBValidKey>((resolve, reject) => {
      const existing = batch.operations.get(opKey);
      if (existing) {
        if (existing.type === "put") {
          // Coalesce puts for same key: update value, chain resolvers
          existing.value = value;
          existing.resolvers.push(resolve);
          existing.rejecters.push(reject);
        } else {
          // Replace delete with put
          const resolvers: Array<(key: IDBValidKey) => void> = [resolve];
          const rejecters: Array<(err: Error) => void> = [reject];
          // Notify any pending delete callers that the key was updated
          for (const res of existing.resolvers) res();
          batch.operations.set(opKey, {
            type: "put",
            key,
            value,
            optimistic,
            resolvers,
            rejecters,
          });
        }
      } else {
        batch.operations.set(opKey, {
          type: "put",
          key,
          value,
          optimistic,
          resolvers: [resolve],
          rejecters: [reject],
        });
      }

      this.scheduleFlush(storeName, batch);
    });
  }

  async delete(
    storeName: string,
    key: IDBValidKey,
    options?: { optimistic?: boolean },
  ): Promise<void> {
    const batch = this.getOrCreateBatch(storeName);
    const opKey = toKeyString(key);
    const optimistic = options?.optimistic ?? true;

    if (optimistic) {
      const entry = this.l1Cache.getOrCreateEntry(`record:${storeName}:${opKey}`, [storeName], key);
      this.l1Cache.setOptimistic(entry, undefined);
    }

    return new Promise<void>((resolve, reject) => {
      const existing = batch.operations.get(opKey);
      if (existing) {
        if (existing.type === "put") {
          // Coalesce put + delete -> delete
          for (const rej of existing.rejecters) {
            rej(new Error(`Operation cancelled: record ${opKey} was deleted before flush`));
          }
          batch.operations.set(opKey, {
            type: "delete",
            key,
            optimistic,
            resolvers: [resolve],
            rejecters: [reject],
          });
        } else {
          existing.resolvers.push(resolve);
          existing.rejecters.push(reject);
        }
      } else {
        batch.operations.set(opKey, {
          type: "delete",
          key,
          optimistic,
          resolvers: [resolve],
          rejecters: [reject],
        });
      }

      this.scheduleFlush(storeName, batch);
    });
  }

  async clear(storeName: string): Promise<void> {
    const batch = this.getOrCreateBatch(storeName);
    batch.clearRequested = true;

    // Any queued puts/deletes are superseded by clear
    for (const op of batch.operations.values()) {
      for (const rej of op.rejecters) {
        rej(new Error(`Operation cancelled: store ${storeName} was cleared`));
      }
    }
    batch.operations.clear();

    return new Promise<void>((resolve, reject) => {
      batch.clearResolvers.push(resolve);
      batch.clearRejecters.push(reject);
      this.scheduleFlush(storeName, batch);
    });
  }

  async flush(storeName: string): Promise<void> {
    const batch = this.batches.get(storeName);
    if (!batch) return;
    this.batches.delete(storeName);

    if (batch.timer !== undefined) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
    }

    // 1. Handle clear if requested
    if (batch.clearRequested) {
      try {
        await this.storage.clear(storeName);
        this.l1Cache.incrementGeneration(storeName);
        this.l1Cache.invalidateByStore(storeName);

        this.syncPort.publish({
          originTabId: this.syncPort.tabId,
          timestamp: Date.now(),
          storeName,
          operation: "clear",
          affectedKeys: [],
        });

        for (const res of batch.clearResolvers) res();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const rej of batch.clearRejecters) rej(error);
      }
      return;
    }

    const opsList = Array.from(batch.operations.values());
    if (opsList.length === 0) return;

    // 2. CRITICAL: Execute async middleware BEFORE opening the storage transaction
    if (this.middleware) {
      for (const op of opsList) {
        if (op.type === "put") {
          try {
            op.transformedValue = await this.middleware.runBeforeWrite(storeName, "put", op.value);
          } catch (mwErr) {
            const error = mwErr instanceof Error ? mwErr : new Error(String(mwErr));
            // Rollback optimistic overlay
            if (op.optimistic && op.key !== undefined) {
              const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
              if (entry) this.l1Cache.rollbackOptimistic(entry);
            }
            for (const rej of op.rejecters) rej(error);
            return;
          }
        }
      }
    } else {
      for (const op of opsList) {
        if (op.type === "put") {
          op.transformedValue = op.value;
        }
      }
    }

    // 3. Prepare storage batch operations
    const storageOps: StorageBatchOp[] = opsList.map((op) => ({
      type: op.type,
      key: op.key,
      value: op.type === "put" ? op.transformedValue : undefined,
    }));

    try {
      // 4. Dispatch single atomic batch to storage
      const resultKeys = await this.storage.batch(storeName, storageOps);

      // 5. Success handling
      this.l1Cache.incrementGeneration(storeName);
      const affectedKeys: IDBValidKey[] = [];

      for (let i = 0; i < opsList.length; i++) {
        const op = opsList[i];
        const resKey = resultKeys[i] ?? op.key;
        if (resKey !== undefined) {
          affectedKeys.push(resKey);
        }

        // Commit optimistic overlay in cache
        if (op.optimistic && resKey !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(resKey)}`);
          if (entry) {
            this.l1Cache.commitOptimistic(entry);
          }
        }

        // On delete, clear data in cache entry
        if (op.type === "delete" && op.key !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
          if (entry) {
            entry.data = undefined;
            entry.optimisticData = undefined;
            this.l1Cache.updateEntrySnapshot(entry);
          }
        }

        if (op.type === "put") {
          for (const res of op.resolvers) {
            res(resKey!);
          }
        } else {
          for (const res of op.resolvers) {
            res();
          }
        }
      }

      // 6. Broadcast mutation envelope and invalidate local cache queries
      const envelope: MutationEnvelope = {
        originTabId: this.syncPort.tabId,
        timestamp: Date.now(),
        storeName,
        operation: opsList.length > 1 ? "bulk" : (opsList[0].type as "put" | "delete"),
        affectedKeys,
      };

      if (this.dependencyTracker) {
        this.l1Cache.invalidateMatching((entry) => {
          if (entry.queryHash.startsWith(`record:${storeName}:`)) {
            return false;
          }
          return this.dependencyTracker!.shouldInvalidate(entry, envelope);
        });
      } else {
        const invalidatedHashes = this.l1Cache.invalidateByStore(storeName);
        for (const hash of invalidatedHashes) {
          if (hash.startsWith(`record:${storeName}:`)) continue;
          const entry = this.l1Cache.getEntry(hash);
          if (entry) {
            this.l1Cache.updateEntrySnapshot(entry);
          }
        }
      }

      if (affectedKeys.length > 0) {
        this.syncPort.publish(envelope);
      }
    } catch (err) {
      // 7. Error handling: rollback optimistic overlays and reject callers
      const error = err instanceof Error ? err : new Error(String(err));

      for (const op of opsList) {
        if (op.optimistic && op.key !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
          if (entry) {
            this.l1Cache.rollbackOptimistic(entry);
          }
        }
        for (const rej of op.rejecters) {
          rej(error);
        }
      }
    }
  }
}
