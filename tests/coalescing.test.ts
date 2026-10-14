import { describe, it, expect, vi } from "vitest";
import { createDatabase } from "../src";

describe("Microtask Write Coalescer", () => {
  it("coalesces concurrent writes into a single batch", async () => {
    const db = createDatabase({
      name: "test-coalesce-db",
      version: 1,
      stores: {
        users: { keyPath: "id" },
      },
    });

    const batchSpy = vi.spyOn(db.storage, "batch");

    // Queue 50 concurrent writes
    const promises = Array.from({ length: 50 }, (_, i) =>
      db.put("users", { id: `user_${i}`, name: `User ${i}` }, `user_${i}`),
    );

    await Promise.all(promises);

    // Exactly 1 batch call to storage should have been made
    expect(batchSpy).toHaveBeenCalledTimes(1);

    // Verify all 50 records were written
    const allUsers = await db.query("users").toArray();
    expect(allUsers).toHaveLength(50);
  });

  it("deduplicates identical keys queued within the same microtask", async () => {
    const db = createDatabase({
      name: "test-dedup-db",
      version: 1,
      stores: {
        items: { keyPath: "id" },
      },
    });

    // Queue multiple puts for same key 'k1'
    const p1 = db.put("items", { id: "k1", val: "v1" }, "k1");
    const p2 = db.put("items", { id: "k1", val: "v2" }, "k1");
    const p3 = db.put("items", { id: "k1", val: "v3_final" }, "k1");

    await Promise.all([p1, p2, p3]);

    const record = await db.get("items", "k1");
    expect(record).toEqual({ id: "k1", val: "v3_final" });
  });

  it("coalesces put followed by delete into a delete", async () => {
    const db = createDatabase({
      name: "test-put-del-db",
      version: 1,
      stores: {
        items: {},
      },
    });

    // Queue put then delete for same key in same microtask
    const pPut = db.put("items", { name: "temp" }, "temp-key");
    const pDel = db.delete("items", "temp-key");

    await expect(pPut).rejects.toThrow("deleted before flush");
    await pDel;

    const record = await db.get("items", "temp-key");
    expect(record).toBeUndefined();
  });
});
