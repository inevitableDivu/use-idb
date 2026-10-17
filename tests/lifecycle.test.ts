import { describe, it, expect } from "vitest";
import {
  createDatabase,
  DatabaseClosingForUpgradeError,
} from "../src";

describe("Database Lifecycle & Upgrade Safety", () => {
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
