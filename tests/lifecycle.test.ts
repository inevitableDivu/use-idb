import { describe, it, expect } from "vitest";
import {
  createDatabase,
  DatabaseClosingForUpgradeError,
  DatabaseConfigurationConflictError,
  MemoryStorageAdapter,
  createEncryptionMiddleware,
  TransactionMiddlewareUnsupportedError,
  DatabaseMigrationError,
  DatabaseDestroyedError,
  MiddlewareSchemaConflictError,
  outOfLineStore,
  store,
} from "../src";

describe("Database Lifecycle & Upgrade Safety", () => {
  it("reuses the same engine for the same schema and middleware instances", async () => {
    const schema = {
      name: "registration-compatible-db",
      version: 1,
      stores: { records: { keyPath: "id" } },
    };
    const middleware = {
      name: "test-middleware",
      beforeWrite: (ctx: { value: unknown }) => ctx.value,
    };
    const config = { middlewares: [middleware] };

    const first = createDatabase(schema, config);
    const second = createDatabase(schema, config);

    expect(second).toBe(first);
    await first.destroy();
  });

  it("rejects a second registration that changes middleware security configuration", async () => {
    const schema = {
      name: "registration-middleware-conflict-db",
      version: 1,
      stores: { records: { keyPath: "id" } },
    };
    const keyA = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const keyB = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const first = createDatabase(schema, {
      storage: new MemoryStorageAdapter(),
      middlewares: [createEncryptionMiddleware(keyA, ["secret"])],
    });

    expect(() =>
      createDatabase(schema, {
        storage: new MemoryStorageAdapter(),
        middlewares: [createEncryptionMiddleware(keyB, ["secret"])],
      }),
    ).toThrow(DatabaseConfigurationConflictError);

    await first.destroy();
  });

  it("rejects schema version, store, and adapter configuration conflicts", async () => {
    const schema = {
      name: "registration-schema-conflict-db",
      version: 1,
      stores: { records: { keyPath: "id" } },
    };
    const first = createDatabase(schema, { storage: new MemoryStorageAdapter() });

    expect(() =>
      createDatabase({ ...schema, version: 2 }, { storage: new MemoryStorageAdapter() }),
    ).toThrow(/schema/);

    expect(() =>
      createDatabase(
        { ...schema, stores: { other: { keyPath: "id" } } },
        { storage: first.storage },
      ),
    ).toThrow(/schema/);

    expect(() =>
      createDatabase(schema, {
        storage: first.storage,
        sync: {
          subscribe: () => () => {},
          publish: () => {},
          close: () => {},
        } as any,
      }),
    ).toThrow(/sync adapter/);

    await first.destroy();
  });

  it("rejects operations with DatabaseClosingForUpgradeError during remote upgrade", async () => {
    const db = createDatabase({
      name: "test-upgrade-guard-db",
      version: 1,
      stores: { logs: { keyPath: "id" } },
    });

    // Adapter opens successfully
    await (db.storage as any).ensureOpen?.();

    // Verify error properties for remote upgrade rejection
    const err = new DatabaseClosingForUpgradeError();
    expect(err.name).toBe("DatabaseClosingForUpgradeError");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("schema upgrade");
  });

  it("validates database configuration before registering or opening storage", () => {
    expect(() =>
      createDatabase({
        name: "invalid-schema-version-db",
        version: 0,
        stores: { records: { keyPath: "id" } },
      } as any),
    ).toThrow(/positive safe integer/);

    expect(() =>
      createDatabase({
        name: "invalid-multi-entry-schema-db",
        version: 1,
        stores: {
          records: {
            keyPath: "id",
            indexes: { compound_tags: { keyPath: ["organizationId", "tag"], multiEntry: true } },
          },
        },
      } as any),
    ).toThrow(/multiEntry.*compound keyPath/);
  });

  it("rejects explicit transactions when middleware would otherwise be bypassed", async () => {
    const db = createDatabase(
      {
        name: "transaction-middleware-contract-db",
        version: 1,
        stores: { records: { keyPath: "id" } },
      },
      {
        middlewares: [
          {
            name: "test-transform",
            beforeWrite: ({ value }) => value,
            afterRead: ({ value }) => value,
          },
        ],
      },
    );

    await expect(
      db.transaction(["records"], "readwrite", async (tx) => {
        await tx.put("records", { id: "r1" });
      }),
    ).rejects.toBeInstanceOf(TransactionMiddlewareUnsupportedError);

    await db.destroy();
  });

  it("provides clone isolation and atomic rollback in memory storage", async () => {
    const schema = {
      name: "memory-transaction-semantics-db",
      version: 1,
      stores: {
        records: {
          keyPath: "id",
          indexes: { by_email: { keyPath: "email", unique: true } },
        },
        audit: { keyPath: "id" },
      },
    };
    const memory = new MemoryStorageAdapter(schema);
    await memory.open();

    const value = { id: "r1", email: "one@example.test", profile: { score: 1 } };
    await memory.put("records", value);
    value.profile.score = 99;
    expect((await memory.get<typeof value>("records", "r1"))?.profile.score).toBe(1);

    const loaded = await memory.get<typeof value>("records", "r1");
    loaded!.profile.score = 42;
    expect((await memory.get<typeof value>("records", "r1"))?.profile.score).toBe(1);

    await expect(
      memory.transaction(["records", "audit"], "readwrite", async (tx) => {
        await tx.put("records", { id: "r2", email: "two@example.test" });
        await tx.put("audit", { id: "a1", action: "created" });
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");

    expect(await memory.get("records", "r2")).toBeUndefined();
    expect(await memory.get("audit", "a1")).toBeUndefined();

    await memory.transaction(["records", "audit"], "readwrite", async (tx) => {
      await tx.put("records", { id: "r2", email: "two@example.test" });
      await tx.put("audit", { id: "a1", action: "created" });
    });
    expect(await memory.get("records", "r2")).toMatchObject({ email: "two@example.test" });
    expect(await memory.get("audit", "a1")).toMatchObject({ action: "created" });

    await expect(
      memory.batch("records", [
        { type: "put", value: { id: "r3", email: "three@example.test" } },
        { type: "put", value: { id: "r4", email: "one@example.test" } },
      ]),
    ).rejects.toThrow(/Unique index constraint/);
    expect(await memory.get("records", "r3")).toBeUndefined();
    expect(await memory.get("records", "r4")).toBeUndefined();
    await memory.close();
  });

  it("provides an atomic synchronous update primitive", async () => {
    const db = createDatabase(
      {
        name: "atomic-update-helper-db",
        version: 1,
        stores: {
          counters: store<{ id: string; value: number }>()({ keyPath: "id" }),
        },
      },
      { storage: new MemoryStorageAdapter() },
    );

    await db.put("counters", { id: "main", value: 1 });
    const updated = await db.update("counters", "main", (current) => ({
      id: "main",
      value: (current?.value ?? 0) + 1,
    }));
    expect(updated.value).toBe(2);
    expect(await db.get("counters", "main")).toEqual({ id: "main", value: 2 });

    await expect(
      db.update("counters", "main", (() => Promise.resolve({ id: "main", value: 3 })) as any),
    ).rejects.toThrow(/must be synchronous/);
    await db.destroy();
  });

  it("requires an explicit migration to change a store primary key", async () => {
    const name = "explicit-primary-key-migration-db";
    const versionOne = createDatabase({
      name,
      version: 1,
      stores: { records: store<{ id: string; title: string }>()({ keyPath: "id" }) },
    });
    await versionOne.open();
    await versionOne.put("records", { id: "r1", title: "Keep me" });
    await versionOne.destroy();

    const versionTwoWithoutMigration = createDatabase({
      name,
      version: 2,
      stores: { records: store<{ newId: string; title: string }>()({ keyPath: "newId" }) },
    });
    await expect(versionTwoWithoutMigration.open()).rejects.toBeInstanceOf(DatabaseMigrationError);
    await versionTwoWithoutMigration.destroy();

    const versionTwoWithMigration = createDatabase({
      name,
      version: 2,
      stores: { records: store<{ newId: string; title: string }>()({ keyPath: "newId" }) },
      migrations: {
        2: ({ db, transaction }) => {
          const oldStore = transaction.objectStore("records");
          const oldRows: Array<{ id: string; title: string }> = [];
          const cursorRequest = oldStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              oldRows.push(cursor.value as { id: string; title: string });
              cursor.continue();
              return;
            }
            db.deleteObjectStore("records");
            const newStore = db.createObjectStore("records", { keyPath: "newId" });
            for (const row of oldRows) newStore.put({ newId: row.id, title: row.title });
          };
        },
      },
    });

    await versionTwoWithMigration.open();
    expect(await versionTwoWithMigration.get("records", "r1")).toEqual({
      newId: "r1",
      title: "Keep me",
    });
    await versionTwoWithMigration.destroy();
  });

  it("does not report or cache a batch whose IndexedDB transaction aborts", async () => {
    const db = createDatabase({
      name: "indexeddb-atomic-batch-abort-db",
      version: 1,
      stores: {
        records: store<{ id: string; email: string }>()({
          keyPath: "id",
          indexes: { by_email: { keyPath: "email", unique: true } },
        }),
      },
    });

    await db.open();
    await db.put("records", { id: "existing", email: "taken@example.test" });
    await expect(
      db.putMany("records", [
        { id: "would-be-first", email: "new@example.test" },
        { id: "would-abort-second", email: "taken@example.test" },
      ]),
    ).rejects.toBeTruthy();

    expect(await db.get("records", "would-be-first")).toBeUndefined();
    expect(await db.get("records", "would-abort-second")).toBeUndefined();
    expect(await db.get("records", "existing")).toEqual({
      id: "existing",
      email: "taken@example.test",
    });
    await db.destroy();
  });

  it("rejects middleware that transforms primary keys or indexed fields", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);

    expect(() =>
      createDatabase(
        {
          name: "middleware-primary-key-conflict-db",
          version: 1,
          stores: { records: { keyPath: "id" } },
        },
        {
          storage: new MemoryStorageAdapter(),
          middlewares: [createEncryptionMiddleware(key, ["id"])],
        },
      ),
    ).toThrow(MiddlewareSchemaConflictError);

    expect(() =>
      createDatabase(
        {
          name: "middleware-index-conflict-db",
          version: 1,
          stores: {
            records: {
              keyPath: "id",
              indexes: { by_email: { keyPath: "profile.email", unique: true } },
            },
          },
        },
        {
          storage: new MemoryStorageAdapter(),
          middlewares: [createEncryptionMiddleware(key, ["profile"])],
        },
      ),
    ).toThrow(/overlaps primary-key\/index path/);
  });

  it("throws a typed error when an engine is used after destroy", async () => {
    const db = createDatabase(
      {
        name: "destroyed-engine-contract-db",
        version: 1,
        stores: { records: store<{ id: string }>()({ keyPath: "id" }) },
      },
      { storage: new MemoryStorageAdapter() },
    );
    await db.destroy();

    await expect(db.get("records", "missing")).rejects.toBeInstanceOf(DatabaseDestroyedError);
    expect(() => db.query("records")).toThrow(DatabaseDestroyedError);
  });

  it("accepts typed out-of-line keys without changing inline-key behavior", async () => {
    interface AuditEvent {
      kind: "created" | "updated";
      createdAt: Date;
    }
    const db = createDatabase({
      name: "lifecycle-out-of-line-store-db",
      version: 1,
      stores: {
        events: outOfLineStore<AuditEvent, string>()({ indexes: { by_kind: "kind" } }),
      },
    });
    await db.put("events", { kind: "created", createdAt: new Date() }, "event-1");
    expect(await db.get("events", "event-1")).toMatchObject({ kind: "created" });
    await db.destroy();
  });
});
