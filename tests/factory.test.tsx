import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  createDatabase,
  createDatabaseHooks,
  type DatabaseSchema,
  type StoreConfig,
} from "../src";

describe("createDatabaseHooks Factory", () => {
  interface Article {
    id: string;
    title: string;
    views: number;
  }

  interface BlogSchema extends DatabaseSchema<{
    articles: StoreConfig<Article>;
  }> {
    name: "blog-db";
    version: 1;
    stores: {
      articles: StoreConfig<Article>;
    };
  }

  it("provides type-safe hooks bound to database engine", async () => {
    const db = createDatabase<BlogSchema>({
      name: "blog-db",
      version: 1,
      stores: {
        articles: { keyPath: "id", indexes: { by_views: { keyPath: "views" } } },
      },
    });

    const hooks = createDatabaseHooks<BlogSchema>(db);

    const { result: recordResult } = renderHook(() =>
      hooks.useRecord("articles", "art_1", {
        defaultValue: { id: "art_1", title: "Draft Post", views: 0 },
      }),
    );

    expect(recordResult.current.data?.title).toBe("Draft Post");

    // Update record via mutation hook
    const { result: mutationResult } = renderHook(() => hooks.useMutation());

    await act(async () => {
      await mutationResult.current.put("articles", {
        id: "art_1",
        title: "Published Post",
        views: 100,
      });
    });

    await waitFor(() => {
      expect(recordResult.current.data?.title).toBe("Published Post");
      expect(recordResult.current.data?.views).toBe(100);
    });

    // Verify IDBStatus hook
    const { result: statusResult } = renderHook(() => hooks.useIDBStatus());
    expect(statusResult.current.connectionState).toBeDefined();
    expect(statusResult.current.isFallbackMode).toBe(false);
    expect(statusResult.current.reconnect).toBeTypeOf("function");
  });
});
