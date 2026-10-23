# use-idb

**Typed, reactive IndexedDB for React 18+ and TypeScript.** Build browser-persistent features with a schema-first database API, live React hooks, typed queries, and optional encryption—without maintaining a separate state cache yourself.

<p align="left">
  <a href="https://www.npmjs.com/package/@inevitable_divu/use-idb"><img src="https://img.shields.io/npm/v/%40inevitable_divu%2Fuse-idb?label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@inevitable_divu/use-idb"><img src="https://img.shields.io/npm/dm/%40inevitable_divu%2Fuse-idb?label=downloads" alt="npm downloads"></a>
  <a href="https://github.com/inevitableDivu/use-idb/actions/workflows/ci.yml"><img src="https://github.com/inevitableDivu/use-idb/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/inevitableDivu/use-idb/blob/main/LICENSE"><img src="https://img.shields.io/github/license/inevitableDivu/use-idb" alt="MIT license"></a>
</p>

- **Quick start:** install the package and build a typed, reactive list in a few minutes.
- **Full guide:** schema design, CRUD, querying, hooks, configuration, migrations, encryption, and operational behavior are covered below.
- **Runnable examples:** see the <a href="https://github.com/inevitableDivu/use-idb/tree/main/examples">examples directory</a> and <a href="https://github.com/inevitableDivu/use-idb/blob/main/examples/README.md">examples guide</a>.
- **Release notes:** see the <a href="https://github.com/inevitableDivu/use-idb/blob/main/CHANGELOG.md">changelog</a>.

> **What this is:** a client-side storage and React reactivity layer built on IndexedDB. It is not a server database, a cloud-sync service, or a conflict-resolution system. Your application remains responsible for authentication, server synchronization, validation, and multi-writer conflict handling.

## Contents

- [Why use-idb](#why-use-idb)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Simple key-value state](#simple-key-value-state)
- [Define a database and stores](#define-a-database-and-stores)
- [CRUD and transactions](#crud-and-transactions)
- [Queries](#queries)
- [React hooks](#react-hooks)
- [Runtime configuration](#runtime-configuration)
- [Schema migrations](#schema-migrations)
- [Encryption and security](#encryption-and-security)
- [Storage, lifecycle, and performance](#storage-lifecycle-and-performance)
- [Troubleshooting](#troubleshooting)
- [API overview](#api-overview)
- [License](#license)

## Why use-idb

IndexedDB is asynchronous and useful for persistent browser data, but connecting it to a React UI usually requires extra code for caching, loading states, subscriptions, invalidation, and concurrent writes. The package brings those pieces together.

- **Typed schemas:** infer store names, record types, keys, and index values from your definitions.
- **Reactive reads:** <code>useRecord</code> and <code>useLiveQuery</code> subscribe to cached data through React's <code>useSyncExternalStore</code>.
- **Committed writes:** write promises resolve after the underlying storage transaction commits; failed writes reject.
- **Batched writes:** compatible writes queued in the same microtask can share a transaction.
- **IndexedDB queries:** fluent filters, indexes, key ranges, cursor direction, pagination, projections, and query-plan inspection.
- **Cross-tab invalidation:** tabs notify each other that data changed; each tab refreshes from its own database.
- **Optional AES-GCM middleware:** encrypt selected fields using the Web Crypto API.
- **Pluggable infrastructure:** custom storage, sync, and lock adapters; bounded cache configuration; diagnostics; optional memory fallback.
- **Rich values:** the built-in serializer supports values including <code>Date</code>, <code>BigInt</code>, <code>Map</code>, <code>Set</code>, <code>ArrayBuffer</code>, typed arrays, <code>DataView</code>, <code>undefined</code>, and special numeric values.

The package has root, <code>./react</code>, and <code>./core</code> exports. React is a peer dependency (<code>react &gt;=18</code>).

## Installation

Choose your package manager:

```bash
npm install @inevitable_divu/use-idb
# or
pnpm add @inevitable_divu/use-idb
# or
yarn add @inevitable_divu/use-idb
```

For React hooks, your application must also have React installed. This package ships TypeScript declarations.

## Quick start

This example creates a typed <code>todos</code> store and a React component that automatically refreshes when matching records change. It uses the public package export and can be adapted to a Vite, Next.js, or other React application.

### 1. Define the database

Create <code>src/db.ts</code>:

```ts
import { createDatabase, createDatabaseHooks, store } from "@inevitable_divu/use-idb";

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: Date;
}

export const db = createDatabase({
  name: "my-app",
  version: 1,
  stores: {
    todos: store<Todo>()({
      keyPath: "id",
      indexes: {
        by_done: "done",
        by_created: "createdAt",
      },
    }),
  },
});

export const { useLiveQuery, useMutation, useRecord, useIDBStatus } = createDatabaseHooks(db);
```

The <code>name</code> identifies this database in the browser, and <code>version</code> controls schema upgrades. Store definitions are persistent schema: changing the primary key configuration of an existing store requires a migration (see [Schema migrations](#schema-migrations)).

### 2. Use it in a component

Create <code>src/TodoList.tsx</code>:

```tsx
import { useLiveQuery, useMutation } from "./db";

export function TodoList() {
  const {
    data: todos = [],
    isLoading,
    error,
    refetch,
  } = useLiveQuery(
    (database) =>
      database.query("todos").where("by_done").equals(false).orderBy("createdAt", "desc").toArray(),
    [],
  );

  const { put, deleteRecord, isPending } = useMutation("todos");

  async function addTodo() {
    await put({
      id: crypto.randomUUID(),
      title: "Read the use-idb guide",
      done: false,
      createdAt: new Date(),
    });
  }

  if (isLoading) return <p>Loading todos…</p>;
  if (error) return <p role="alert">Could not load todos: {error.message}</p>;

  return (
    <section>
      <button disabled={isPending} onClick={() => void addTodo().catch(console.error)}>
        Add todo
      </button>
      <button onClick={() => void refetch()}>Refresh</button>

      {todos.length === 0 ? (
        <p>No open todos yet.</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              {todo.title}
              <button
                disabled={isPending}
                onClick={() => void deleteRecord(todo.id).catch(console.error)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

That's the basic workflow: define a store, query it in a hook, and write through a mutation. The live query tracks its store dependencies and re-renders after local changes and supported cross-tab invalidations. Production applications should handle mutation failures with their own user-facing error state instead of only logging them.

## Simple key-value state

For a single preference or other small key-value use case, you can use <code>useIdb</code> without defining a schema or hook factory:

```tsx
import { useIdb } from "@inevitable_divu/use-idb";

export function ThemeToggle() {
  const {
    value: theme = "light",
    setValue,
    loading,
    error,
  } = useIdb<"light" | "dark">("app-theme", { defaultValue: "light" });

  if (error) return <p role="alert">{error.message}</p>;

  return (
    <button
      disabled={loading}
      onClick={() =>
        void setValue((current) => (current === "dark" ? "light" : "dark")).catch(console.error)
      }
    >
      Theme: {theme}
    </button>
  );
}
```

By default, <code>useIdb</code> uses the shared database named <code>**use_idb_default**</code> and the <code>keyval</code> object store. You can specify another <code>storeName</code>. Its result contains <code>value</code>, <code>setValue</code>, <code>remove</code>, <code>loading</code>, and <code>error</code>.

Use the schema-based API for applications with multiple entities, indexes, typed queries, migrations, or more explicit storage configuration.

## Define a database and stores

### Inline primary keys

Use <code>store&lt;T&gt;()({...})</code> to declare a record shape and its key path. Index aliases can be simple field names or objects with index options.

```ts
import { createDatabase, store } from "@inevitable_divu/use-idb";

interface User {
  id: string;
  email: string;
  role: "admin" | "member";
  tags: string[];
  createdAt: Date;
}

export const db = createDatabase({
  name: "users-db",
  version: 1,
  stores: {
    users: store<User>()({
      keyPath: "id",
      indexes: {
        by_email: { keyPath: "email", unique: true },
        by_role: "role",
        by_tag: { keyPath: "tags", multiEntry: true },
        by_created: "createdAt",
      },
    }),
  },
});
```

- <code>keyPath</code> identifies the primary key on each record. For a compound key, use a tuple such as <code>["workspaceId", "userId"]</code>.
- <code>indexes</code> defines the secondary indexes you can query. Use <code>unique: true</code> when duplicates should be rejected.
- <code>multiEntry: true</code> indexes each item in an array-valued property; it cannot be combined with a compound index key path.
- Use stable database names and increase <code>version</code> when you need a schema upgrade.

### Out-of-line primary keys

Use <code>outOfLineStore&lt;TItem, TKey&gt;()({...})</code> when the key is passed separately and is not stored on the record itself:

```ts
import { createDatabase, outOfLineStore } from "@inevitable_divu/use-idb";

interface AuditEvent {
  type: "created" | "updated";
  occurredAt: Date;
}

const auditDb = createDatabase({
  name: "audit-db",
  version: 1,
  stores: {
    events: outOfLineStore<AuditEvent, string>()({
      indexes: { by_type: "type" },
    }),
  },
});

await auditDb.put("events", { type: "created", occurredAt: new Date() }, "event-1");
const event = await auditDb.get("events", "event-1");
```

## CRUD and transactions

The database instance exposes typed storage operations. These examples assume <code>db</code> has a <code>users</code> store.

```ts
// Insert or replace a record. Inline-key stores read the key from the record.
await db.put("users", {
  id: "u-1",
  email: "ada@example.com",
  role: "admin",
  tags: ["engineering"],
  createdAt: new Date(),
});

// Read one record; a missing key returns undefined.
const user = await db.get("users", "u-1");

// Delete one record or clear the whole store.
await db.delete("users", "u-1");
await db.clear("users");

// Read matching records through the query builder.
const admins = await db.query("users").where("by_role").equals("admin").toArray();
```

A write resolves after the owning storage transaction commits. If the transaction aborts, the write rejects and committed cache state is not published.

### Atomic operations across stores

Use <code>db.transaction</code> when a set of changes must succeed or fail together:

```ts
// Assumes db has "inventory" and "orders" stores.
interface InventoryItem {
  id: string;
  remaining: number;
}

await db.transaction(["inventory", "orders"], "readwrite", async (tx) => {
  const item = await tx.get<InventoryItem>("inventory", "item-1");
  if (!item || item.remaining < 1) {
    throw new Error("Item is unavailable");
  }

  await tx.put("inventory", { ...item, remaining: item.remaining - 1 });
  await tx.put("orders", {
    id: crypto.randomUUID(),
    itemId: "item-1",
    placedAt: new Date(),
  });
});
```

Keep transaction callbacks focused on database work. IndexedDB transactions can become inactive while waiting for network requests, timers, or unrelated asynchronous tasks. Do not use this as a place to await remote API calls.

**Middleware limitation:** explicit <code>db.transaction()</code> is rejected with <code>TransactionMiddlewareUnsupportedError</code> when middleware is configured. This prevents async middleware—such as Web Crypto encryption—from being silently bypassed or awaited unsafely inside a live IndexedDB transaction. For middleware-enabled databases, use the normal middleware-aware CRUD and batch operations or redesign the operation boundary.

### Synchronous record updates

For a database without middleware, <code>db.update(storeName, key, updater)</code> performs a short readwrite transaction with a synchronous updater. Keep the updater pure and synchronous; it can fail if the transaction aborts. This helper is unavailable when middleware is configured.

## Queries

Queries use IndexedDB stores, indexes, and cursors where possible. The fluent builder is typed from the store definition.

```ts
// Exact index match.
const admins = await db.query("users").where("by_role").equals("admin").toArray();

// A range on an index.
const recentUsers = await db
  .query("users")
  .where("by_created")
  .above(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
  .toArray();

// Filter query results further.
const taggedAdmins = await db
  .query("users")
  .where("by_role")
  .equals("admin")
  .filter((user) => user.tags.includes("engineering"))
  .toArray();

// Sort, paginate, and count.
const firstPage = await db
  .query("users")
  .orderBy("createdAt", "desc")
  .offset(0)
  .limit(20)
  .toArray();
const totalAdmins = await db.query("users").where("by_role").equals("admin").count();
const firstAdmin = await db.query("users").where("by_role").equals("admin").first();

// Return only selected fields.
const summaries = await db.query("users").select("id", "email").toArray();
```

### Query operators

Use <code>where(fieldOrIndexName)</code> followed by one of:

- **Matching:** <code>equals(value)</code>, <code>notEquals(value)</code>, <code>anyOf(values)</code>
- **Ranges:** <code>gt(value)</code>, <code>gte(value)</code>, <code>lt(value)</code>, <code>lte(value)</code>, <code>between(lower, upper, includeLower?, includeUpper?)</code>, <code>above(value)</code>, <code>below(value)</code>, <code>startsWith(prefix)</code>
- **Composition and post-processing:** <code>and(fieldOrIndexName)</code>, <code>filter(predicate)</code>, <code>orderBy(field, "asc" | "desc")</code>
- **Traversal and results:** <code>direction("next" | "nextunique" | "prev" | "prevunique")</code>, <code>offset(count)</code>, <code>limit(count)</code>, <code>select(...fields)</code>, <code>toArray()</code>, <code>first()</code>, <code>count()</code>, <code>explain()</code>

Prefer indexed fields for high-volume filtering. JavaScript <code>filter</code> predicates and some sort/pagination combinations may require reading or sorting results in memory. <code>explain()</code> reports the selected access path and whether filtering, sorting, or pagination requires post-processing.

## React hooks

Create hooks once at module scope with <code>createDatabaseHooks(db)</code>. The factory binds store names, record types, and key types to the database configuration.

### <code>useRecord(storeName, key, options?)</code>

Subscribe to one record. It returns <code>data</code>, <code>isLoading</code>, <code>isFetching</code>, <code>error</code>, <code>set(value)</code>, <code>patch(partial)</code>, and <code>remove()</code>.

```tsx
function UserName({ id }: { id: string }) {
  const { data: user, isLoading, patch, error } = useRecord("users", id);

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!user) return <p>User not found</p>;

  return (
    <button onClick={() => void patch({ role: "member" }).catch(console.error)}>
      {user.email} — change role
    </button>
  );
}
```

<code>set</code> replaces the record; <code>patch</code> applies a shallow patch to an existing record; <code>remove</code> deletes it. The optional <code>optimistic</code> setting controls whether the cache is updated before the write commits. The hook does not create a missing record just because you call <code>patch</code>.

### <code>useLiveQuery(queryFn, deps, options?)</code>

Subscribe to a query and re-render when tracked data changes. The result contains <code>data</code>, <code>isLoading</code>, <code>isFetching</code>, <code>error</code>, and <code>refetch()</code>.

```tsx
const result = useLiveQuery(
  (database) => database.query("users").where("by_role").equals(role).toArray(),
  [role],
);
```

Treat the callback as a **pure query description**. It may be invoked more than once as dependencies are inspected and data is fetched. Do not perform writes, analytics, or other side effects inside it.

For custom asynchronous work, pass an explicit <code>stores</code> list so changes to those stores invalidate the query. The factory-bound hook can run custom async work as well:

```tsx
const { data, error } = useLiveQuery(
  async () => {
    const response = await fetch("/api/suggestions");
    if (!response.ok) throw new Error("Could not load suggestions");
    return response.json() as Promise<string[]>;
  },
  [],
  { stores: ["users"], queryKey: "user-suggestions" },
);
```

The unbound <code>useLiveQuery</code> export also accepts a second callback context with an <code>AbortSignal</code> for cancellable async work. When it must use a particular database instance, render the component below <code>IndexedDBProvider</code>.

Other options include <code>initialData</code>, <code>enabled</code>, <code>queryKey</code>, and <code>suspense</code>. Use <code>queryKey</code> to distinguish otherwise similar queries when captured state affects results.

### <code>useMutation(storeName)</code>

Provides <code>put</code>, <code>bulkPut</code>, <code>deleteRecord</code>, <code>remove</code>, and <code>clearStore</code>, together with <code>isPending</code> and <code>error</code>. The factory-generated mutation hook is scoped to one store. <code>bulkPut</code> writes in chunks; its default chunk size is 500 records.

### <code>useIDBStatus()</code>

Read storage and connection status, including <code>connectionState</code>, <code>isFallbackMode</code>, <code>fallbackReason</code>, <code>isUpgradeBlocked</code>, <code>requiresReloadForUpgrade</code>, and quota/persistence information. The result also includes <code>refreshQuota()</code> and <code>reconnect()</code>.

Use status in your UI when persistence matters. A write to in-memory fallback storage is not equivalent to durable IndexedDB persistence.

### React Suspense and context

<code>useLiveQuery</code> supports an opt-in <code>{ suspense: true }</code> option. Place the component below a React <code>&lt;Suspense fallback={...}&gt;</code> boundary. Suspense is optional; the ordinary loading/error result contract remains available for non-Suspense use.

<code>IndexedDBProvider</code> and <code>useDatabase</code> are available for applications that want to supply/read an engine through context. When using <code>createDatabaseHooks(db)</code>, the hooks are already bound to that instance.

## Runtime configuration

The recommended configuration separates the persistent schema from runtime behavior:

```ts
import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Draft {
  id: string;
  title: string;
}

const db = createDatabase({
  schema: {
    name: "drafts-db",
    version: 1,
    stores: {
      drafts: store<Draft>()({ keyPath: "id" }),
    },
  },
  cache: {
    maxEntries: 1000,
    ttlMs: 60_000,
  },
  writes: {
    coalesceWindowMs: 0,
  },
  crossTab: {
    enabled: true,
  },
  fallback: {
    strategy: "error",
    requestPersistentStorage: true,
  },
  diagnostics: {
    onEvent(event) {
      console.info("use-idb", event.type);
    },
    onError(error) {
      console.error("use-idb", error);
    },
  },
});
```

All groups are optional. Important settings:

| Option                                                  | Purpose                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| <code>adapters</code>                                   | Supply custom <code>storage</code>, <code>sync</code>, or <code>lock</code> adapters.                                                    |
| <code>middleware</code>                                 | Ordered middleware such as serialization or field encryption.                                                                            |
| <code>cache.maxEntries</code>, <code>cache.ttlMs</code> | Cache capacity and time-to-live. Defaults: 1,000 entries and 60,000 ms. Active subscriptions can keep the cache above the soft capacity. |
| <code>writes.coalesceWindowMs</code>                    | Write coalescing window in milliseconds. Defaults to <code>0</code>, which coalesces writes queued in the same microtask.                |
| <code>crossTab.enabled</code>                           | Enable cross-tab invalidation; enabled by default.                                                                                       |
| <code>fallback.strategy</code>                          | <code>"memory"</code> to allow volatile in-memory fallback, or <code>"error"</code> to fail if IndexedDB cannot be used.                 |
| <code>fallback.requestPersistentStorage</code>          | Ask the browser for persistent storage on a best-effort basis; the browser decides whether to grant it.                                  |
| <code>diagnostics</code>                                | Optional event/error callbacks. Exceptions thrown by diagnostics callbacks do not change storage outcomes.                               |

The backward-compatible form <code>createDatabase(schema, { middlewares: [...] })</code> is also supported. In the grouped runtime API the option is named <code>middleware</code> (singular).

Schema and migration failures are not silently converted into memory fallback. For applications where durability is required, consider <code>fallback: { strategy: "error" }</code> and expose storage status to users.

## Schema migrations

Increase the database <code>version</code> when adding or changing stores and indexes. Migrations run during the synchronous IndexedDB version-change transaction.

```ts
import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Profile {
  id: string;
  fullName: string;
  displayName?: string;
}

const db = createDatabase({
  name: "profiles-db",
  version: 2,
  stores: {
    profiles: store<Profile>()({
      keyPath: "id",
      indexes: { by_display_name: "displayName" },
    }),
  },
  migrations: {
    2: ({ transaction }) => {
      const profiles = transaction.objectStore("profiles");
      const request = profiles.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;

        const profile = cursor.value as Profile;
        if (profile.displayName === undefined) {
          cursor.update({ ...profile, displayName: profile.fullName });
        }
        cursor.continue();
      };
    },
  },
});
```

Key rules:

- Keep migrations synchronous in the IndexedDB sense: use requests/cursors inside the version-change transaction; do not await network calls or unrelated promises.
- Index definitions can be reconciled during an upgrade, but changing a store's primary <code>keyPath</code> or <code>autoIncrement</code> setting requires an explicit migration that rebuilds the store and copies the existing data.
- Test upgrades from every schema version you support, not only a fresh database.
- If another open tab prevents an upgrade, close/reload that tab and inspect <code>useIDBStatus()</code> for blocked-upgrade status.

## Encryption and security

<code>createEncryptionMiddleware</code> can encrypt selected fields with AES-GCM through the browser's Web Crypto API. It supports key rings so older ciphertext can be read while new writes use a new primary key.

```ts
import { createDatabase, createEncryptionMiddleware, store } from "@inevitable_divu/use-idb";

interface PrivateNote {
  id: string;
  title: string;
  secret: string;
}

export function createPrivateNotesDatabase(encryptionKey: CryptoKey) {
  return createDatabase(
    {
      name: "private-notes",
      version: 1,
      stores: {
        notes: store<PrivateNote>()({ keyPath: "id" }),
      },
    },
    {
      middlewares: [createEncryptionMiddleware(encryptionKey, ["secret"])],
    },
  );
}
```

**Security responsibilities remain with the application:**

- Manage keys separately from the encrypted records. Do not store the encryption key beside the ciphertext.
- Plan key persistence, recovery, rotation, and loss behavior. An in-memory non-extractable key will not automatically survive a reload.
- Encryption protects selected stored fields; it does not secure a compromised application runtime or replace authorization, XSS defenses, or server-side access controls.
- Ciphertext is bound to store, field, and primary key when the key is available. For auto-generated keys that are not known before encryption, that per-record binding cannot provide the same protection against ciphertext being moved between records.
- Middleware uses asynchronous transformations, so explicit <code>db.transaction()</code> and <code>db.update()</code> are intentionally unavailable with middleware configured. Use the regular middleware-aware mutation methods.

See [encrypted private notes](https://github.com/inevitableDivu/use-idb/blob/main/examples/encrypted-private-notes.ts) for a fuller example.

## Storage, lifecycle, and performance

### Browser storage and memory fallback

IndexedDB is browser-managed storage and can be cleared by the user, browser settings, eviction, private browsing restrictions, or test environments. It is not a backup system.

If configured to fall back to memory, the package uses volatile, process-local storage. Data in that mode is not durable across reloads and is not shared between tabs. Check <code>useIDBStatus().isFallbackMode</code> and <code>fallbackReason</code> before telling users that changes are safely persisted. Use <code>fallback.strategy: "error"</code> when silently switching to volatile storage would be unacceptable.

The persistent-storage request is best effort. A request does not guarantee that a browser will grant persistence or retain data indefinitely.

### Cross-tab behavior

Cross-tab messages are versioned invalidation hints, not a replication log. A receiving tab refreshes from its own IndexedDB database; messages do not contain records and do not resolve conflicting simultaneous edits. Cross-tab invalidation is disabled while using isolated in-memory fallback storage.

### Cache, optimistic updates, and writes

The hooks use a synchronous cache snapshot to integrate with React rendering. Mutations can optimistically update this snapshot; the promise still indicates whether storage committed. Failed writes reject and optimistic changes are rolled back. Disable optimistic behavior for supported hooks if the UI should wait for persistence.

Compatible writes queued in the same microtask may be combined into a transaction. This reduces overhead for some workloads, but throughput and latency depend on the browser, data size, indexes, and access pattern; the package does not promise a fixed performance improvement.

### Server rendering

IndexedDB is a browser API. During server rendering, hooks use server-safe snapshots rather than reading browser storage. Render an appropriate fallback and let the client hydrate/read persisted data. Do not treat IndexedDB contents as available to server components or as a server-side data store.

## Troubleshooting

| Symptom                                            | What to check                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data seems to disappear after reload               | Check whether the engine fell back to memory, whether the browser cleared storage, and whether the database name/version changed.                         |
| An upgrade is blocked                              | Close other tabs running an older connection, then reload as needed. Inspect <code>isUpgradeBlocked</code> and <code>requiresReloadForUpgrade</code>.     |
| A query does not rerun when captured state changes | Include relevant values in the <code>deps</code> array and use <code>queryKey</code> when distinct query identities need to be represented.               |
| A live-query callback seems to run more than once  | This is part of dependency discovery and fetching. Keep the callback pure and move side effects outside it.                                               |
| Writes fail with middleware enabled                | Use CRUD/batch APIs. Explicit transactions and <code>db.update()</code> cannot run with middleware.                                                       |
| TypeScript rejects a field or key                  | Define stores with <code>store&lt;T&gt;()({...})</code> or <code>outOfLineStore&lt;TItem, TKey&gt;()({...})</code> and query declared fields/indexes.     |
| React UI does not reflect a custom async query     | Declare affected stores in <code>options.stores</code> and provide a stable <code>queryKey</code> when needed. Use the abort signal for cancellable work. |

## API overview

| API                                                       | Purpose                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| <code>createDatabase(schema)</code>                       | Create or retrieve an engine for a typed database schema.       |
| <code>store&lt;T&gt;()({...})</code>                      | Define a typed store with an inline primary key.                |
| <code>outOfLineStore&lt;TItem, TKey&gt;()({...})</code>   | Define a typed store whose primary key is passed separately.    |
| <code>createDatabaseHooks(db)</code>                      | Create schema-bound React hooks.                                |
| <code>useIdb(key, options?)</code>                        | Simple reactive key-value hook backed by the default database.  |
| <code>useRecord(store, key, options?)</code>              | Subscribe to one record and set, patch, or remove it.           |
| <code>useLiveQuery(queryFn, deps, options?)</code>        | Subscribe to query results.                                     |
| <code>useMutation(store)</code>                           | Perform store-scoped writes, batch writes, deletes, and clears. |
| <code>useIDBStatus()</code>                               | Read connection, fallback, upgrade, and storage quota status.   |
| <code>db.get/put/delete/clear(...)</code>                 | Core CRUD operations.                                           |
| <code>db.query(store)</code>                              | Build a typed IndexedDB query.                                  |
| <code>db.transaction(stores, mode, callback)</code>       | Run explicit atomic transaction work (without middleware).      |
| <code>createEncryptionMiddleware(key, fields)</code>      | Encrypt selected fields through Web Crypto.                     |
| <code>IndexedDBProvider</code> / <code>useDatabase</code> | Provide or access an engine through React context.              |

Imports are available from <code>@inevitable_divu/use-idb</code>; React-only APIs are also available from <code>@inevitable_divu/use-idb/react</code>, and core engine APIs from <code>@inevitable_divu/use-idb/core</code>.

## Examples and release notes

The [examples directory](https://github.com/inevitableDivu/use-idb/tree/main/examples) covers typed CRUD, live React lists, multi-entry indexes, offline outboxes, compound keys, schema migration, atomic multi-store updates, field encryption, cross-tab invalidation, and bulk import/export. Start with the [examples guide](https://github.com/inevitableDivu/use-idb/blob/main/examples/README.md).

For release-specific changes and migration notes, see the [changelog](https://github.com/inevitableDivu/use-idb/blob/main/CHANGELOG.md). Bugs and feature requests belong in [GitHub Issues](https://github.com/inevitableDivu/use-idb/issues).

## License

MIT © [Divyansh Pandey](https://github.com/inevitableDivu)
