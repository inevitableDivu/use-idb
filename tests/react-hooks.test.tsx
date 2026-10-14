import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import {
  useIdb,
  useRecord,
  useLiveQuery,
  useMutation,
  useIDBStatus,
  createDatabase,
  IndexedDBProvider,
} from "../src";

describe("React Hooks", () => {
  describe("useIdb (zero-config)", () => {
    it("initializes with defaultValue and updates value", async () => {
      const { result } = renderHook(() =>
        useIdb<string>("theme_setting", { defaultValue: "light" }),
      );

      expect(result.current.value).toBe("light");

      await act(async () => {
        await result.current.setValue("dark");
      });

      await waitFor(() => {
        expect(result.current.value).toBe("dark");
      });
    });

    it("supports functional updates and remove", async () => {
      const { result } = renderHook(() => useIdb<number>("counter_key", { defaultValue: 10 }));

      await act(async () => {
        await result.current.setValue((prev) => (prev ?? 0) + 5);
      });

      await waitFor(() => {
        expect(result.current.value).toBe(15);
      });

      await act(async () => {
        await result.current.remove();
      });

      await waitFor(() => {
        // Reverts to default value after remove
        expect(result.current.value).toBe(10);
      });
    });
  });

  describe("useRecord (relational store)", () => {
    it("reads, sets, and patches records", async () => {
      const db = createDatabase({
        name: "test-hooks-db",
        version: 1,
        stores: {
          profiles: { keyPath: "id" },
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <IndexedDBProvider client={db}>{children}</IndexedDBProvider>
      );

      const { result } = renderHook(
        () =>
          useRecord<{ id: string; name: string; score: number }>("profiles", "p1", {
            defaultValue: { id: "p1", name: "Guest", score: 0 },
          }),
        { wrapper },
      );

      expect(result.current.data?.name).toBe("Guest");

      // Set
      await act(async () => {
        await result.current.set({ id: "p1", name: "Alice", score: 100 });
      });

      await waitFor(() => {
        expect(result.current.data?.name).toBe("Alice");
        expect(result.current.data?.score).toBe(100);
      });

      // Patch
      await act(async () => {
        await result.current.patch({ score: 250 });
      });

      await waitFor(() => {
        expect(result.current.data?.name).toBe("Alice");
        expect(result.current.data?.score).toBe(250);
      });
    });
  });

  describe("useMutation", () => {
    it("provides mutation primitives", async () => {
      const db = createDatabase({
        name: "test-mutation-db",
        version: 1,
        stores: {
          items: { keyPath: "id" },
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <IndexedDBProvider client={db}>{children}</IndexedDBProvider>
      );

      const { result } = renderHook(() => useMutation(), { wrapper });

      await act(async () => {
        await result.current.put("items", { id: "m1", label: "Mutated Item" });
      });

      const item = await db.get<{ id: string; label: string }>("items", "m1");
      expect(item?.label).toBe("Mutated Item");
    });
  });

  describe("useLiveQuery", () => {
    it("subscribes and updates reactively when records are added", async () => {
      const db = createDatabase({
        name: "test-livequery-db",
        version: 1,
        stores: {
          todos: { keyPath: "id" },
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <IndexedDBProvider client={db}>{children}</IndexedDBProvider>
      );

      const { result } = renderHook(
        () =>
          useLiveQuery<{ id: string; text: string }[]>((client) => client.query("todos"), [], {
            initialData: [],
          }),
        { wrapper },
      );

      expect(result.current.data).toEqual([]);

      // Insert todo
      await act(async () => {
        await db.put("todos", { id: "t1", text: "Buy groceries" }, "t1");
      });

      await waitFor(() => {
        expect(result.current.data).toHaveLength(1);
        expect(result.current.data?.[0]?.text).toBe("Buy groceries");
      });
    });
  });

  describe("useIDBStatus", () => {
    it("exposes connection telemetry", () => {
      const { result } = renderHook(() => useIDBStatus());

      expect(result.current).toHaveProperty("connectionState");
      expect(result.current).toHaveProperty("isFallbackMode");
      expect(result.current).toHaveProperty("quota");
      expect(typeof result.current.reconnect).toBe("function");
    });
  });
});
