import { describe, it, expect } from "vitest";
import { L1Cache } from "../src";

describe("Optimistic Rollback", () => {
  it("rolls back optimistic overlay to previous state when transaction aborts", () => {
    const cache = new L1Cache();
    const entry = cache.getOrCreateEntry<{ id: string; name: string }>(
      "record:users:u1",
      ["users"],
      "u1",
    );

    // Initial confirmed value
    cache.resolve(entry, { id: "u1", name: "Confirmed Name" });
    expect(entry.snapshot.data?.name).toBe("Confirmed Name");

    // Apply optimistic update
    cache.setOptimistic(entry, { id: "u1", name: "Optimistic Name" });
    expect(entry.snapshot.data?.name).toBe("Optimistic Name");

    // Transaction aborts: trigger rollback
    cache.rollbackOptimistic(entry);

    // Snapshot automatically reverts to confirmed value
    expect(entry.snapshot.data?.name).toBe("Confirmed Name");
  });

  it("notifies subscribers referentially only when state actually changes", () => {
    const cache = new L1Cache();
    const entry = cache.getOrCreateEntry<string>("test-hash", ["store"]);
    let callCount = 0;

    cache.subscribe("test-hash", () => {
      callCount++;
    });

    cache.resolve(entry, "value-1");
    expect(callCount).toBe(1);

    // Calling updateEntrySnapshot with identical data does NOT notify again
    cache.updateEntrySnapshot(entry);
    expect(callCount).toBe(1);

    cache.resolve(entry, "value-2");
    expect(callCount).toBe(2);
  });
});
