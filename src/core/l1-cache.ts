/**
 * L1 Synchronous Snapshot Cache for useSyncExternalStore integration.
 *
 * Provides:
 * - Pre-allocated frozen snapshot tuples with referential stability (Object.is)
 * - Per-store Lamport generation counters preventing stale async reads
 * - Optimistic overlay stack with instant rollback
 * - Configurable GC timer after zero active subscribers
 */

/**
 * Frozen, referentially stable query snapshot consumed synchronously by `useSyncExternalStore`.
 *
 * @template T - The stored data type.
 */
export interface QuerySnapshot<T = unknown> {
  /**
   * The active data value (incorporating any active optimistic overlays).
   */
  readonly data: T | undefined;

  /**
   * `true` on initial read before data has been loaded.
   */
  readonly isLoading: boolean;

  /**
   * `true` whenever an active asynchronous read is running.
   */
  readonly isFetching: boolean;

  /**
   * Error caught during execution, or `null` if healthy.
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
  /**
   * Deterministic query hash.
   */
  queryHash: string;

  /**
   * Set of object stores this query reads from.
   */
  storeNames: Set<string>;

  /**
   * Optional key or key range dependency for fine-grained invalidation.
   */
  keyDependency?: IDBValidKey | IDBKeyRange;

  /**
   * Optional index dependency name.
   */
  indexDependency?: string;

  /**
   * Current lifecycle status.
   */
  status: CacheEntryStatus;

  /**
   * Base resolved data from storage.
   */
  data: T | undefined;

  /**
   * Optimistic overlay value before transaction commits.
   */
  optimisticData?: T;

  /**
   * Error if operation rejected.
   */
  error: Error | null;

  /**
   * Store generation counter value when read was initiated.
   */
  generationAtStart: number;

  /**
   * Active promise used for React `<Suspense>` integration.
   */
  promise?: Promise<T>;

  /**
   * Frozen snapshot returned synchronously to React components.
   */
  snapshot: QuerySnapshot<T>;

  /**
   * Set of active subscriber listener callbacks.
   */
  subscribers: Set<() => void>;

  /**
   * Active garbage collection timer running after zero subscribers remain.
   */
  gcTimer?: ReturnType<typeof setTimeout>;

  /**
   * Background re-fetch callback triggered upon cache invalidation.
   */
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

const DEFAULT_OPTIONS: L1CacheOptions = {
  maxEntries: 1000,
  ttlMs: 60_000,
};

function createSnapshot<T>(entry: CacheEntry<T>): QuerySnapshot<T> {
  return Object.freeze({
    data: entry.optimisticData !== undefined ? entry.optimisticData : entry.data,
    isLoading: entry.status === "pending" && entry.data === undefined,
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
    this.options = {
      maxEntries: options?.maxEntries ?? DEFAULT_OPTIONS.maxEntries,
      ttlMs: options?.ttlMs ?? DEFAULT_OPTIONS.ttlMs,
    };
  }

  getGeneration(storeName: string): number {
    return this.storeGenerations.get(storeName) ?? 0;
  }

  incrementGeneration(storeName: string): number {
    const next = this.getGeneration(storeName) + 1;
    this.storeGenerations.set(storeName, next);
    return next;
  }

  getOrCreateEntry<T>(
    queryHash: string,
    storeNames: string[],
    keyDependency?: IDBValidKey | IDBKeyRange,
    indexDependency?: string,
  ): CacheEntry<T> {
    let entry = this.entries.get(queryHash) as CacheEntry<T> | undefined;

    if (entry) {
      // Cancel GC timer if entry is being reused
      if (entry.gcTimer !== undefined) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = undefined;
      }
      return entry;
    }

    entry = {
      queryHash,
      storeNames: new Set(storeNames),
      keyDependency,
      indexDependency,
      status: "idle",
      data: undefined,
      error: null,
      generationAtStart: 0,
      subscribers: new Set(),
      snapshot: Object.freeze({
        data: undefined,
        isLoading: true,
        isFetching: true,
        error: null,
      }),
    };

    this.entries.set(queryHash, entry as CacheEntry);
    this.enforceMaxEntries();
    return entry;
  }

  getEntry<T>(queryHash: string): CacheEntry<T> | undefined {
    return this.entries.get(queryHash) as CacheEntry<T> | undefined;
  }

  /**
   * Updates the snapshot of a cache entry and notifies subscribers
   * ONLY if the snapshot has actually changed (referential stability).
   */
  updateEntrySnapshot<T>(entry: CacheEntry<T>): void {
    const nextSnapshot = createSnapshot(entry);
    if (entry.snapshot && snapshotsEqual(entry.snapshot, nextSnapshot)) {
      return;
    }
    entry.snapshot = nextSnapshot;
    for (const listener of entry.subscribers) {
      listener();
    }
  }

  /**
   * Mark entry as pending (fetching).
   * Tags the read with current store generation to detect stale reads.
   */
  markPending<T>(entry: CacheEntry<T>, storeNames: string[]): void {
    entry.status = "pending";
    // Record the maximum generation across all dependent stores
    entry.generationAtStart = Math.max(...storeNames.map((s) => this.getGeneration(s)));
    this.updateEntrySnapshot(entry);
  }

  /**
   * Resolve a completed read. Discards the result if a mutation
   * incremented the generation since the read started (zombie read prevention).
   */
  resolve<T>(entry: CacheEntry<T>, data: T): boolean {
    const currentMaxGen = Math.max(
      ...Array.from(entry.storeNames).map((s) => this.getGeneration(s)),
    );

    if (currentMaxGen > entry.generationAtStart) {
      // Stale read — discard result, keep entry in pending for re-fetch
      return false;
    }

    entry.status = "resolved";
    entry.data = data;
    entry.error = null;
    this.updateEntrySnapshot(entry);
    return true;
  }

  reject<T>(entry: CacheEntry<T>, error: Error): void {
    entry.status = "error";
    entry.error = error;
    this.updateEntrySnapshot(entry);
  }

  setPromise(queryHash: string, promise: Promise<unknown>): void {
    const entry = this.entries.get(queryHash);
    if (entry) {
      entry.promise = promise;
    }
  }

  getPromise(queryHash: string): Promise<unknown> | undefined {
    return this.entries.get(queryHash)?.promise;
  }

  /**
   * Apply an optimistic overlay before the transaction commits.
   */
  setOptimistic<T>(entry: CacheEntry<T>, data: T): void {
    entry.optimisticData = data;
    this.updateEntrySnapshot(entry);
  }

  /**
   * Commit the optimistic overlay (transaction succeeded).
   */
  commitOptimistic<T>(entry: CacheEntry<T>): void {
    if (entry.optimisticData !== undefined) {
      entry.data = entry.optimisticData;
      entry.optimisticData = undefined;
      this.updateEntrySnapshot(entry);
    }
  }

  /**
   * Rollback the optimistic overlay (transaction aborted).
   */
  rollbackOptimistic<T>(entry: CacheEntry<T>): void {
    entry.optimisticData = undefined;
    this.updateEntrySnapshot(entry);
  }

  /**
   * Subscribe to snapshot changes. Starts GC timer on last unsubscribe.
   */
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
        entry.fetcher = undefined;
        entry.gcTimer = setTimeout(() => {
          this.entries.delete(queryHash);
        }, this.options.ttlMs);
      }
    };
  }

  /**
   * Invalidate all cache entries that depend on the given store.
   * Returns the list of invalidated query hashes for re-fetching.
   */
  invalidateByStore(storeName: string): string[] {
    return this.invalidateMatching((entry) => entry.storeNames.has(storeName));
  }

  /**
   * Invalidate cache entries matching a predicate.
   * Active subscribers will automatically trigger their fetchers.
   */
  invalidateMatching(predicate: (entry: CacheEntry) => boolean): string[] {
    const invalidated: string[] = [];
    for (const [hash, entry] of this.entries) {
      if (predicate(entry)) {
        entry.status = "idle";
        invalidated.push(hash);
        if (entry.subscribers.size > 0 && entry.fetcher) {
          entry.fetcher().catch(() => {});
        }
      }
    }
    return invalidated;
  }

  getEntries(): IterableIterator<CacheEntry> {
    return this.entries.values();
  }

  private enforceMaxEntries(): void {
    if (this.entries.size <= this.options.maxEntries) return;
    // Evict oldest entries without active subscribers
    for (const [hash, entry] of this.entries) {
      if (entry.subscribers.size === 0) {
        if (entry.gcTimer !== undefined) {
          clearTimeout(entry.gcTimer);
        }
        this.entries.delete(hash);
        if (this.entries.size <= this.options.maxEntries) return;
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
}
