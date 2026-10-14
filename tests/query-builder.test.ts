import { describe, it, expect } from "vitest";
import { createDatabase } from "../src";

interface Product {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
}

describe("QueryBuilder", () => {
  it("builds and executes queries with filter, offset, and limit", async () => {
    const db = createDatabase({
      name: "test-query-db",
      version: 1,
      stores: {
        products: { keyPath: "id" },
      },
    });

    // Populate products
    for (let i = 1; i <= 10; i++) {
      await db.put<Product>(
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
      .query<Product>("products")
      .filter((p) => p.inStock)
      .toArray();

    expect(inStockItems).toHaveLength(5);
    expect(inStockItems.every((p) => p.inStock)).toBe(true);

    // Query with limit and offset
    const paginated = await db.query<Product>("products").offset(2).limit(3).toArray();

    expect(paginated).toHaveLength(3);
  });
});
