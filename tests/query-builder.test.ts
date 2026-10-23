import { describe, it, expect, expectTypeOf } from "vitest";
import { createDatabase, outOfLineStore, store } from "../src";

interface Product {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
}

interface User {
  id: string;
  email: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: Date;
}

describe("QueryBuilder", () => {
  it("builds and executes queries with filter, offset, and limit", async () => {
    const db = createDatabase({
      name: "test-query-db",
      version: 1,
      stores: {
        products: store<Product>()({ keyPath: "id" }),
      },
    });

    // Populate products
    for (let i = 1; i <= 10; i++) {
      await db.put(
        "products",
        {
          id: `p${i}`,
          name: `Product ${i}`,
          price: i * 10,
          inStock: i % 2 === 1,
        },
        `p${i}`,
      );
    }

    // Query in-stock items
    const inStockItems = await db
      .query("products")
      .filter((p) => p.inStock)
      .toArray();

    expect(inStockItems).toHaveLength(5);
    expect(inStockItems.every((p) => p.inStock)).toBe(true);

    // Query with limit and offset
    const paginated = await db.query("products").offset(2).limit(3).toArray();

    expect(paginated).toHaveLength(3);
  });

  it("preserves inferred store, query, key, index, and projection types", async () => {
    const db = createDatabase({
      name: "typed-query-db",
      version: 1,
      stores: {
        users: store<User>()({
          keyPath: "id",
          indexes: {
            by_role: "role",
            by_email: { keyPath: "email", unique: true },
          },
        }),
      },
    });

    const getUser = db.get("users", "user-1");
    const getAllUsers = db.getAll("users");
    expectTypeOf(getUser).toEqualTypeOf<Promise<User | undefined>>();
    expectTypeOf(getAllUsers).toEqualTypeOf<Promise<User[]>>();
    expectTypeOf(db.query("users").where("role").equals("admin").toArray()).toEqualTypeOf<
      Promise<User[]>
    >();
    expectTypeOf(db.query("users").where("by_role").equals("user").first()).toEqualTypeOf<
      Promise<User | undefined>
    >();
    expectTypeOf(db.query("users").select("id", "email").toArray()).toEqualTypeOf<
      Promise<Pick<User, "id" | "email">[]>
    >();
    const invalidCalls = () => {
      // @ts-expect-error Store key is inferred from keyPath "id".
      db.get("users", 42);
      // @ts-expect-error The value type for role is the literal union from User.
      db.query("users").where("role").equals("guest");
      // @ts-expect-error Named indexes retain their configured property value types.
      db.query("users").where("by_role").equals("guest");
      // @ts-expect-error A literal union does not accept a number.
      db.query("users").where("role").equals(123);
      // @ts-expect-error A boolean field cannot use the string prefix operator.
      db.query("users").where("active").startsWith("true");
      // @ts-expect-error Date fields cannot use the string prefix operator.
      db.query("users").where("createdAt").startsWith("2026");
      // @ts-expect-error Ordering is restricted to model fields.
      db.query("users").orderBy("missing");
      // @ts-expect-error Query fields are restricted to model keys and configured indexes.
      db.query("users").where("missing");
      // @ts-expect-error Writes must match the selected store's entity.
      db.put("users", { id: "bad", email: "bad@example.test", role: "guest", active: false });
      // @ts-expect-error Store names are inferred from the configuration.
      db.get("missing", "user-1");
    };
    expectTypeOf(invalidCalls).toBeFunction();

    await db.put("users", {
      id: "u1",
      email: "admin@example.test",
      role: "admin",
      active: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.put("users", {
      id: "u2",
      email: "user@example.test",
      role: "user",
      active: false,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(await db.query("users").where("role").equals("admin").toArray()).toHaveLength(1);
    expect(await db.query("users").where("role").equals("admin").count()).toBe(1);
    expect(await db.query("users").where("by_role").equals("user").toArray()).toHaveLength(1);
    expect(await db.query("users").where("id").equals("u2").first()).toMatchObject({
      role: "user",
    });
    expect(await db.query("users").where("role").notEquals("admin").toArray()).toHaveLength(1);
    expect(await db.query("users").where("role").anyOf(["admin", "user"]).toArray()).toHaveLength(
      2,
    );
    expect(
      await db.query("users").where("email").equals("user@example.test").first(),
    ).toMatchObject({
      id: "u2",
    });
    expect(await db.query("users").where("active").equals(true).toArray()).toHaveLength(1);
    expect(
      await db.query("users").orderBy("role", "desc").limit(1).select("email").toArray(),
    ).toEqual([{ email: "user@example.test" }]);
  });

  it("accepts the single-call store builder for the default id key path", () => {
    const db = createDatabase({
      name: "single-call-store-db",
      version: 1,
      stores: {
        products: store<Product>({
          keyPath: "id",
          indexes: { by_name: "name" },
        }),
      },
    });

    expectTypeOf(db.get("products", "product-1")).toEqualTypeOf<Promise<Product | undefined>>();
    // @ts-expect-error The configured keyPath infers a string key.
    db.get("products", 1);
    const invalidStorePaths = () => {
      // @ts-expect-error Invalid model fields cannot be used as index paths.
      store<Product>()({ keyPath: "id", indexes: { by_missing: "missing" } });
      // @ts-expect-error Invalid model fields cannot be used as the primary key path.
      store<Product>()({ keyPath: "missing" });
    };
    expectTypeOf(invalidStorePaths).toBeFunction();
  });

  it("infers and queries multi-entry indexes by their element values", async () => {
    interface TaggedRecord {
      id: string;
      tags: string[];
    }

    const db = createDatabase({
      name: "multi-entry-index-db",
      version: 1,
      stores: {
        records: store<TaggedRecord>()({
          keyPath: "id",
          indexes: { by_tag: { keyPath: "tags", multiEntry: true } },
        }),
      },
    });

    expectTypeOf(db.query("records").where("by_tag").equals("typescript").toArray()).toEqualTypeOf<
      Promise<TaggedRecord[]>
    >();
    const invalidMultiEntryQuery = () => {
      // @ts-expect-error A multi-entry index is queried by an element, not the full array.
      db.query("records").where("by_tag").equals(["typescript"]);
    };
    expectTypeOf(invalidMultiEntryQuery).toBeFunction();

    await db.put("records", { id: "r1", tags: ["typescript", "indexeddb"] });
    await db.put("records", { id: "r2", tags: ["typescript"] });
    await db.put("records", { id: "r3", tags: ["react"] });

    expect(await db.query("records").where("by_tag").equals("typescript").toArray()).toHaveLength(
      2,
    );
    expect(await db.query("records").where("by_tag").equals("typescript").count()).toBe(2);
    expect(
      await db.query("records").where("by_tag").anyOf(["typescript", "indexeddb"]).toArray(),
    ).toHaveLength(3);
  });

  it("infers compound primary keys as tuples", async () => {
    interface Membership {
      organizationId: string;
      memberId: number;
      role: string;
    }

    const db = createDatabase({
      name: "compound-key-db",
      version: 1,
      stores: {
        memberships: store<Membership>()({
          keyPath: ["organizationId", "memberId"],
          indexes: {
            by_org_member: ["organizationId", "memberId"],
          },
        }),
      },
    });

    expectTypeOf(db.get("memberships", ["org-1", 7])).toEqualTypeOf<
      Promise<Membership | undefined>
    >();
    // @ts-expect-error Compound key tuple elements follow the keyPath order and model value types.
    db.get("memberships", [7, "org-1"]);

    await db.put("memberships", { organizationId: "org-1", memberId: 7, role: "owner" });
    expect(await db.get("memberships", ["org-1", 7])).toMatchObject({ role: "owner" });
    expect(
      await db.query("memberships").where("by_org_member").equals(["org-1", 7]).toArray(),
    ).toHaveLength(1);
  });

  it("does not reuse a key range when composing predicates across different indexes", async () => {
    const db = createDatabase({
      name: "query-multi-index-range-reset-db",
      version: 1,
      stores: {
        users: store<{
          id: string;
          role: "admin" | "user";
          age: number;
        }>()({
          keyPath: "id",
          indexes: {
            by_role: "role",
            by_age: "age",
          },
        }),
      },
    });

    await db.put("users", { id: "a", role: "admin", age: 20 });
    await db.put("users", { id: "b", role: "admin", age: 40 });
    await db.put("users", { id: "c", role: "user", age: 20 });

    const matches = await db
      .query("users")
      .where("by_role")
      .equals("admin")
      .and("by_age")
      .equals(20)
      .toArray();

    expect(matches.map((user) => user.id)).toEqual(["a"]);
    await db.destroy();
  });

  it("supports typed out-of-line primary keys", async () => {
    interface AuditEvent {
      type: "created" | "updated";
      occurredAt: Date;
    }

    const db = createDatabase({
      name: "typed-out-of-line-key-db",
      version: 1,
      stores: {
        events: outOfLineStore<AuditEvent, string>()({
          indexes: {
            by_type: "type",
          },
        }),
      },
    });

    expectTypeOf(db.get("events", "event-1")).toEqualTypeOf<Promise<AuditEvent | undefined>>();
    // @ts-expect-error The out-of-line primary key is declared as a string.
    db.get("events", 1);
    // @ts-expect-error Stored values must match the declared event shape.
    db.put("events", { type: "deleted", occurredAt: new Date() }, "event-2");

    await db.put(
      "events",
      { type: "created", occurredAt: new Date("2026-10-23T00:00:00.000Z") },
      "event-1",
    );
    expect(await db.get("events", "event-1")).toMatchObject({ type: "created" });
    expect(await db.query("events").where("by_type").equals("created").count()).toBe(1);
    await db.destroy();
  });

  it("explains the selected index path and JavaScript post-processing", async () => {
    const db = createDatabase({
      name: "query-explain-plan-db",
      version: 1,
      stores: {
        users: store<User>()({
          keyPath: "id",
          indexes: { by_email: "email" },
        }),
      },
    });

    const plan = db
      .query("users")
      .where("by_email")
      .equals("alice@example.test")
      .orderBy("createdAt", "desc")
      .limit(10)
      .explain();

    expect(plan).toMatchObject({
      storeName: "users",
      accessPath: "index",
      indexName: "by_email",
      usesKeyRange: true,
      requiresPostSort: true,
      sortField: "createdAt",
      sortDirection: "desc",
      pagination: "materialize-and-slice",
    });
    await db.destroy();
  });
});
