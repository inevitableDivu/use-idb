import type { DatabaseSchema } from "../../types/schema";
import type { ConnectionState, StorageQuota } from "../../types/status";
import type { QueryAST } from "../../types/query";
import type { IStoragePort, IStorageTransaction, StorageBatchOp, StorageEntry } from "../../ports/storage.port";
import type { ILockPort } from "../../ports/lock.port";
import type { ISyncPort } from "../../ports/sync.port";
import { runMigrations } from "./migration-runner";

const RETRY_ERRORS = ["InvalidStateError", "TransactionInactiveError"];
const VERSION_CHANGE_DRAIN_TIMEOUT_MS = 2000;

export class DatabaseClosingForUpgradeError extends Error {
  readonly retryable = true;
  constructor(
    message = "Database connection is closing or closed for a schema upgrade in another tab. Reload required.",
  ) {
    super(message);
    this.name = "DatabaseClosingForUpgradeError";
  }
}

/**
 * Robust IndexedDB storage adapter implementing {@link IStoragePort}.
 *
 * Implements a 10-state lifecycle FSM, WebLocks upgrade exclusivity, Safari zombie handle auto-recovery,
 * immediate operation rejection during remote upgrades, and zero-leak transaction management.
 */
export class IndexedDBStorageAdapter implements IStoragePort {
  private db: IDBDatabase | null = null;
  private state: ConnectionState = "IDLE";
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private openPromise: Promise<void> | null = null;
  private activeBatchCount = 0;
  private batchDrainResolvers: Array<() => void> = [];
  private _isUpgradeBlocked = false;
  private _requiresReload = false;

  constructor(
    private readonly schema: DatabaseSchema,
    private readonly lockPort?: ILockPort,
    private readonly syncPort?: ISyncPort,
  ) {
    if (typeof indexedDB === "undefined") {
      this.state = "SSR";
    }

    // REL-07: Safari Visibility Heartbeat
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.state === "OPEN" && this.db) {
          try {
            const firstStore = this.schema.stores ? Object.keys(this.schema.stores)[0] : undefined;
            if (firstStore) {
              const tx = this.db.transaction(firstStore, "readonly");
              tx.abort();
            }
          } catch {
            this.db?.close();
            this.db = null;
            this.setState("RECONNECTING");
            this.open().catch(() => {});
          }
        }
      });
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
    if (this.state === "CLOSING_FOR_UPGRADE" || this._requiresReload) {
      throw new DatabaseClosingForUpgradeError();
    }
    if (this.state === "OPEN" && this.db) return;

    // Deduplicate concurrent open() calls
    if (this.openPromise) return this.openPromise;

    // CON-08: Exclusively acquire WebLock during database open/upgrade if lockPort available
    if (this.lockPort) {
      this.openPromise = this.lockPort.request(`idb-upgrade:${this.schema.name}`, async () => {
        await this.doOpen();
      });
    } else {
      this.openPromise = this.doOpen();
    }

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

        try {
          runMigrations(db, tx, this.schema, oldVersion, newVersion);
        } catch (err) {
          try {
            tx.abort();
          } catch {
            // Already aborted
          }
          reject(err);
        }
      };

      request.onblocked = () => {
        this._isUpgradeBlocked = true;
        this.setState("BLOCKED");

        // REL-06: Broadcast force release request so older tabs close their handles
        if (this.syncPort) {
          this.syncPort.publish({
            originTabId: this.syncPort.tabId,
            timestamp: Date.now(),
            storeName: "*",
            operation: "force_release",
            affectedKeys: [],
          });
        }
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

  // ── Safari Auto-Healing & Contention Guards ──

  private async executeWithRetry<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    await this.ensureOpen();
    try {
      return await fn(this.db!);
    } catch (err) {
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        this.setState("QUOTA_EXCEEDED" as any);
        throw err;
      }
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
    if (this.state === "CLOSING_FOR_UPGRADE" || this._requiresReload) {
      throw new DatabaseClosingForUpgradeError();
    }
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
          const target = indexName
            ? tx.objectStore(storeName).index(indexName)
            : tx.objectStore(storeName);

          const keyRange = range instanceof IDBKeyRange ? range : (range ?? null);
          const req = target.getAll(keyRange, limit);
          req.onsuccess = () => resolve(req.result as T[]);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async getAllWithKeys<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<StorageEntry<T>[]> {
    return this.executeWithRetry(
      (db) =>
        new Promise<StorageEntry<T>[]>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const target = indexName
            ? tx.objectStore(storeName).index(indexName)
            : tx.objectStore(storeName);
          const keyRange = range instanceof IDBKeyRange ? range : (range ?? null);
          const valuesRequest = target.getAll(keyRange, limit);
          const keysRequest = target.getAllKeys(keyRange, limit);
          let values: T[] | undefined;
          let keys: IDBValidKey[] | undefined;

          const completeIfReady = () => {
            if (!values || !keys) return;
            if (values.length !== keys.length) {
              reject(new DOMException("IndexedDB returned mismatched keys and values", "DataError"));
              return;
            }
            resolve(values.map((value, index) => ({ key: keys![index]!, value })));
          };

          valuesRequest.onsuccess = () => {
            values = valuesRequest.result as T[];
            completeIfReady();
          };
          keysRequest.onsuccess = () => {
            keys = keysRequest.result as IDBValidKey[];
            completeIfReady();
          };
          valuesRequest.onerror = () => reject(valuesRequest.error);
          keysRequest.onerror = () => reject(keysRequest.error);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new DOMException("Read transaction aborted", "AbortError"));
        }),
    );
  }

  async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    return this.executeWithRetry(
      (db) =>
        new Promise<IDBValidKey>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const req =
            store.keyPath !== null
              ? store.put(value)
              : key !== undefined
                ? store.put(value, key)
                : store.put(value);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    return this.executeWithRetry(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
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
          const tx = db.transaction(storeName, "readwrite");
          const req = tx.objectStore(storeName).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async count(
    storeName: string,
    range?: IDBKeyRange | IDBValidKey,
    indexName?: string,
  ): Promise<number> {
    return this.executeWithRetry(
      (db) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const keyRange = range instanceof IDBKeyRange ? range : range;
          const source = indexName
            ? tx.objectStore(storeName).index(indexName)
            : tx.objectStore(storeName);
          const req = source.count(keyRange);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  // ── Atomic Batch ──

  async batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]> {
    this.activeBatchCount++;
    try {
      return await this.executeWithRetry(
        (db) =>
          new Promise<(IDBValidKey | undefined)[]>((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            const store = tx.objectStore(storeName);
            const results: (IDBValidKey | undefined)[] = [];
            let completed = 0;
            const total = ops.length;

            if (total === 0) {
              resolve([]);
              return;
            }

            for (let i = 0; i < total; i++) {
              const op = ops[i]!;
              let req: IDBRequest;

              if (op.type === "put") {
                req =
                  store.keyPath !== null
                    ? store.put(op.value)
                    : op.key !== undefined
                      ? store.put(op.value, op.key)
                      : store.put(op.value);
              } else {
                req = store.delete(op.key!);
              }

              const idx = i;
              req.onsuccess = () => {
                results[idx] = op.type === "put" ? (req.result as IDBValidKey) : undefined;
                completed++;
                if (completed === total) {
                  resolve(results);
                }
              };

              req.onerror = () => {
                reject(req.error);
              };
            }

            tx.onerror = () => reject(tx.error);
            tx.onabort = () =>
              reject(tx.error ?? new DOMException("Batch transaction aborted", "AbortError"));
          }),
      );
    } finally {
      this.activeBatchCount--;
      if (this.activeBatchCount === 0) {
        for (const drain of this.batchDrainResolvers) {
          drain();
        }
        this.batchDrainResolvers = [];
      }
    }
  }

  // ── Explicit Transactions (REL-05 Hardened) ──

  async transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T> {
    return this.executeWithRetry(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeNames, mode);

          let userSettled = false;
          let userResult: T;
          let userError: unknown;
          let txCompleted = false;

          // REL-05: Attach handlers BEFORE running any user operations
          tx.oncomplete = () => {
            txCompleted = true;
            if (userSettled) {
              if (userError) reject(userError);
              else resolve(userResult);
            }
          };

          tx.onerror = () => {
            reject(userError ?? tx.error ?? new DOMException("Transaction error", "UnknownError"));
          };

          tx.onabort = () => {
            reject(userError ?? tx.error ?? new DOMException("Transaction aborted", "AbortError"));
          };

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
                const req = key !== undefined ? store.put(value, key) : store.put(value);
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

          fn(txProxy).then(
            (result) => {
              userSettled = true;
              userResult = result;
              if (txCompleted) {
                resolve(result);
              }
            },
            (err) => {
              userSettled = true;
              userError = err;
              try {
                tx.abort();
              } catch {
                // Already aborted
              }
              reject(err);
            },
          );
        }),
    );
  }

  // ── Cursor / Query Engine (REA-05 Software Offset Filter) ──

  async cursor<T>(ast: QueryAST<T>): Promise<T[]> {
    return (await this.cursorWithKeys(ast)).map((entry) => entry.value);
  }

  async cursorWithKeys<T>(ast: QueryAST<T>): Promise<StorageEntry<T>[]> {
    // Fast-path: no JS filter, direction='next', offset=0 -> native getAll.
    const canUseFastPath =
      !ast.filterPredicate && ast.direction === "next" && ast.offsetCount === 0;

    if (canUseFastPath) {
      return this.getAllWithKeys<T>(ast.storeName, ast.indexName, ast.range, ast.limitCount);
    }

    return this.executeWithRetry(
      (db) =>
        new Promise<StorageEntry<T>[]>((resolve, reject) => {
          const tx = db.transaction(ast.storeName, "readonly");
          const source = ast.indexName
            ? tx.objectStore(ast.storeName).index(ast.indexName)
            : tx.objectStore(ast.storeName);

          const range = ast.range instanceof IDBKeyRange ? ast.range : (ast.range ?? null);
          const req = source.openCursor(range, ast.direction);
          const results: StorageEntry<T>[] = [];
          let skippedMatches = 0;
          let needsPhysicalAdvance = !ast.filterPredicate && ast.offsetCount > 0;

          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(results);
              return;
            }

            if (needsPhysicalAdvance) {
              needsPhysicalAdvance = false;
              cursor.advance(ast.offsetCount);
              return;
            }

            const entry: StorageEntry<T> = {
              key: cursor.primaryKey,
              value: cursor.value as T,
            };

            if (ast.filterPredicate) {
              if (ast.filterPredicate(entry.value)) {
                if (skippedMatches < ast.offsetCount) {
                  skippedMatches++;
                } else {
                  results.push(entry);
                }
              }
            } else {
              results.push(entry);
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
      const percentUsed =
        usage !== null && quota !== null && quota > 0
          ? Math.round((usage / quota) * 1000) / 10
          : null;
      const isPersisted =
        navigator.storage.persisted ? await navigator.storage.persisted() : null;

      return {
        usageBytes: usage,
        quotaBytes: quota,
        percentUsed,
        isPersisted,
      };
    }

    return {
      usageBytes: null,
      quotaBytes: null,
      percentUsed: null,
      isPersisted: null,
    };
  }
}
