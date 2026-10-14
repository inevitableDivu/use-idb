import { describe, it, expect } from "vitest";
import { MemoryStorageAdapter } from "../src";

describe("MemoryStorageAdapter", () => {
  it("supports basic CRUD operations", async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.open();

    expect(adapter.getState()).toBe("FALLBACK_MEMORY");

    // Put
    const key = await adapter.put("items", { name: "Item 1" }, "item_1");
    expect(key).toBe("item_1");

    // Get
    const record = await adapter.get<{ name: string }>("items", "item_1");
    expect(record).toEqual({ name: "Item 1" });

    // Count
    expect(await adapter.count("items")).toBe(1);

    // Delete
    await adapter.delete("items", "item_1");
    expect(await adapter.get("items", "item_1")).toBeUndefined();
    expect(await adapter.count("items")).toBe(0);
  });

  it("supports auto-increment keys", async () => {
    const adapter = new MemoryStorageAdapter();
    const k1 = await adapter.put("notes", { text: "Note 1" });
    const k2 = await adapter.put("notes", { text: "Note 2" });

    expect(k1).toBe(1);
    expect(k2).toBe(2);

    const all = await adapter.getAll("notes");
    expect(all).toHaveLength(2);
  });

  it("supports cursor queries with filter, offset, and limit", async () => {
    const adapter = new MemoryStorageAdapter();
    for (let i = 1; i <= 20; i++) {
      await adapter.put("numbers", { val: i, even: i % 2 === 0 }, i);
    }

    const evenResults = await adapter.cursor<{ val: number; even: boolean }>({
      storeName: "numbers",
      direction: "next",
      offsetCount: 2,
      limitCount: 3,
      filterPredicate: (item) => item.even,
    });

    // Even numbers: 2, 4, 6, 8, 10, 12, ...
    // Offset 2 -> starts at 6
    // Limit 3 -> 6, 8, 10
    expect(evenResults.map((r) => r.val)).toEqual([6, 8, 10]);
  });
});
