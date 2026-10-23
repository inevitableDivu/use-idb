/**
 * Immutable snapshot of a cache entry returned synchronously to React components.
 *
 * @template T - The stored entity or query result type.
 */
export interface QuerySnapshot<T> {
  /**
   * The current synchronous data value, or `undefined` if not yet loaded.
   */
  readonly data: T | undefined;

  /**
   * `true` only during the initial load before any data or error is available.
   */
  readonly isLoading: boolean;

  /**
   * `true` whenever an active asynchronous fetch is in flight.
   */
  readonly isFetching: boolean;

  /**
   * Error encountered during the latest fetch, or `null` if healthy.
   */
  readonly error: Error | null;
}

/**
 * Status lifecycle states of a cache entry.
 */
export type CacheEntryStatus = "idle" | "pending" | "resolved" | "error";

/**
 * Internal cache entry tracked inside {@link L1Cache}.
 *
 * @template T - Stored data type.
 */
export interface CacheEntry<T = unknown> {
  queryHash: string;
  storeNames: Set<string>;
  keyDependency?: IDBValidKey | IDBKeyRange;
  indexDependency?: string;
  indexName?: string;
  status: CacheEntryStatus;
  data: T | undefined;
  optimisticData?: T | typeof DELETED_SENTINEL;
  optimisticOverlays?: Map<string, unknown>;
  retryCount?: number;
  error: Error | null;
  generationAtStart: number;
  /** Monotonic token used to discard out-of-order fetch results. */
  requestId: number;
  promise?: Promise<T>;
  snapshot: QuerySnapshot<T>;
  subscribers: Set<() => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
  fetcher?: () => Promise<unknown>;
}

/**
 * Options for configuring {@link L1Cache}.
 */
export interface L1CacheOptions {
  /**
   * Maximum number of entries kept in cache before LRU eviction.
   *
   * @default 1000
   */
  maxEntries: number;

  /**
   * Time in milliseconds before an entry with 0 subscribers is evicted from memory.
   *
   * @default 60000
   */
  ttlMs: number;
}

/**
 * Unique symbol indicating that a record has been optimistically deleted.
 * Used internally to distinguish between "no optimistic overlay" (undefined)
 * and "optimistically deleted" (DELETED_SENTINEL).
 */
export const DELETED_SENTINEL = Symbol("DELETED");

const DEFAULT_OPTIONS: L1CacheOptions = {
  maxEntries: 1000,
  ttlMs: 60_000,
};

function createSnapshot<T>(entry: CacheEntry<T>): QuerySnapshot<T> {
  let activeData: T | undefined = entry.data;
  if (entry.optimisticData === DELETED_SENTINEL) {
    activeData = undefined;
  } else if (entry.optimisticData !== undefined) {
    activeData = entry.optimisticData as T;
  }

  return Object.freeze({
    data: activeData,
    isLoading: entry.status === "pending" && activeData === undefined,
    isFetching: entry.status === "pending",
    error: entry.error,
  });
}

function snapshotsEqual<T>(a: QuerySnapshot<T>, b: QuerySnapshot<T>): boolean {
  return (
    Object.is(a.data, b.data) &&
    a.isLoading === b.isLoading &&
    a.isFetching === b.isFetching &&
    Object.is(a.error, b.error)
  );
}

export class L1Cache {
  private entries = new Map<string, CacheEntry>();
  private storeGenerations = new Map<string, number>();
  private readonly options: L1CacheOptions;

  constructor(options?: Partial<L1CacheOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getGeneration(storeName: string): number {
    return this.storeGenerations.get(storeName) ?? 0;
  }

  incrementGeneration(storeName: string): number {
    const next = this.getGeneration(storeName) + 1;
    this.storeGenerations.set(storeName, next);
    return next;
  }

  getEntry<T>(queryHash: string): CacheEntry<T> | undefined {
    return this.entries.get(queryHash) as CacheEntry<T> | undefined;
  }

  getOrCreateEntry<T>(
    queryHash: string,
    storeNames: string[],
    keyDependency?: IDBValidKey | IDBKeyRange,
    indexDependency?: string,
  ): CacheEntry<T> {
    let entry = this.entries.get(queryHash) as CacheEntry<T> | undefined;

    if (!entry) {
      if (this.entries.size >= this.options.maxEntries) {
        this.evictOldestWithoutSubscribers();
      }

      entry = {
        queryHash,
        storeNames: new Set(storeNames),
        keyDependency,
        indexDependency,
        indexName: indexDependency,
        status: "idle",
        data: undefined,
        optimisticData: undefined,
        optimisticOverlays: new Map(),
        retryCount: 0,
        error: null,
        generationAtStart: 0,
        requestId: 0,
        snapshot: Object.freeze({
          data: undefined,
          isLoading: false,
          isFetching: false,
          error: null,
        }),
        subscribers: new Set(),
      };

      this.entries.set(queryHash, entry as CacheEntry);
    } else {
      for (const s of storeNames) {
        entry.storeNames.add(s);
      }
      if (keyDependency !== undefined) {
        entry.keyDependency = keyDependency;
      }
      if (indexDependency !== undefined) {
        entry.indexDependency = indexDependency;
        entry.indexName = indexDependency;
      }
    }

    return entry;
  }

  markPending<T>(entry: CacheEntry<T>, storeNames: string[]): number {
    entry.requestId += 1;
    entry.status = "pending";
    entry.generationAtStart = Math.max(...storeNames.map((s) => this.getGeneration(s)));
    this.updateEntrySnapshot(entry);
    return entry.requestId;
  }

  startPending<T>(entry: CacheEntry<T>, storeNames: string[]): void {
    this.markPending(entry, storeNames);
  }

  /**
   * Resolve a completed read. Discards the result if a mutation
   * incremented the generation since the read started (zombie read prevention).
   *
   * Automatically triggers a background re-fetch if a stale read is rejected.
   */
  resolve<T>(entry: CacheEntry<T>, data: T, requestId?: number): boolean {
    if (requestId !== undefined && requestId !== entry.requestId) return false;
    const currentMaxGen = Math.max(
      ...Array.from(entry.storeNames).map((s) => this.getGeneration(s)),
    );

    if (currentMaxGen > entry.generationAtStart) {
      // Stale read detected — auto re-fetch if fetcher is available
      const retryCount = (entry.retryCount ?? 0) + 1;
      entry.retryCount = retryCount;
      if (entry.fetcher && retryCount <= 3) {
        entry.generationAtStart = currentMaxGen;
        entry.fetcher().catch((err) => {
          this.reject(entry, err instanceof Error ? err : new Error(String(err)));
        });
      } else {
        // Exceeded retries, mark resolved with current state
        entry.status = "resolved";
        this.updateEntrySnapshot(entry);
      }
      return false;
    }

    entry.retryCount = 0;
    entry.status = "resolved";
    entry.data = data;
    entry.error = null;
    this.updateEntrySnapshot(entry);
    return true;
  }

  reject<T>(entry: CacheEntry<T>, error: Error, requestId?: number): void {
    if (requestId !== undefined && requestId !== entry.requestId) return;
    entry.status = "error";
    entry.error = error;
    this.updateEntrySnapshot(entry);
  }

  setPromise(queryHash: string, promise: Promise<unknown>): void {
    const entry = this.entries.get(queryHash);
    if (entry) {
      entry.promise = promise as Promise<any>;
    }
  }

  getPromise(queryHash: string): Promise<unknown> | undefined {
    return this.entries.get(queryHash)?.promise;
  }

  /**
   * Apply an optimistic overlay before the transaction commits.
   */
  setOptimistic<T>(entry: CacheEntry<T>, data: T | typeof DELETED_SENTINEL, mutationId?: string): void {
    if (mutationId) {
      if (!entry.optimisticOverlays) {
        entry.optimisticOverlays = new Map();
      }
      entry.optimisticOverlays.set(mutationId, data);
    }
    entry.optimisticData = data as any;
    this.updateEntrySnapshot(entry);
  }

  /**
   * Commit the optimistic overlay (transaction succeeded).
   */
  commitOptimistic<T>(entry: CacheEntry<T>, mutationId?: string): void {
    if (mutationId && entry.optimisticOverlays) {
      entry.optimisticOverlays.delete(mutationId);
    }
    if (entry.optimisticData === DELETED_SENTINEL) {
      entry.data = undefined;
      entry.optimisticData = undefined;
      this.updateEntrySnapshot(entry);
    } else if (entry.optimisticData !== undefined) {
      entry.data = entry.optimisticData as T;
      entry.optimisticData = undefined;
      this.updateEntrySnapshot(entry);
    }
  }

  /**
   * Rollback the optimistic overlay (transaction aborted).
   */
  rollbackOptimistic<T>(entry: CacheEntry<T>, mutationId?: string): void {
    if (mutationId && entry.optimisticOverlays) {
      entry.optimisticOverlays.delete(mutationId);
      if (entry.optimisticOverlays.size > 0) {
        const remaining = Array.from(entry.optimisticOverlays.values());
        entry.optimisticData = remaining[remaining.length - 1] as any;
        this.updateEntrySnapshot(entry);
        return;
      }
    }
    entry.optimisticData = undefined;
    this.updateEntrySnapshot(entry);
  }

  subscribe(queryHash: string, listener: () => void, fetcher?: () => Promise<unknown>): () => void {
    const entry = this.entries.get(queryHash);
    if (!entry) return () => {};

    entry.subscribers.add(listener);
    if (fetcher) {
      entry.fetcher = fetcher;
    }
    if (entry.gcTimer !== undefined) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }

    return () => {
      entry.subscribers.delete(listener);
      if (entry.subscribers.size === 0) {
        this.scheduleGC(entry);
      }
    };
  }

  invalidateByStore(storeName: string): void {
    for (const entry of this.entries.values()) {
      if (entry.storeNames.has(storeName)) {
        entry.status = "idle";
        this.updateEntrySnapshot(entry);
        if (entry.fetcher && entry.subscribers.size > 0) {
          entry.fetcher().catch(() => {});
        }
      }
    }
  }

  invalidateMatching(predicate: (entry: CacheEntry) => boolean): void {
    for (const entry of this.entries.values()) {
      if (predicate(entry)) {
        entry.status = "idle";
        this.updateEntrySnapshot(entry);
        if (entry.fetcher && entry.subscribers.size > 0) {
          entry.fetcher().catch(() => {});
        }
      }
    }
  }

  invalidateByQueryHash(queryHash: string): void {
    const entry = this.entries.get(queryHash);
    if (entry) {
      entry.status = "idle";
      this.updateEntrySnapshot(entry);
      if (entry.fetcher && entry.subscribers.size > 0) {
        entry.fetcher().catch(() => {});
      }
    }
  }

  getAllEntries(): Iterable<CacheEntry> {
    return this.entries.values();
  }

  updateEntrySnapshot<T>(entry: CacheEntry<T>): void {
    const prev = entry.snapshot;
    const next = createSnapshot(entry);

    if (!snapshotsEqual(prev, next)) {
      entry.snapshot = next;
      for (const listener of entry.subscribers) {
        listener();
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.gcTimer !== undefined) {
        clearTimeout(entry.gcTimer);
      }
    }
    this.entries.clear();
    this.storeGenerations.clear();
  }

  private scheduleGC(entry: CacheEntry): void {
    if (this.options.ttlMs <= 0) {
      this.entries.delete(entry.queryHash);
      return;
    }

    entry.gcTimer = setTimeout(() => {
      if (entry.subscribers.size === 0) {
        this.entries.delete(entry.queryHash);
      }
    }, this.options.ttlMs);
  }

  private evictOldestWithoutSubscribers(): void {
    for (const [hash, entry] of this.entries.entries()) {
      if (entry.subscribers.size === 0) {
        if (entry.gcTimer !== undefined) {
          clearTimeout(entry.gcTimer);
        }
        this.entries.delete(hash);
        return;
      }
    }
  }
}
