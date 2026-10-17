import { describe, it, expect } from "vitest";
import { L1Cache, DELETED_SENTINEL } from "../src";

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

  it("renders record as deleted immediately during optimistic delete and restores on rollback", () => {
    const cache = new L1Cache();
    const entry = cache.getOrCreateEntry("record:users:u1", ["users"], "u1");

    // Initial state: record exists
    cache.resolve(entry, { id: "u1", name: "Bob" });
    expect(entry.snapshot.data).toEqual({ id: "u1", name: "Bob" });

    // Apply optimistic deletion overlay using DELETED_SENTINEL
    const overlayKey = "overlay_del_1";
    cache.setOptimistic(entry, DELETED_SENTINEL as any, overlayKey);

    // Snapshot data must immediately be undefined (record appears deleted)
    expect(entry.snapshot.data).toBeUndefined();
    expect(entry.snapshot.isLoading).toBe(false);

    // Rollback optimistic overlay
    cache.rollbackOptimistic(entry, overlayKey);

    // Restores original data
    expect(entry.snapshot.data).toEqual({ id: "u1", name: "Bob" });
  });
});
