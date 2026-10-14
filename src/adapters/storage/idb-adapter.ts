import type { ConnectionState, StorageQuota } from "../../types/status";
import type { QueryAST } from "../../types/query";
import type { DatabaseSchema } from "../../types/schema";
import type { IStoragePort, IStorageTransaction, StorageBatchOp } from "../../ports/storage.port";
import { runMigrations } from "./migration-runner";

const RETRY_ERRORS = ["InvalidStateError", "UnknownError"];
const VERSION_CHANGE_DRAIN_TIMEOUT_MS = 500;

/**
 * Native IndexedDB storage adapter with connection lifecycle FSM,
 * Safari zombie connection auto-healing, and fast-path cursor optimization.
 */
export class IndexedDBStorageAdapter implements IStoragePort {
  private db: IDBDatabase | null = null;
  private openPromise: Promise<void> | null = null;
  private state: ConnectionState = "IDLE";
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private _isUpgradeBlocked = false;
  private _requiresReload = false;
  private activeBatchCount = 0;
  private batchDrainResolvers: Array<() => void> = [];

  constructor(private readonly schema: DatabaseSchema) {
    if (typeof window === "undefined" || typeof indexedDB === "undefined") {
      this.setState("SSR");
    }
  }

  // ── State Machine ──

  private setState(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  isUpgradeBlocked(): boolean {
    return this._isUpgradeBlocked;
  }

  requiresReloadForUpgrade(): boolean {
    return this._requiresReload;
  }

  // ── Connection Lifecycle ──

  async open(): Promise<void> {
    if (this.state === "SSR") {
      throw new Error("IndexedDB is not available in this environment");
    }
    if (this.state === "OPEN" && this.db) return;

    // Deduplicate concurrent open() calls
    if (this.openPromise) return this.openPromise;

    this.openPromise = this.doOpen();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = null;
    }
  }

  private doOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setState("CONNECTING");

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.schema.name, this.schema.version);
      } catch (err) {
        this.setState("ERROR");
        reject(err);
        return;
      }

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        this.setState("UPGRADING");
        const db = request.result;
        const tx = request.transaction!;
        const oldVersion = event.oldVersion;
        const newVersion = event.newVersion ?? this.schema.version;

        // Run migrations synchronously in the versionchange transaction.
        // Note: runMigrations is async but IndexedDB versionchange transactions
        // stay open during the microtask chain (no cross-task awaits inside).
        runMigrations(db, tx, this.schema, oldVersion, newVersion).catch((err) => {
          // If migrations fail, abort the transaction
          try {
            tx.abort();
          } catch {
            // tx may already be finished
          }
          reject(err);
        });
      };

      request.onblocked = () => {
        this._isUpgradeBlocked = true;
        this.setState("BLOCKED");
      };

      request.onsuccess = () => {
        this.db = request.result;
        this._isUpgradeBlocked = false;
        this.setState("OPEN");
        this.attachConnectionHandlers();
        resolve();
      };

      request.onerror = () => {
        this.setState("ERROR");
        reject(request.error ?? new DOMException("Failed to open database", "UnknownError"));
      };
    });
  }

  private attachConnectionHandlers(): void {
    if (!this.db) return;

    this.db.onversionchange = () => {
      this.setState("CLOSING_FOR_UPGRADE");
      this._requiresReload = true;

      // Drain active batches with a timeout
      const drainPromise =
        this.activeBatchCount > 0
          ? new Promise<void>((resolve) => {
              this.batchDrainResolvers.push(resolve);
              setTimeout(resolve, VERSION_CHANGE_DRAIN_TIMEOUT_MS);
            })
          : Promise.resolve();

      drainPromise.then(() => {
        this.db?.close();
        this.db = null;
      });
    };

    this.db.onclose = () => {
      this.db = null;
      if (this.state === "OPEN") {
        this.setState("IDLE");
      }
    };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.setState("IDLE");
  }

  // ── Safari Auto-Healing ──

  private async executeWithRetry<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    await this.ensureOpen();
    try {
      return await fn(this.db!);
    } catch (err) {
      if (err instanceof DOMException && RETRY_ERRORS.includes(err.name)) {
        // Safari zombie connection: purge and retry once
        this.db?.close();
        this.db = null;
        this.setState("RECONNECTING");
        await this.open();
        return fn(this.db!);
      }
      throw err;
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.state !== "OPEN" || !this.db) {
      await this.open();
    }
  }

  // ── CRUD Operations ──

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return this.executeWithRetry(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async getAll<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]> {
    return this.executeWithRetry(
      (db) =>
        new Promise<T[]>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const source = indexName
            ? tx.objectStore(storeName).index(indexName)
            : tx.objectStore(storeName);
          const req = source.getAll(range ?? null, limit);
          req.onsuccess = () => resolve(req.result as T[]);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    return this.executeWithRetry(
      (db) =>
        new Promise<IDBValidKey>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite", { durability: "relaxed" });
          const store = tx.objectStore(storeName);
          const req =
            key !== undefined && !store.keyPath ? store.put(value, key) : store.put(value);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    return this.executeWithRetry(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite", { durability: "relaxed" });
          const req = tx.objectStore(storeName).delete(key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async clear(storeName: string): Promise<void> {
    return this.executeWithRetry(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite", { durability: "relaxed" });
          const req = tx.objectStore(storeName).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async count(storeName: string, range?: IDBKeyRange | IDBValidKey): Promise<number> {
    return this.executeWithRetry(
      (db) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).count(range ?? undefined);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  // ── Batch Operations ──

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    return this.executeWithRetry(
      (db) =>
        new Promise<(IDBValidKey | undefined)[]>((resolve, reject) => {
          this.activeBatchCount++;
          const tx = db.transaction(storeName, "readwrite", { durability: "relaxed" });
          const store = tx.objectStore(storeName);
          const results: (IDBValidKey | undefined)[] = new Array(ops.length);

          // Fire all IDBRequests synchronously — never await inside this loop
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            try {
              if (op.type === "put") {
                const req =
                  op.key !== undefined && !store.keyPath
                    ? store.put(op.value, op.key)
                    : store.put(op.value);
                const idx = i;
                req.onsuccess = () => {
                  results[idx] = req.result;
                };
              } else {
                if (op.key !== undefined) {
                  store.delete(op.key);
                }
                results[i] = undefined;
              }
            } catch (syncErr) {
              // If a sync error occurs (e.g., DataError), abort the transaction
              try {
                tx.abort();
              } catch {
                // already aborting
              }
              this.activeBatchCount--;
              this.checkBatchDrain();
              reject(syncErr);
              return;
            }
          }

          tx.oncomplete = () => {
            this.activeBatchCount--;
            this.checkBatchDrain();
            resolve(results);
          };

          tx.onabort = () => {
            this.activeBatchCount--;
            this.checkBatchDrain();
            reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
          };
        }),
    );
  }

  private checkBatchDrain(): void {
    if (this.activeBatchCount <= 0) {
      for (const resolve of this.batchDrainResolvers) {
        resolve();
      }
      this.batchDrainResolvers = [];
    }
  }

  // ── Explicit Transactions ──

  async transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    return this.executeWithRetry(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const durability = mode === "readwrite" ? { durability: "relaxed" as const } : undefined;
          const tx = db.transaction(storeNames, mode, durability);

          const txProxy: IStorageTransaction = {
            get<V>(storeName: string, key: IDBValidKey): Promise<V | undefined> {
              return new Promise((res, rej) => {
                const req = tx.objectStore(storeName).get(key);
                req.onsuccess = () => res(req.result as V | undefined);
                req.onerror = () => rej(req.error);
              });
            },
            put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
              return new Promise((res, rej) => {
                const store = tx.objectStore(storeName);
                const req =
                  key !== undefined && !store.keyPath ? store.put(value, key) : store.put(value);
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              });
            },
            delete(storeName: string, key: IDBValidKey): Promise<void> {
              return new Promise((res, rej) => {
                const req = tx.objectStore(storeName).delete(key);
                req.onsuccess = () => res();
                req.onerror = () => rej(req.error);
              });
            },
            clear(storeName: string): Promise<void> {
              return new Promise((res, rej) => {
                const req = tx.objectStore(storeName).clear();
                req.onsuccess = () => res();
                req.onerror = () => rej(req.error);
              });
            },
          };

          // Execute user function within the transaction scope.
          // CRITICAL: fn must NOT await non-IDBRequest promises or the
          // browser will auto-commit the transaction.
          fn(txProxy).then(
            (result) => {
              // Wait for transaction to complete before resolving
              tx.oncomplete = () => resolve(result);
              tx.onabort = () =>
                reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
            },
            (err) => {
              try {
                tx.abort();
              } catch {
                // tx may already be done
              }
              reject(err);
            },
          );
        }),
    );
  }

  // ── Cursor / Query Engine ──

  async cursor<T>(ast: QueryAST<T>): Promise<T[]> {
    // Fast-path: no JS filter, direction='next', offset=0 → use native getAll
    const canUseFastPath =
      !ast.filterPredicate && ast.direction === "next" && ast.offsetCount === 0;

    if (canUseFastPath) {
      return this.getAll<T>(ast.storeName, ast.indexName, ast.range, ast.limitCount);
    }

    // Slow path: cursor iteration with advance/filter
    return this.executeWithRetry(
      (db) =>
        new Promise<T[]>((resolve, reject) => {
          const tx = db.transaction(ast.storeName, "readonly");
          const source = ast.indexName
            ? tx.objectStore(ast.storeName).index(ast.indexName)
            : tx.objectStore(ast.storeName);

          const range = ast.range instanceof IDBKeyRange ? ast.range : (ast.range ?? null);
          const req = source.openCursor(range, ast.direction);
          const results: T[] = [];
          let needsAdvance = ast.offsetCount > 0;

          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(results);
              return;
            }

            // Handle offset via cursor.advance (zero-allocation skip)
            if (needsAdvance) {
              needsAdvance = false;
              cursor.advance(ast.offsetCount);
              return;
            }

            const value = cursor.value as T;

            if (ast.filterPredicate) {
              if (ast.filterPredicate(value)) {
                results.push(value);
              }
            } else {
              results.push(value);
            }

            if (ast.limitCount !== undefined && results.length >= ast.limitCount) {
              resolve(results);
              return;
            }

            cursor.continue();
          };

          req.onerror = () => reject(req.error);
        }),
    );
  }

  // ── Quota ──

  async getQuota(): Promise<StorageQuota> {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage ?? null;
      const quota = estimate.quota ?? null;
      return {
        usageBytes: usage,
        quotaBytes: quota,
        percentUsed: usage !== null && quota !== null && quota > 0 ? (usage / quota) * 100 : null,
        isPersisted:
          typeof navigator.storage.persisted === "function"
            ? await navigator.storage.persisted()
            : null,
      };
    }
    return { usageBytes: null, quotaBytes: null, percentUsed: null, isPersisted: null };
  }
}
