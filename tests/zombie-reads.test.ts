import { describe, it, expect } from "vitest";
import { L1Cache, createDatabase } from "../src";

describe("Zombie Read Prevention (Race Condition Handling)", () => {
  it("discards stale async reads when a newer mutation increments the generation counter", async () => {
    const cache = new L1Cache();
    const entry = cache.getOrCreateEntry<{ id: string; name: string }>(
      "record:users:1",
      ["users"],
      "1",
    );

    // Initial state: generation is 0
    expect(cache.getGeneration("users")).toBe(0);

    // Read 1 starts at generation 0
    cache.markPending(entry, ["users"]);
    expect(entry.generationAtStart).toBe(0);

    // Optimistic mutation happens while Read 1 is still in-flight
    // Mutation sets optimistic data and increments generation
    cache.setOptimistic(entry, { id: "1", name: "Alice (Edited)" });
    cache.incrementGeneration("users");
    expect(cache.getGeneration("users")).toBe(1);

    // Read 1 resolves with old data from before the mutation
    const accepted = cache.resolve(entry, { id: "1", name: "Alice (Old)" });

    // Stale read MUST be rejected
    expect(accepted).toBe(false);

    // Snapshot data must still be the optimistic edited value
    expect(entry.snapshot.data).toEqual({ id: "1", name: "Alice (Edited)" });
  });

  it("accepts read results when no mutations occurred during read", async () => {
    const db = createDatabase({
      name: "test-read-db",
      version: 1,
      stores: {
        users: { keyPath: "id" },
      },
    });

    await db.put("users", { id: "u1", name: "Bob" }, "u1");

    const record = await db.get("users", "u1");
    expect(record).toEqual({ id: "u1", name: "Bob" });
  });
});
