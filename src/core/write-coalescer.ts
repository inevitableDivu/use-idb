import type { IStoragePort, StorageBatchOp } from "../ports/storage.port";
import type { ISyncPort, MutationEnvelope } from "../ports/sync.port";
import { DELETED_SENTINEL, type L1Cache } from "./l1-cache";
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
  coalescedDeleteResolvers?: Array<() => void>;
  coalescedDeleteRejecters?: Array<(err: Error) => void>;
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

/**
 * Options for configuring the {@link WriteCoalescer}.
 */
export interface WriteCoalescerOptions {
  /**
   * Coalescing window in milliseconds. If 0, coalesces writes within the same microtask (`queueMicrotask`).
   *
   * @default 0
   */
  coalesceWindowMs?: number;
}

/**
 * Microtask write coalescer that queues concurrent writes and deletes per object store,
 * coalescing multiple updates for the same key and flushing them inside a single atomic
 * `readwrite` transaction.
 */
export class WriteCoalescer {
  private batches = new Map<string, StoreBatch>();
  private storage: IStoragePort;

  constructor(
    storage: IStoragePort,
    private readonly l1Cache: L1Cache,
    private readonly syncPort: ISyncPort,
    private readonly dependencyTracker?: DependencyTracker,
    private readonly middleware?: MiddlewarePipeline,
    private readonly options?: WriteCoalescerOptions,
  ) {
    this.storage = storage;
  }

  /**
   * Rebinds the active storage adapter (used when falling back to memory storage).
   */
  setStorage(storage: IStoragePort): void {
    this.storage = storage;
  }

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
          // Replace delete with put: chain delete resolvers to resolve after commit
          const resolvers: Array<(key: IDBValidKey) => void> = [resolve];
          const rejecters: Array<(err: Error) => void> = [reject];
          batch.operations.set(opKey, {
            type: "put",
            key,
            value,
            optimistic,
            resolvers,
            rejecters,
            coalescedDeleteResolvers: existing.resolvers,
            coalescedDeleteRejecters: existing.rejecters,
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
      this.l1Cache.setOptimistic(entry, DELETED_SENTINEL);
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
          // Coalesce delete + delete
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

    // Reject all pending put/delete operations superseded by clear
    for (const op of batch.operations.values()) {
      for (const rej of op.rejecters) {
        rej(new Error(`Operation cancelled: store ${storeName} was cleared before flush`));
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
      // If new operations arrived while clear was processing, schedule next flush
      if (batch.operations.size > 0) {
        const nextBatch = this.getOrCreateBatch(storeName);
        for (const [k, op] of batch.operations) {
          nextBatch.operations.set(k, op);
        }
        this.scheduleFlush(storeName, nextBatch);
      }
      return;
    }

    const opsList = Array.from(batch.operations.values());
    if (opsList.length === 0) return;

    // 2. CRITICAL (CON-01): Two-Phase Per-Operation Middleware Execution
    // Isolate failures so that one failing operation doesn't hang or abort healthy operations.
    const healthyOps: QueuedOp[] = [];

    for (const op of opsList) {
      if (op.type === "put") {
        try {
          op.transformedValue = this.middleware
            ? await this.middleware.runBeforeWrite(storeName, "put", op.value, op.key)
            : op.value;
          healthyOps.push(op);
        } catch (mwErr) {
          const error = mwErr instanceof Error ? mwErr : new Error(String(mwErr));
          // Rollback optimistic overlay for this failing operation
          if (op.optimistic && op.key !== undefined) {
            const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
            if (entry) this.l1Cache.rollbackOptimistic(entry);
          }
          for (const rej of op.rejecters) rej(error);
          for (const rej of op.coalescedDeleteRejecters ?? []) rej(error);
        }
      } else {
        healthyOps.push(op);
      }
    }

    if (healthyOps.length === 0) return;

    // 3. Prepare storage batch operations
    const storageOps: StorageBatchOp[] = healthyOps.map((op) => ({
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

      for (let i = 0; i < healthyOps.length; i++) {
        const op = healthyOps[i]!;
        const resKey = resultKeys[i] ?? op.key;
        if (resKey !== undefined) {
          affectedKeys.push(resKey);
        }

        // Commit optimistic overlay or update committed value in cache
        if (op.type === "put" && resKey !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(resKey)}`);
          if (entry) {
            entry.retryCount = 0;
            entry.status = "resolved";
            entry.data = op.value as any;
            entry.optimisticData = undefined;
            entry.generationAtStart = this.l1Cache.getGeneration(storeName);
            entry.error = null;
            this.l1Cache.updateEntrySnapshot(entry);
          }
        }

        // On delete, commit delete overlay or update as undefined in cache
        if (op.type === "delete" && op.key !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
          if (entry) {
            entry.retryCount = 0;
            entry.status = "resolved";
            entry.data = undefined;
            entry.optimisticData = undefined;
            entry.generationAtStart = this.l1Cache.getGeneration(storeName);
            entry.error = null;
            this.l1Cache.updateEntrySnapshot(entry);
          }
        }

        if (op.type === "put") {
          for (const res of op.resolvers) {
            res(resKey!);
          }
          // Resolve any coalesced delete operations now that write has committed
          for (const res of op.coalescedDeleteResolvers ?? []) {
            res();
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
        operation: healthyOps.length > 1 ? "bulk" : (healthyOps[0]!.type as "put" | "delete"),
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
        this.l1Cache.invalidateByStore(storeName);
      }

      if (affectedKeys.length > 0) {
        this.syncPort.publish(envelope);
      }
    } catch (err) {
      // 7. Error handling: rollback optimistic overlays and reject callers
      const error = err instanceof Error ? err : new Error(String(err));

      for (const op of healthyOps) {
        if (op.optimistic && op.key !== undefined) {
          const entry = this.l1Cache.getEntry(`record:${storeName}:${toKeyString(op.key)}`);
          if (entry) {
            this.l1Cache.rollbackOptimistic(entry);
          }
        }
        for (const rej of op.rejecters) {
          rej(error);
        }
        if (op.type === "put") {
          for (const rej of op.coalescedDeleteRejecters ?? []) {
            rej(error);
          }
        }
      }
    }
  }

  /**
   * Executes a direct batch write routed through middleware and cache invalidation.
   */
  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    const transformedOps: StorageBatchOp[] = [];

    for (const op of ops) {
      if (op.type === "put") {
        const transformed = this.middleware
          ? await this.middleware.runBeforeWrite(storeName, "put", op.value, op.key)
          : op.value;
        transformedOps.push({ ...op, value: transformed });
      } else {
        transformedOps.push(op);
      }
    }

    const results = await this.storage.batch(storeName, transformedOps);
    this.l1Cache.incrementGeneration(storeName);

    const affectedKeys: IDBValidKey[] = [];
    for (let i = 0; i < ops.length; i++) {
      const resKey = results[i] ?? ops[i]!.key;
      if (resKey !== undefined) affectedKeys.push(resKey);
    }

    const envelope: MutationEnvelope = {
      originTabId: this.syncPort.tabId,
      timestamp: Date.now(),
      storeName,
      operation: ops.length > 1 ? "bulk" : (ops[0]!.type as "put" | "delete"),
      affectedKeys,
    };

    if (this.dependencyTracker) {
      this.l1Cache.invalidateMatching((entry) => this.dependencyTracker!.shouldInvalidate(entry, envelope));
    } else {
      this.l1Cache.invalidateByStore(storeName);
    }

    if (affectedKeys.length > 0) {
      this.syncPort.publish(envelope);
    }

    return results;
  }
}
