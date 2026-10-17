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

  it("does not hang surviving operations when an intermediate middleware operation rejects", async () => {
    const failingMiddleware = {
      name: "failing-middleware",
      async beforeWrite(ctx: any) {
        if (ctx.key === "poison_pill") {
          throw new Error("Validation failure: poison pill rejected");
        }
        return ctx.value;
      },
    };

    const db = createDatabase(
      {
        name: "test-middleware-isolation-db",
        version: 1,
        stores: { items: { keyPath: "id" } },
      },
      {
        middlewares: [failingMiddleware],
      },
    );

    // Queue 3 writes concurrently within the same microtask:
    // op1: valid, op2: poison pill, op3: valid
    const p1 = db.put("items", { id: "item_1", name: "First" }, "item_1");
    const p2 = db.put("items", { id: "poison_pill", name: "Poison" }, "poison_pill");
    const p3 = db.put("items", { id: "item_3", name: "Third" }, "item_3");

    const [res1, res2, res3] = await Promise.allSettled([p1, p2, p3]);

    // op1 must succeed
    expect(res1.status).toBe("fulfilled");
    // op2 must reject with the middleware error
    expect(res2.status).toBe("rejected");
    if (res2.status === "rejected") {
      expect(res2.reason.message).toContain("poison pill rejected");
    }
    // op3 must NOT hang and must succeed
    expect(res3.status).toBe("fulfilled");

    // Verify that item_1 and item_3 are written, and poison_pill is not
    const item1 = await db.get("items", "item_1");
    const poison = await db.get("items", "poison_pill");
    const item3 = await db.get("items", "item_3");

    expect(item1).toEqual({ id: "item_1", name: "First" });
    expect(poison).toBeUndefined();
    expect(item3).toEqual({ id: "item_3", name: "Third" });
  });
});
