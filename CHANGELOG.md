# Changelog

Notable user-facing changes are recorded here. Versions are published only after the corresponding release workflow succeeds.

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
