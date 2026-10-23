import { renderHook, act, waitFor, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React, { Suspense } from "react";
import {
  useIdb,
  useRecord,
  useLiveQuery,
  useMutation,
  useIDBStatus,
  createDatabase,
  store,
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
          profiles: store<{ id: string; name: string; score: number }>()({ keyPath: "id" }),
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

    it("preserves concurrent patches to different fields", async () => {
      const db = createDatabase({
        name: "test-concurrent-patch-db",
        version: 1,
        stores: {
          profiles: store<{ id: string; name: string; score: number }>()({ keyPath: "id" }),
        },
      });
      await db.put("profiles", { id: "p2", name: "Initial", score: 0 });
      const { result } = renderHook(() =>
        useRecord<{ id: string; name: string; score: number }>("profiles", "p2", undefined, db),
      );

      await act(async () => {
        await Promise.all([
          result.current.patch({ name: "Updated" }),
          result.current.patch({ score: 99 }),
        ]);
      });

      const saved = await db.get("profiles", "p2");
      expect(saved).toEqual({ id: "p2", name: "Updated", score: 99 });
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
          items: store<{ id: string; label: string }>()({ keyPath: "id" }),
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <IndexedDBProvider client={db}>{children}</IndexedDBProvider>
      );

      const { result } = renderHook(() => useMutation(), { wrapper });

      await act(async () => {
        await result.current.put("items", { id: "m1", label: "Mutated Item" });
      });

      const item = await db.get("items", "m1");
      expect(item?.label).toBe("Mutated Item");
    });
  });

  describe("useLiveQuery", () => {
    it("subscribes and updates reactively when records are added", async () => {
      const db = createDatabase({
        name: "test-livequery-db",
        version: 1,
        stores: {
          todos: store<{ id: string; text: string }>()({ keyPath: "id" }),
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <IndexedDBProvider client={db}>{children}</IndexedDBProvider>
      );

      const { result } = renderHook(
        () =>
          useLiveQuery<{ id: string; text: string }[]>(
            (client) =>
              client.query("todos").toArray() as Promise<{ id: string; text: string }[]>,
            [],
            {
            initialData: [],
            },
          ),
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
        stores: {
          items: store<{ id: string; title: string }>()({ keyPath: "id" }),
        },
      });

      await db.put("items", { id: "i1", title: "Suspense Item" });

      function SuspenseComponent() {
        const { data } = useLiveQuery<{ id: string; title: string }[]>(
          (engine) =>
            engine.query("items").toArray() as Promise<{ id: string; title: string }[]>,
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
        stores: { tasks: store<{ id: string; title: string }>()({ keyPath: "id" }) },
      });

      const { result } = renderHook(() =>
        useLiveQuery<number>((engine) => engine.query("tasks").asCount(), [], undefined, db),
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

    it("uses declared stores to avoid speculative execution and aborts custom async work on unmount", async () => {
      const db = createDatabase({
        name: "test-livequery-cancellation-db",
        version: 1,
        stores: { tasks: store<{ id: string }>()({ keyPath: "id" }) },
      });

      const signals: AbortSignal[] = [];
      const query = vi.fn((_engine: unknown, context: { signal: AbortSignal }) => {
        signals.push(context.signal);
        return new Promise<number>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      });

      const { unmount } = renderHook(() =>
        useLiveQuery<number>(
          query,
          [],
          { stores: ["tasks"], queryKey: "cancellable-custom-query" },
          db,
        ),
      );

      await waitFor(() => expect(query).toHaveBeenCalled());
      // A declared store list avoids invoking arbitrary async work during dependency inspection.
      expect(query.mock.calls.length).toBeLessThanOrEqual(2);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);

      unmount();
      await waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
      await db.destroy();
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
