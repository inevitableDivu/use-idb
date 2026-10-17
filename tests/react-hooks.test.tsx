import { renderHook, act, waitFor, render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React, { Suspense } from "react";
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

    it("maintains referentially identical snapshot across re-renders when key is undefined", () => {
      const db = createDatabase({
        name: "test-snapshot-stability-db",
        version: 1,
        stores: { notes: { keyPath: "id" } },
      });

      const { result, rerender } = renderHook(
        ({ recordKey }: { recordKey?: string }) => useRecord("notes", recordKey, undefined, db),
        { initialProps: { recordKey: undefined } },
      );

      const firstData = result.current.data;
      const firstLoading = result.current.isLoading;
      const firstFetching = result.current.isFetching;

      // Force multiple component re-renders while key remains undefined
      rerender({ recordKey: undefined });
      rerender({ recordKey: undefined });

      expect(result.current.data).toBe(firstData);
      expect(result.current.isLoading).toBe(firstLoading);
      expect(result.current.isFetching).toBe(firstFetching);
      expect(result.current.data).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
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

    it("suspends on initial query read and resolves with live query data", async () => {
      const db = createDatabase({
        name: "test-suspense-db",
        version: 1,
        stores: { items: { keyPath: "id" } },
      });

      await db.put("items", { id: "i1", title: "Suspense Item" });

      function SuspenseComponent() {
        const { data } = useLiveQuery(
          (engine) => engine.query<{ id: string; title: string }>("items").toArray(),
          [],
          { suspense: true },
          db,
        );

        return (
          <div>
            <h1>Items</h1>
            <ul>
              {data?.map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ul>
          </div>
        );
      }

      render(
        <Suspense fallback={<div data-testid="suspense-fallback">Loading...</div>}>
          <SuspenseComponent />
        </Suspense>,
      );

      // Initially fallback should be visible
      expect(screen.queryByTestId("suspense-fallback")).not.toBeNull();

      // After async query resolves, items are displayed
      await waitFor(() => {
        expect(screen.getByText("Suspense Item")).not.toBeNull();
      });
      expect(screen.queryByTestId("suspense-fallback")).toBeNull();
    });

    it("reactively updates count when records are inserted and deleted", async () => {
      const db = createDatabase({
        name: "test-count-db",
        version: 1,
        stores: { tasks: { keyPath: "id" } },
      });

      const { result } = renderHook(() =>
        useLiveQuery((engine) => engine.query("tasks").asCount(), [], undefined, db),
      );

      await waitFor(() => {
        expect(result.current.data).toBe(0);
      });

      // Insert record 1
      await act(async () => {
        await db.put("tasks", { id: "t1", title: "Task 1" });
      });

      await waitFor(() => {
        expect(result.current.data).toBe(1);
      });

      // Insert record 2
      await act(async () => {
        await db.put("tasks", { id: "t2", title: "Task 2" });
      });

      await waitFor(() => {
        expect(result.current.data).toBe(2);
      });

      // Delete record 1
      await act(async () => {
        await db.delete("tasks", "t1");
      });

      await waitFor(() => {
        expect(result.current.data).toBe(1);
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
