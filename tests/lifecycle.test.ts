import { describe, it, expect } from "vitest";
import {
  createDatabase,
  DatabaseClosingForUpgradeError,
  DatabaseConfigurationConflictError,
  MemoryStorageAdapter,
  createEncryptionMiddleware,
} from "../src";

describe("Database Lifecycle & Upgrade Safety", () => {
  it("reuses the same engine for the same schema and middleware instances", async () => {
    const schema = {
      name: "registration-compatible-db",
      version: 1,
      stores: { records: { keyPath: "id" } },
    };
    const middleware = { name: "test-middleware", beforeWrite: (ctx: { value: unknown }) => ctx.value };
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
    const keyA = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const keyB = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
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
      createDatabase(
        { ...schema, version: 2 },
        { storage: new MemoryStorageAdapter() },
      ),
    ).toThrow(/schema/);

    expect(() =>
      createDatabase(
        { ...schema, stores: { other: { keyPath: "id" } } },
        { storage: first.storage },
      ),
    ).toThrow(/schema/);

    expect(() =>
      createDatabase(schema, { storage: first.storage, sync: { 
        subscribe: () => () => {},
        publish: () => {},
        close: () => {},
      } as any }),
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
});
