# `reactive-idb` — Production-Grade IndexedDB Engine for React

**Master Architecture, Edge-Case Mitigation & Implementation Blueprint**

---

## 1. Project Overview & Core Philosophy

`reactive-idb` is a zero-dependency, type-safe, reactive IndexedDB state engine built for modern React (React 18/19+). Unlike thin imperative wrappers, `reactive-idb` bridges the fundamental impedance mismatch between **React's synchronous rendering lifecycle (`useSyncExternalStore`)** and **IndexedDB's asynchronous, event-loop-bound transactional model**.

### Core Design Goals

1. **Zero UI Tearing & 0ms Reads:** Synchronous reads via an L1 In-Memory Query Cache with structural sharing and Lamport generation counters.
2. **Microtask Write Coalescing:** Automatically batches concurrent writes across components within the same tick into a single atomic `IDBTransaction` (10x–50x write throughput).
3. **Self-Healing Connection State Machine:** Handles multi-tab `versionchange` deadlocks, Safari background tab disconnects (`InvalidStateError`), and browser storage policy blocks.
4. **Granular Cross-Tab Synchronization:** Key-range and index-aware `BroadcastChannel` invalidation paired with Web Locks API (`navigator.locks`) for safe migrations.
5. **Pluggable Middleware & Graceful Degradation:** Built-in support for field-level encryption (WebCrypto), schema validation, and automatic fallback to an In-Memory Adapter when running in restricted/incognito environments or SSR.

---

## 2. Real-World IndexedDB Failure Modes & Mitigations

Every module in this project must enforce strict guards against the following production browser bugs:

### 2.1 The Microtask Auto-Commit Trap

- **The Bug:** IndexedDB transactions do not stay open across arbitrary `async/await` boundaries. The browser automatically commits a transaction the instant the microtask queue drains without a new `IDBRequest` queued. Calling `await fetch()` or `await crypto.subtle.encrypt()` inside an active transaction throws `TransactionInactiveError`.
- **The Mitigation:** All middleware transformations (validation, encryption, compression) **must execute before opening the `IDBTransaction`** or after the transaction resolves. Inside a transaction loop, only raw `IDBRequest` promises may be scheduled synchronously.

### 2.2 Multi-Tab Upgrade Deadlocks (`versionchange` & `blocked`)

- **The Bug:** Tab A holds DB `v1` open. Tab B loads new deployment code requesting DB `v2`. Tab B's `indexedDB.open('AppDB', 2)` fires `onblocked` and hangs indefinitely unless Tab A calls `db.close()`.
- **The Mitigation:** The Connection Manager listens to `db.onversionchange`. When triggered:
  1. It transitions connection state to `CLOSING_FOR_UPGRADE`.
  2. It awaits any active in-flight `readwrite` batch in the Write Coalescer (max 500ms timeout).
  3. It calls `db.close()` and emits an `onVersionChangeBlocked` event to React so the UI can soft-reload or display an update banner.

### 2.3 Safari / WebKit Background Zombie Connections

- **The Bug:** When an iOS/macOS Safari tab is backgrounded or suspended, WebKit may sever the underlying SQLite lock without firing `db.onclose`. The next `db.transaction()` call throws `InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing` or hangs indefinitely.
- **The Mitigation:**
  1. Wrap `db.transaction()` in a try/catch that traps `InvalidStateError` and `UnknownError`.
  2. On trap, purge the cached `IDBDatabase` singleton, transition state to `RECONNECTING`, re-open the database, and transparently replay the failed operation once.
  3. Listen to `document.visibilitychange`; when returning to `visible`, run a lightweight heartbeat check on the connection.

### 2.4 Main-Thread Structured Clone Jank

- **The Bug:** IndexedDB executes serialization (Structured Clone) synchronously on the main thread before handing off to the background storage thread. Reading/writing large arrays via `getAll()` blocks React rendering frames.
- **The Mitigation:** Implement cursor-based pagination (`cursor.advance(offset)`) so skipped records are never cloned into JS memory, and enforce chunked bulk writes (`chunkSize = 500`).

### 2.5 Unindexable Primitives (`boolean`, `null`, `undefined`)

- **The Bug:** The IndexedDB specification forbids `boolean`, `null`, and `undefined` as valid key types (`IDBValidKey`). Indexing a boolean property (`isArchived: false`) causes records to be silently omitted from index queries or throws `DataError` when querying with `IDBKeyRange.only(true)`.
- **The Mitigation:** The Key Serializer transparently maps booleans (`false` $\rightarrow$ `0`, `true` $\rightarrow$ `1`) in index key paths or provides a virtual index helper.

### 2.6 Stale Read Race Conditions ("Zombie Reads")

- **The Bug:**
  - `t = 0ms`: Component mounts, starts async read `R1` for `users/1`.
  - `t = 5ms`: Optimistic mutation `M1` updates `users/1` to `"Alice (Edited)"` and increments store generation counter $G$ from $1 \rightarrow 2$.
  - `t = 15ms`: Async read `R1` (which started at $G = 1$) resolves with `"Alice"` and overwrites the L1 Cache with stale data.
- **The Mitigation:** Tag every read operation with the store's `generationId` at the time the read begins. When the read resolves, if `currentGenerationId > readStartGenerationId`, discard the read result from overwriting the L1 cache and re-verify.

---

## 3. Directory & Module Architecture

Use this exact modular structure when scaffolding the package:

```text
src/
├── index.ts                      # Public API exports
├── types/
│   ├── schema.ts                 # Type-safe schema DSL, Store & Index inference
│   ├── query.ts                  # KeyRange, Cursor, and Filter types
│   └── status.ts                 # Connection, Quota, and Engine status types
├── core/
│   ├── connection-manager.ts     # FSM for IDBDatabase lifecycle, healing & upgrades
│   ├── migration-runner.ts       # Versioned upgrade execution inside versionchange tx
│   ├── write-coalescer.ts        # Microtask batching queue & atomic transactions
│   ├── cursor-engine.ts          # Index queries, compound keys, .advance() pagination
│   └── memory-adapter.ts         # Fallback Map-based storage engine for SSR/Incognito
├── cache/
│   ├── l1-cache.ts               # Synchronous snapshot store, generation counters, LRU GC
│   └── dependency-tracker.ts     # Matches mutation envelopes against active query ranges
├── sync/
│   ├── broadcast-bus.ts          # Cross-tab BroadcastChannel diff emitter/listener
│   └── lock-coordinator.ts       # Web Locks API wrapper for leader-only operations
├── middleware/
│   ├── pipeline.ts               # Pre-write / Post-read async transformation pipeline
│   └── encryption.ts             # Optional WebCrypto AES-GCM field encryptor
└── react/
    ├── context.tsx               # <IndexedDBProvider> & singleton registry
    ├── use-live-query.ts         # Reactive query hook over useSyncExternalStore
    ├── use-record.ts             # Single-record CRUD + optimistic update hook
    ├── use-mutation.ts           # Batched write, bulkPut, and transactional hook
    └── use-idb-status.ts         # Connection health, storage quota, and upgrade alerts
```

---

## 4. Deep-Dive Module Specifications

### 4.1 Type-Safe Schema Definition (`src/types/schema.ts`)

Developers define their database schema using a declarative TypeScript configuration object. All hooks infer store names, primary key types, value shapes, and index names directly from this object.

```typescript
export type KeyPath<T> = (keyof T & string) | ReadonlyArray<keyof T & string>;

export interface IndexConfig<T> {
  keyPath: KeyPath<T>;
  unique?: boolean;
  multiEntry?: boolean;
}

export interface StoreConfig<TRecord = unknown, TKey extends IDBValidKey = string> {
  keyPath?: keyof TRecord & string;
  autoIncrement?: boolean;
  indexes?: Record<string, IndexConfig<TRecord>>;
}

export type MigrationContext = {
  db: IDBDatabase;
  transaction: IDBTransaction;
  oldVersion: number;
  newVersion: number | null;
};

export interface DatabaseSchema<TStores extends Record<string, StoreConfig<any, any>>> {
  name: string;
  version: number;
  stores: TStores;
  migrations?: Record<number, (ctx: MigrationContext) => void | Promise<void>>;
  options?: {
    coalesceWindowMs?: number; // Default: 0 (microtask)
    cacheMaxEntries?: number; // Default: 1000 queries
    cacheTTLMs?: number; // Default: 60_000ms after 0 subscribers
    enableCrossTabSync?: boolean; // Default: true
    fallbackToMemory?: boolean; // Default: true
    requestPersistentStorage?: boolean; // Default: false
  };
}

// Type Inference Helpers
export type StoreNames<S extends DatabaseSchema<any>> = keyof S["stores"] & string;
export type StoreValue<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends StoreConfig<infer R, any> ? R : never;
export type StoreKey<S extends DatabaseSchema<any>, K extends StoreNames<S>> =
  S["stores"][K] extends StoreConfig<any, infer Key> ? Key : IDBValidKey;
export type StoreIndexes<
  S extends DatabaseSchema<any>,
  K extends StoreNames<S>,
> = keyof S["stores"][K]["indexes"] & string;
```

---

### 4.2 Connection State Machine (`src/core/connection-manager.ts`)

The Connection Manager replaces naive global variables with a deterministic Finite State Machine (FSM).

#### States

$$\text{State} \in \{ \text{SSR}, \text{IDLE}, \text{CONNECTING}, \text{OPEN}, \text{UPGRADING}, \text{BLOCKED}, \text{CLOSING\_FOR\_UPGRADE}, \text{RECONNECTING}, \text{FALLBACK\_MEMORY}, \text{ERROR} \}$$

#### State Transition Rules & Invariants

1. **Deduplicated Open (`CONNECTING`):** Multiple components mounting simultaneously must share the exact same `openPromise`. Never call `indexedDB.open()` twice concurrently for the same DB name.
2. **Handling `onupgradeneeded` (`UPGRADING`):**
   - Diffs `db.objectStoreNames` against `schema.stores`.
   - Automatically creates missing object stores and diffs `store.indexNames` against `schema.stores[name].indexes` (creating new indexes and deleting removed ones).
   - Executes incremental version callbacks in `schema.migrations[v]` for $v \in (\text{oldVersion}, \text{newVersion}]$.
3. **Handling `onblocked` (`BLOCKED`):**
   - Fires when another tab refuses to close an older DB version.
   - Emits a `BLOCKED` status via the status bus and broadcasts a `FORCE_RELEASE_REQUEST` over `BroadcastChannel`.
4. **Handling `onversionchange` (`CLOSING_FOR_UPGRADE`):**
   - Triggered in an older tab when a newer tab initiates an upgrade.
   - Immediately blocks new transactions, awaits active write batches, calls `db.close()`, sets state to `CLOSING_FOR_UPGRADE`, and notifies the React layer via `useIDBStatus()`.
5. **Auto-Healing (`RECONNECTING`):**
   - Exposes `executeWithRetry<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T>`.
   - If `fn` throws `InvalidStateError` (Safari zombie connection), closes the broken reference, resets state to `IDLE`, re-opens the connection, and retries `fn` once.
6. **Fallback Switching (`FALLBACK_MEMORY`):**
   - If `typeof window === 'undefined'` or `window.indexedDB` throws `SecurityError` / `InvalidStateError` / `UnknownError` (corrupted LevelDB backing store), routes all operations to `MemoryAdapter` so the application never white-screens.

---

### 4.3 L1 Synchronous Cache & Dependency Tracker (`src/cache/l1-cache.ts`)

To work seamlessly with React's `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`, `getSnapshot()` **must** be synchronous and return the exact same object reference (`Object.is`) unless underlying data has changed.

#### Cache Entry Structure

```typescript
export interface CacheEntry<T = unknown> {
  queryHash: string;
  storeNames: Set<string>;
  keyDependency?: IDBValidKey | IDBKeyRange;
  indexDependency?: string;
  status: "pending" | "resolved" | "error";
  data: T | undefined;
  error: Error | null;
  generationAtStart: number;
  promise?: Promise<T>; // Used for React <Suspense> support
  subscribers: Set<() => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
}
```

#### Generation Counter & Optimistic Snapshot Stack

- Each store maintains an integer `generationCounter: Map<StoreName, number>` initialized to $0$.
- Whenever a local mutation or remote `BroadcastChannel` message touches `storeName`, `generationCounter` increments: $G_{s} \leftarrow G_{s} + 1$.
- **Optimistic Overlay:** Before a batched write commits to disk, the mutation registers an optimistic patch in `optimisticOverlays: Map<MutationId, Patch>`. `getSnapshot()` merges the base cache entry with active optimistic overlays synchronously.
- **Rollback:** If the `IDBTransaction` aborts, the overlay is deleted from `optimisticOverlays`, and `subscribers` are notified immediately, restoring the prior UI state.
- **Garbage Collection:** When `entry.subscribers.size === 0`, start a `gcTimer` (`cacheTTLMs`, default 60s). If a component remounts within 60s, cancel the timer and serve the cached value instantaneously (SWR pattern).

---

### 4.4 Granular Mutation Envelopes & Dependency Matching (`src/cache/dependency-tracker.ts`)

Avoid re-running every query in the app when a single record changes.

#### Mutation Envelope Schema

```typescript
export interface MutationEnvelope {
  originTabId: string;
  timestamp: number;
  storeName: string;
  operation: "put" | "delete" | "clear" | "bulk";
  affectedKeys: IDBValidKey[]; // Empty if 'clear'
}
```

#### Invalidation Matching Algorithm

When a `MutationEnvelope` arrives (from local `WriteCoalescer` or remote `BroadcastChannel`):

1. Find all `CacheEntry` items where `entry.storeNames.has(envelope.storeName)`.
2. If `envelope.operation === 'clear'` or `entry.keyDependency === undefined` (full store query):
   - Mark entry stale and re-execute query.
3. If `entry.keyDependency` is a specific `IDBValidKey` (e.g., `useRecord('users', 'u_1')`):
   - Only invalidate if `envelope.affectedKeys.includes(entry.keyDependency)`.
4. If `entry.keyDependency` is an `IDBKeyRange`:
   - Only invalidate if `envelope.affectedKeys.some(k => entry.keyDependency.includes(k))`.

---

### 4.5 Microtask Write Coalescer (`src/core/write-coalescer.ts`)

Opening separate `readwrite` transactions for concurrent `.put()` calls causes severe disk-flush contention. The Write Coalescer groups operations queued within the same microtask (or a configurable window, e.g., `5ms`) into a single `IDBTransaction` per store.

#### Execution Flow

```
Component A calls put('users', u1) ──┐
Component B calls put('users', u2) ──┼──► Queue in PendingBatch['users']
Component C calls del('users', u3) ──┘           │
                                                 ▼ (queueMicrotask)
                         ┌───────────────────────────────────────────────┐
                         │ 1. Run Pre-Write Middleware (Async WebCrypto) │
                         │ 2. Open SINGLE db.transaction(['users'], 'rw')│
                         │ 3. Fire store.put(u1), store.put(u2), del(u3) │
                         │    synchronously in the same tick!            │
                         │ 4. On tx.oncomplete:                          │
                         │    - Commit optimistic overlay to L1 Cache    │
                         │    - Broadcast MutationEnvelope to other tabs │
                         │    - Resolve individual Promises (A, B, C)    │
                         │ 5. On tx.onabort / tx.onerror:                │
                         │    - Rollback optimistic overlay in L1 Cache  │
                         │    - Reject individual Promises               │
                         └───────────────────────────────────────────────┘
```

#### Deduplication Rule Inside a Batch

If the same primary key `k` is queued multiple times within the same microtask batch:

- `put(k, v1)` followed by `put(k, v2)` $\rightarrow$ Coalesce to a single `put(k, v2)`.
- `put(k, v1)` followed by `delete(k)` $\rightarrow$ Coalesce to a single `delete(k)`.

---

### 4.6 Cursor & Query Engine (`src/core/cursor-engine.ts`)

Provides a fluent, type-safe query builder that compiles down to native `IDBIndex`, `IDBKeyRange`, and `IDBCursor`.

#### Supported Query Operations

```typescript
db.query("users")
  .where("age")
  .between(18, 65)
  .direction("prev")
  .filter((user) => user.isActive) // JS predicate applied during cursor iteration
  .offset(100) // Uses cursor.advance(100) — zero object allocation!
  .limit(25) // Stops cursor iteration immediately at 25 matches
  .toArray();
```

#### Fast Path Optimization

- If a query has **no JS `.filter()` predicate**, `direction === 'next'`, and `offset === 0`:
  - Use native `storeOrIndex.getAll(keyRange, limit)` instead of `openCursor()`. Native `getAll` executes entirely in C++ and crosses the JS/C++ bridge only once, making it 5x faster than iterating a cursor.
- If `offset > 0`, `direction === 'prev'`, or a custom `.filter()` predicate exists:
  - Fall back to `openCursor(keyRange, direction)`.
  - For `offset > 0` without a custom JS `.filter()`, call `cursor.advance(offset)` on the first iteration before calling `cursor.continue()`.

---

### 4.7 Middleware Pipeline (`src/middleware/pipeline.ts`)

Production applications require audit logging, runtime validation, and encryption at rest.

```typescript
export interface IDBMiddleware<S extends DatabaseSchema<any>> {
  name: string;
  beforeWrite?: <K extends StoreNames<S>>(ctx: {
    storeName: K;
    operation: "put" | "add";
    value: StoreValue<S, K>;
  }) => Promise<StoreValue<S, K>> | StoreValue<S, K>;

  afterRead?: <K extends StoreNames<S>>(ctx: {
    storeName: K;
    value: unknown;
  }) => Promise<StoreValue<S, K>> | StoreValue<S, K>;
}
```

- **CRITICAL IMPLEMENTATION RULE:** Because middleware hooks (`beforeWrite`, `afterRead`) can be asynchronous (e.g., `crypto.subtle.encrypt`), they **must never run while an `IDBTransaction` is open**.
  - `beforeWrite` runs in the `WriteCoalescer` _before_ calling `db.transaction()`.
  - `afterRead` runs _after_ the `IDBTransaction` or `IDBRequest` resolves its raw payload.
  - Note: Encrypted fields cannot be used as IndexedDB indexes unless deterministic hashing (HMAC) is used for the index key.

---

## 5. React Hooks API Specification (`src/react/`)

### 5.1 `<IndexedDBProvider>` (`src/react/context.tsx`)

Initializes the engine instance (or binds a pre-created singleton) and manages lifecycle listeners (`visibilitychange`, `window.onunload` cleanup).

```tsx
const db = createDatabase(schema, { middlewares: [encryptionMiddleware] });

export function App() {
  return (
    <IndexedDBProvider client={db}>
      <Dashboard />
    </IndexedDBProvider>
  );
}
```

### 5.2 `useLiveQuery` (`src/react/use-live-query.ts`)

Subscribes to an arbitrary query or multi-store read and automatically re-renders only when the tracked key-range or store mutates.

```typescript
export interface UseLiveQueryOptions<T> {
  initialData?: T;
  suspense?: boolean;
  enabled?: boolean;
}

export interface UseLiveQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
```

- **Internal Wiring with `useSyncExternalStore`:**
  1. Compute a deterministic `queryHash` from the query builder AST or dependency array (`deps`).
  2. `subscribe(onStoreChange)` registers `onStoreChange` in `l1Cache.getOrCreateEntry(queryHash).subscribers` and triggers initial fetch if `status === 'idle'`.
  3. `getSnapshot()` reads synchronously from `l1Cache.getEntry(queryHash)` and returns a cached frozen status tuple `{ data, isLoading, isFetching, error }` (only creating a new wrapper object when internal values actually change).
  4. `getServerSnapshot()` returns `{ data: options.initialData, isLoading: !options.initialData, isFetching: false, error: null }`.
  5. If `options.suspense === true` and `entry.status === 'pending'`, throw `entry.promise`.

### 5.3 `useRecord` (`src/react/use-record.ts`)

Ergonomic hook for watching and mutating a single record by primary key with built-in optimistic updates.

```typescript
const {
  data: user,
  isLoading,
  error,
  set, // (val: User, opts?: { optimistic?: boolean }) => Promise<void>
  patch, // (partial: Partial<User>, opts?: { optimistic?: boolean }) => Promise<void>
  remove, // () => Promise<void>
} = useRecord("users", userId);
```

### 5.4 `useMutation` (`src/react/use-mutation.ts`)

Provides write primitives that leverage the `WriteCoalescer` and explicit multi-store atomic transactions.

```typescript
const {
  put, // Coalesced single write
  bulkPut, // Chunked high-throughput write
  deleteRecord, // Coalesced delete
  clearStore, // Truncate store
  transaction, // Explicit multi-store atomic transaction
  isPending,
} = useMutation();
```

### 5.5 `useIDBStatus` (`src/react/use-idb-status.ts`)

Exposes operational telemetry for system observability and recovery UIs.

```typescript
export interface IDBStatusSnapshot {
  connectionState: ConnectionState;
  isFallbackMode: boolean; // True if running on MemoryAdapter
  isUpgradeBlocked: boolean; // True if another tab is blocking a version bump
  requiresReloadForUpgrade: boolean; // True if this tab closed its DB for a newer tab
  quota: {
    usageBytes: number | null;
    quotaBytes: number | null;
    percentUsed: number | null;
    isPersisted: boolean | null;
  };
  reconnect: () => Promise<void>;
}
```

---

## 6. Step-by-Step "Vibe Coding" Implementation Roadmap

When prompting an AI coding assistant to build this library, execute in **6 sequential phases** so each layer is unit-tested before the next layer consumes it.

### Phase 1: Types, Schema DSL & Key Serialization

- **Prompt Goal:** Create `src/types/schema.ts`, `src/types/query.ts`, and `src/core/key-serializer.ts`.
- **Key Deliverables:**
  - Full TypeScript generic inference (`StoreNames`, `StoreValue`, `StoreKey`, `StoreIndexes`).
  - Key serializer converting `boolean` $\leftrightarrow$ `0 | 1` and validating `IDBValidKey` constraints.
  - Deterministic query hash generator (`hashQuery(store, index, range, direction, offset, limit)`).

### Phase 2: Memory Fallback Adapter & Connection Manager FSM

- **Prompt Goal:** Create `src/core/memory-adapter.ts`, `src/core/migration-runner.ts`, and `src/core/connection-manager.ts`.
- **Key Deliverables:**
  - Complete FSM handling `open`, `onupgradeneeded` (auto-creating/deleting stores & indexes), `onversionchange` (graceful close), and `onblocked`.
  - Auto-retry wrapper trapping `InvalidStateError` for Safari background recovery.
  - Seamless fallback to `MemoryAdapter` when `indexedDB` is unavailable or corrupted.

### Phase 3: Cursor Engine & Middleware Pipeline

- **Prompt Goal:** Create `src/core/cursor-engine.ts` and `src/middleware/pipeline.ts`.
- **Key Deliverables:**
  - Fluent query builder supporting `.where()`, `.equals()`, `.between()`, `.startsWith()`, `.filter()`, `.offset()`, and `.limit()`.
  - C++ fast-path selector (`getAll` vs `openCursor` + `cursor.advance`).
  - Pre-write and post-read middleware runner strictly isolated outside `IDBTransaction` boundaries.

### Phase 4: L1 Cache, Dependency Tracker & Cross-Tab Sync

- **Prompt Goal:** Create `src/cache/l1-cache.ts`, `src/cache/dependency-tracker.ts`, and `src/sync/broadcast-bus.ts`.
- **Key Deliverables:**
  - Synchronous snapshot registry with referential stability (`Object.is`).
  - Per-store Lamport `generationCounter` preventing stale async reads from overwriting newer mutations.
  - Optimistic overlay stack with instant rollback support.
  - `BroadcastChannel` sync bus filtering out self-originated events via `originTabId` and matching key ranges.

### Phase 5: Microtask Write Coalescer

- **Prompt Goal:** Create `src/core/write-coalescer.ts`.
- **Key Deliverables:**
  - `queueMicrotask` batch accumulator per object store.
  - Key deduplication within the same batch (`put` + `put` $\rightarrow$ last `put`; `put` + `delete` $\rightarrow$ `delete`).
  - Atomic `IDBTransaction` execution, optimistic cache commit on `tx.oncomplete`, and rollback on `tx.onabort`.

### Phase 6: React 18/19 Hooks Layer

- **Prompt Goal:** Create `src/react/context.tsx`, `use-live-query.ts`, `use-record.ts`, `use-mutation.ts`, and `use-idb-status.ts`.
- **Key Deliverables:**
  - `useSyncExternalStore` integration with zero tearing in React `startTransition` and `<Suspense>`.
  - SSR compatibility via `getServerSnapshot`.

---

## 7. Comprehensive Testing & Chaos Verification Suite

Do not rely solely on `jsdom` + `fake-indexeddb`—it runs in Node memory and misses real browser microtask auto-commit and WebKit connection bugs.

### 7.1 Unit & Concurrency Tests (`Vitest` + `fake-indexeddb`)

1. **Microtask Coalescing Verification:**
   - Fire `Promise.all(Array.from({ length: 100 }, (_, i) => put('users', { id: i })))`.
   - Assert via spy on `IDBDatabase.prototype.transaction` that **exactly 1** `readwrite` transaction was opened.
2. **Zombie Read Prevention (Race Condition Test):**
   - Delay an initial `get('users', '1')` read by 50ms using a proxy stub.
   - At 10ms, execute an optimistic `put('users', { id: '1', name: 'New' })`.
   - At 50ms, let the initial read resolve with `{ id: '1', name: 'Old' }`.
   - Assert that `useRecord('users', '1').data.name` remains `'New'`.
3. **Optimistic Rollback on Constraint Violation:**
   - Create a store with `{ unique: true }` on `email`.
   - Insert User A with `a@test.com`.
   - Optimistically update User B to `a@test.com`.
   - Verify the UI immediately reflects `a@test.com`, and when `ConstraintError` aborts the transaction, verify the UI automatically reverts User B to its prior email and populates `error`.
4. **L1 Cache Garbage Collection & Resurrection:**
   - Mount a component using `useLiveQuery`, unmount it, advance fake timers by `30s` (< `60s` TTL), remount, and assert `isLoading === false` on the very first render frame (0ms cache hit).
   - Unmount, advance timers by `61s`, remount, and assert cache entry was evicted.

### 7.2 Real Browser & Multi-Tab Chaos Tests (`Playwright`)

1. **Multi-Tab Version Upgrade Handoff:**
   - Open Page 1 with `schema v1`. Verify connection state is `OPEN`.
   - Open Page 2 in the same browser context with `schema v2` (adding a new store `audit_logs`).
   - Assert Page 1 receives `onversionchange`, flushes pending writes, closes its `v1` handle (`requiresReloadForUpgrade === true`), and Page 2 completes `onupgradeneeded` within `< 200ms` without hanging on `blocked`.
2. **Cross-Tab Granular Invalidation:**
   - Open Page 1 watching `useRecord('users', 'u_1')` and `useRecord('users', 'u_2')` (track render counts).
   - In Page 2, mutate `'u_1'`.
   - Assert Page 1 re-renders the `'u_1'` component with updated data, while the `'u_2'` component has **0 extra re-renders**.
3. **Middleware Async Isolation (Microtask Auto-Commit Check):**
   - Enable the WebCrypto AES-GCM encryption middleware (which uses async `crypto.subtle.encrypt`).
   - Perform a `bulkPut` of 200 records in Chromium, Firefox, and WebKit.
   - Verify zero `TransactionInactiveError` exceptions occur.
4. **Safari Zombie Connection Self-Healing:**
   - Force `db.close()` directly on the underlying raw `IDBDatabase` instance behind the Connection Manager's back (simulating iOS background eviction).
   - Trigger a `useMutation().put()` call.
   - Assert the Connection Manager traps `InvalidStateError`, transparently re-opens the DB, replays the write, and resolves without throwing to the React component.

---

## 8. Reference Core Implementation Skeletons

Use these exact reference patterns when generating the core modules:

### 8.1 Synchronous Snapshot Tuple Pattern (Preventing `useSyncExternalStore` Loops)

```typescript
// Inside L1Cache Entry:
// CRITICAL: Never create a new object inside getSnapshot()!
// Always return the pre-allocated `entry.snapshot` reference and only replace
// `entry.snapshot` when mutating the entry state.

export interface QuerySnapshot<T> {
  readonly data: T | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

function updateEntrySnapshot<T>(entry: CacheEntry<T>): void {
  const nextSnapshot: QuerySnapshot<T> = Object.freeze({
    data: entry.optimisticData !== undefined ? entry.optimisticData : entry.data,
    isLoading: entry.status === "pending" && entry.data === undefined,
    isFetching: entry.status === "pending",
    error: entry.error,
  });

  // Referential equality check before notifying React
  if (
    entry.snapshot &&
    Object.is(entry.snapshot.data, nextSnapshot.data) &&
    entry.snapshot.isLoading === nextSnapshot.isLoading &&
    entry.snapshot.isFetching === nextSnapshot.isFetching &&
    Object.is(entry.snapshot.error, nextSnapshot.error)
  ) {
    return;
  }

  entry.snapshot = nextSnapshot;
  entry.subscribers.forEach((listener) => listener());
}
```

### 8.2 Safe Transaction Loop inside `WriteCoalescer`

```typescript
// CRITICAL: Do NOT `await` individual requests inside the loop if you need
// maximum throughput; queue all IDBRequests synchronously onto the transaction
// and resolve when `tx.oncomplete` fires.

async function flushStoreBatch(
  db: IDBDatabase,
  storeName: string,
  ops: CoalescedOp[],
): Promise<void> {
  // 1. Run async middleware BEFORE opening the IDBTransaction
  for (const op of ops) {
    if (op.type === "put" && middleware.beforeWrite) {
      op.transformedValue = await middleware.beforeWrite({
        storeName,
        operation: "put",
        value: op.rawValue,
      });
    }
  }

  // 2. Open transaction and schedule all requests synchronously
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite", { durability: "relaxed" });
    const store = tx.objectStore(storeName);

    for (const op of ops) {
      try {
        const req =
          op.type === "put"
            ? op.key !== undefined
              ? store.put(op.transformedValue, op.key)
              : store.put(op.transformedValue)
            : store.delete(op.key!);

        req.onsuccess = () => {
          op.resultKey = req.result;
        };
        req.onerror = () => {
          op.requestError = req.error;
        };
      } catch (syncErr) {
        op.requestError = syncErr as Error;
      }
    }

    tx.oncomplete = () => {
      for (const op of ops) {
        if (op.requestError) op.reject(op.requestError);
        else op.resolve(op.resultKey);
      }
      resolve();
    };

    tx.onabort = () => {
      const abortErr = tx.error ?? new DOMException("Transaction aborted", "AbortError");
      for (const op of ops) {
        op.reject(op.requestError ?? abortErr);
      }
      reject(abortErr);
    };

    tx.onerror = () => {
      // Handled via onabort unless stopPropagation() was called
    };
  });
}
```

---

## 9. Package Configuration & Build Constraints

- **Target Bundle Size:** `< 4.5 kB` min+gzip (Zero runtime dependencies; React 18/19 as peer dependency).
- **Module Formats:** Dual ESM (`.mjs`) and CJS (`.cjs`) via `tsup` with `"sideEffects": false` for tree-shaking.
- **TypeScript Config:** `"strict": true`, `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`.
