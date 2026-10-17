import { describe, it, expect, expectTypeOf } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  createDatabase,
  createDatabaseHooks,
  store,
} from "../src";

describe("createDatabaseHooks Factory", () => {
  interface Article {
    id: string;
    title: string;
    views: number;
  }

  it("provides type-safe hooks bound to database engine", async () => {
    const db = createDatabase({
      name: "blog-db",
      version: 1,
      stores: {
        articles: store<Article>()({
          keyPath: "id",
          indexes: { by_views: { keyPath: "views" } },
        }),
      },
    });

    const hooks = createDatabaseHooks(db);

    const { result: recordResult } = renderHook(() =>
      hooks.useRecord("articles", "art_1", {
        defaultValue: { id: "art_1", title: "Draft Post", views: 0 },
      }),
    );

    const { result: liveQueryResult } = renderHook(() =>
      hooks.useLiveQuery((queryDb) =>
        queryDb.query("articles").where("views").gte(50).toArray(),
      ),
    );
    expectTypeOf(liveQueryResult.current.data).toEqualTypeOf<Article[] | undefined>();

    expect(recordResult.current.data?.title).toBe("Draft Post");

    // Update record via mutation hook
    const { result: mutationResult } = renderHook(() => hooks.useMutation("articles"));

    await act(async () => {
      await mutationResult.current.put({
        id: "art_1",
        title: "Published Post",
        views: 100,
      });
    });

    await waitFor(() => {
      expect(recordResult.current.data?.title).toBe("Published Post");
      expect(recordResult.current.data?.views).toBe(100);
      expect(liveQueryResult.current.data).toEqual([
        { id: "art_1", title: "Published Post", views: 100 },
      ]);
    });

    // Verify IDBStatus hook
    const { result: statusResult } = renderHook(() => hooks.useIDBStatus());
    expect(statusResult.current.connectionState).toBeDefined();
    expect(statusResult.current.isFallbackMode).toBe(false);
    expect(statusResult.current.reconnect).toBeTypeOf("function");

    const typeChecks = () => {
      // @ts-expect-error The article key path is string-valued.
      hooks.useRecord("articles", 42);
      // @ts-expect-error Mutations require values matching Article.
      hooks.useMutation("articles").put({ id: "bad", title: "Bad", views: "many" });
      hooks.useLiveQuery((queryDb) =>
        // @ts-expect-error Comparison values use the selected field's inferred type.
        queryDb.query("articles").where("views").equals("many").toArray(),
      );
    };
    expect(typeChecks).toBeTypeOf("function");
  });
});
