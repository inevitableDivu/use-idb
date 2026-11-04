# Changelog

Notable user-facing changes are recorded here. Versions are published only after the corresponding release workflow succeeds.

## 1.5.2 — Security Hardening & Developer Experience Release (2026-11-04)

### Security & Cryptography

- **Decrypted Query Predicate Filtering**: Postpone in-memory filter predicates in `src/core/query-engine.ts` until records are decrypted via `middleware.runAfterRead`, preventing ciphertext leaks and incorrect filter evaluation on raw encrypted payloads ([#18](https://github.com/inevitableDivu/use-idb/issues/18)).
- **Prototype Pollution Defense in Serializer**: Sanitize decoded property keys against `__proto__`, `constructor`, and `prototype` in tagged object envelopes, legacy records, and JSON revivers; also filter dangerous keys during serialization ([#26](https://github.com/inevitableDivu/use-idb/issues/26)).
- **WebCrypto Key Generation & Derivation Helpers**: Added standard client-side encryption utility functions `generateEncryptionKey()`, `deriveEncryptionKey()` (PBKDF2 with SHA-256), `exportKeyRaw()`, and `importKeyRaw()` to eliminate WebCrypto boilerplate ([#24](https://github.com/inevitableDivu/use-idb/issues/24)).
- **Remote Lock Release Hardening**: Ignored unauthenticated `force_release` cross-tab messages unless the engine is actively closing for a local schema upgrade ([#20](https://github.com/inevitableDivu/use-idb/issues/20)).

### Core Engine & Platform Support

- **Web Worker & Service Worker Scope Support**: Extended global scope detection in `src/core/adapter-factory.ts` and `src/adapters/sync/broadcast-adapter.ts` (`WorkerGlobalScope`, `'importScripts' in self`) so IndexedDB and BroadcastSync operate seamlessly in worker threads ([#19](https://github.com/inevitableDivu/use-idb/issues/19)).
- **Safari Event Listener Cleanup**: Removed `visibilitychange` listeners on database close in `IDBStorageAdapter` to avoid document listener leaks during repeated connect/close cycles in Safari ([#20](https://github.com/inevitableDivu/use-idb/issues/20)).
- **Chained Range Bound Merging**: Merged existing lower and upper bounds into `IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)` when chaining range operators (such as `above()` and `below()`), fixing bound clobbering ([#23](https://github.com/inevitableDivu/use-idb/issues/23)).
- **HMR & Fast Refresh Registry Protection**: Replaced reference-based `identityOf` in `src/core/database-registry.ts` with normalized function signature serialization for migrations and diagnostic handlers, preventing false `DatabaseConfigurationConflictError` throws during Vite/Next.js hot reloads ([#25](https://github.com/inevitableDivu/use-idb/issues/25)).

### React & Developer Experience

- **Typed `useIdb` in `createDatabaseHooks`**: Added custom engine binding support to `useIdb` and exposed typed `useIdb` from the `createDatabaseHooks` factory, allowing component-level custom store access with full TypeScript autocompletion ([#21](https://github.com/inevitableDivu/use-idb/issues/21)).
- **Async Query Store Dependency Warnings**: Added non-production warning when `useLiveQuery` receives an `async` query callback without explicit `stores: [...]` options, helping developers avoid missed updates from asynchronous dependency discovery ([#22](https://github.com/inevitableDivu/use-idb/issues/22)).

## 1.3.0 — Documentation & Packaging (2026-10-23)

- Package documentation rewrite and README improvements.
- CI and release workflow hardening.

## 1.2.0 — Prepared release (2026-10-23)

### Reliability and correctness

- Resolve IndexedDB write, delete, clear, and batch operations only after the owning transaction commits.
- Avoid replaying user-provided transaction callbacks when retrying transient IndexedDB failures.
- Serialize write-coalescer flushes per object store and drain pending operations before closing or destroying an engine.
- Isolate optimistic cache overlays by mutation ID so rolling back one write does not erase newer updates.
- Track query freshness per dependent store and prevent incompatible index key ranges from leaking across composed predicates.
- Invalidate all affected query subscriptions after a committed explicit read-write transaction.
- Make schema upgrades detect changed index key paths and uniqueness/multi-entry settings.
- Validate schema definitions and runtime tuning options before database registration.
- Make the memory adapter schema-aware, clone-isolated, transactionally staged, conflict-detecting, and atomic for batches and unique-index constraints.
- Restrict memory fallback to recognized availability/security failures instead of hiding schema and migration errors.
- Turn off BroadcastChannel notifications when using isolated memory fallback storage.

### Developer experience

- Implement the persistent-storage request option as a best-effort browser request.
- Expose fallback reasons and a quota/persistence refresh action through the status API.
- Validate writes against configured inline key paths, including writes inside explicit transactions.
- Version and validate cross-tab mutation envelopes while accepting unversioned envelopes during rolling upgrades.
- Export actionable schema-registration and middleware/transaction errors.
- Document that live-query callbacks should be pure and that explicit transactions are not supported while middleware is enabled, because asynchronous middleware cannot safely run inside an active IndexedDB transaction.

### Migration notes

- Explicit `db.transaction()` calls now throw `TransactionMiddlewareUnsupportedError` when any middleware is configured. This replaces unsafe behavior where encryption/serialization middleware could be bypassed. Use standard engine CRUD/batch APIs for those configurations.
- Memory storage remains volatile and process-local. It is not a replacement for durable storage and does not provide cross-tab shared data.
- Schema errors now surface before registration or during the upgrade rather than being silently converted into empty in-memory storage.
